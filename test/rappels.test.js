// Tests de l'API « À venir » et des rappels : npm test
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import { createAuth } from "../auth.js";
import { createGarage, cleanVehicle } from "../garage.js";
import { createCarnet } from "../carnet.js";
import { createRappels, cleanRappel } from "../rappels.js";
import { createLocalStorage } from "../storage.js";
import { loadKnowledge } from "../knowledge.js";

const PASSWORD = "un mot de passe solide";
const TODAY = "2026-10-14";
const P208 = { marque: "Peugeot", modele: "208", motorisation: "1.2 PureTech 110", annee: 2017 };

describe("validation", () => {
  test("champs de rappel du véhicule, tous facultatifs", () => {
    const { data } = cleanVehicle({ ...P208, miseEnCirculation: "2017-05-12", assuranceEcheance: "2027-03-01", pneusHiver: true, vidangeKm: "10 000", vidangeMois: 12 });
    assert.deepEqual([data.miseEnCirculation, data.assuranceEcheance, data.pneusHiver, data.vidangeKm, data.vidangeMois], ["2017-05-12", "2027-03-01", true, 10000, 12]);
    const vide = cleanVehicle(P208).data;
    assert.deepEqual([vide.miseEnCirculation, vide.assuranceEcheance, vide.pneusHiver, vide.vidangeKm, vide.vidangeMois], [null, null, false, null, null]);
    assert.ok(cleanVehicle({ ...P208, miseEnCirculation: "2099-01-01" }).error, "mise en circulation dans le futur");
    assert.ok(cleanVehicle({ ...P208, vidangeKm: 500 }).error);
    assert.ok(cleanVehicle({ ...P208, vidangeMois: 48 }).error);
  });
  test("rappel libre : titre et date ou kilométrage", () => {
    assert.ok(cleanRappel({ titre: "Essuie-glaces" }).error);
    assert.ok(cleanRappel({ date: "2027-01-01" }).error);
    assert.deepEqual(cleanRappel({ titre: " Essuie-glaces ", date: "2027-01-01" }).data, { titre: "Essuie-glaces", date: "2027-01-01", km: null });
    assert.deepEqual(cleanRappel({ titre: "Géométrie", km: "60 000" }).data, { titre: "Géométrie", date: null, km: 60000 });
  });
});

test("migration : une base de l'étape 4 reçoit les nouvelles colonnes sans perdre ses voitures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retroviz-migration-"));
  const file = path.join(dir, "ancienne.db");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE vehicles (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, surnom TEXT NOT NULL DEFAULT '', marque TEXT NOT NULL, modele TEXT NOT NULL,
      motorisation TEXT NOT NULL DEFAULT '', annee INTEGER, boite TEXT NOT NULL DEFAULT '', fiche_id TEXT, fiche_refusee INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
    INSERT INTO users (id, email, password_hash) VALUES (1, 'a@exemple.fr', 'x');
    INSERT INTO vehicles (user_id, marque, modele) VALUES (1, 'Renault', 'Clio');`);
  old.close();
  const db = openDb(file);
  const row = db.prepare("SELECT * FROM vehicles").get();
  assert.equal(row.marque, "Renault");
  assert.equal(row.pneus_hiver, 0);
  assert.equal(row.mise_en_circulation, null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("API", () => {
  let server, base, db, dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "retroviz-rappels-"));
    db = openDb(":memory:");
    const kb = loadKnowledge();
    const carnet = createCarnet(db, createLocalStorage(dir), { log: () => {} });
    const rappels = createRappels(db, kb, { now: () => TODAY });
    const garage = createGarage(db, kb, { carnet, rappels });
    const app = express();
    app.use(express.json());
    app.use(createAuth(db, { exportData: garage.exportFor, beforeDeleteUser: carnet.beforeDeleteUser }));
    app.use(garage); app.use(carnet); app.use(rappels);
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://localhost:${server.address().port}`;
  });
  after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  async function newUser(email) {
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
    await c("POST", "/api/auth/signup", { email, password: PASSWORD });
    return c;
  }

  test("« À venir » : rappels, entretiens et pannes de la fiche, triés ; résumé et badge sur la carte", async () => {
    const c = await newUser("avenir1@exemple.fr");
    const v = (await c("POST", "/api/garage", { ...P208, miseEnCirculation: "2017-05-12", pneusHiver: true })).body.vehicule;
    assert.equal(v.miseEnCirculation, "2017-05-12");
    assert.equal(v.pneusHiver, true);
    await c("POST", `/api/garage/${v.id}/releves`, { date: "2026-01-14", km: 40000 });
    await c("POST", `/api/garage/${v.id}/releves`, { date: TODAY, km: 49000 });
    // Dernière vidange il y a 14 mois : en retard.
    await c("POST", `/api/garage/${v.id}/entretiens`, { date: "2025-08-01", type: "vidange", km: 30000, alimenterReleves: false });

    const av = (await c("GET", `/api/garage/${v.id}/avenir`)).body;
    assert.equal(av.kmAujourdhui, 49000);
    assert.equal(av.items[0].cle, "vidange");
    assert.equal(av.items[0].statut, "retard");
    assert.ok(av.items.some(it => it.cle === "ct"));
    assert.ok(av.items.some(it => it.cle === "pneus-hiver"));
    assert.ok(av.items.some(it => it.categorie === "entretien"), "entretiens de la fiche 208");
    assert.ok(av.items.some(it => it.categorie === "surveiller"), "pannes connues de la fiche 208");

    const card = (await c("GET", "/api/garage")).body.vehicules[0];
    assert.equal(card.avenir.enRetard, 1);
    assert.equal(card.avenir.plusUrgent.cle, "vidange");

    // C'est fait : une nouvelle vidange dans le carnet, plus rien en retard.
    await c("POST", `/api/garage/${v.id}/entretiens`, { date: TODAY, type: "vidange", km: 49000 });
    assert.equal((await c("GET", "/api/garage")).body.vehicules[0].avenir.enRetard, 0);
  });

  test("rappels libres : ajout, suppression, réservés au propriétaire, effacés avec la voiture, dans l'export", async () => {
    const a = await newUser("avenir2@exemple.fr"), b = await newUser("avenir3@exemple.fr");
    const vid = (await a("POST", "/api/garage", P208)).body.vehicule.id;
    assert.equal((await a("POST", `/api/garage/${vid}/rappels`, { titre: "Essuie-glaces" })).status, 400);
    const r = await a("POST", `/api/garage/${vid}/rappels`, { titre: "Essuie-glaces", date: "2026-10-01" });
    assert.equal(r.status, 201);
    const libre = r.body.items.find(it => it.categorie === "rappel" && it.titre === "Essuie-glaces");
    assert.equal(libre.statut, "retard");
    assert.deepEqual(libre.fait, { type: "autre", description: "Essuie-glaces" });

    assert.equal((await b("GET", `/api/garage/${vid}/avenir`)).status, 404);
    assert.equal((await b("POST", `/api/garage/${vid}/rappels`, { titre: "x", km: 1 })).status, 404);
    assert.equal((await b("DELETE", `/api/garage/${vid}/rappels/${libre.rappelId}`)).status, 404);

    const exp = (await a("GET", "/api/account/export")).body;
    assert.deepEqual(exp.vehicules[0].rappels, [{ titre: "Essuie-glaces", date: "2026-10-01", km: null }]);

    const del = await a("DELETE", `/api/garage/${vid}/rappels/${libre.rappelId}`);
    assert.ok(!del.body.items.some(it => it.titre === "Essuie-glaces"));
    await a("POST", `/api/garage/${vid}/rappels`, { titre: "Géométrie", km: 60000 });
    await a("DELETE", `/api/garage/${vid}`);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rappels WHERE vehicle_id = ?").get(vid).n, 0);
  });

  test("modifier la voiture conserve et met à jour les champs de rappel", async () => {
    const c = await newUser("avenir4@exemple.fr");
    const v = (await c("POST", "/api/garage", { ...P208, assuranceEcheance: "2026-11-01" })).body.vehicule;
    const put = (await c("PUT", `/api/garage/${v.id}`, { ...P208, assuranceEcheance: "2026-11-01", vidangeKm: 10000, vidangeMois: 6 })).body.vehicule;
    assert.equal(put.assuranceEcheance, "2026-11-01");
    assert.equal(put.vidangeKm, 10000);
    const av = (await c("GET", `/api/garage/${v.id}/avenir`)).body;
    assert.equal(av.items.find(it => it.cle === "assurance").statut, "bientot");
    assert.deepEqual(av.items.find(it => it.cle === "vidange").intervalle, { km: 10000, mois: 6, source: "vous" });
  });
});
