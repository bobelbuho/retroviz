// Tests du badge « Voiture bien suivie » : npm test
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { evaluerBadge } from "../badge.js";
import { createBadge } from "../badge.js";
import { computeAvenir } from "../avenir.js";
import { energieDe } from "../energie.js";
import { stats } from "../kilometrage.js";
import { openDb } from "../db.js";
import { createAuth } from "../auth.js";
import { createGarage } from "../garage.js";
import { createCarnet } from "../carnet.js";
import { createRappels } from "../rappels.js";
import { createLocalStorage } from "../storage.js";
import { loadKnowledge } from "../knowledge.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TODAY = "2026-10-14";
const VOITURE = { id: 1, marque: "Peugeot", modele: "208", motorisation: "1.2 PureTech 110", achat_date: "2025-06-01", mise_en_circulation: "2022-11-01", pneus_hiver: 0, created_at: "2025-06-02T00:00:00Z" };
const RELEVES = [{ date: "2025-06-01", km: 78000 }, { date: "2025-12-01", km: 85000 }, { date: "2026-04-01", km: 88000 }, { date: "2026-10-01", km: 94000 }];
const ENTRETIENS = [
  { date: "2025-10-01", km: 80000, type: "vidange", facture_key: "a.pdf", description: "" },
  { date: "2026-08-01", km: 92000, type: "vidange", facture_key: "b.pdf", description: "" },
];
const evaluer = ({ v = VOITURE, releves = RELEVES, entretiens = ENTRETIENS, today = TODAY } = {}) => {
  const avenir = computeAvenir({ vehicle: v, releves, entretiens, kilometrage: stats(releves), today });
  return evaluerBadge({ vehicule: v, releves, entretiens, avenir, aujourdhui: today });
};
const critere = (r, id) => r.criteres.find(c => c.id === id);

describe("critères", () => {
  test("voiture bien suivie : les 5 critères remplis", () => {
    const r = evaluer();
    assert.deepEqual(r.criteres.map(c => [c.id, c.ok]), [["historique", true], ["releves", true], ["vidanges", true], ["a_jour", true], ["preuves", true]]);
    assert.equal(r.obtenu, true);
    assert.equal(r.manquants, 0);
  });

  test("historique : depuis la plus ancienne date connue, y compris un entretien plus ancien que l'achat", () => {
    const recente = { ...VOITURE, achat_date: "2026-03-01" };
    assert.equal(critere(evaluer({ v: recente, releves: [{ date: "2026-03-01", km: 86000 }] , entretiens: [] }), "historique").ok, false);
    const avecAncien = evaluer({ v: recente, releves: [{ date: "2026-03-01", km: 86000 }], entretiens: [{ date: "2024-05-10", km: 60000, type: "freins", facture_key: "x.pdf" }] });
    assert.equal(critere(avecAncien, "historique").ok, true, "historique reçu d'un ancien propriétaire");
    assert.match(critere(avecAncien, "historique").detail, /10 mai 2024/);
  });

  test("relevés : 3 sur 12 mois, jamais plus de 6 mois sans relevé ; les km des entretiens comptent", () => {
    const peu = evaluer({ releves: [{ date: "2026-04-01", km: 88000 }], entretiens: [] });
    assert.equal(critere(peu, "releves").ok, false);
    assert.match(critere(peu, "releves").aide, /il en manque 2/);
    const vieux = evaluer({ releves: [{ date: "2025-11-01", km: 84000 }, { date: "2025-12-01", km: 85000 }, { date: "2026-01-15", km: 86000 }], entretiens: [] });
    assert.equal(critere(vieux, "releves").ok, false, "dernier relevé il y a 9 mois");
    assert.match(critere(vieux, "releves").aide, /le dernier date de 9 mois/);
    const avecEntretiens = evaluer({ releves: [{ date: "2026-04-01", km: 88000 }] });
    assert.equal(critere(avecEntretiens, "releves").ok, false, "1 relevé + la vidange d'août = 2 points sur 12 mois (celle d'octobre 2025 est trop ancienne)");
  });

  test("vidanges : seules les 2 dernières comptent (+10 %)", () => {
    const ancienneEnRetard = [{ date: "2019-01-01", km: 20000, type: "vidange", facture_key: "a" }, { date: "2022-01-01", km: 60000, type: "vidange", facture_key: "b" }, ...ENTRETIENS];
    assert.equal(critere(evaluer({ entretiens: ancienneEnRetard }), "vidanges").ok, true, "une vieille vidange en retard ne compte plus");
    const ecartTropGrand = [{ date: "2025-01-01", km: 70000, type: "vidange", facture_key: "a" }, { date: "2026-08-01", km: 92000, type: "vidange", facture_key: "b" }];
    const r = critere(evaluer({ entretiens: ecartTropGrand }), "vidanges");
    assert.equal(r.ok, false);
    assert.match(r.detail, /19 mois/);
    assert.match(r.aide, /2 vidanges faites à temps/);
    assert.equal(critere(evaluer({ entretiens: [] }), "vidanges").ok, false);
    assert.equal(critere(evaluer({ entretiens: [ENTRETIENS[1]] }), "vidanges").ok, true, "une seule vidange notée");
  });

  test("rien en retard : un contrôle technique dépassé fait perdre le critère", () => {
    const r = evaluer({ v: { ...VOITURE, mise_en_circulation: "2015-06-01", dernier_ct: "2024-09-01" } });
    assert.equal(critere(r, "a_jour").ok, false);
    assert.match(critere(r, "a_jour").aide, /Contrôle technique/);
  });

  test("preuves : facture = 1 point, sans facture = 0,5 ; ce qu'il faut ajouter", () => {
    const sans = ENTRETIENS.map(e => ({ ...e, facture_key: null })).concat([{ date: "2026-02-01", km: 86000, type: "pneus", facture_key: null }, { date: "2026-03-01", km: 87000, type: "freins", facture_key: null }]);
    const r = critere(evaluer({ entretiens: sans }), "preuves");
    assert.equal(r.ok, false);
    assert.match(r.detail, /score de preuve 50 %/);
    assert.match(r.aide, /la facture de 2 entretiens/);
    const deuxSurTrois = [...ENTRETIENS, { date: "2026-02-01", km: 86000, type: "pneus", facture_key: null }];
    assert.equal(critere(evaluer({ entretiens: deuxSurTrois }), "preuves").ok, true, "(2 + 0,5) / 3 = 83 %");
  });
});

describe("électrique et hybrides", () => {
  test("déduction de l'énergie", () => {
    assert.equal(energieDe({ modele: "e-208", motorisation: "136 ch 50 kWh" }), "electrique");
    assert.equal(energieDe({ modele: "Yaris", motorisation: "1.5 Hybrid 116" }), "hybride");
    assert.equal(energieDe({ modele: "308", motorisation: "Hybrid 180 PHEV" }), "hybride_rechargeable");
    assert.equal(energieDe({ modele: "208", motorisation: "1.2 PureTech", energie: "electrique" }), "electrique", "le champ saisi l'emporte");
  });
  test("électrique : pas de vidange (ni dans « À venir », ni dans le badge), remplacée par les entretiens de la fiche", () => {
    const ev = { ...VOITURE, modele: "e-208", motorisation: "136 ch 50 kWh" };
    const r = evaluer({ v: ev, entretiens: [{ date: "2025-10-01", km: 80000, type: "freins", facture_key: "a" }, { date: "2026-08-01", km: 92000, type: "pneus", facture_key: "b" }] });
    assert.ok(!r.criteres.some(c => c.id === "vidanges"));
    assert.equal(critere(r, "entretiens_fiche").ok, true);
    assert.equal(r.obtenu, true);
    assert.ok(!computeAvenir({ vehicle: ev, today: TODAY }).items.some(it => it.cle === "vidange"));
  });
  test("hybride et hybride rechargeable : gardent le critère vidange (moteur thermique)", () => {
    for (const energie of ["hybride", "hybride_rechargeable"]) {
      const r = evaluer({ v: { ...VOITURE, energie } });
      assert.ok(r.criteres.some(c => c.id === "vidanges"), energie);
      assert.ok(computeAvenir({ vehicle: { ...VOITURE, energie }, today: TODAY }).items.some(it => it.cle === "vidange"), energie);
    }
  });
});

describe("gain et perte du badge (API)", () => {
  let server, base, jour = TODAY, dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "retroviz-badge-"));
    const db = openDb(":memory:"), kb = loadKnowledge();
    const rappels = createRappels(db, kb, { now: () => jour });
    const badge = createBadge(db, { rappels, now: () => jour });
    const carnet = createCarnet(db, createLocalStorage(dir), { log: () => {} });
    const garage = createGarage(db, kb, { carnet, rappels, badge });
    const app = express();
    app.use(express.json());
    app.use(createAuth(db)); app.use(garage); app.use(carnet); app.use(rappels); app.use(badge);
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://localhost:${server.address().port}`;
  });
  after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test("obtenu, puis perdu (avec la date et la raison), puis récupéré", async () => {
    let cookie = "";
    const c = async (method, p, body, raw) => {
      const res = await fetch(base + p, { method, headers: { "Content-Type": raw ? "application/octet-stream" : "application/json", ...(cookie && { Cookie: cookie }) }, body: raw || (body ? JSON.stringify(body) : method === "GET" ? undefined : "{}") });
      const set = res.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
      return { status: res.status, body: await res.json() };
    };
    await c("POST", "/api/auth/signup", { email: "badge@exemple.fr", password: "un mot de passe solide" });
    const vid = (await c("POST", "/api/garage", { marque: "Peugeot", modele: "208", motorisation: "1.2 PureTech 110", achatDate: "2025-06-01", miseEnCirculation: "2022-11-01", dernierCt: "2025-01-15" })).body.vehicule.id;
    for (const r of RELEVES) await c("POST", `/api/garage/${vid}/releves`, r);
    for (const e of ENTRETIENS) {
      const eid = (await c("POST", `/api/garage/${vid}/entretiens`, { date: e.date, km: e.km, type: e.type, alimenterReleves: false })).body.entretien.id;
      await c("PUT", `/api/garage/${vid}/entretiens/${eid}/facture`, null, Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64)]));
    }
    let b = (await c("GET", `/api/garage/${vid}/badge`)).body;
    assert.equal(b.obtenu, true);
    assert.equal(b.depuis, TODAY);
    assert.match(b.avertissement, /informations saisies par le propriétaire/);
    assert.deepEqual((await c("GET", "/api/garage")).body.vehicules[0].badge, { obtenu: true, manquants: 0, perduLe: null });

    jour = "2027-02-01"; // le contrôle technique (dû le 15 janvier 2027) est maintenant en retard
    b = (await c("GET", `/api/garage/${vid}/badge`)).body;
    assert.equal(b.obtenu, false);
    assert.equal(b.perduLe, "2027-02-01");
    const manque = b.criteres.filter(x => !x.ok);
    assert.deepEqual(manque.map(x => x.id), ["a_jour"]);
    assert.match(manque[0].detail, /Contrôle technique/);
    assert.ok(manque.every(x => x.aide), "chaque critère manquant dit comment le récupérer");
    assert.equal((await c("GET", "/api/garage")).body.vehicules[0].badge.perduLe, "2027-02-01");

    // Le propriétaire indique son dernier contrôle technique : le badge revient.
    await c("PUT", `/api/garage/${vid}`, { marque: "Peugeot", modele: "208", motorisation: "1.2 PureTech 110", achatDate: "2025-06-01", miseEnCirculation: "2022-11-01", dernierCt: "2026-10-10" });
    b = (await c("GET", `/api/garage/${vid}/badge`)).body;
    assert.equal(b.obtenu, true, JSON.stringify(b.criteres.filter(x => !x.ok)));
    assert.equal(b.perduLe, null);
  });
});
