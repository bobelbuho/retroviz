// Route /api/chat : la page envoie le mode, la conversation et la voiture ; le serveur ajoute ses consignes
// (prompts.js) et les fiches de la base, puis relaie la réponse de l'IA en flux.
import express from "express";
import { buildContext } from "./knowledge.js";
import { buildSystem, cleanAchat, buildAchatPrompt, designationAchat, MODES_VALIDES } from "./prompts.js";

export const MAX_HISTORIQUE = 12; // derniers messages gardés de la conversation

// Nettoie la conversation : rôles user/assistant seulement, texte non vide, tours consécutifs du même rôle fusionnés.
export function cleanMessages(raw) {
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
  // On garde les derniers échanges, en commençant toujours par un message de l'utilisateur.
  let kept = out.slice(-MAX_HISTORIQUE);
  while (kept.length && kept[0].role !== "user") kept = kept.slice(1);
  if (!kept.length || kept[kept.length - 1].role !== "user") return null;
  const size = kept.reduce((n, m) => n + m.content.length, 0);
  return size > 100_000 ? null : kept;
}

function errorCode(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 400) return "invalid_request";
  return "upstream_error";
}

// client : client Anthropic (ou faux client dans les tests).
export function createChat({ client, kb, model, maxTokens = 8000, log = console.error }) {
  const router = express.Router();

  router.post("/api/chat", async (req, res) => {
    const b = req.body || {};
    const mode = b.mode;
    if (!MODES_VALIDES.includes(mode)) return res.status(400).json({ code: "invalid_request", error: "Mode inconnu." });
    const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

    let messages, vehicule, texte;
    if (mode === "achat") {
      const { data, error } = cleanAchat(b.achat);
      if (error) return res.status(400).json({ code: "invalid_request", error });
      messages = [{ role: "user", content: buildAchatPrompt(data) }];
      vehicule = designationAchat(data);
      texte = "";
    } else {
      messages = cleanMessages(b.messages);
      if (!messages) return res.status(400).json({ code: "invalid_request", error: "Conversation invalide." });
      vehicule = str(b.vehicule, 300);
      // Recherche dans la base : les 3 derniers messages de l'utilisateur, le plus récent en premier.
      texte = messages.filter(m => m.role === "user").slice(-3).reverse().map(m => m.content).join("\n").slice(0, 6000);
    }

    const { text: kbText, sources } = buildContext({ vehicule, texte }, kb);
    // Fiches utilisées, en JSON encodé pour rester en ASCII dans l'en-tête HTTP.
    res.setHeader("X-Retroviz-Sources", encodeURIComponent(JSON.stringify(sources)));

    const stream = client.beta.messages.stream({
      model, max_tokens: maxTokens,
      // Si le modèle décline la demande, l'API la relance sur un autre modèle (repli côté serveur).
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      system: buildSystem({ mode, vehicule, kbText }),
      messages,
    });
    res.on("close", () => { if (!res.writableEnded) stream.abort(); });

    let started = false;
    stream.on("text", delta => {
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
      log("Erreur API Claude :", err?.status, err?.message);
      if (!started) res.status(err?.status || 500).json({ code: errorCode(err?.status), error: err?.message || "Erreur" });
      else res.end();
    }
  });

  return router;
}
