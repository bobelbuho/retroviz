// Tests de la page de vie d'une voiture et de sa photo : npm test
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { openDb } from "../db.js";
import { createAuth } from "../auth.js";
import { createGarage, cleanVehicle } from "../garage.js";
import { createCarnet } from "../carnet.js";
import { createVie, construireVie } from "../vie.js";
import { createLocalStorage } from "../storage.js";
import { loadKnowledge } from "../knowledge.js";

const PASSWORD = "un mot de passe solide";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(64)]);

describe("construireVie", () => {
  const v = { id: 7, created_at: "2024-03-10T09:00:00.000Z", achat_date: "2023-11-02", achat_km: 92000 };
  const releves = [{ date: "2023-11-02", km: 92000 }, { date: "2024-06-01", km: 98500 }, { date: "2025-02-01", km: 104000 }];
  const entretiens = [
    { id: 1, date: "2024-01-15", type: "vidange", km: 95000, cout_centimes: 12000, facture_key: "a.pdf", garage: "Garage Martin" },
    { id: 2, date: "2024-09-20", type: "pneus", km: 101000, cout_centimes: 42000, facture_key: null, garage: "" },
    { id: 3, date: "2022-05-01", type: "freins", km: 80000, cout_centimes: 30000, facture_key: null, garage: "" }, // avant l'achat
  ];
  const vie = construireVie({ vehicule: v, releves, entretiens, estimations: [{ date: "2025-01-10", km: 103000, basse: 7000, haute: 8500, valeur_probable: 7800 }], aujourdhui: "2026-10-14" });

  test("frise : tous les événements, du plus récent au plus ancien, avec le niveau de preuve", () => {
    const dates = vie.evenements.map(e => e.date);
    assert.deepEqual(dates, [...dates].sort().reverse());
    const types = new Set(vie.evenements.map(e => e.type));
    for (const t of ["achat", "ajout", "releve", "entretien", "valeur", "jalon"]) assert.ok(types.has(t), t);
    const vidange = vie.evenements.find(e => e.entretienId === 1);
    assert.equal(vidange.preuve, "facture");
    assert.equal(vidange.facture, "/api/garage/7/entretiens/1/facture");
    assert.equal(vie.evenements.find(e => e.entretienId === 2).preuve, "declare");
  });

  test("étapes marquantes : paliers franchis avec vous et anniversaires", () => {
    const titres = vie.jalons.map(j => `${j.date} ${j.titre}`);
    // Premier km connu au-delà de 100 000 : l'entretien pneus à 101 000 km (séparateur des milliers : espace fine).
    assert.ok(titres.some(t => /^2024-09-20 100\s000 km atteints$/.test(t)), titres.join(" | "));
    assert.ok(!titres.some(t => /50\s000 km/.test(t)), "50 000 km déjà dépassés à l'achat");
    assert.ok(titres.includes("2024-11-02 1 an avec vous"));
    assert.ok(titres.includes("2025-11-02 2 ans avec vous"));
    assert.ok(!titres.some(t => t.includes("3 ans")), "pas d'anniversaire futur");
  });

  test("chiffres clés depuis l'achat (les entretiens d'avant l'achat ne comptent pas)", () => {
    assert.equal(vie.chiffres.depuis, "2023-11-02");
    assert.equal(vie.chiffres.kmParcourus, 12000);
    assert.equal(vie.chiffres.totalDepense, 540);
    assert.equal(vie.chiffres.entretiens, 2);
    assert.equal(vie.chiffres.avecFacture, 1);
    assert.equal(vie.chiffres.coutParKm, 0.045);
    assert.ok(vie.chiffres.coutParMois > 15 && vie.chiffres.coutParMois < 16, String(vie.chiffres.coutParMois)); // 540 € sur ~35 mois
  });

  test("voiture sans achat ni relevé : départ à l'ajout, pas de km ni de coût par km", () => {
    const vide = construireVie({ vehicule: { id: 1, created_at: "2026-10-01T00:00:00Z" }, aujourdhui: "2026-10-14" });
    assert.equal(vide.debut.source, "ajout");
    assert.equal(vide.chiffres.kmParcourus, null);
    assert.equal(vide.chiffres.coutParKm, null);
    assert.equal(vide.evenements.length, 1);
  });

  test("date et kilométrage d'achat : facultatifs et contrôlés", () => {
    const base = { marque: "Peugeot", modele: "208" };
    assert.equal(cleanVehicle({ ...base, achatDate: "2023-11-02", achatKm: "92 000" }).data.achatKm, 92000);
    assert.ok(cleanVehicle({ ...base, achatDate: "2099-01-01" }).error);
    assert.ok(cleanVehicle({ ...base, achatKm: "beaucoup" }).error);
  });
});

describe("API : page de vie et photo", () => {
  let server, base, dir, db;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "retroviz-vie-"));
    db = openDb(":memory:");
    const storage = createLocalStorage(dir);
    const carnet = createCarnet(db, storage, { log: () => {} });
    const garage = createGarage(db, loadKnowledge(), { carnet, storage, log: () => {} });
    const beforeDeleteUser = uid => { const a = carnet.beforeDeleteUser(uid), b = garage.beforeDeleteUser(uid); return async () => { await a(); await b(); }; };
    const app = express();
    app.use(express.json());
    app.use(createAuth(db, { exportData: garage.exportFor, beforeDeleteUser }));
    app.use(garage); app.use(carnet); app.use(createVie(db, { now: () => "2026-10-14" }));
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://localhost:${server.address().port}`;
  });
  after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const fichiers = () => fs.readdirSync(dir);

  async function user(email) {
    let cookie = "";
    const c = async (method, p, body, raw) => {
      const res = await fetch(base + p, {
        method,
        headers: { ...(raw ? { "Content-Type": "application/octet-stream" } : body !== undefined && { "Content-Type": "application/json" }), ...(cookie && { Cookie: cookie }) },
        body: raw || (body === undefined ? undefined : JSON.stringify(body)),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      const type = res.headers.get("content-type") || "";
      return { status: res.status, headers: res.headers, body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    await c("POST", "/api/auth/signup", { email, password: PASSWORD });
    return c;
  }

  test("page de vie : réservée au propriétaire, avec les chiffres clés", async () => {
    const a = await user("vie1@exemple.fr"), b = await user("vie2@exemple.fr");
    const vid = (await a("POST", "/api/garage", { marque: "Peugeot", modele: "208", achatDate: "2025-01-10", achatKm: 40000, km: 52000 })).body.vehicule.id;
    await a("POST", `/api/garage/${vid}/entretiens`, { date: "2025-06-01", type: "vidange", km: 46000, cout: "120" });
    const vie = (await a("GET", `/api/garage/${vid}/vie`)).body;
    assert.equal(vie.chiffres.kmParcourus, 12000);
    assert.equal(vie.chiffres.totalDepense, 120);
    assert.ok(vie.evenements.some(e => e.type === "achat"));
    assert.equal((await b("GET", `/api/garage/${vid}/vie`)).status, 404);
  });

  test("photo : vrai type vérifié, JPEG/PNG/WebP seulement, propriétaire seul, effacée avec la voiture et le compte", async () => {
    const a = await user("photo1@exemple.fr"), b = await user("photo2@exemple.fr");
    const vid = (await a("POST", "/api/garage", { marque: "Renault", modele: "Clio" })).body.vehicule.id;
    const url = `/api/garage/${vid}/photo`;
    assert.equal((await a("PUT", url, undefined, PDF)).status, 415);
    assert.equal((await a("PUT", url, undefined, HEIC)).status, 415);
    assert.equal((await a("PUT", url, undefined, Buffer.from("du texte qui se dit .jpg"))).status, 415);
    const up = await a("PUT", url, undefined, PNG);
    assert.equal(up.status, 200);
    assert.match(up.body.vehicule.photo.url, new RegExp(`^/api/garage/${vid}/photo\\?v=`));
    const get = await a("GET", url);
    assert.equal(get.headers.get("content-type"), "image/png");
    assert.deepEqual(get.body, PNG);
    assert.equal((await b("GET", url)).status, 404);
    assert.equal((await b("PUT", url, undefined, PNG)).status, 404);
    // Remplacer la photo efface l'ancienne.
    const avant = fichiers().length;
    await a("PUT", url, undefined, PNG);
    assert.equal(fichiers().length, avant);
    // Avec la voiture.
    await a("DELETE", `/api/garage/${vid}`);
    assert.equal(fichiers().length, avant - 1);
    // Avec le compte.
    const vid2 = (await a("POST", "/api/garage", { marque: "Renault", modele: "Clio" })).body.vehicule.id;
    await a("PUT", `/api/garage/${vid2}/photo`, undefined, PNG);
    assert.equal(fichiers().length, avant);
    await a("DELETE", "/api/account", { password: PASSWORD });
    assert.equal(fichiers().length, avant - 1);
  });
});
