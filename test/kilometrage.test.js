// Tests des relevés de kilométrage : npm test
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { openDb } from "../db.js";
import { createAuth } from "../auth.js";
import { createGarage, designation } from "../garage.js";
import { cleanReleve, incoherence, stats, today } from "../kilometrage.js";
import { loadKnowledge } from "../knowledge.js";

const PASSWORD = "un mot de passe solide";
const CLIO = { marque: "Renault", modele: "Clio IV", motorisation: "1.5 dCi 90", annee: 2016 };

describe("validation d'un relevé", () => {
  const NOW = "2026-10-14";
  test("accepte « 85 000 », date du jour par défaut", () => {
    assert.deepEqual(cleanReleve({ km: "85 000" }, NOW).data, { date: NOW, km: 85000 });
    assert.deepEqual(cleanReleve({ km: 120000, date: "2025-03-01" }, NOW).data, { date: "2025-03-01", km: 120000 });
  });
  test("refuse ce qui serait mal lu ou impossible", () => {
    for (const km of ["85.000", "85,5", "-3", "", "beaucoup", 12.5, 3_000_000, undefined]) {
      assert.ok(cleanReleve({ km }, NOW).error, `km = ${km}`);
    }
    assert.ok(cleanReleve({ km: 1, date: "2026-02-30" }, NOW).error, "31 février");
    assert.ok(cleanReleve({ km: 1, date: "14/10/2026" }, NOW).error, "format");
    assert.ok(cleanReleve({ km: 1, date: "2026-10-20" }, NOW).error, "futur");
    assert.equal(cleanReleve({ km: 1, date: "2026-10-15" }, NOW).error, undefined, "un jour de marge pour les fuseaux horaires");
  });
});

describe("cohérence et moyenne", () => {
  const R = [{ date: "2025-01-01", km: 50000 }, { date: "2025-07-01", km: 56000 }];
  test("un compteur ne recule pas", () => {
    assert.match(incoherence(R, { date: "2025-08-01", km: 55000 }), /inférieur à celui du 01\/07\/2025 \(56\u202f000 km\)/);
    assert.match(incoherence(R, { date: "2025-03-01", km: 60000 }), /supérieur à celui du 01\/07\/2025/);
    assert.equal(incoherence(R, { date: "2025-03-01", km: 52000 }), null);
    // Même date : le relevé remplace l'ancien, on ne le compare pas à lui-même.
    assert.equal(incoherence(R, { date: "2025-07-01", km: 55000 }), null);
  });
  test("moyenne par mois entre le premier et le dernier relevé", () => {
    // 6 000 km en 181 jours ≈ 5,95 mois
    assert.deepEqual(stats(R), { dernier: { date: "2025-07-01", km: 56000 }, moyenneMensuelle: 1009 });
    assert.deepEqual(stats([]), { dernier: null, moyenneMensuelle: null });
  });
  test("pas de moyenne avec un seul relevé ou moins de 30 jours d'écart", () => {
    assert.equal(stats([R[0]]).moyenneMensuelle, null);
    assert.equal(stats([R[0], { date: "2025-01-20", km: 51000 }]).moyenneMensuelle, null);
  });
  test("la désignation pour l'assistant inclut le dernier kilométrage", () => {
    assert.equal(designation(CLIO, 85000), "Renault Clio IV 1.5 dCi 90, 2016, 85\u202f000 km");
    assert.equal(designation(CLIO), "Renault Clio IV 1.5 dCi 90, 2016");
  });
});

describe("API des relevés", () => {
  let server, base, db;
  before(async () => {
    db = openDb(":memory:");
    const garage = createGarage(db, loadKnowledge());
    const app = express();
    app.use(express.json());
    app.use(createAuth(db, { exportData: garage.exportFor }));
    app.use(garage);
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://localhost:${server.address().port}`;
  });
  after(() => server.close());

  async function newUser(email) {
    let cookie = "";
    const c = async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...(cookie && { Cookie: cookie }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return { status: res.status, body: await res.json() };
    };
    await c("POST", "/api/auth/signup", { email, password: PASSWORD });
    return c;
  }

  test("kilométrage actuel à l'ajout = premier relevé du jour", async () => {
    const c = await newUser("km1@exemple.fr");
    assert.equal((await c("POST", "/api/garage", { ...CLIO, km: "85.000" })).status, 400);
    const v = (await c("POST", "/api/garage", { ...CLIO, km: "85 000" })).body.vehicule;
    assert.deepEqual(v.kilometrage, { dernier: { date: today(), km: 85000 }, moyenneMensuelle: null });
    assert.match(v.designation, /85\u202f000 km$/);
  });

  test("ajouter, remplacer, refuser l'incohérent, supprimer", async () => {
    const c = await newUser("km2@exemple.fr");
    const { id } = (await c("POST", "/api/garage", CLIO)).body.vehicule;
    assert.equal((await c("GET", `/api/garage/${id}/releves`)).body.releves.length, 0);

    await c("POST", `/api/garage/${id}/releves`, { date: "2025-01-01", km: 50000 });
    const r = await c("POST", `/api/garage/${id}/releves`, { date: "2025-07-01", km: 56000 });
    assert.equal(r.status, 201);
    assert.equal(r.body.moyenneMensuelle, 1009);
    assert.equal(r.body.vehicule.kilometrage.moyenneMensuelle, 1009);
    assert.deepEqual(r.body.releves.map(x => x.date), ["2025-07-01", "2025-01-01"]); // le plus récent d'abord

    const bad = await c("POST", `/api/garage/${id}/releves`, { date: "2025-09-01", km: 40000 });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.code, "incoherent_releve");

    const same = await c("POST", `/api/garage/${id}/releves`, { date: "2025-07-01", km: 57000 });
    assert.equal(same.body.releves.length, 2, "même date : remplacé, pas ajouté");
    assert.equal(same.body.dernier.km, 57000);

    const rid = same.body.releves[0].id;
    const del = await c("DELETE", `/api/garage/${id}/releves/${rid}`);
    assert.equal(del.body.releves.length, 1);
    assert.equal(del.body.moyenneMensuelle, null);
    assert.equal((await c("DELETE", `/api/garage/${id}/releves/${rid}`)).status, 404);
  });

  test("les relevés d'une voiture ne sont accessibles qu'à son propriétaire", async () => {
    const a = await newUser("km-proprio@exemple.fr"), b = await newUser("km-voisin@exemple.fr");
    const { id } = (await a("POST", "/api/garage", { ...CLIO, km: 1000 })).body.vehicule;
    const rid = (await a("GET", `/api/garage/${id}/releves`)).body.releves[0].id;
    assert.equal((await b("GET", `/api/garage/${id}/releves`)).status, 404);
    assert.equal((await b("POST", `/api/garage/${id}/releves`, { km: 2000 })).status, 404);
    assert.equal((await b("DELETE", `/api/garage/${id}/releves/${rid}`)).status, 404);
    // Un relevé ne se supprime pas via une autre voiture, même du même propriétaire.
    const other = (await a("POST", "/api/garage", CLIO)).body.vehicule.id;
    assert.equal((await a("DELETE", `/api/garage/${other}/releves/${rid}`)).status, 404);
  });

  test("export RGPD avec les relevés ; effacés avec la voiture", async () => {
    const c = await newUser("km-export@exemple.fr");
    const { id } = (await c("POST", "/api/garage", { ...CLIO, km: 1000 })).body.vehicule;
    const exp = await c("GET", "/api/account/export");
    assert.deepEqual(exp.body.vehicules[0].releves, [{ date: today(), km: 1000 }]);
    await c("DELETE", `/api/garage/${id}`);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM releves WHERE vehicle_id = ?").get(id).n, 0);
  });
});
