// Serveur Rétroviz : sert l'interface (dossier public) et relaie les questions à l'API Claude.
// La clé API reste sur le serveur, elle n'est jamais envoyée au navigateur.
import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 8000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("⚠️  ANTHROPIC_API_KEY absente : copiez .env.example en .env et ajoutez votre clé.");
}

const client = new Anthropic(); // lit ANTHROPIC_API_KEY dans l'environnement
const app = express();
app.use(express.json({ limit: "1mb" }));
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

  const stream = client.messages.stream({ model: MODEL, max_tokens: MAX_TOKENS, messages });
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

app.listen(PORT, () => {
  console.log(`🚗 Rétroviz tourne sur http://localhost:${PORT} (modèle : ${MODEL})`);
});
