// Tests de la page « Relecture » (sur une copie de data/) : npm test
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { openDb } from "../db.js";
import { createAuth } from "../auth.js";
import { createRelecture, parseAdmins } from "../relecture.js";
import { loadKnowledge, findVoyants, DATA_DIR } from "../knowledge.js";

const PASSWORD = "un mot de passe solide";
let server, base, dir, kb;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "retroviz-data-"));
  for (const f of ["voyants.json", "obd.json", "vehicules.json"]) fs.copyFileSync(path.join(DATA_DIR, f), path.join(dir, f));
  kb = loadKnowledge(dir);
  const db = openDb(":memory:");
  const relecture = createRelecture({ dataDir: dir, kb, admins: parseAdmins("Admin@Exemple.fr, autre@exemple.fr"), now: () => "2026-10-15" });
  const app = express();
  app.use(express.json());
  app.use(createAuth(db, { isAdmin: relecture.isAdmin }));
  app.use(relecture);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function user(email) {
  let cookie = "";
  const c = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json() };
  };
  const r = await c("POST", "/api/auth/signup", { email, password: PASSWORD });
  c.me = r.body.user;
  return c;
}
const lireFichier = f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));

describe("accès", () => {
  test("réservé aux administrateurs ; invisible pour les autres", async () => {
    const admin = await user("admin@exemple.fr"), simple = await user("simple@exemple.fr");
    assert.equal(admin.me.admin, true, "l'adresse est reconnue sans tenir compte des majuscules");
    assert.equal(simple.me.admin, undefined);
    assert.equal((await simple("GET", "/api/admin/tableau")).status, 404);
    assert.equal((await simple("PUT", "/api/admin/fiches/voyants/abs", { fiche: {} })).status, 404);
    assert.equal((await fetch(`${base}/api/admin/tableau`)).status, 401);
    const t = (await admin("GET", "/api/admin/tableau")).body;
    assert.equal(t.fiches.voyants.total, 69);
    assert.equal(t.fiches.voyants.a_verifier, 69);
  });
});

describe("fiches", () => {
  let admin;
  before(async () => { admin = await user("autre@exemple.fr"); });

  test("liste filtrable par collection, statut et mot", async () => {
    const all = (await admin("GET", "/api/admin/fiches")).body.fiches;
    assert.equal(all.length, 69 + 113 + 5);
    const huile = (await admin("GET", "/api/admin/fiches?collection=voyants&q=huile")).body.fiches;
    assert.deepEqual(huile.map(f => f.id).sort(), ["niveau-huile", "pression-huile"]);
    assert.equal((await admin("GET", "/api/admin/fiches?statut=verifie")).body.fiches.length, 0);
  });

  test("corriger : écrit dans le fichier, avec la date et l'auteur, et recharge la base", async () => {
    const { fiche } = (await admin("GET", "/api/admin/fiches/voyants/abs")).body;
    const r = await admin("PUT", "/api/admin/fiches/voyants/abs", { fiche: { ...fiche, autres_noms: [...fiche.autres_noms, "antiblocage clignotant bizarre"] } });
    assert.equal(r.status, 200);
    const ecrite = lireFichier("voyants.json").find(v => v.id === "abs");
    assert.ok(ecrite.autres_noms.includes("antiblocage clignotant bizarre"));
    assert.equal(ecrite.mise_a_jour, "2026-10-15");
    assert.deepEqual(ecrite.revisions.at(-1), { date: "2026-10-15", par: "autre@exemple.fr", action: "correction" });
    assert.equal(findVoyants("antiblocage clignotant bizarre", kb)[0]?.id, "abs", "base rechargée sans redémarrer");
  });

  test("refuse une fiche invalide sans toucher au fichier", async () => {
    const avant = fs.readFileSync(path.join(dir, "voyants.json"), "utf8");
    const { fiche } = (await admin("GET", "/api/admin/fiches/voyants/fap")).body;
    const cas = [
      { ...fiche, statut: "verifie", sources: [] },
      { ...fiche, icone: '<path d="M1 1"/><script>alert(1)</script>' },
      { ...fiche, icone: '<path d="M1 1" onclick="alert(1)"/>' },
      { ...fiche, urgence: "jaune" },
      { ...fiche, id: "autre-id" },
    ];
    for (const f of cas) assert.equal((await admin("PUT", "/api/admin/fiches/voyants/fap", { fiche: f })).status, 400, JSON.stringify(f).slice(0, 60));
    assert.equal((await admin("PUT", "/api/admin/fiches/voyants/fap", {})).status, 400);
    assert.equal(fs.readFileSync(path.join(dir, "voyants.json"), "utf8"), avant);
  });

  test("passer en « vérifiée » : impossible sans source, puis tracé", async () => {
    const url = "/api/admin/fiches/obd/P0300";
    assert.equal((await admin("POST", `${url}/verifier`, {})).body.code, "no_source");
    assert.equal((await admin("POST", `${url}/sources`, { source: " " })).status, 400);
    const s = await admin("POST", `${url}/sources`, { source: "SAE J2012 (liste des codes génériques)" });
    assert.deepEqual(s.body.fiche.sources, ["SAE J2012 (liste des codes génériques)"]);
    assert.equal((await admin("POST", `${url}/sources`, { source: "SAE J2012 (liste des codes génériques)" })).status, 409);
    const v = await admin("POST", `${url}/verifier`, {});
    assert.equal(v.body.fiche.statut, "verifie");
    assert.equal(v.body.fiche.verifie_par, "autre@exemple.fr");
    const ecrite = lireFichier("obd.json").find(c => c.code === "P0300");
    assert.equal(ecrite.statut, "verifie");
    assert.deepEqual(ecrite.revisions.map(x => x.action), ["source ajoutée", "passée en vérifiée"]);
    assert.equal(kb.codes.get("P0300").statut, "verifie");
    assert.equal((await admin("GET", "/api/admin/tableau")).body.fiches.obd.verifie, 1);
  });

  test("fiche ou collection inconnue", async () => {
    assert.equal((await admin("GET", "/api/admin/fiches/voyants/nexiste-pas")).status, 404);
    assert.equal((await admin("GET", "/api/admin/fiches/recettes/x")).status, 404);
  });
});
