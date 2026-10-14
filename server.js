// Serveur Rétroviz : sert l'interface (dossier public) et relaie les questions à l'API Claude.
// La clé API reste sur le serveur, elle n'est jamais envoyée au navigateur.
import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { loadKnowledge, buildContext } from "./knowledge.js";
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
console.log(`📚 Base Rétroviz : ${kb.vehicules.length} fiche(s) véhicule, ${kb.codes.size} code(s) OBD.`);

const KB_RULES = `Voici des fiches de la base Rétroviz. Utilise-les en priorité. Les fiches "à vérifier" peuvent contenir des erreurs : dis-le si tu t'appuies dessus. Si la base ne couvre pas la question, dis-le et réponds avec tes connaissances générales en le signalant.`;

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

// Nettoie la conversation : rôles valides, texte non vide, tours consécutifs du même rôle fusionnés.
function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
    const content = String(m.content ?? "").trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + content;
    else out.push({ role: m.role, content });
  }
  if (!out.length || out[0].role !== "user" || out[out.length - 1].role !== "user") return null;
  const size = out.reduce((n, m) => n + m.content.length, 0);
  return size > 200000 ? null : out;
}

function errorCode(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 400) return "invalid_request";
  return "upstream_error";
}

app.post("/api/chat", async (req, res) => {
  const messages = cleanMessages(req.body?.messages);
  if (!messages) return res.status(400).json({ code: "invalid_request", error: "Conversation invalide." });

  // Fiches de la base correspondant au véhicule et au dernier message (champ « context » facultatif).
  const ctx = req.body?.context;
  // texte = les 3 derniers messages de l'utilisateur, le plus récent en premier (c'est lui qu'on garde si on coupe).
  const str = v => (typeof v === "string" ? v.slice(0, 6000) : "");
  const { text: kbText, sources } = ctx && typeof ctx === "object"
    ? buildContext({ vehicule: str(ctx.vehicule), texte: str(ctx.texte) }, kb)
    : { text: "", sources: [] };
  // Liste des fiches utilisées, en JSON encodé pour rester en ASCII dans l'en-tête HTTP.
  res.setHeader("X-Retroviz-Sources", encodeURIComponent(JSON.stringify(sources)));

  const params = { model: MODEL, max_tokens: MAX_TOKENS, messages };
  if (kbText) params.system = `${KB_RULES}\n\n${kbText}`;
  const stream = client.messages.stream(params);
  res.on("close", () => { if (!res.writableEnded) stream.abort(); });

  let started = false;
  stream.on("text", (delta) => {
    if (!started) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      started = true;
    }
    res.write(delta);
  });

  try {
    await stream.finalMessage();
    res.end();
  } catch (err) {
    if (res.writableEnded || res.destroyed) return; // le visiteur a cliqué sur « Arrêter »
    console.error("Erreur API Claude :", err?.status, err?.message);
    if (!started) res.status(err?.status || 500).json({ code: errorCode(err?.status), error: err?.message || "Erreur" });
    else res.end();
  }
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
