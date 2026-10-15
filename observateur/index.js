// L'Observateur : cherche, extrait, recoupe et propose des améliorations de la base Rétroviz.
// Il ne modifie jamais directement les fiches, sauf pour ajouter les rappels officiels (RappelConso, Safety Gate).
import { findVehicle, normalize } from "../knowledge.js";
import { rappelConso, safetyGate, nhtsa, ademe, viseModele, peutConcerner } from "./officiels.js";
import { BudgetAtteint } from "./ia.js";
import { recouper } from "./recoupement.js";
import { proposerPourFiche, proposerNouvelleFiche, ficheDe, elementRappel } from "./comparaison.js";
import { coutMaxEur } from "./couts.js";

export const QUESTIONS = [
  c => `${c} pannes fréquentes et fiabilité`,
  c => `${c} problèmes connus et kilométrage`,
  c => `${c} prix des réparations et de l'entretien (distribution, embrayage)`,
  c => `${c} avis de mécanicien et points faibles`,
];
// Les trois modèles du pilote.
export const PILOTE = ["Renault Clio IV", "Peugeot 208 I", "Volkswagen Golf VII"];
const NHTSA_MARQUES = { volkswagen: "volkswagen", toyota: "toyota", ford: "ford", bmw: "bmw", mercedes: "mercedes-benz", audi: "audi", fiat: "fiat", mini: "mini", volvo: "volvo", hyundai: "hyundai", kia: "kia", nissan: "nissan", honda: "honda", mazda: "mazda", skoda: null, peugeot: null, renault: null, citroen: null, dacia: null, opel: null };

// Fiches de la base pour une cible (« Clio IV », « Peugeot 208 I »…).
// Une génération nommée (« Clio IV ») écarte les autres générations du modèle : on garde les fiches les mieux classées.
export function fichesDeCible(kb, cible) {
  const r = findVehicle(cible, kb, 50).filter(x => x.correspondance !== "moteur");
  const max = Math.max(...r.map(x => x.score));
  return r.filter(x => x.score === max).map(x => x.fiche);
}

// Années à interroger pour une période « 2012-2019 » : début, milieu, fin (suffisant pour les rappels).
export function anneesRepresentatives(annees) {
  const m = String(annees || "").match(/(\d{4})\D+(\d{4})/);
  if (!m) return [];
  const a = +m[1], b = +m[2];
  return [...new Set([a, Math.round((a + b) / 2), b])];
}

/**
 * Un passage de l'Observateur sur une cible.
 * deps : { db, kb, web, ia (null sans clé API), relecture, propositions, budget, sources, model, today, log }
 * options : { officiels, web, maxPages, simulation, semainesSafetyGate }
 */
export async function passage(cible, deps, options = {}) {
  const { db, kb, web, ia, relecture, propositions, budget, sources, model, today } = deps;
  const opt = { officiels: true, web: true, maxPages: 8, simulation: false, semainesSafetyGate: 8, ...options };
  const journal = [];
  const log = l => { const ligne = { t: new Date().toISOString(), ...l }; journal.push(ligne); deps.log?.(ligne); };
  const compte = { sources: 0, refusees: 0, faits: 0, propositions: 0, rappels: 0 };
  const debut = new Date().toISOString();
  const coutAvant = budget.passage; // le même budget peut servir à plusieurs passages d'un même lancement
  const { lastInsertRowid } = db.prepare("INSERT INTO observateur_passages (debut, cible) VALUES (?, ?)").run(debut, cible);
  const passageId = Number(lastInsertRowid);
  let statut = "termine";
  const exemples = [];

  const fiches = fichesDeCible(kb, cible);
  const marque = fiches[0]?.marque || cible.split(" ")[0];
  const modele = fiches[0]?.modele || cible.split(" ").slice(1).join(" ");
  const generation = fiches[0]?.generation || modele;
  log({ type: "info", message: `Cible « ${cible} » : ${fiches.length} fiche${fiches.length > 1 ? "s" : ""} dans la base (${fiches.map(f => f.id).join(", ") || "aucune"}).` });

  // Écrit une proposition (sauf en simulation) et la garde comme exemple pour le compte rendu.
  const proposer = p => {
    exemples.push(p);
    if (opt.simulation) { compte.propositions++; return; }
    if (propositions.creer({ ...p, passageId }) != null) compte.propositions++;
  };

  // Rappels officiels : ajoutés directement aux fiches visées (sans doublon), avec la mention « source officielle ».
  // Un rappel qui cite le modèle sans sa génération (« 208 » : 208 I ou 208 II ?) devient une proposition à trancher.
  function ajouterRappels(rappels, nomSource) {
    for (const fiche of fiches) {
      const bonneMarque = r => !r.marque || normalize(r.marque).includes(normalize(fiche.marque));
      const texte = r => `${r.modeles} ${r.produit || ""}`;
      const vises = rappels.filter(r => bonneMarque(r) && viseModele(texte(r), fiche));
      const actuelle = relecture.lire("vehicules").find(f => f.id === fiche.id);
      const deja = new Set((actuelle.rappels || []).map(r => r.url));
      const ecartes = [];
      const ambigus = rappels.filter(r => bonneMarque(r) && !viseModele(texte(r), fiche) && ` ${normalize(texte(r))} `.includes(` ${normalize(fiche.modele)} `) && !deja.has(r.url))
        .filter(r => peutConcerner(r, fiche) || (ecartes.push(r), false));
      if (ecartes.length) log({ type: "info", message: `${nomSource} : ${ecartes.length} rappel${ecartes.length > 1 ? "s" : ""} « ${fiche.modele} » écarté${ecartes.length > 1 ? "s" : ""} pour ${fiche.id} (autre génération ou période de production différente)` });
      for (const r of ambigus) {
        proposer({ origine: "observateur", type: "ajout", collection: "vehicules", cibleId: fiche.id, champ: "rappels", valeur: elementRappel(r),
          resume: `Rappel ${nomSource} qui cite « ${fiche.modele} » sans préciser la génération : concerne-t-il ${fiche.generation} ?`,
          sources: [{ url: r.url, type: "officiel", titre: `${nomSource} ${r.date || ""}`.trim() }], confiance: "signale", nbSources: 1 });
      }
      const nouveaux = vises.filter(r => r.url && !deja.has(r.url)).map(elementRappel);
      if (!nouveaux.length) continue;
      compte.rappels += nouveaux.length;
      log({ type: "rappel", message: `${nomSource} : ${nouveaux.length} rappel${nouveaux.length > 1 ? "s" : ""} officiel${nouveaux.length > 1 ? "s" : ""} pour ${fiche.id}`, urls: nouveaux.map(r => r.url) });
      if (opt.simulation) continue;
      const r = relecture.enregistrer("vehicules", fiche.id, { ...actuelle, rappels: [...(actuelle.rappels || []), ...nouveaux] }, "observateur", `rappels officiels ajoutés (${nomSource})`);
      if (r.error) log({ type: "erreur", message: `rappels non écrits pour ${fiche.id} : ${r.error}` });
    }
  }

  try {
    /* ---------- 1. Données officielles ---------- */
    if (opt.officiels) {
      try {
        const rc = await rappelConso(web, marque, modele);
        compte.sources++;
        log({ type: "source", message: `RappelConso : ${rc.length} rappel${rc.length > 1 ? "s" : ""} automobiles pour « ${marque} ${modele} »` });
        ajouterRappels(rc, "RappelConso");
      } catch (e) { log({ type: "erreur", message: `RappelConso : ${e.message}` }); }
      try {
        const sg = await safetyGate(web, opt.semainesSafetyGate);
        compte.sources++;
        const marqueN = normalize(marque);
        const vises = sg.filter(a => normalize(a.marque).includes(marqueN));
        log({ type: "source", message: `Safety Gate : ${sg.length} alerte${sg.length > 1 ? "s" : ""} véhicules sur ${opt.semainesSafetyGate} semaines, ${vises.length} pour ${marque}` });
        ajouterRappels(vises, "Safety Gate");
      } catch (e) { log({ type: "erreur", message: `Safety Gate : ${e.message}` }); }
      const make = NHTSA_MARQUES[normalize(marque)];
      if (make) {
        try {
          const annees = anneesRepresentatives(fiches[0]?.annees);
          const r = await nhtsa(web, make, normalize(modele).split(" ")[0], annees);
          compte.sources++;
          const top = Object.entries(r.plaintes.parOrgane).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([o, n]) => `${o} ${n}`).join(", ");
          log({ type: "source", message: `NHTSA (États-Unis, années ${annees.join(", ")}) : ${r.rappels.length} rappel${r.rappels.length > 1 ? "s" : ""}, ${r.plaintes.total} plaintes (${top || "aucune"})` });
          // Rappels américains : proposés (pas ajoutés d'office), car le modèle américain peut différer du modèle européen.
          for (const f of fiches) for (const rap of r.rappels) {
            proposer({ origine: "observateur", type: "ajout", collection: "vehicules", cibleId: f.id, champ: "rappels",
              valeur: { ...elementRappel(rap), mention: "rappel aux États-Unis (modèle américain), texte d'origine en anglais", langue: "en" },
              resume: `Rappel NHTSA ${rap.numero} (${rap.organe}) aux États-Unis, texte en anglais : à vérifier pour le modèle européen et à traduire avant d'accepter.`,
              sources: [{ url: rap.url, type: "officiel", titre: `NHTSA ${rap.numero}` }], confiance: "signale", nbSources: 1 });
          }
        } catch (e) { log({ type: "erreur", message: `NHTSA : ${e.message}` }); }
      } else log({ type: "info", message: `NHTSA : ${marque} n'est pas vendue aux États-Unis, ignoré.` });
      try {
        const ad = await ademe(web, marque, modele);
        compte.sources++;
        log({ type: "source", message: `ADEME : ${ad.length} version${ad.length > 1 ? "s" : ""} neuve${ad.length > 1 ? "s" : ""} actuelle${ad.length > 1 ? "s" : ""} (ne couvre pas les générations d'occasion plus anciennes)` });
      } catch (e) { log({ type: "erreur", message: `ADEME : ${e.message}` }); }
    }

    /* ---------- 2. Recherche web, lecture, extraction ---------- */
    if (opt.web && !ia) log({ type: "info", message: "Recherche web et extraction ignorées : pas de clé API Claude." });
    if (opt.web && ia) {
      const domaines = sources.filter(s => s.methode === "recherche_web" && s.autorisee).flatMap(s => s.domaines).filter(d => !d.startsWith("www."));
      const motorisations = [...new Set(fiches.flatMap(f => (f.moteurs || []).slice(0, 1)))];
      const sujets = motorisations.length ? motorisations.map(m => `${marque} ${generation} ${m}`) : [cible];
      const pages = new Map();
      for (const sujet of sujets) for (const q of QUESTIONS) {
        try {
          for (const p of await ia.rechercher(q(sujet), domaines)) if (!pages.has(p.url)) pages.set(p.url, { ...p, sujet });
        } catch (e) { if (e instanceof BudgetAtteint) throw e; log({ type: "erreur", message: `recherche : ${e.message}` }); }
      }
      log({ type: "info", message: `${pages.size} page${pages.size > 1 ? "s" : ""} trouvée${pages.size > 1 ? "s" : ""} par la recherche` });

      // Garder de quoi regrouper les faits à la fin (sinon, extractions payées pour rien).
      const reserve = coutMaxEur(model, { caracteres: 60_000, maxTokens: 8000 }, budget.eurParUsd);
      const faits = [];
      // Pannes citées par plusieurs avis de propriétaires Rétroviz : regroupées et recoupées avec le reste.
      for (const f of deps.avis?.faitsPourObservateur({ marque, modele }) || []) faits.push({ ...f, id: faits.length + 1 });
      if (faits.length) log({ type: "source", message: `${faits.length} panne${faits.length > 1 ? "s" : ""} citée${faits.length > 1 ? "s" : ""} par plusieurs avis de propriétaires Rétroviz` });
      let lues = 0;
      for (const p of pages.values()) {
        if (lues >= opt.maxPages) break;
        const lu = await web.lirePage(p.url);
        if (lu.refus) { compte.refusees++; log({ type: "refus", message: lu.refus, url: p.url }); continue; }
        if (budget.restant() < reserve + coutMaxEur(model, { caracteres: lu.texte.length + 3000, maxTokens: 4000 }, budget.eurParUsd)) {
          log({ type: "info", message: "Budget presque atteint : collecte arrêtée pour garder de quoi regrouper les faits." });
          statut = "budget_atteint";
          break;
        }
        lues++; compte.sources++;
        const source = web.sourceDe(new URL(lu.url).hostname);
        const extraits = await ia.extraire({ texte: lu.texte, url: lu.url, cible: p.sujet });
        log({ type: "source", message: `${extraits.length} fait${extraits.length > 1 ? "s" : ""} : ${source?.nom || ""}`, url: lu.url });
        for (const f of extraits) faits.push({ ...f, id: faits.length + 1, url: lu.url, typeSource: source?.type || "", titrePage: p.titre, datePage: p.date });
      }
      compte.faits = faits.length;

      /* ---------- 3. Regroupement, recoupement, propositions ---------- */
      if (faits.length) {
        const groupes = recouper(await ia.regrouper(faits, `${marque} ${generation}`), new Map(faits.map(f => [f.id, f])));
        log({ type: "info", message: `${groupes.length} groupe${groupes.length > 1 ? "s" : ""} de faits, dont ${groupes.filter(g => g.confiance === "confirme").length} confirmé(s)` });
        const parMotorisation = new Map();
        for (const g of groupes) {
          const cle = normalize(g.motorisation || "");
          if (!parMotorisation.has(cle)) parMotorisation.set(cle, { motorisation: g.motorisation || "", groupes: [] });
          parMotorisation.get(cle).groupes.push(g);
        }
        for (const { motorisation, groupes: gs } of parMotorisation.values()) {
          if (!motorisation) { for (const f of fiches) proposerPourFiche(f, gs).forEach(proposer); continue; } // tout le modèle
          const fiche = ficheDe(kb, { marque, modele, generation, motorisation });
          if (fiche) proposerPourFiche(fiche, gs).forEach(proposer);
          else proposer(proposerNouvelleFiche({ marque, modele, generation, motorisation }, gs, today()));
        }
      }
    }
  } catch (e) {
    if (e instanceof BudgetAtteint) { statut = "budget_atteint"; log({ type: "info", message: `Arrêt : ${e.message}.` }); }
    else { statut = "erreur"; log({ type: "erreur", message: e.message }); }
  }

  const cout = Math.round((budget.passage - coutAvant) * 10000) / 10000;
  db.prepare(`UPDATE observateur_passages SET fin = ?, statut = ?, sources = ?, refusees = ?, faits = ?, propositions = ?, rappels = ?, cout_eur = ?, journal = ? WHERE id = ?`)
    .run(new Date().toISOString(), statut, compte.sources, compte.refusees, compte.faits, compte.propositions, compte.rappels, cout, JSON.stringify(journal), passageId);
  return { passageId, cible, statut, ...compte, coutEur: cout, journal, exemples };
}
