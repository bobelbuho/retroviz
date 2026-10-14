// Tests de « Mon garage » : npm test
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { openDb } from "../db.js";
import { createAuth } from "../auth.js";
import { createGarage, cleanVehicle, matchFiche, designation, MAX_VEHICLES } from "../garage.js";
import { loadKnowledge } from "../knowledge.js";

const kb = loadKnowledge();
const PASSWORD = "un mot de passe solide";
const CLIO = { marque: "Renault", modele: "Clio IV", motorisation: "1.5 dCi 90", annee: 2016, boite: "Manuelle" };

let server, base, db;
before(async () => {
  db = openDb(":memory:");
  const garage = createGarage(db, kb);
  const app = express();
  app.use(express.json());
  app.use(createAuth(db, { exportData: garage.exportFor }));
  app.use(garage);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

// Client qui garde son cookie de session, comme un navigateur.
function client() {
  let cookie = "";
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json() };
  };
}
async function newUser(email) {
  const c = client();
  assert.equal((await c("POST", "/api/auth/signup", { email, password: PASSWORD })).status, 201);
  return c;
}

describe("validation", () => {
  test("marque et modèle obligatoires, espaces nettoyés, boîte en minuscules", () => {
    assert.ok(cleanVehicle({ marque: "Renault" }).error);
    const { data } = cleanVehicle({ marque: "  Renault ", modele: "Clio   IV", boite: "Automatique" });
    assert.equal(data.marque, "Renault");
    assert.equal(data.modele, "Clio IV");
    assert.equal(data.boite, "automatique");
    assert.equal(data.annee, null);
  });
  test("année et boîte contrôlées", () => {
    assert.ok(cleanVehicle({ ...CLIO, annee: 1850 }).error);
    assert.ok(cleanVehicle({ ...CLIO, annee: "deux mille" }).error);
    assert.ok(cleanVehicle({ ...CLIO, annee: 2031 }, 2026).error);
    assert.equal(cleanVehicle({ ...CLIO, annee: "2027" }, 2026).data.annee, 2027);
    assert.ok(cleanVehicle({ ...CLIO, boite: "robotisée" }).error);
  });
  test("désignation pour l'assistant", () => {
    assert.equal(designation({ ...CLIO, boite: "manuelle" }), "Renault Clio IV 1.5 dCi 90, 2016, boîte manuelle");
  });
});

describe("lien avec une fiche Rétroviz", () => {
  test("modèle et moteur connus : fiche reliée", () => {
    assert.equal(matchFiche({ ...CLIO }, kb), "renault-clio-4-15-dci");
    assert.equal(matchFiche({ marque: "Peugeot", modele: "208", motorisation: "1.2 puretech 110" }, kb), "peugeot-208-1-12-puretech");
  });
  test("moteur inconnu ou absent : pas de fiche", () => {
    assert.equal(matchFiche({ marque: "Peugeot", modele: "208", motorisation: "1.6 BlueHDi" }, kb), null);
    assert.equal(matchFiche({ marque: "Peugeot", modele: "208", motorisation: "" }, kb), null);
  });
  test("année hors de la période de la fiche : pas de fiche", () => {
    assert.equal(matchFiche({ ...CLIO, annee: 2008 }, kb), null);
  });
  test("autre modèle avec le même moteur : pas de fiche", () => {
    assert.equal(matchFiche({ marque: "Peugeot", modele: "308", motorisation: "1.2 PureTech 130" }, kb), null);
  });
});

describe("API /api/garage", () => {
  test("connexion obligatoire", async () => {
    assert.equal((await client()("GET", "/api/garage")).status, 401);
  });

  test("ajouter, lister, modifier, supprimer", async () => {
    const c = await newUser("garage@exemple.fr");
    const add = await c("POST", "/api/garage", { ...CLIO, surnom: "La grise" });
    assert.equal(add.status, 201);
    const v = add.body.vehicule;
    assert.equal(v.surnom, "La grise");
    assert.equal(v.fiche.id, "renault-clio-4-15-dci");
    assert.equal(v.fiche.statut, "a_verifier");

    const list = await c("GET", "/api/garage");
    assert.deepEqual(list.body.vehicules.map(x => x.id), [v.id]);

    // « Ce n'est pas ma voiture » : la fiche est retirée et ne revient pas à la modification suivante.
    const refuse = await c("PUT", `/api/garage/${v.id}`, { ...CLIO, ficheRefusee: true });
    assert.equal(refuse.body.vehicule.fiche, null);
    assert.equal(refuse.body.vehicule.ficheRefusee, true);
    const edit = await c("PUT", `/api/garage/${v.id}`, { ...CLIO, annee: 2017, ficheRefusee: true });
    assert.equal(edit.body.vehicule.annee, 2017);
    assert.equal(edit.body.vehicule.fiche, null);
    const relink = await c("PUT", `/api/garage/${v.id}`, { ...CLIO });
    assert.equal(relink.body.vehicule.fiche.id, "renault-clio-4-15-dci");

    assert.equal((await c("PUT", `/api/garage/${v.id}`, { marque: "Renault" })).status, 400);
    assert.equal((await c("DELETE", `/api/garage/${v.id}`)).status, 200);
    assert.equal((await c("GET", "/api/garage")).body.vehicules.length, 0);
    assert.equal((await c("DELETE", `/api/garage/${v.id}`)).status, 404);
  });

  test("chacun ne voit et ne modifie que ses voitures", async () => {
    const a = await newUser("proprio@exemple.fr"), b = await newUser("voisin@exemple.fr");
    const { id } = (await a("POST", "/api/garage", CLIO)).body.vehicule;
    assert.equal((await b("GET", "/api/garage")).body.vehicules.length, 0);
    assert.equal((await b("PUT", `/api/garage/${id}`, CLIO)).status, 404);
    assert.equal((await b("DELETE", `/api/garage/${id}`)).status, 404);
    assert.equal((await a("GET", "/api/garage")).body.vehicules.length, 1);
  });

  test(`garage limité à ${MAX_VEHICLES} voitures`, async () => {
    const c = await newUser("collection@exemple.fr");
    for (let i = 0; i < MAX_VEHICLES; i++) assert.equal((await c("POST", "/api/garage", CLIO)).status, 201);
    assert.equal((await c("POST", "/api/garage", CLIO)).body.code, "garage_full");
  });

  test("export RGPD et suppression du compte incluent le garage", async () => {
    const c = await newUser("export@exemple.fr");
    await c("POST", "/api/garage", CLIO);
    const exp = await c("GET", "/api/account/export");
    assert.equal(exp.body.vehicules.length, 1);
    assert.equal(exp.body.vehicules[0].modele, "Clio IV");

    const userId = db.prepare("SELECT id FROM users WHERE email = ?").get("export@exemple.fr").id;
    assert.equal((await c("DELETE", "/api/account", { password: PASSWORD })).status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ?").get(userId).n, 0);
  });
});
