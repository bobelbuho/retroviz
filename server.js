// Serveur Rétroviz : sert l'interface (dossier public) et relaie les questions à l'API Claude.
// La clé API reste sur le serveur, elle n'est jamais envoyée au navigateur.
import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { loadKnowledge } from "./knowledge.js";
import { createChat } from "./chat.js";
import { openDb } from "./db.js";
import { createAuth } from "./auth.js";
import { createGarage } from "./garage.js";
import { createCarnet } from "./carnet.js";
import { createLocalStorage } from "./storage.js";
import { createRappels } from "./rappels.js";
import { createValeur, anthropicEstimator } from "./valeur.js";

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 8000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("⚠️  ANTHROPIC_API_KEY absente : copiez .env.example en .env et ajoutez votre clé.");
}

// Base de connaissances (dossier data/), chargée une fois au démarrage.
const kb = loadKnowledge();
console.log(`📚 Base Rétroviz : ${kb.vehicules.length} fiche(s) véhicule, ${kb.codes.size} code(s) OBD, ${kb.voyants.length} voyant(s).`);

// Comptes et garages (fichier storage/retroviz.db par défaut, variable DB_PATH pour le changer).
const db = openDb();
// Factures : stockage local dans storage/uploads/ (variable UPLOAD_DIR pour le changer). Voir storage.js.
const carnet = createCarnet(db, createLocalStorage());
const rappels = createRappels(db, kb);

const client = new Anthropic(); // lit ANTHROPIC_API_KEY dans l'environnement
// Valeur indicative : même modèle que l'assistant ; désactivée sans clé API.
const valeur = createValeur(db, { estimate: process.env.ANTHROPIC_API_KEY ? anthropicEstimator(client, MODEL) : null });
const garage = createGarage(db, kb, { carnet, rappels, valeur });
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(createAuth(db, { exportData: garage.exportFor, beforeDeleteUser: carnet.beforeDeleteUser }));
app.use(garage);
app.use(carnet);
app.use(rappels);
app.use(valeur);
app.use(express.static("public"));

// Assistant : consignes et fiches ajoutées côté serveur (chat.js, prompts.js).
app.use(createChat({ client, kb, model: MODEL, maxTokens: MAX_TOKENS }));

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
