// Lancement de l'Observateur : npm run observer -- --modele "Clio IV"   (npm run observer -- --aide pour l'aide)
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { openDb } from "../db.js";
import { loadKnowledge, DATA_DIR } from "../knowledge.js";
import { createRelecture } from "../relecture.js";
import { createPropositions } from "../propositions.js";
import { createRetours } from "../retours.js";
import { createAvis } from "../avis.js";
import { today } from "../kilometrage.js";
import { createWeb } from "../observateur/web.js";
import { createIA } from "../observateur/ia.js";
import { createBudget } from "../observateur/couts.js";
import { passage, PILOTE } from "../observateur/index.js";

const AIDE = `L'Observateur cherche, extrait et recoupe des informations, puis crée des propositions à valider dans la page « Relecture ».

Utilisation : npm run observer -- [options]
  --modele "Clio IV"     modèle à observer (option répétable)
  --pilote               les 3 modèles du pilote : ${PILOTE.join(", ")}
  --prioritaires [N]     les N voitures les plus demandées sans fiche (5 par défaut)
  --hebdo                passage hebdomadaire : tous les modèles de la base + 5 prioritaires
  --max-pages N          pages lues au plus par modèle (8 par défaut)
  --semaines N           semaines de rapports Safety Gate lues (8 par défaut)
  --sans-web             seulement les données officielles (gratuit, sans clé API)
  --sans-officiel        seulement la recherche web
  --simulation           n'écrit rien : affiche ce qui serait proposé
  --planifier            explique comment lancer le passage hebdomadaire automatiquement

Variables du fichier .env : ANTHROPIC_API_KEY, OBSERVER_BUDGET_EUR (budget mensuel en euros, obligatoire pour la recherche web),
OBSERVER_MODEL (sinon MODEL), OBSERVER_EUR_PAR_USD (conversion, 0.92 par défaut).`;

function args(argv) {
  const o = { modeles: [], maxPages: 8, semaines: 8 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], suivant = () => argv[++i];
    if (a === "--modele") o.modeles.push(suivant());
    else if (a === "--pilote") o.pilote = true;
    else if (a === "--prioritaires") { o.prioritaires = /^\d+$/.test(argv[i + 1] || "") ? +suivant() : 5; }
    else if (a === "--hebdo") o.hebdo = true;
    else if (a === "--max-pages") o.maxPages = Math.max(1, +suivant() || 8);
    else if (a === "--semaines") o.semaines = Math.max(1, +suivant() || 8);
    else if (a === "--sans-web") o.sansWeb = true;
    else if (a === "--sans-officiel") o.sansOfficiel = true;
    else if (a === "--simulation") o.simulation = true;
    else if (a === "--planifier") o.planifier = true;
    else if (a === "--aide" || a === "--help") o.aide = true;
    else throw new Error(`option inconnue : ${a}`);
  }
  return o;
}

const PLANIFIER = `Lancer l'Observateur chaque semaine (le lundi à 3 h) :

Windows (Planificateur de tâches), dans une invite de commandes :
  schtasks /Create /TN "Retroviz Observateur" /SC WEEKLY /D MON /ST 03:00 /TR "cmd /c cd /d ${process.cwd()} && npm run observer -- --hebdo >> storage\\observateur.log 2>&1"

Linux ou macOS (cron), avec « crontab -e » :
  0 3 * * 1 cd ${process.cwd()} && npm run observer -- --hebdo >> storage/observateur.log 2>&1

Le budget mensuel (OBSERVER_BUDGET_EUR) arrête l'Observateur dès qu'il est atteint.`;

async function main() {
  let o;
  try { o = args(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n\n${AIDE}`); process.exit(2); }
  if (o.aide) return console.log(AIDE);
  if (o.planifier) return console.log(PLANIFIER);

  const db = openDb();
  const kb = loadKnowledge();
  const sources = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "sources.json"), "utf8"));
  const relecture = createRelecture({ dataDir: DATA_DIR, kb });
  const propositions = createPropositions(db, relecture);
  const retours = createRetours(db);

  const cibles = [...o.modeles];
  if (o.pilote) cibles.push(...PILOTE);
  if (o.hebdo) cibles.push(...new Set(kb.vehicules.map(f => `${f.marque} ${f.generation || f.modele}`)));
  if (o.prioritaires || o.hebdo) cibles.push(...retours.prioritaires(o.prioritaires || 5).map(p => p.vehicule).filter(v => v && !v.startsWith("(")));
  const uniques = [...new Set(cibles.map(c => c.trim()).filter(Boolean))];
  if (!uniques.length) { console.error(`Aucun modèle indiqué.\n\n${AIDE}`); process.exit(2); }

  const budgetEur = Number(process.env.OBSERVER_BUDGET_EUR) || 0;
  const eurParUsd = Number(process.env.OBSERVER_EUR_PAR_USD) || 0.92;
  const model = process.env.OBSERVER_MODEL || process.env.MODEL || "claude-sonnet-5-5";
  const debutMois = new Date().toISOString().slice(0, 7) + "-01";
  const dejaDepense = db.prepare("SELECT COALESCE(SUM(cout_eur), 0) AS eur FROM observateur_passages WHERE debut >= ?").get(debutMois).eur;
  const budget = createBudget({ budgetEur, depenseDuMois: () => dejaDepense, eurParUsd });

  let web = !o.sansWeb;
  if (web && !process.env.ANTHROPIC_API_KEY) { console.log("⚠️  Pas de clé ANTHROPIC_API_KEY : recherche web et extraction désactivées (données officielles seulement)."); web = false; }
  if (web && !budgetEur) { console.log("⚠️  OBSERVER_BUDGET_EUR non défini dans .env : recherche web et extraction désactivées. Exemple : OBSERVER_BUDGET_EUR=10"); web = false; }
  if (web && budget.restant() <= 0) { console.log(`⚠️  Budget du mois déjà atteint (${dejaDepense.toFixed(2)} € sur ${budgetEur} €) : recherche web désactivée.`); web = false; }

  const ligne = l => console.log(`  ${l.type === "refus" ? "⛔" : l.type === "rappel" ? "🛡️ " : l.type === "erreur" ? "⚠️ " : l.type === "cout" ? "💶" : "•"} ${l.message}${l.url ? ` — ${l.url}` : ""}`);
  const ia = web ? createIA({ client: new Anthropic(), model, budget, log: ligne }) : null;
  // Avis de propriétaires Rétroviz : une source de plus, de type « proprietaires » (jamais suffisante seule pour confirmer).
  const avis = createAvis(db, { kb });
  const deps = { db, kb, web: createWeb({ sources }), ia, relecture, propositions, budget, sources, model, today, avis, log: ligne };

  console.log(`🔭 Observateur${o.simulation ? " (simulation : rien n'est écrit)" : ""} — ${uniques.length} modèle(s), budget ${budgetEur ? `${budget.restant().toFixed(2)} € restants ce mois-ci` : "non défini"}, modèle d'IA ${web ? model : "non utilisé"}`);
  const bilans = [];
  for (const cible of uniques) {
    console.log(`\n▶ ${cible}`);
    const b = await passage(cible, deps, { officiels: !o.sansOfficiel, web, maxPages: o.maxPages, simulation: o.simulation, semainesSafetyGate: o.semaines });
    bilans.push(b);
    console.log(`  ⇒ ${b.statut} : ${b.sources} source(s) consultée(s), ${b.refusees} page(s) écartée(s), ${b.faits} fait(s), ${b.propositions} proposition(s), ${b.rappels} rappel(s) officiel(s), ${b.coutEur.toFixed(4)} €`);
    if (b.statut === "budget_atteint") { console.log("\nBudget atteint : arrêt de l'Observateur."); break; }
  }
  const total = bilans.reduce((n, b) => n + b.coutEur, 0);
  console.log(`\nTotal : ${bilans.reduce((n, b) => n + b.propositions, 0)} proposition(s), ${bilans.reduce((n, b) => n + b.rappels, 0)} rappel(s) officiel(s), ${total.toFixed(4)} €. Propositions à valider dans la page « Relecture ».`);
  // Échantillon pour juger la qualité (pilote).
  const exemples = bilans.flatMap(b => b.exemples.map(p => ({ ...p, cible: b.cible })));
  if (exemples.length) {
    const fichier = path.join("storage", `observateur-echantillon-${new Date().toISOString().slice(0, 10)}.json`);
    fs.mkdirSync("storage", { recursive: true });
    fs.writeFileSync(fichier, JSON.stringify(exemples, null, 2));
    console.log(`Échantillon des propositions : ${fichier}`);
  }
}

main().catch(e => { console.error("Erreur :", e); process.exit(1); });
