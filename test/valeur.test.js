// Tests de la valeur indicative (l'IA est simulée) : npm test
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { openDb } from "../db.js";
import { createAuth } from "../auth.js";
import { createGarage } from "../garage.js";
import { createCarnet } from "../carnet.js";
import { createValeur, validateEstimation, parseJson, buildInput, anthropicEstimator, SCHEMA } from "../valeur.js";
import { createLocalStorage } from "../storage.js";
import { loadKnowledge } from "../knowledge.js";

const PASSWORD = "un mot de passe solide";
const BON = { basse: 7800, haute: 9200, valeur_probable: 8500, explication: "Kilométrage moyen pour son âge.", facteurs: [{ facteur: "Distribution faite", effet: "plus" }, { facteur: "Moteur réputé fragile", effet: "moins" }], conseils: ["Rassemblez les factures."] };

describe("validation de la réponse de l'IA", () => {
  test("réponse correcte : acceptée et nettoyée", () => {
    const { data } = validateEstimation({ ...BON, basse: 7800.4, explication: "  ok  " });
    assert.equal(data.basse, 7800);
    assert.equal(data.explication, "ok");
  });
  test("réponses refusées", () => {
    const cas = {
      "fourchette inversée": { ...BON, basse: 9500 },
      "valeur probable hors fourchette": { ...BON, valeur_probable: 12000 },
      "nombre en texte": { ...BON, basse: "7800" },
      "valeur négative": { ...BON, basse: -1 },
      "valeur absurde": { ...BON, haute: 50_000_000 },
      "fourchette trop large": { ...BON, basse: 100, valeur_probable: 5000, haute: 9200 },
      "effet inconnu": { ...BON, facteurs: [{ facteur: "x", effet: "neutre" }] },
      "aucun facteur": { ...BON, facteurs: [] },
      "explication vide": { ...BON, explication: " " },
      "conseils absents": { ...BON, conseils: undefined },
    };
    for (const [nom, o] of Object.entries(cas)) assert.ok(validateEstimation(o).error, nom);
    assert.ok(validateEstimation(null).error);
  });
  test("lecture du JSON : brut, dans un bloc ```json, ou entouré de texte", () => {
    assert.deepEqual(parseJson(JSON.stringify(BON)), BON);
    assert.deepEqual(parseJson("```json\n" + JSON.stringify(BON) + "\n```"), BON);
    assert.deepEqual(parseJson("Voici : " + JSON.stringify(BON) + " Bonne vente !"), BON);
    assert.equal(parseJson("désolé, je ne peux pas"), null);
    assert.equal(parseJson("[1,2]"), null);
  });
});

describe("données envoyées à l'IA", () => {
  test("aucune donnée personnelle : ni surnom, ni garage, ni description du carnet", () => {
    const vehicle = { marque: "Peugeot", modele: "208", motorisation: "1.2 PureTech 110", boite: "manuelle", annee: 2017, mise_en_circulation: "2017-05-12", surnom: "La voiture de Martine", user_id: 42 };
    const releves = [{ date: "2025-10-14", km: 70000 }, { date: "2026-10-14", km: 82000 }];
    const entretiens = [
      { type: "distribution", date: "2026-02-01", km: 78000, facture_key: "x.pdf", garage: "Garage Dupont", description: "Payé par Jean Martin, 06 12 34 56 78" },
      { type: "autre", date: "2026-03-01", km: 79000, facture_key: null, garage: "", description: "Lavage" },
    ];
    const input = buildInput(vehicle, releves, entretiens);
    const json = JSON.stringify(input);
    for (const prive of ["Martine", "Dupont", "Jean Martin", "06 12", "user_id", "42", "Lavage"]) assert.ok(!json.includes(prive), prive);
    assert.deepEqual(input.kilometrage, { km: 82000, releve_le: "2026-10-14" });
    assert.equal(input.moyenne_km_par_mois, 1001); // 12 000 km en 365 jours
    assert.deepEqual(input.carnet, { nombre_entretiens: 2, avec_facture: 1, entretiens_importants: [{ type: "Distribution", date: "2026-02-01", km: 78000, facture: true }] });
  });
  test("appel à l'API : schéma JSON imposé, texte relu, refus signalé", async () => {
    let params = null;
    const fakeClient = { beta: { messages: { create: async p => { params = p; return { model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(BON) }] }; } } } };
    const r = await anthropicEstimator(fakeClient, "claude-sonnet-5-5")({ marque: "Peugeot" });
    assert.deepEqual(JSON.parse(r.text), BON);
    assert.equal(params.model, "claude-sonnet-5-5");
    assert.deepEqual(params.output_config.format, { type: "json_schema", schema: SCHEMA });
    assert.match(params.messages[0].content, /"marque": "Peugeot"/);
    const refus = { beta: { messages: { create: async () => ({ stop_reason: "refusal", content: [] }) } } };
    await assert.rejects(anthropicEstimator(refus, "m")({}), /refus/);
  });
});

describe("API /api/garage/:id/valeur", () => {
  let server, base, db, dir, jour = "2026-10-14";
  const ia = { appels: 0, reponse: () => JSON.stringify(BON), delai: 0, erreur: null };
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "retroviz-valeur-"));
    db = openDb(":memory:");
    const kb = loadKnowledge();
    const carnet = createCarnet(db, createLocalStorage(dir), { log: () => {} });
    const estimate = async () => {
      ia.appels++;
      if (ia.delai) await new Promise(r => setTimeout(r, ia.delai));
      if (ia.erreur) throw ia.erreur;
      return { text: ia.reponse(), model: "faux-modele" };
    };
    const valeur = createValeur(db, { estimate, now: () => jour, log: () => {} });
    const garage = createGarage(db, kb, { carnet, valeur });
    const app = express();
    app.use(express.json());
    app.use(createAuth(db, { exportData: garage.exportFor, beforeDeleteUser: carnet.beforeDeleteUser }));
    app.use(garage); app.use(carnet); app.use(valeur);
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://localhost:${server.address().port}`;
  });
  after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  async function newUser(email) {
    let cookie = "";
    const c = async (method, p, body) => {
      if (method === "POST" && body === undefined) body = {}; // la page envoie toujours du JSON (protection CSRF)
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
  const reset = () => { ia.appels = 0; ia.reponse = () => JSON.stringify(BON); ia.delai = 0; ia.erreur = null; jour = "2026-10-14"; };

  test("une estimation par jour ; sinon la dernière est réaffichée sans appeler l'IA ; historique", async () => {
    reset();
    const c = await newUser("valeur1@exemple.fr");
    const vid = (await c("POST", "/api/garage", { marque: "Peugeot", modele: "208" })).body.vehicule.id;
    await c("POST", `/api/garage/${vid}/releves`, { date: "2026-10-01", km: 82000 });
    const vide = (await c("GET", `/api/garage/${vid}/valeur`)).body;
    assert.deepEqual([vide.estimations.length, vide.derniere, vide.peutEstimer], [0, null, true]);

    const r1 = await c("POST", `/api/garage/${vid}/valeur`);
    assert.equal(r1.status, 201);
    assert.equal(r1.body.derniere.valeurProbable, 8500);
    assert.equal(r1.body.derniere.km, 82000, "kilométrage du moment");
    assert.equal(r1.body.derniere.date, "2026-10-14");
    assert.equal(r1.body.peutEstimer, false);

    const r2 = await c("POST", `/api/garage/${vid}/valeur`);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.dejaFaiteAujourdhui, true);
    assert.equal(r2.body.estimations.length, 1);
    assert.equal(ia.appels, 1, "l'IA n'est pas rappelée le même jour");

    // Le lendemain, avec plus de kilomètres : deuxième point de l'historique.
    jour = "2026-10-15";
    await c("POST", `/api/garage/${vid}/releves`, { date: "2026-10-14", km: 82500 });
    ia.reponse = () => JSON.stringify({ ...BON, basse: 7600, valeur_probable: 8300 });
    const r3 = await c("POST", `/api/garage/${vid}/valeur`);
    assert.equal(r3.status, 201);
    assert.deepEqual(r3.body.estimations.map(e => [e.date, e.km, e.valeurProbable]), [["2026-10-14", 82000, 8500], ["2026-10-15", 82500, 8300]]);
    assert.equal((await c("GET", "/api/garage")).body.vehicules[0].valeur.valeurProbable, 8300, "dernière estimation sur la carte");
  });

  test("réponse invalide : erreur claire, rien d'enregistré, nouvel essai possible", async () => {
    reset();
    const c = await newUser("valeur2@exemple.fr");
    const vid = (await c("POST", "/api/garage", { marque: "Renault", modele: "Clio" })).body.vehicule.id;
    for (const mauvaise of ["pas du JSON", JSON.stringify({ ...BON, basse: 99999 }), JSON.stringify({ basse: 1 })]) {
      ia.reponse = () => mauvaise;
      const r = await c("POST", `/api/garage/${vid}/valeur`);
      assert.equal(r.status, 502);
      assert.equal(r.body.code, "invalid_estimation");
      assert.match(r.body.error, /Rien n'a été enregistré/);
    }
    const apres = (await c("GET", `/api/garage/${vid}/valeur`)).body;
    assert.equal(apres.estimations.length, 0);
    assert.equal(apres.peutEstimer, true);
    ia.erreur = Object.assign(new Error("trop de requêtes"), { status: 429 });
    assert.equal((await c("POST", `/api/garage/${vid}/valeur`)).status, 429);
    ia.erreur = Object.assign(new Error("panne"), { status: 500 });
    assert.equal((await c("POST", `/api/garage/${vid}/valeur`)).body.code, "upstream_error");
    assert.equal((await c("GET", `/api/garage/${vid}/valeur`)).body.estimations.length, 0);
  });

  test("deux demandes simultanées : un seul appel à l'IA", async () => {
    reset();
    const c = await newUser("valeur3@exemple.fr");
    const vid = (await c("POST", "/api/garage", { marque: "Dacia", modele: "Sandero" })).body.vehicule.id;
    ia.delai = 150;
    const [a, b] = await Promise.all([c("POST", `/api/garage/${vid}/valeur`), c("POST", `/api/garage/${vid}/valeur`)]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(ia.appels, 1);
  });

  test("autorisations : un utilisateur ne voit ni ne lance les estimations d'un autre", async () => {
    reset();
    const a = await newUser("valeur-proprio@exemple.fr"), b = await newUser("valeur-voisin@exemple.fr");
    const vid = (await a("POST", "/api/garage", { marque: "Peugeot", modele: "308" })).body.vehicule.id;
    await a("POST", `/api/garage/${vid}/valeur`);
    ia.appels = 0;
    assert.equal((await b("GET", `/api/garage/${vid}/valeur`)).status, 404);
    assert.equal((await b("POST", `/api/garage/${vid}/valeur`)).status, 404);
    assert.equal(ia.appels, 0);
    assert.equal((await fetch(`${base}/api/garage/${vid}/valeur`)).status, 401);
    assert.ok(!JSON.stringify((await b("GET", "/api/account/export")).body).includes("8500"));
  });

  test("RGPD : dans l'export, effacées avec la voiture et avec le compte", async () => {
    reset();
    const c = await newUser("valeur4@exemple.fr");
    const v1 = (await c("POST", "/api/garage", { marque: "Peugeot", modele: "208" })).body.vehicule.id;
    const v2 = (await c("POST", "/api/garage", { marque: "Renault", modele: "Clio" })).body.vehicule.id;
    await c("POST", `/api/garage/${v1}/valeur`);
    await c("POST", `/api/garage/${v2}/valeur`);
    const exp = (await c("GET", "/api/account/export")).body;
    assert.equal(exp.vehicules[0].estimations[0].valeurProbable, 8500);
    const n = vid => db.prepare("SELECT COUNT(*) AS n FROM estimations WHERE vehicle_id = ?").get(vid).n;
    await c("DELETE", `/api/garage/${v1}`);
    assert.equal(n(v1), 0, "avec la voiture");
    await c("DELETE", "/api/account", { password: PASSWORD });
    assert.equal(n(v2), 0, "avec le compte");
  });

  test("sans clé API sur le serveur : message clair", async () => {
    const db2 = openDb(":memory:");
    const v = createValeur(db2, { estimate: null });
    const app = express();
    app.use(express.json());
    app.use(createAuth(db2));
    app.use(createGarage(db2, loadKnowledge()));
    app.use(v);
    const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    try {
      const url = `http://localhost:${srv.address().port}`;
      const res = await fetch(`${url}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "x@exemple.fr", password: PASSWORD }) });
      const cookie = res.headers.get("set-cookie").split(";")[0];
      const H = { "Content-Type": "application/json", Cookie: cookie };
      const vid = (await (await fetch(`${url}/api/garage`, { method: "POST", headers: H, body: JSON.stringify({ marque: "A", modele: "B" }) })).json()).vehicule.id;
      const r = await fetch(`${url}/api/garage/${vid}/valeur`, { method: "POST", headers: H, body: "{}" });
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /clé API/);
    } finally {
      srv.close();
    }
  });
});
