// Tests : retours sous les réponses, signalements, questions sans fiche, consentement, statistiques, propositions.
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
import { createLocalStorage } from "../storage.js";
import { createRelecture, parseAdmins } from "../relecture.js";
import { createPropositions, appliquer } from "../propositions.js";
import { createRetours, anonymiser, SEUIL_STATS } from "../retours.js";
import { createChat } from "../chat.js";
import { loadKnowledge, DATA_DIR } from "../knowledge.js";

const PASSWORD = "un mot de passe solide";
let server, base, db, dir, kb, propositions;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "retroviz-retours-"));
  for (const f of ["voyants.json", "obd.json", "vehicules.json"]) fs.copyFileSync(path.join(DATA_DIR, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, "uploads"));
  kb = loadKnowledge(dir);
  db = openDb(":memory:");
  const relecture = createRelecture({ dataDir: dir, kb, admins: parseAdmins("admin@exemple.fr"), now: () => "2026-10-15" });
  propositions = createPropositions(db, relecture);
  const retours = createRetours(db, { limiteParHeure: 1000 });
  retours.onSignalement = p => propositions.creer(p);
  const carnet = createCarnet(db, createLocalStorage(path.join(dir, "uploads")), { log: () => {} });
  const garage = createGarage(db, kb, { carnet });
  const fakeClient = { beta: { messages: { stream() { const h = {}; return { on(e, f) { h[e] = f; return this; }, abort() {}, async finalMessage() { h.text?.("ok"); return {}; } }; } } } };
  const app = express();
  app.use(express.json());
  app.use(createAuth(db, { isAdmin: relecture.isAdmin, exportData: garage.exportFor }));
  app.use(garage); app.use(carnet); app.use(relecture); app.use(propositions); app.use(retours);
  app.use(createChat({ client: fakeClient, kb, model: "m", log: () => {}, onSansFiche: retours.noterSansFiche }));
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function user(email) {
  let cookie = "";
  const c = async (method, p, body) => {
    if (method !== "GET" && body === undefined) body = {};
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const txt = await res.text();
    let b; try { b = JSON.parse(txt); } catch { b = txt; }
    return { status: res.status, body: b };
  };
  if (email) {
    let r = await c("POST", "/api/auth/signup", { email, password: PASSWORD });
    if (r.status === 409) r = await c("POST", "/api/auth/login", { email, password: PASSWORD }); // compte déjà créé par un test précédent
    c.me = r.body.user;
  }
  return c;
}
const n = (table, where = "1=1") => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;

describe("anonymat", () => {
  test("e-mails, téléphones, plaques et numéros de série retirés ; désignations de voitures gardées", () => {
    const t = anonymiser("Écrivez-moi à jean.dupont@mail.fr ou au 06 12 34 56 78, plaque AB-123-CD, VIN VF1RJA00012345678");
    for (const prive of ["jean.dupont", "06 12", "AB-123-CD", "VF1RJA"]) assert.ok(!t.includes(prive), prive);
    assert.equal(anonymiser("Peugeot 208 GT 130 ch 2019"), "Peugeot 208 GT 130 ch 2019");
  });
});

describe("retours sous les réponses", () => {
  test("oui / non enregistrés sans aucun lien avec un compte", async () => {
    const anonyme = await user();
    assert.equal((await anonyme("POST", "/api/retours", { mode: "particulier", avis: "oui", fiches: [{ type: "voyant", id: "abs", label: "ABS" }] })).status, 201);
    assert.equal((await anonyme("POST", "/api/retours", { mode: "pro", avis: "non" })).status, 201);
    assert.equal((await anonyme("POST", "/api/retours", { mode: "particulier", avis: "bof" })).status, 400);
    const cols = db.prepare("PRAGMA table_info(retours)").all().map(c => c.name);
    assert.ok(!cols.some(c => /user|email|ip/i.test(c)), "aucune colonne d'identification");
  });

  test("« Signaler une erreur » : commentaire obligatoire, anonymisé, et signalement dans la Relecture", async () => {
    const anonyme = await user(), admin = await user("admin@exemple.fr");
    assert.equal((await anonyme("POST", "/api/retours", { mode: "particulier", avis: "erreur" })).status, 400);
    await anonyme("POST", "/api/retours", { mode: "particulier", avis: "erreur", commentaire: "Le voyant ABS n'empêche pas de rouler, appelez-moi au 0612345678",
      extrait: "NIVEAU: ROUGE…", fiches: [{ type: "voyant", id: "abs", label: "ABS" }] });
    const sig = (await admin("GET", "/api/admin/propositions?type=signalement")).body.propositions[0];
    assert.equal(sig.type, "signalement");
    assert.equal(sig.collection, "voyants");
    assert.equal(sig.cibleId, "abs");
    assert.ok(!sig.resume.includes("0612345678"));
    // Traiter le signalement ne modifie aucune fiche.
    const avant = fs.readFileSync(path.join(dir, "voyants.json"), "utf8");
    assert.equal((await admin("POST", `/api/admin/propositions/${sig.id}/accepter`)).status, 200);
    assert.equal(fs.readFileSync(path.join(dir, "voyants.json"), "utf8"), avant);
  });
});

describe("questions sans fiche", () => {
  test("notées sans le texte de la question ; regroupées pour l'Observateur", async () => {
    const anonyme = await user(), admin = await user("admin@exemple.fr");
    const ask = (vehicule, question) => anonyme("POST", "/api/chat", { mode: "particulier", vehicule, messages: [{ role: "user", content: question }] });
    await ask("Toyota Yaris 1.0 VVT-i 2015", "bruit bizarre en tournant, mon numéro 0612345678");
    await ask("toyota yaris 1.0 vvt-i 2015", "et P1234 ?");
    await ask("Renault Clio IV 1.5 dCi 90", "bruit au freinage"); // fiche existante : pas notée
    await ask("Toyota Yaris 1.0 VVT-i", "même voiture, sans l'année");
    const lignes = db.prepare("SELECT * FROM questions_sans_fiche").all();
    assert.equal(lignes.length, 3);
    assert.ok(lignes.every(l => !JSON.stringify(l).includes("bruit") && !JSON.stringify(l).includes("0612")));
    const prio = (await admin("GET", "/api/admin/questions-sans-fiche")).body.prioritaires;
    assert.equal(prio[0].nombre, 3, "avec ou sans année : même voiture");
    assert.deepEqual(prio[0].codes, ["P1234"]);
  });
});

describe("consentement et statistiques anonymes", () => {
  test("désactivé par défaut, modifiable par l'utilisateur, dans l'export", async () => {
    const c = await user("consent@exemple.fr");
    assert.equal(c.me.statsConsent, false);
    assert.equal((await (await user())("PUT", "/api/account/consentement", { stats: true })).status, 401);
    assert.deepEqual((await c("PUT", "/api/account/consentement", { stats: true })).body, { statsConsent: true });
    assert.equal((await c("GET", "/api/auth/me")).body.user.statsConsent, true);
    assert.equal((await c("GET", "/api/account/export")).body.account.statsConsent, true);
  });

  test(`publiées seulement à partir de ${SEUIL_STATS} véhicules de comptes consentants, en fourchette arrondie`, async () => {
    const ajoute = async (i, consent) => {
      const c = await user(`stat${i}${consent ? "" : "-non"}@exemple.fr`);
      if (consent) await c("PUT", "/api/account/consentement", { stats: true });
      const vid = (await c("POST", "/api/garage", { marque: "Renault", modele: "Clio IV", motorisation: "1.5 dCi 90" })).body.vehicule.id;
      await c("POST", `/api/garage/${vid}/entretiens`, { date: "2025-01-10", type: "reparation", km: 100000 + i * 3000, description: "embrayage", alimenterReleves: false });
      await c("POST", `/api/garage/${vid}/entretiens`, { date: "2025-02-10", type: "distribution", km: 120000 + i * 1000, alimenterReleves: false });
    };
    for (let i = 0; i < SEUIL_STATS - 1; i++) await ajoute(i, true);
    for (let i = 0; i < 5; i++) await ajoute(i, false); // non consentants : jamais comptés
    let stats = (await (await user())("GET", "/api/stats/entretiens")).body.statistiques;
    assert.equal(stats.length, 0, `${SEUIL_STATS - 1} véhicules consentants : rien de publié`);
    await ajoute(SEUIL_STATS - 1, true);
    stats = (await (await user())("GET", "/api/stats/entretiens")).body.statistiques;
    const repa = stats.find(s => s.type === "reparation");
    assert.equal(repa.vehicules, SEUIL_STATS);
    assert.equal(repa.sujet, "renault-clio-4-15-dci");
    assert.ok(repa.kmBas % 1000 === 0 && repa.kmHaut % 1000 === 0 && repa.kmBas <= repa.kmHaut);
  });
});

describe("propositions", () => {
  test("appliquer : ajout à une liste, modification d'un champ ou d'un élément", () => {
    const f = { pannes: [{ titre: "a", km_typique: 1 }], annees: "2012-2019" };
    assert.equal(appliquer(f, "ajout", "pannes", { titre: "b" }).pannes.length, 2);
    assert.equal(appliquer(f, "modification", "annees", "2012-2020").annees, "2012-2020");
    assert.equal(appliquer(f, "modification", "pannes.0.km_typique", 90000).pannes[0].km_typique, 90000);
    assert.equal(f.pannes.length, 1, "la fiche d'origine n'est pas modifiée");
    assert.throws(() => appliquer(f, "ajout", "annees", 1));
  });

  test("accepter (avec modification), rejeter avec motif, pas de doublon", async () => {
    const admin = await user("admin@exemple.fr");
    const panne = { titre: "Fuite d'huile au joint de cache-culbuteurs", km_typique: 150000, gravite: "faible", symptomes: "Odeur d'huile chaude", cout_indicatif: "150 à 300 €" };
    const src = [{ url: "https://exemple.fr/article", type: "presse", titre: "Article" }];
    const id = propositions.creer({ origine: "observateur", type: "ajout", collection: "vehicules", cibleId: "renault-clio-4-15-dci", champ: "pannes", valeur: panne, resume: "Ajouter une panne", sources: src, confiance: "signale" });
    assert.equal(propositions.creer({ origine: "observateur", type: "ajout", collection: "vehicules", cibleId: "renault-clio-4-15-dci", champ: "pannes", valeur: panne, resume: "doublon", sources: src }), null);
    const r = await admin("POST", `/api/admin/propositions/${id}/accepter`, { valeur: { ...panne, km_typique: 140000 } });
    assert.equal(r.status, 200);
    const fiche = JSON.parse(fs.readFileSync(path.join(dir, "vehicules.json"), "utf8")).find(v => v.id === "renault-clio-4-15-dci");
    assert.equal(fiche.pannes.at(-1).km_typique, 140000, "valeur modifiée dans la Relecture");
    assert.ok(fiche.sources.includes("https://exemple.fr/article"));
    assert.equal(fiche.statut, "a_verifier", "jamais vérifiée automatiquement");
    assert.equal(fiche.revisions.at(-1).action, `proposition #${id} acceptée`);
    assert.equal((await admin("POST", `/api/admin/propositions/${id}/accepter`)).status, 409);

    const id2 = propositions.creer({ origine: "observateur", type: "modification", collection: "vehicules", cibleId: "renault-clio-4-15-dci", champ: "annees", valeur: "2012-2021", resume: "Années", sources: src });
    assert.equal((await admin("POST", `/api/admin/propositions/${id2}/rejeter`, { motif: " " })).status, 400);
    const rej = await admin("POST", `/api/admin/propositions/${id2}/rejeter`, { motif: "La Clio IV s'arrête en 2019." });
    assert.equal(rej.body.proposition.statut, "rejetee");
    assert.equal((await admin("GET", "/api/admin/propositions?statut=rejetee")).body.propositions[0].motif, "La Clio IV s'arrête en 2019.");
    // Accès réservé.
    assert.equal((await (await user("pasadmin@exemple.fr"))("GET", "/api/admin/propositions")).status, 404);
  });

  test("création d'une fiche : toujours « à vérifier », rédigée par l'IA, avec ses sources", async () => {
    const admin = await user("admin@exemple.fr");
    const fiche = { code: "P2BA0", libelle: "Code fictif pour le test", causes_frequentes: ["Fuite d'air"], verifications: ["Pression de suralimentation"], statut: "verifie", sources: [], redige_par: "humain", mise_a_jour: "2026-01-01" };
    const id = propositions.creer({ origine: "observateur", type: "creation", collection: "obd", cibleId: "P2BA0", valeur: fiche, resume: "Nouveau code", sources: [{ url: "https://exemple.fr/p2ba0", type: "pro" }] });
    const r = await admin("POST", `/api/admin/propositions/${id}/accepter`);
    assert.equal(r.status, 200);
    assert.equal(r.body.fiche.statut, "a_verifier");
    assert.equal(r.body.fiche.redige_par, "ia");
    assert.deepEqual(r.body.fiche.sources, ["https://exemple.fr/p2ba0"]);
  });
});
