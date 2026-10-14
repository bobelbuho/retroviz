// Serveur Rétroviz : sert l'interface (dossier public) et relaie les questions à l'API Claude.
// La clé API reste sur le serveur, elle n'est jamais envoyée au navigateur.
import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { loadKnowledge, DATA_DIR } from "./knowledge.js";
import { createRelecture, parseAdmins } from "./relecture.js";
import { createPropositions } from "./propositions.js";
import { createRetours } from "./retours.js";
import { createChat } from "./chat.js";
import { openDb } from "./db.js";
import { createAuth } from "./auth.js";
import { createGarage } from "./garage.js";
import { createCarnet } from "./carnet.js";
import { createLocalStorage } from "./storage.js";
import { createRappels } from "./rappels.js";
import { createValeur, anthropicEstimator } from "./valeur.js";
import { createVie } from "./vie.js";
import { createBadge } from "./badge.js";
import { createTransfert } from "./transfert.js";
import { createAvis } from "./avis.js";
import { createSchema } from "./schema.js";

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 8000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("⚠️  ANTHROPIC_API_KEY absente : copiez .env.example en .env et ajoutez votre clé.");
}

// Base de connaissances (dossier data/), chargée une fois au démarrage.
const kb = loadKnowledge();
console.log(`📚 Base Rétroviz : ${kb.vehicules.length} fiche(s) véhicule, ${kb.codes.size} code(s) OBD, ${kb.voyants.length} voyant(s), ${kb.pieces.length} pièce(s).`);

// Comptes et garages (fichier storage/retroviz.db par défaut, variable DB_PATH pour le changer).
const db = openDb();
// Factures : stockage local dans storage/uploads/ (variable UPLOAD_DIR pour le changer). Voir storage.js.
const fichiers = createLocalStorage(); // factures et photos de voitures
const carnet = createCarnet(db, fichiers);
const rappels = createRappels(db, kb);

const client = new Anthropic(); // lit ANTHROPIC_API_KEY dans l'environnement
// Valeur indicative : même modèle que l'assistant ; désactivée sans clé API.
const valeur = createValeur(db, { estimate: process.env.ANTHROPIC_API_KEY ? anthropicEstimator(client, MODEL) : null });
const badge = createBadge(db, { rappels });
const garage = createGarage(db, kb, { carnet, rappels, valeur, storage: fichiers, badge });
const vie = createVie(db);
// Dossier partageable, transfert au nouveau propriétaire, notes sur l'historique reçu.
const transfert = createTransfert(db, { carnet, vie, badge, rappels, valeur, storage: fichiers });
// Export RGPD : chaque voiture avec son historique, y compris celui reçu d'anciens propriétaires.
const exportData = uid => {
  const d = garage.exportFor(uid);
  for (const v of d.vehicules) v.changementsDeProprietaire = transfert.datesTransfert(v.id);
  d.avis = avis.exportFor(uid); // y compris ceux sur des voitures vendues depuis
  return d;
};
// Suppression du compte : factures et photos effacées du stockage.
const beforeDeleteUser = uid => { const a = carnet.beforeDeleteUser(uid), b = garage.beforeDeleteUser(uid); return async () => { await a(); await b(); }; };
// Relecture des fiches : réservée aux adresses de ADMIN_EMAILS (séparées par des virgules).
const relecture = createRelecture({ dataDir: DATA_DIR, kb, admins: parseAdmins(process.env.ADMIN_EMAILS), extraTableau: () => tableau() });
const propositions = createPropositions(db, relecture);
// Avis de propriétaires : publication depuis le garage, lecture publique, signalements, modération.
const avis = createAvis(db, { kb, isAdmin: relecture.isAdmin });
// Retours sous les réponses, questions sans fiche, statistiques anonymes (avec consentement).
const retours = createRetours(db);
retours.onSignalement = p => propositions.creer(p); // les signalements arrivent dans la Relecture
const depenseDuMois = db.prepare("SELECT COALESCE(SUM(cout_eur), 0) AS eur FROM observateur_passages WHERE debut >= ?");
const derniersPassages = db.prepare("SELECT id, debut, cible, statut, sources, refusees, faits, propositions, rappels, cout_eur FROM observateur_passages ORDER BY id DESC LIMIT 8");
const tableau = () => ({
  propositions: propositions.enAttente(),
  avisSignales: avis.aModerer(),
  retours: retours.statsRetours(),
  questionsSansFiche: retours.prioritaires(5),
  statistiquesPubliables: retours.statistiques().length,
  depenseObservateurMois: Math.round(depenseDuMois.get(new Date().toISOString().slice(0, 7) + "-01").eur * 100) / 100,
  budgetObservateur: Number(process.env.OBSERVER_BUDGET_EUR) || 0,
  passagesObservateur: derniersPassages.all(),
});
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(createAuth(db, { exportData, beforeDeleteUser, isAdmin: relecture.isAdmin }));
app.use(garage);
app.use(carnet);
app.use(rappels);
app.use(valeur);
app.use(vie);
app.use(transfert);
app.use(createSchema(db, kb, { rappels })); // schéma interactif des pièces
app.use(badge);
app.use(relecture);
app.use(propositions);
app.use(avis);
app.use(retours);
app.use(express.static("public"));
// pdf.js (navigateur) : conversion des factures PDF en image pour les masquer, sans service extérieur.
app.use("/vendor/pdfjs", express.static("node_modules/pdfjs-dist/build", { index: false }));

// Assistant : consignes et fiches ajoutées côté serveur (chat.js, prompts.js).
app.use(createChat({ client, kb, model: MODEL, maxTokens: MAX_TOKENS, onSansFiche: retours.noterSansFiche }));

// Voyants du tableau de bord (fiches et icônes), publics.
app.get("/api/voyants", (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({ voyants: kb.voyants });
});

// Fiche d'un code OBD de la base (ex. /api/codes/P0300).
app.get("/api/codes/:code", (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const fiche = kb.codes.get(code);
  if (!fiche) return res.status(404).json({ code: "not_found", error: `Code ${code} absent de la base Rétroviz.` });
  res.json({ statut: "a_verifier", ...fiche });
});

app.listen(PORT, () => {
  console.log(`🚗 Rétroviz tourne sur http://localhost:${PORT} (modèle : ${MODEL})`);
});
