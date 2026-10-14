// Tests des calculs « À venir » (dates et kilométrages) : npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeAvenir, addMonths, addYears, diffDays, kmAujourdhui, kindOf, VIDANGE_DEFAUT } from "../avenir.js";
import { loadKnowledge } from "../knowledge.js";

const kb = loadKnowledge();
const fiche = id => kb.vehicules.find(f => f.id === id);
const TODAY = "2026-10-14";
const VIDE = { mise_en_circulation: null, assurance_echeance: null, pneus_hiver: 0, vidange_km: null, vidange_mois: null };
const KM = { dernier: { date: TODAY, km: 52000 }, moyenneMensuelle: 1000 };
const run = (opts = {}) => computeAvenir({ vehicle: { ...VIDE, ...opts.vehicle }, today: TODAY, kilometrage: KM, ...opts, vehicle: { ...VIDE, ...opts.vehicle } });
const get = (res, cle) => res.items.find(it => it.cle === cle);

describe("dates", () => {
  test("ajout de mois et d'années, fins de mois et années bissextiles", () => {
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
    assert.equal(addMonths("2026-11-15", 3), "2027-02-15");
    assert.equal(addYears("2024-02-29", 1), "2025-02-28");
    assert.equal(diffDays("2026-10-14", "2026-11-01"), 18);
    assert.equal(diffDays("2026-03-28", "2026-03-30"), 2, "passage à l'heure d'été sans décalage");
  });
  test("kilométrage estimé aujourd'hui", () => {
    assert.equal(kmAujourdhui({ dernier: { date: "2026-07-14", km: 50000 }, moyenneMensuelle: 1000 }, TODAY), 53023); // 92 jours ≈ 3,02 mois
    assert.equal(kmAujourdhui({ dernier: { date: "2026-07-14", km: 50000 }, moyenneMensuelle: null }, TODAY), 50000);
    assert.equal(kmAujourdhui({ dernier: null, moyenneMensuelle: null }, TODAY), null);
  });
});

describe("contrôle technique", () => {
  test("premier contrôle avant les 4 ans", () => {
    const ct = get(run({ vehicle: { mise_en_circulation: "2023-03-10" } }), "ct");
    assert.equal(ct.date, "2027-03-10");
    assert.equal(ct.statut, "plus_tard");
    assert.match(ct.note, /procès-verbal/);
    const proche = get(run({ vehicle: { mise_en_circulation: "2022-11-01" } }), "ct");
    assert.equal(proche.date, "2026-11-01");
    assert.equal(proche.joursRestants, 18);
    assert.equal(proche.statut, "bientot");
  });
  test("plus de 4 ans sans contrôle dans le carnet : tous les 2 ans, prochain à venir", () => {
    const ct = get(run({ vehicle: { mise_en_circulation: "2015-06-01" } }), "ct");
    assert.equal(ct.date, "2027-06-01"); // 2019, 2021, 2023, 2025, 2027
    assert.match(ct.texte, /en supposant/);
    assert.equal(ct.aCompleter, "dernier_ct");
    assert.match(ct.aCompleterTexte, /indiquez la date de votre dernier contrôle technique pour un rappel exact/);
  });
  test("un contrôle du carnet sert de nouvelle référence, même sans date de mise en circulation", () => {
    const ok = get(run({ entretiens: [{ type: "controle_technique", date: "2024-11-20", km: 33500, description: "" }] }), "ct");
    assert.equal(ok.date, "2026-11-20");
    assert.equal(ok.statut, "plus_tard");
    const retard = get(run({ vehicle: { mise_en_circulation: "2015-06-01" }, entretiens: [{ type: "controle_technique", date: "2024-09-01", km: null, description: "" }] }), "ct");
    assert.equal(retard.date, "2026-09-01");
    assert.equal(retard.statut, "retard");
  });
  test("date du dernier contrôle saisie sur la voiture : calcul exact, rien à compléter", () => {
    const ct = get(run({ vehicle: { mise_en_circulation: "2015-06-01", dernier_ct: "2025-03-02" } }), "ct");
    assert.equal(ct.date, "2027-03-02");
    assert.equal(ct.aCompleter, null);
    assert.doesNotMatch(ct.texte, /en supposant/);
    // Le plus récent l'emporte, qu'il vienne du carnet ou du champ.
    const carnetPlusRecent = get(run({ vehicle: { dernier_ct: "2024-01-10" }, entretiens: [{ type: "controle_technique", date: "2025-06-01", km: null, description: "" }] }), "ct");
    assert.equal(carnetPlusRecent.date, "2027-06-01");
    const champPlusRecent = get(run({ vehicle: { dernier_ct: "2025-06-01" }, entretiens: [{ type: "controle_technique", date: "2024-01-10", km: null, description: "" }] }), "ct");
    assert.equal(champPlusRecent.date, "2027-06-01");
  });
  test("moins de 4 ans : premier contrôle exact, rien à compléter", () => {
    assert.equal(get(run({ vehicle: { mise_en_circulation: "2023-03-10" } }), "ct").aCompleter, null);
  });
  test("sans date de mise en circulation ni contrôle : à compléter", () => {
    const ct = get(run(), "ct");
    assert.equal(ct.statut, "inconnu");
    assert.equal(ct.date, null);
    assert.equal(ct.aCompleter, "vehicule");
  });
});

describe("assurance et pneus hiver", () => {
  test("assurance renouvelée chaque année", () => {
    assert.equal(get(run({ vehicle: { assurance_echeance: "2025-03-01" } }), "assurance").date, "2027-03-01");
    assert.equal(get(run({ vehicle: { assurance_echeance: "2026-10-20" } }), "assurance").statut, "bientot");
    assert.equal(get(run(), "assurance"), undefined, "rien si pas d'échéance saisie");
  });
  test("pneus hiver : monter avant le 1er novembre, démonter à partir du 1er avril", () => {
    const monter = get(run({ vehicle: { pneus_hiver: 1 } }), "pneus-hiver");
    assert.equal(monter.titre, "Monter les pneus hiver");
    assert.equal(monter.date, "2026-11-01");
    assert.equal(monter.statut, "bientot");
    assert.match(monter.note, /Loi Montagne/);
    const dec = get(computeAvenir({ vehicle: { ...VIDE, pneus_hiver: 1 }, today: "2026-12-15" }), "pneus-hiver");
    assert.equal(dec.titre, "Démonter les pneus hiver");
    assert.equal(dec.date, "2027-04-01");
    assert.equal(get(computeAvenir({ vehicle: { ...VIDE, pneus_hiver: 1 }, today: "2026-03-20" }), "pneus-hiver").date, "2026-04-01");
    assert.equal(get(run(), "pneus-hiver"), undefined, "rappel facultatif");
  });
});

describe("vidange", () => {
  test("intervalle : fiche liée, sinon 15 000 km ou 1 an, sinon valeur de l'utilisateur", () => {
    assert.deepEqual(get(run(), "vidange").intervalle, { ...VIDANGE_DEFAUT, source: "defaut" });
    assert.deepEqual(get(run({ fiche: fiche("renault-clio-4-15-dci") }), "vidange").intervalle, { km: 20000, mois: 12, source: "fiche" });
    assert.deepEqual(get(run({ fiche: fiche("renault-clio-4-15-dci"), vehicle: { vidange_km: 10000, vidange_mois: 6 } }), "vidange").intervalle, { km: 10000, mois: 6, source: "vous" });
  });
  test("sans vidange dans le carnet : à compléter", () => {
    const v = get(run(), "vidange");
    assert.equal(v.statut, "inconnu");
    assert.equal(v.aCompleter, "carnet");
  });
  test("prochaine vidange à partir de la dernière du carnet : date ou km, le premier atteint", () => {
    const loin = get(run({ entretiens: [{ type: "vidange", date: "2026-01-10", km: 41000, description: "" }] }), "vidange");
    assert.equal(loin.date, "2027-01-10");
    assert.equal(loin.km, 56000);
    assert.equal(loin.kmRestants, 4000);
    assert.equal(loin.statut, "plus_tard");
    const parDate = get(run({ entretiens: [{ type: "vidange", date: "2025-11-01", km: 48000, description: "" }] }), "vidange");
    assert.equal(parDate.statut, "bientot", "12 mois bientôt atteints, même s'il reste des km");
    const parKm = get(run({ fiche: fiche("renault-clio-4-15-dci"), entretiens: [{ type: "vidange", date: "2026-05-01", km: 30000, description: "" }] }), "vidange");
    assert.equal(parKm.km, 50000);
    assert.equal(parKm.statut, "retard", "20 000 km dépassés, même si la date est loin");
  });
  test("vidange notée sans kilométrage : estimé d'après les relevés", () => {
    const releves = [{ date: "2026-01-01", km: 40000 }, { date: "2026-07-01", km: 46000 }];
    const v = get(run({ releves, entretiens: [{ type: "vidange", date: "2026-04-01", km: null, description: "" }] }), "vidange");
    assert.equal(v.km, 42983 + 15000);
  });
});

describe("prochains entretiens et pannes de la fiche", () => {
  const f208 = fiche("peugeot-208-1-12-puretech");
  test("ce qui arrive, à quel km et à quelle date estimée", () => {
    const res = run({ fiche: f208 });
    const bougies = res.items.find(it => /Bougies/.test(it.titre));
    assert.equal(bougies.categorie, "entretien");
    assert.equal(bougies.km, 60000);
    assert.equal(bougies.kmRestants, 8000);
    assert.equal(bougies.dateEstimee, true);
    assert.equal(bougies.date, "2027-06-15"); // 8 000 km à 1 000 km par mois = 8 mois ≈ 244 jours
    assert.ok(!res.items.some(it => it.categorie === "entretien" && /Vidange/.test(it.titre)), "la vidange est un rappel, pas en double");
  });
  test("déjà fait d'après le carnet : le suivant est recalculé", () => {
    const res = run({ fiche: f208, kilometrage: { dernier: { date: TODAY, km: 130000 }, moyenneMensuelle: 1000 },
      entretiens: [{ type: "reparation", date: "2024-01-10", km: 60000, description: "Remplacement des bougies d'allumage" },
                   { type: "distribution", date: "2025-02-01", km: 101000, description: "Kit courroie" }] });
    const bougies = res.items.find(it => /Bougies/.test(it.titre));
    assert.equal(bougies.km, 120000);
    assert.equal(bougies.statut, "retard");
    const courroie = res.items.find(it => /Courroie/.test(it.titre));
    assert.equal(courroie.km, 201000);
    assert.equal(courroie.statut, "plus_tard");
  });
  test("dépassé sans trace dans le carnet : « à vérifier », pas « en retard »", () => {
    const res = run({ fiche: f208, kilometrage: { dernier: { date: TODAY, km: 130000 }, moyenneMensuelle: 1000 } });
    const courroie = res.items.find(it => /Courroie/.test(it.titre));
    assert.equal(courroie.statut, "verifier");
    assert.match(courroie.texte, /vérifiez/);
    assert.equal(res.enRetard, 0);
  });
  test("pannes connues : « à surveiller », jamais certaines ni en retard", () => {
    const res = run({ fiche: f208, kilometrage: { dernier: { date: TODAY, km: 85000 }, moyenneMensuelle: 1000 } });
    const pannes = res.items.filter(it => it.categorie === "surveiller");
    assert.equal(pannes.length, f208.pannes.length);
    assert.ok(pannes.every(p => p.statut === "surveiller" && /pas certain/.test(p.texte)));
    assert.match(pannes.find(p => p.km === 80000).texte, /dans cette zone/);
  });
  test("correspondance entre entretiens de la fiche et carnet", () => {
    assert.deepEqual(kindOf("Vidange avec une huile à la norme constructeur exacte"), { type: "vidange", motCle: "vidange" });
    assert.equal(kindOf("Vidange de la boîte DSG (versions automatiques)").type, null, "la boîte n'est pas une vidange moteur");
    assert.equal(kindOf("Courroie de distribution et pompe à eau").type, "distribution");
    assert.equal(kindOf("Kit d'embrayage").motCle, "embrayage");
  });
});

describe("voitures incomplètes", () => {
  test("sans relevés : échéances en km sans date, statut à compléter", () => {
    const res = computeAvenir({ vehicle: { ...VIDE, mise_en_circulation: "2023-03-10" }, fiche: fiche("peugeot-208-1-12-puretech"), today: TODAY });
    assert.equal(res.kmAujourdhui, null);
    const bougies = res.items.find(it => /Bougies/.test(it.titre));
    assert.equal(bougies.km, 60000);
    assert.equal(bougies.date, null);
    assert.equal(bougies.statut, "inconnu");
    assert.equal(get(res, "ct").statut, "plus_tard", "le contrôle technique reste calculable");
  });
  test("sans fiche : ni entretiens ni pannes de fiche, vidange par défaut", () => {
    const res = run();
    assert.ok(res.items.every(it => it.categorie === "rappel"));
    assert.equal(get(res, "vidange").intervalle.km, 15000);
  });
  test("sans rien : aucun plantage, rien d'urgent", () => {
    const res = computeAvenir({ vehicle: VIDE, today: TODAY });
    assert.equal(res.plusUrgent, null);
    assert.equal(res.enRetard, 0);
  });
});

describe("tri et résumé", () => {
  test("du plus urgent au plus lointain ; le plus urgent pour la carte", () => {
    const res = run({
      fiche: fiche("peugeot-208-1-12-puretech"),
      vehicle: { mise_en_circulation: "2022-11-01", assurance_echeance: "2027-01-15", pneus_hiver: 1 },
      entretiens: [{ type: "vidange", date: "2025-09-01", km: 40000, description: "" }],
      rappels: [{ id: 7, titre: "Balais d'essuie-glace", date: "2026-12-01", km: null }, { id: 8, titre: "Géométrie", date: null, km: 53500 }],
    });
    const statuts = res.items.map(it => it.statut);
    const rang = { retard: 0, bientot: 1, verifier: 2, plus_tard: 3, surveiller: 3, inconnu: 4 };
    assert.deepEqual(statuts, [...statuts].sort((a, b) => rang[a] - rang[b]), "statuts dans l'ordre");
    assert.equal(res.items[0].cle, "vidange"); // 12 mois dépassés
    assert.equal(res.plusUrgent.cle, "vidange");
    assert.equal(res.enRetard, 1);
    const bientot = res.items.filter(it => it.statut === "bientot").map(it => it.cle);
    assert.deepEqual(bientot.sort(), ["ct", "pneus-hiver"], "les deux dans 18 jours");
    assert.equal(get(res, "libre-8").statut, "plus_tard", "1 500 km restants");
    assert.equal(get(res, "libre-8").fait.description, "Géométrie");
  });
});
