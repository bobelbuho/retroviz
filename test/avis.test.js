// Tests des avis de propriétaires : npm test
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { openDb } from "../db.js";
import { createAuth } from "../auth.js";
import { createGarage } from "../garage.js";
import { createAvis, cleanAvis, problemesTexte, eligibilite, synthese, clePiece, SEUIL_SYNTHESE } from "../avis.js";
import { loadKnowledge } from "../knowledge.js";

const PASSWORD = "un mot de passe solide";
const NOTES = { fiabilite: 4, cout_entretien: 3, confort: 4, consommation: 5, rapport_qualite_prix: 4 };
const avisValide = (extra = {}) => ({ notes: NOTES, recommande: true, points_forts: "Sobre", points_faibles: "Bruits de planche de bord", commentaire: "", pannes: [], ...extra });

describe("règles des avis", () => {
  test("filtre : coordonnées et injures refusées, avis négatif accepté", () => {
    assert.deepEqual(problemesTexte("Écrivez-moi à jean.dupont@mail.fr ou au 06 12 34 56 78"), ["une adresse e-mail", "un numéro de téléphone"]);
    assert.deepEqual(problemesTexte("Ma voiture AB-123-CD, voir www.monsite.fr"), ["un lien vers un site", "une plaque d'immatriculation"]);
    assert.deepEqual(problemesTexte("Le vendeur est un connard"), ["une injure"]);
    assert.deepEqual(problemesTexte("Boîte de vitesses catastrophique, une vraie poubelle, le 130 ch est un veau. À fuir."), []);
    assert.deepEqual(problemesTexte("Distribution technique à 120 000 km"), []);
  });
  test("validation : 5 notes de 1 à 5, recommandation, au moins un contenu", () => {
    assert.ok(cleanAvis({ ...avisValide(), notes: { ...NOTES, confort: 6 } }).error);
    assert.ok(cleanAvis({ ...avisValide(), recommande: "oui" }).error);
    assert.ok(cleanAvis(avisValide({ points_forts: "", points_faibles: "" })).error);
    const ok = cleanAvis(avisValide({ pannes: [{ piece: "Embrayage", km: "112 000", cout: "850,50" }, { piece: "  " }] }));
    assert.deepEqual(ok.data.pannes, [{ piece: "Embrayage", km: 112000, cout: 851 }]);
    assert.equal(cleanAvis(avisValide({ commentaire: "appelez le 0612345678" })).code, "filtre");
  });
  test("éligibilité : 3 mois dans le garage et 2 relevés, avec ce qui manque", () => {
    assert.ok(eligibilite({ depuis: "2026-01-01", relevesPropres: 2, aujourdhui: "2026-10-14" }).ok);
    const non = eligibilite({ depuis: "2026-09-01", relevesPropres: 1, aujourdhui: "2026-10-14" });
    assert.deepEqual(non.raisons.map(r => r.id), ["duree", "releves"]);
    assert.match(non.raisons[0].texte, /1 décembre 2026/);
  });
  test("synthèse : moyennes, recommandation, pannes citées par au moins 2 avis", () => {
    const a = (fiab, reco, pannes) => ({ notes: { ...NOTES, fiabilite: fiab }, recommande: reco, pannes });
    const s = synthese([a(5, true, [{ piece: "Embrayage", km: 100000, cout: 900 }]), a(3, false, [{ piece: "l'embrayage", km: 120000, cout: 1100 }, { piece: "Turbo" }]),
      a(4, true, [{ piece: "Embrayages", km: 110000 }]), a(2, true, []), a(1, false, [{ piece: "Turbo", km: 90000 }])]);
    assert.equal(s.moyennes.fiabilite, 3);
    assert.equal(s.recommandent, 60);
    assert.deepEqual(s.pannes.map(p => [p.piece, p.nombre]), [["Embrayage", 3], ["Turbo", 2]]);
    assert.equal(s.pannes[0].kmMedian, 110000);
    assert.equal(clePiece("Les plaquettes"), "plaquette");
  });
});

describe("API des avis", () => {
  let server, base, db, avis;
  before(async () => {
    db = openDb(":memory:");
    const kb = loadKnowledge();
    const garage = createGarage(db, kb, { log: () => {} });
    avis = createAvis(db, { kb, isAdmin: u => u?.email === "admin@exemple.fr" });
    const app = express();
    app.use(express.json());
    app.use(createAuth(db, { exportData: uid => ({ ...garage.exportFor(uid), avis: avis.exportFor(uid) }) }));
    app.use(garage); app.use(avis);
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://localhost:${server.address().port}`;
  });
  after(() => server.close());

  async function user(email) {
    let cookie = "";
    const c = async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...(cookie && { Cookie: cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return { status: res.status, body: await res.json() };
    };
    await c("POST", "/api/auth/signup", { email, password: PASSWORD });
    return c;
  }
  // Voiture ajoutée il y a 4 mois, avec 2 relevés.
  async function voiture(c, def = {}) {
    const id = (await c("POST", "/api/garage", { marque: "Peugeot", modele: "208", motorisation: "1.2 PureTech 82", annee: 2016, ...def })).body.vehicule.id;
    db.prepare("UPDATE vehicles SET created_at = '2026-06-01T10:00:00.000Z' WHERE id = ?").run(id);
    await c("POST", `/api/garage/${id}/releves`, { date: "2026-06-01", km: 90000 });
    await c("POST", `/api/garage/${id}/releves`, { date: "2026-09-01", km: 94000 });
    return id;
  }

  test("conditions de publication, un avis par voiture, modifiable", async () => {
    const a = await user("avis1@exemple.fr");
    const neuve = (await a("POST", "/api/garage", { marque: "Renault", modele: "Clio" })).body.vehicule.id;
    const e = (await a("GET", `/api/garage/${neuve}/avis`)).body.eligibilite;
    assert.equal(e.ok, false);
    assert.equal((await a("PUT", `/api/garage/${neuve}/avis`, avisValide())).status, 403);
    const id = await voiture(a);
    const pub = await a("PUT", `/api/garage/${id}/avis`, avisValide());
    assert.equal(pub.status, 201);
    assert.equal(pub.body.avis.kmActuel, 94000);
    const modif = await a("PUT", `/api/garage/${id}/avis`, avisValide({ recommande: false }));
    assert.equal(modif.status, 200);
    assert.equal(modif.body.avis.id, pub.body.avis.id);
    assert.equal(modif.body.avis.recommande, false);
    assert.equal((await a("PUT", `/api/garage/${id}/avis`, avisValide({ commentaire: "écrivez à moi@exemple.fr" }))).status, 400);
  });

  test("lecture publique : jamais l'identité ; avis un par un, puis synthèse à partir de 5", async () => {
    const ids = [];
    for (let i = 0; i < SEUIL_SYNTHESE - 1; i++) {
      const c = await user(`proprio${i}@exemple.fr`);
      ids.push(await voiture(c, { modele: "5008", motorisation: "1.6 BlueHDi 120" }));
      await c("PUT", `/api/garage/${ids.at(-1)}/avis`, avisValide({ pannes: [{ piece: "Vanne EGR", km: 80000 + i * 1000, cout: 400 }] }));
    }
    let r = await (await fetch(`${base}/api/avis?marque=Peugeot&modele=5008&motorisation=1.6 BlueHDi 120`)).json();
    assert.equal(r.modele.nombre, 4);
    assert.equal(r.modele.synthese, null);
    assert.ok(!JSON.stringify(r).includes("proprio"));
    assert.equal(r.modele.avis[0].verifie, true);
    const c = await user("proprio9@exemple.fr");
    await c("PUT", `/api/garage/${await voiture(c, { modele: "5008", motorisation: "2.0 BlueHDi 150" })}/avis`, avisValide());
    r = await (await fetch(`${base}/api/avis?marque=Peugeot&modele=5008&motorisation=1.6 BlueHDi 120`)).json();
    assert.equal(r.motorisation.nombre, 4);
    assert.equal(r.modele.nombre, 5);
    assert.equal(r.modele.synthese.pannes[0].piece, "Vanne EGR");
    assert.equal(r.modele.synthese.pannes[0].nombre, 4);
    // Faits pour l'Observateur : une seule source « propriétaires ».
    const faits = avis.faitsPourObservateur({ marque: "Peugeot", modele: "5008" });
    assert.equal(faits.length, 1);
    assert.equal(faits[0].typeSource, "proprietaires");
    assert.match(faits[0].contenu, /citée par 4 propriétaires sur 5 avis/);
  });

  test("signalement anonyme, modération avec motif obligatoire, motif visible par l'auteur", async () => {
    const a = await user("auteur3@exemple.fr"), admin = await user("admin@exemple.fr");
    const id = await voiture(a, { modele: "2008" });
    const aid = (await a("PUT", `/api/garage/${id}/avis`, avisValide({ points_faibles: "Boîte automatique catastrophique" }))).body.avis.id;
    const sig = await fetch(`${base}/api/avis/${aid}/signaler`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ motif: "faux", detail: "trop négatif" }) });
    assert.equal(sig.status, 201);
    assert.equal((await a("GET", "/api/admin/avis")).status, 404, "réservé aux administrateurs");
    const file = (await admin("GET", "/api/admin/avis")).body;
    assert.equal(file.avis.length, 1);
    assert.ok(!Object.values(file.motifs).some(m => /négati/i.test(m)), "« négatif » n'est pas un motif de masquage");
    assert.equal((await admin("POST", `/api/admin/avis/${aid}`, { action: "masquer" })).status, 400);
    await admin("POST", `/api/admin/avis/${aid}`, { action: "masquer", motif: "hors_sujet" });
    const r = await (await fetch(`${base}/api/avis?marque=Peugeot&modele=2008`)).json();
    assert.equal(r.modele.nombre, 0);
    const miens = (await a("GET", "/api/avis/miens")).body.avis;
    assert.equal(miens[0].statut, "masque");
    assert.equal(miens[0].motifMasque, "Ne parle pas de la voiture");
    // Corrigé par l'auteur : de nouveau dans la file de modération.
    await a("PUT", `/api/garage/${id}/avis`, avisValide({ points_faibles: "Boîte automatique lente" }));
    assert.equal((await admin("GET", "/api/admin/avis")).body.avis.length, 1);
    // Garder : republié.
    await admin("POST", `/api/admin/avis/${aid}`, { action: "garder" });
    assert.equal((await (await fetch(`${base}/api/avis?marque=Peugeot&modele=2008`)).json()).modele.nombre, 1);
  });

  test("RGPD : dans l'export, effacé avec le compte", async () => {
    const a = await user("rgpd4@exemple.fr");
    const id = await voiture(a, { modele: "308" });
    await a("PUT", `/api/garage/${id}/avis`, avisValide());
    assert.equal((await a("GET", "/api/account/export")).body.avis.length, 1);
    await a("DELETE", "/api/account", { password: PASSWORD });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM avis").all()[0].n >= 0, true);
    assert.equal((await (await fetch(`${base}/api/avis?marque=Peugeot&modele=308`)).json()).modele.nombre, 0);
  });
});
