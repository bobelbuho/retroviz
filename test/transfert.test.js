// Tests du carnet qui suit la voiture : dossier partagé, transfert, historique verrouillé, notes : npm test
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
import { createVie } from "../vie.js";
import { createRappels } from "../rappels.js";
import { createBadge } from "../badge.js";
import { createTransfert, cleanOptions, nouveauCode, normaliserCode, ESSAIS_PAR_HEURE } from "../transfert.js";
import { createLocalStorage } from "../storage.js";
import { loadKnowledge } from "../knowledge.js";
import { sansMetadonnees } from "../metadonnees.js";
import { saisiLe, estAncienne, continuite, resumeSaisie, differences } from "../historique.js";

const PASSWORD = "un mot de passe solide";
const seg = (marker, payload) => { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = marker; b.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([b, payload]); };
const JPEG_EXIF = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\0\x01\x02\0\0\x01\0\x01\0\0", "latin1")),
  seg(0xe1, Buffer.from("Exif\0\0GPS 45.76N 4.83E", "latin1")), seg(0xfe, Buffer.from("Jean Dupont", "latin1")),
  seg(0xda, Buffer.from([0, 1, 2, 3, 4, 5])), Buffer.from([9, 8, 7, 0xff, 0xd9])]);
const chunk = (type, data) => { const b = Buffer.alloc(8); b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); return Buffer.concat([b, data, Buffer.alloc(4)]); };
const PNG_TEXTE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", Buffer.alloc(13)),
  chunk("tEXt", Buffer.from("Author\0Jean Dupont", "latin1")), chunk("IDAT", Buffer.alloc(10)), chunk("IEND", Buffer.alloc(0))]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64)]);

describe("métadonnées des images", () => {
  test("JPEG : Exif et commentaire retirés, l'image reste", () => {
    const { buffer, nettoye } = sansMetadonnees(JPEG_EXIF, "jpg");
    assert.ok(nettoye);
    assert.ok(!buffer.toString("latin1").includes("GPS") && !buffer.toString("latin1").includes("Dupont"));
    assert.ok(buffer.toString("latin1").includes("JFIF"));
    assert.deepEqual([...buffer.subarray(-5)], [9, 8, 7, 0xff, 0xd9]);
  });
  test("PNG : blocs de texte retirés", () => {
    const { buffer } = sansMetadonnees(PNG_TEXTE, "png");
    assert.ok(!buffer.toString("latin1").includes("Dupont"));
    assert.ok(buffer.toString("latin1").includes("IDAT") && buffer.toString("latin1").includes("IEND"));
  });
  test("PDF : non modifié, signalé", () => {
    assert.deepEqual(sansMetadonnees(PDF, "pdf"), { buffer: PDF, nettoye: false });
  });
});

describe("historique : saisie après coup, modifications, continuité", () => {
  test("saisi le … : seulement plus de 30 jours après la date", () => {
    assert.equal(saisiLe({ date: "2025-01-10", created_at: "2025-03-01T10:00:00Z" }), "2025-03-01");
    assert.equal(saisiLe({ date: "2025-01-10", created_at: "2025-01-30T10:00:00Z" }), null);
  });
  test("entrée ancienne : date ET saisie de plus de 30 jours", () => {
    assert.ok(estAncienne({ date: "2025-01-10", created_at: "2025-01-10T10:00:00Z" }, "2026-10-14"));
    assert.ok(!estAncienne({ date: "2025-01-10", created_at: "2026-10-10T10:00:00Z" }, "2026-10-14"), "saisie après coup corrigée tout de suite");
  });
  test("différences : valeurs pour les chiffres, jamais l'ancien texte", () => {
    const d = differences({ km: 1000, description: "chez Dupont", garage: "" }, { km: 1200, description: "", garage: "" });
    assert.deepEqual(d, [{ champ: "km", avant: 1000, apres: 1200 }, { champ: "description" }]);
  });
  test("continuité : dernière période sans trou de plus de 6 mois, sur 2 propriétaires", () => {
    const pts = [{ date: "2019-01-01", km: 40000 }, { date: "2020-06-01", km: 60000 }, // trou de 17 mois
      { date: "2021-01-01", km: 78000 }, { date: "2021-05-01", km: 82000 }, { date: "2021-10-01", km: 90000 }, { date: "2022-03-01", km: 98000 },
      { date: "2022-08-01", km: 106000 }, { date: "2023-01-01", km: 121000 }];
    const c = continuite(pts, ["2022-04-15"]);
    assert.deepEqual(c.de, { date: "2021-01-01", km: 78000 }); // 7 mois entre juin 2020 et janvier 2021 : interruption
    assert.deepEqual(c.a, { date: "2023-01-01", km: 121000 });
    assert.equal(c.proprietaires, 2);
    assert.equal(continuite([{ date: "2023-01-01", km: 1 }]), null);
  });
  test("résumé de la saisie après coup", () => {
    const e = [{ date: "2024-01-01", created_at: "2025-01-01T00:00:00Z", facture_key: "a.pdf" }, { date: "2024-01-01", created_at: "2025-01-01T00:00:00Z" }, { date: "2025-01-01", created_at: "2025-01-02T00:00:00Z" }];
    assert.deepEqual(resumeSaisie(e, []), { entretiens: 2, entretiensAvecFacture: 1, releves: 0 });
  });
});

describe("code et options", () => {
  test("code : 8 caractères sans confusion, saisie tolérante", () => {
    const c = nouveauCode();
    assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(normaliserCode(c.toLowerCase().replace("-", " ")), c.replace("-", ""));
    assert.equal(normaliserCode("ABCD-EF0O"), null);
  });
  test("options : tout décoché par défaut, identifiants filtrés", () => {
    const ents = [{ id: 1, description: "x", facture_key: "a.pdf" }, { id: 2, description: "", facture_key: null }];
    assert.deepEqual(cleanOptions({}, ents).options, { garages: false, descriptions: [], factures: [], photo: false });
    assert.deepEqual(cleanOptions({ descriptions: [1, 2, 99], factures: [1, 2] }, ents).options.factures, [1]);
    assert.deepEqual(cleanOptions({ descriptions: [1, 2] }, ents).options.descriptions, [1]);
    assert.equal(cleanOptions({}, ents, { partage: true }).options.duree, 7);
    assert.ok(cleanOptions({ duree: 365 }, ents, { partage: true }).error);
  });
});

describe("API : dossier partagé et transfert", () => {
  let server, base, dir, db, horloge = Date.now();
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "retroviz-transfert-"));
    db = openDb(":memory:");
    const kb = loadKnowledge();
    const storage = createLocalStorage(dir);
    const carnet = createCarnet(db, storage, { log: () => {} });
    const rappels = createRappels(db, kb);
    const badge = createBadge(db, { rappels });
    const garage = createGarage(db, kb, { carnet, rappels, storage, badge, log: () => {} });
    const vie = createVie(db);
    const transfert = createTransfert(db, { carnet, vie, badge, rappels, storage, now: () => horloge });
    const beforeDeleteUser = uid => { const a = carnet.beforeDeleteUser(uid), b = garage.beforeDeleteUser(uid); return async () => { await a(); await b(); }; };
    const exportData = uid => { const d = garage.exportFor(uid); for (const v of d.vehicules) v.changementsDeProprietaire = transfert.datesTransfert(v.id); return d; };
    const app = express();
    app.use(express.json());
    app.use(createAuth(db, { exportData, beforeDeleteUser }));
    app.use(garage); app.use(carnet); app.use(rappels); app.use(vie); app.use(transfert);
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://localhost:${server.address().port}`;
  });
  after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const fichiers = () => fs.readdirSync(dir).sort();

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
  // Voiture du vendeur : 2 entretiens avec facture (une photo avec Exif, un PDF), 1 sans ; une photo ; un rappel libre.
  async function voitureVendeur(a) {
    const vid = (await a("POST", "/api/garage", { surnom: "Titine de Paul", marque: "Peugeot", modele: "208", motorisation: "1.2 PureTech 82", annee: 2016,
      miseEnCirculation: "2016-04-12", achatDate: "2020-03-01", achatKm: 41000, assuranceEcheance: "2027-01-01" })).body.vehicule.id;
    await a("POST", `/api/garage/${vid}/releves`, { date: "2024-01-10", km: 70000 });
    const e1 = (await a("POST", `/api/garage/${vid}/entretiens`, { date: "2024-01-10", type: "vidange", km: 70000, cout: "120", garage: "Garage Martin, Lyon 3e", description: "Vidange, facture au nom de Paul" })).body.entretien.id;
    const e2 = (await a("POST", `/api/garage/${vid}/entretiens`, { date: "2025-02-01", type: "freins", km: 80000, cout: "300", description: "Disques et plaquettes" })).body.entretien.id;
    const e3 = (await a("POST", `/api/garage/${vid}/entretiens`, { date: "2025-09-01", type: "pneus", km: 86000, cout: "400" })).body.entretien.id;
    await a("PUT", `/api/garage/${vid}/entretiens/${e1}/facture`, undefined, JPEG_EXIF);
    await a("PUT", `/api/garage/${vid}/entretiens/${e2}/facture`, undefined, PDF);
    await a("PUT", `/api/garage/${vid}/photo`, undefined, PNG_TEXTE);
    await a("POST", `/api/garage/${vid}/rappels`, { titre: "Appeler Paul au garage", date: "2027-02-01" });
    return { vid, e1, e2, e3 };
  }

  test("dossier partagé : rien d'identifiant par défaut, jeton seul, expiration et révocation", async () => {
    const a = await user("vendeur1@exemple.fr");
    const { vid, e1, e2 } = await voitureVendeur(a);
    const cree = await a("POST", `/api/garage/${vid}/partages`, {});
    assert.equal(cree.status, 201);
    const token = cree.body.lien.split("#")[1];
    // Visiteur anonyme (sans compte).
    const r = await fetch(`${base}/api/dossier/${token}`);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
    const { dossier } = await r.json();
    const texte = JSON.stringify(dossier);
    for (const secret of ["vendeur1@", "Titine", "Paul", "Martin", "Disques", "2027-01-01"]) assert.ok(!texte.includes(secret), secret);
    assert.equal(dossier.voiture.miseEnCirculation, "2016-04");
    assert.equal(dossier.photo, null);
    assert.equal(dossier.valeur, null);
    const vidange = dossier.frise.find(e => e.type === "entretien" && e.titre === "Vidange");
    assert.equal(vidange.facture, null);
    assert.equal(vidange.factureNonMontree, true);
    assert.equal(vidange.preuve, "facture");
    assert.ok(dossier.badge.criteres.length >= 5);
    // Une facture non partagée n'est pas accessible.
    assert.equal((await fetch(`${base}/api/dossier/${token}/factures/${e1}`)).status, 404);
    // Avec facture et description choisies : la facture est servie sans ses métadonnées.
    const cree2 = await a("POST", `/api/garage/${vid}/partages`, { factures: [e1], descriptions: [e2], photo: true, duree: 1 });
    const t2 = cree2.body.lien.split("#")[1];
    const d2 = (await (await fetch(`${base}/api/dossier/${t2}`)).json()).dossier;
    const v2 = d2.frise.find(e => e.titre === "Vidange");
    assert.equal(v2.facture, `/api/dossier/${t2}/factures/${e1}`);
    assert.equal(d2.frise.find(e => e.titre === "Freins").description, "Disques et plaquettes");
    const f = Buffer.from(await (await fetch(base + v2.facture)).arrayBuffer());
    assert.ok(f.toString("latin1").includes("JFIF") && !f.toString("latin1").includes("GPS"));
    const photo = Buffer.from(await (await fetch(base + d2.photo)).arrayBuffer());
    assert.ok(!photo.toString("latin1").includes("Dupont"));
    // Expiration (1 jour) et révocation.
    horloge += 2 * 86_400_000;
    assert.equal((await fetch(`${base}/api/dossier/${t2}`)).status, 404);
    assert.equal((await fetch(`${base}/api/dossier/${token}`)).status, 200);
    await a("DELETE", `/api/garage/${vid}/partages/${cree.body.partage.id}`);
    assert.equal((await fetch(`${base}/api/dossier/${token}`)).status, 404);
    // Un autre compte ne voit pas les liens.
    const b = await user("curieux1@exemple.fr");
    assert.equal((await b("GET", `/api/garage/${vid}/partage`)).status, 404);
  });

  test("copie masquée : l'original reste, la copie sert au partage", async () => {
    const a = await user("vendeur2@exemple.fr");
    const { vid, e1, e2 } = await voitureVendeur(a);
    const masque = await a("PUT", `/api/garage/${vid}/entretiens/${e1}/facture-masquee`, undefined, PNG_TEXTE);
    assert.equal(masque.status, 200);
    assert.ok(masque.body.entretien.facture.masquee);
    assert.equal((await a("PUT", `/api/garage/${vid}/entretiens/${e2}/facture-masquee`, undefined, PDF)).status, 415);
    const original = await a("GET", `/api/garage/${vid}/entretiens/${e1}/facture`);
    assert.deepEqual(original.body, JPEG_EXIF);
    const partage = await a("GET", `/api/garage/${vid}/entretiens/${e1}/facture?version=partage`);
    assert.equal(partage.headers.get("content-type"), "image/png");
  });

  test("transfert : le vendeur choisit, l'acheteur reçoit un historique verrouillé, le vendeur perd l'accès", async () => {
    const a = await user("vendeur3@exemple.fr"), b = await user("acheteur3@exemple.fr");
    const { vid, e1, e2, e3 } = await voitureVendeur(a);
    const avant = fichiers();
    const t = await a("POST", `/api/garage/${vid}/transfert`, { factures: [e1] });
    assert.equal(t.status, 201);
    assert.match(t.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // L'acheteur voit un résumé avant d'accepter.
    const ap = await b("POST", "/api/transfert/apercu", { code: t.body.code.toLowerCase() });
    assert.equal(ap.status, 200);
    assert.deepEqual({ ...ap.body.transfert, expireLe: null }, { voiture: "Peugeot 208 1.2 PureTech 82, 2016", releves: 3, entretiens: 3, factures: 1, descriptions: 0, garages: false, photo: false, expireLe: null });
    // Le vendeur ne peut pas accepter sa propre voiture.
    assert.equal((await a("POST", "/api/transfert/accepter", { code: t.body.code })).status, 409);
    const ok = await b("POST", "/api/transfert/accepter", { code: t.body.code });
    assert.equal(ok.status, 200);
    // Le vendeur n'a plus rien ; le code ne sert plus.
    assert.equal((await a("GET", `/api/garage/${vid}/entretiens`)).status, 404);
    assert.equal((await a("GET", "/api/garage")).body.vehicules.length, 0);
    assert.equal((await b("POST", "/api/transfert/apercu", { code: t.body.code })).status, 404);
    // L'acheteur : voiture sans surnom ni assurance, descriptions et garages retirés, une seule facture, rappels libres effacés.
    const v = (await b("GET", "/api/garage")).body.vehicules[0];
    assert.equal(v.id, vid);
    assert.equal(v.surnom, "");
    assert.equal(v.assuranceEcheance, null);
    assert.equal(v.photo, null);
    assert.equal(v.achatKm, 86000);
    const ents = (await b("GET", `/api/garage/${vid}/entretiens`)).body.entretiens;
    assert.ok(ents.every(e => e.verrouille && e.description === "" && e.garage === ""));
    assert.equal(ents.find(e => e.id === e1).facture.nom.startsWith("facture-2024-01-10"), true);
    assert.equal(ents.find(e => e.id === e2).facture, null);
    assert.equal(ents.find(e => e.id === e2).preuve, "declare");
    assert.equal((await b("GET", `/api/garage/${vid}/avenir`)).body.items.some(i => i.titre.includes("Paul")), false);
    // Fichiers : facture partagée recopiée sans Exif ; tout le reste du vendeur effacé (2 factures + photo).
    const f = await b("GET", `/api/garage/${vid}/entretiens/${e1}/facture`);
    assert.ok(!f.body.toString("latin1").includes("GPS"));
    assert.equal(fichiers().length, avant.length - 2);
    // Historique verrouillé.
    assert.equal((await b("PUT", `/api/garage/${vid}/entretiens/${e3}`, { date: "2025-09-01", type: "pneus", km: 1 })).status, 403);
    assert.equal((await b("DELETE", `/api/garage/${vid}/entretiens/${e3}`)).status, 403);
    assert.equal((await b("DELETE", `/api/garage/${vid}/entretiens/${e1}/facture`)).status, 403);
    const rel = (await b("GET", `/api/garage/${vid}/releves`)).body.releves;
    assert.ok(rel.every(r => r.verrouille));
    assert.equal((await b("DELETE", `/api/garage/${vid}/releves/${rel[0].id}`)).status, 403);
    assert.equal((await b("POST", `/api/garage/${vid}/releves`, { date: rel[0].date, km: rel[0].km + 5 })).status, 403);
    // L'acheteur ajoute ses propres entrées, et une note sur l'historique reçu.
    const nouveau = (await b("POST", `/api/garage/${vid}/entretiens`, { type: "vidange", km: 87000 })).body.entretien.id;
    assert.equal((await b("POST", `/api/garage/${vid}/notes`, { objet: "entretien", objetId: nouveau, texte: "x" })).status, 400);
    assert.equal((await b("POST", `/api/garage/${vid}/notes`, { objet: "entretien", objetId: e3, texte: "Kilométrage vérifié sur le contrôle technique : 86 000 km." })).status, 201);
    const vie = (await b("GET", `/api/garage/${vid}/vie`)).body;
    assert.ok(vie.evenements.some(e => e.type === "proprietaire" && e.titre === "Changement de propriétaire"));
    assert.ok(vie.evenements.some(e => e.titre === "Achat par un propriétaire précédent"));
    assert.equal(vie.evenements.find(e => e.entretienId === e3).notes[0].texte, "Kilométrage vérifié sur le contrôle technique : 86 000 km.");
    assert.equal(vie.continuite, null); // plus de 6 mois entre le dernier entretien reçu et la vidange de l'acheteur
    // Export RGPD de l'acheteur : l'historique reçu et la date du changement de propriétaire.
    const exp = (await b("GET", "/api/account/export")).body;
    assert.equal(exp.vehicules[0].entretiens.length, 4);
    assert.equal(exp.vehicules[0].changementsDeProprietaire.length, 1);
    // Le vendeur supprime son compte : la voiture transférée reste.
    await a("DELETE", "/api/account", { password: PASSWORD });
    assert.equal((await b("GET", "/api/garage")).body.vehicules.length, 1);
  });

  test("code de transfert : essais limités par compte et par heure", async () => {
    const a = await user("vendeur4@exemple.fr"), b = await user("devineur4@exemple.fr");
    const { vid } = await voitureVendeur(a);
    const { code } = (await a("POST", `/api/garage/${vid}/transfert`, {})).body;
    for (let i = 0; i < ESSAIS_PAR_HEURE; i++) assert.equal((await b("POST", "/api/transfert/apercu", { code: "ZZZZ-ZZZZ" })).status, 404);
    // Même le bon code est refusé pendant une heure.
    assert.equal((await b("POST", "/api/transfert/apercu", { code })).status, 429);
    horloge += 61 * 60_000;
    assert.equal((await b("POST", "/api/transfert/apercu", { code })).status, 200);
  });

  test("modification d'une entrée ancienne : gardée, sans l'ancien texte ; saisie après coup signalée", async () => {
    const a = await user("modif5@exemple.fr");
    const vid = (await a("POST", "/api/garage", { marque: "Renault", modele: "Clio" })).body.vehicule.id;
    const eid = (await a("POST", `/api/garage/${vid}/entretiens`, { date: "2025-01-10", type: "vidange", km: 50000, description: "chez Dupont" })).body.entretien.id;
    let e = (await a("GET", `/api/garage/${vid}/entretiens`)).body.entretiens[0];
    assert.ok(e.saisiLe, "saisi après coup");
    // Corrigé tout de suite : pas gardé.
    await a("PUT", `/api/garage/${vid}/entretiens/${eid}`, { date: "2025-01-10", type: "vidange", km: 50500, description: "chez Dupont" });
    assert.equal((await a("GET", `/api/garage/${vid}/entretiens`)).body.entretiens[0].modifications.length, 0);
    // Saisi il y a longtemps, modifié aujourd'hui : gardé.
    db.prepare("UPDATE entretiens SET created_at = '2025-01-10T10:00:00.000Z' WHERE id = ?").run(eid);
    await a("PUT", `/api/garage/${vid}/entretiens/${eid}`, { date: "2025-01-10", type: "vidange", km: 45000, description: "" });
    e = (await a("GET", `/api/garage/${vid}/entretiens`)).body.entretiens[0];
    assert.equal(e.modifications.length, 1);
    assert.deepEqual(e.modifications[0].champs, [{ champ: "km", avant: 50500, apres: 45000 }, { champ: "description" }]);
    assert.ok(!JSON.stringify(e.modifications).includes("Dupont"));
  });
});
