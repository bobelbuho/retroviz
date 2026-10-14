// Tests des comptes : npm test
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { openDb } from "../db.js";
import { createAuth, hashPassword, verifyPassword, normalizeEmail, COOKIE } from "../auth.js";

const PASSWORD = "un mot de passe solide";

let server, base, db;
before(async () => {
  db = openDb(":memory:");
  const app = express();
  app.use(express.json());
  app.use(createAuth(db));
  app.get("/whoami", (req, res) => res.json({ email: req.user?.email ?? null }));
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

// Petit client qui garde le cookie de session, comme un navigateur.
function client() {
  let cookie = "";
  return async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...(cookie && { Cookie: cookie }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    const type = res.headers.get("content-type") || "";
    return { status: res.status, headers: res.headers, body: type.includes("json") ? await res.json() : await res.text() };
  };
}

describe("mots de passe", () => {
  test("haché, salé et vérifiable", async () => {
    const h1 = await hashPassword(PASSWORD), h2 = await hashPassword(PASSWORD);
    assert.notEqual(h1, h2);
    assert.ok(!h1.includes(PASSWORD));
    assert.equal(await verifyPassword(PASSWORD, h1), true);
    assert.equal(await verifyPassword("mauvais mot de passe", h1), false);
  });
  test("adresse e-mail normalisée", () => {
    assert.equal(normalizeEmail("  Marie.Dupont@Exemple.FR "), "marie.dupont@exemple.fr");
    assert.equal(normalizeEmail("pas-une-adresse"), null);
  });
});

describe("inscription et connexion", () => {
  test("parcours complet : inscription, session, déconnexion, connexion", async () => {
    const c = client();
    const r = await c("POST", "/api/auth/signup", { email: "Alice@Exemple.fr", password: PASSWORD });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.email, "alice@exemple.fr");
    assert.match(r.headers.get("set-cookie"), new RegExp(`^${COOKIE}=.+HttpOnly; SameSite=Lax`));
    assert.equal((await c("GET", "/api/auth/me")).body.user.email, "alice@exemple.fr");
    assert.equal((await c("GET", "/whoami")).body.email, "alice@exemple.fr");

    assert.equal((await c("POST", "/api/auth/logout", {})).status, 200);
    assert.equal((await c("GET", "/api/auth/me")).body.user, null);

    assert.equal((await c("POST", "/api/auth/login", { email: "alice@exemple.fr", password: "mauvais mot de passe" })).status, 401);
    const ok = await c("POST", "/api/auth/login", { email: "ALICE@exemple.fr", password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.equal((await c("GET", "/api/auth/me")).body.user.email, "alice@exemple.fr");
  });

  test("le mot de passe n'est jamais stocké en clair", () => {
    const row = db.prepare("SELECT password_hash FROM users WHERE email = ?").get("alice@exemple.fr");
    assert.match(row.password_hash, /^scrypt\$/);
  });

  test("refuse une adresse déjà prise, invalide, ou un mot de passe trop court", async () => {
    const c = client();
    assert.equal((await c("POST", "/api/auth/signup", { email: "alice@exemple.fr", password: PASSWORD })).body.code, "email_taken");
    assert.equal((await c("POST", "/api/auth/signup", { email: "alice", password: PASSWORD })).body.code, "invalid_email");
    assert.equal((await c("POST", "/api/auth/signup", { email: "bob@exemple.fr", password: "court" })).body.code, "weak_password");
  });

  test("bloque après 5 échecs de connexion", async () => {
    const c = client();
    await c("POST", "/api/auth/signup", { email: "carole@exemple.fr", password: PASSWORD });
    for (let i = 0; i < 5; i++) await c("POST", "/api/auth/login", { email: "carole@exemple.fr", password: "mauvais mot de passe" });
    const r = await c("POST", "/api/auth/login", { email: "carole@exemple.fr", password: PASSWORD });
    assert.equal(r.status, 429);
  });

  test("refuse les requêtes venant d'un autre site ou hors JSON", async () => {
    const c = client();
    const cross = await c("POST", "/api/auth/signup", { email: "eve@exemple.fr", password: PASSWORD }, { Origin: "https://pirate.example" });
    assert.equal(cross.status, 403);
    const form = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "email=a" });
    assert.equal(form.status, 403);
  });
});

describe("RGPD", () => {
  test("export : données du compte en JSON téléchargeable, sans le mot de passe", async () => {
    const c = client();
    assert.equal((await c("GET", "/api/account/export")).status, 401);
    await c("POST", "/api/auth/signup", { email: "david@exemple.fr", password: PASSWORD });
    const r = await c("GET", "/api/account/export");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition"), /attachment; filename="retroviz-mes-donnees-/);
    assert.equal(r.body.account.email, "david@exemple.fr");
    assert.equal(r.body.sessions.length, 1);
    assert.ok(!JSON.stringify(r.body).includes("scrypt"));
  });

  test("suppression : mot de passe exigé, puis compte et sessions effacés", async () => {
    const c = client(), other = client();
    await c("POST", "/api/auth/signup", { email: "elise@exemple.fr", password: PASSWORD });
    await other("POST", "/api/auth/login", { email: "elise@exemple.fr", password: PASSWORD });

    assert.equal((await c("DELETE", "/api/account", { password: "mauvais mot de passe" })).status, 401);
    assert.equal((await c("DELETE", "/api/account", { password: PASSWORD })).status, 200);

    assert.equal((await c("GET", "/api/auth/me")).body.user, null);
    assert.equal((await other("GET", "/api/auth/me")).body.user, null);
    const left = db.prepare("SELECT COUNT(*) n FROM users WHERE email = ?").get("elise@exemple.fr").n;
    assert.equal(left, 0);
    assert.equal((await c("POST", "/api/auth/login", { email: "elise@exemple.fr", password: PASSWORD })).status, 401);
  });
});
