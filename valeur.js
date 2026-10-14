// Valeur indicative d'une voiture, estimée par l'IA, avec son historique.
// Aucune donnée personnelle n'est envoyée (ni e-mail, ni surnom, ni garage, ni description libre du carnet),
// et aucune donnée n'est récupérée sur des sites d'annonces : l'IA s'appuie sur ses connaissances générales.
import express from "express";
import { needUser, sameSiteJson } from "./auth.js";
import { stats, today } from "./kilometrage.js";
import { TYPES } from "./carnet.js";

export const VALEUR_MAX = 10_000_000; // € : au-delà, la réponse est jugée invalide
const TYPES_IMPORTANTS = ["distribution", "freins", "pneus", "batterie", "controle_technique", "reparation", "vidange"];

/* ---------- ce qu'on envoie à l'IA ---------- */
// Résumé factuel, sans aucune donnée personnelle. `vehicle` : ligne de la table vehicles.
export function buildInput(vehicle, releves, entretiens) {
  const k = stats(releves);
  const imp = entretiens
    .filter(e => TYPES_IMPORTANTS.includes(e.type))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30)
    .map(e => ({ type: TYPES[e.type], date: e.date, km: e.km ?? null, facture: !!e.facture_key }));
  return {
    marque: vehicle.marque,
    modele: vehicle.modele,
    motorisation: vehicle.motorisation || null,
    boite: vehicle.boite || null,
    annee: vehicle.annee ?? null,
    mise_en_circulation: vehicle.mise_en_circulation || null,
    kilometrage: k.dernier ? { km: k.dernier.km, releve_le: k.dernier.date } : null,
    moyenne_km_par_mois: k.moyenneMensuelle,
    carnet: {
      nombre_entretiens: entretiens.length,
      avec_facture: entretiens.filter(e => e.facture_key).length,
      entretiens_importants: imp,
    },
  };
}

export const SYSTEM = `Tu es un expert indépendant du marché français de la voiture d'occasion. Tu estimes une fourchette de prix de vente entre particuliers, en euros, à partir des seules informations fournies et de tes connaissances générales du marché. Tu n'as accès à aucune annonce : ne prétends jamais en avoir consulté et ne cite aucune cote officielle.

Réponds uniquement avec un objet JSON :
{"basse": entier, "haute": entier, "valeur_probable": entier, "explication": "2 ou 3 phrases simples", "facteurs": [{"facteur": "…", "effet": "plus" | "moins"}], "conseils": ["…"]}

Règles :
- basse ≤ valeur_probable ≤ haute, en euros, arrondis à la centaine.
- 3 à 8 facteurs concrets qui font monter (plus) ou baisser (moins) la valeur : kilométrage par rapport à l'âge, entretiens faits ou à venir (distribution…), factures présentes ou non, réputation du moteur, boîte…
- 2 à 5 conseils pratiques pour mieux vendre cette voiture.
- Si une information manque (kilométrage, motorisation…), élargis la fourchette et dis-le dans l'explication.
- Langage simple, pour un non-spécialiste.`;

export const userPrompt = input => `Voiture à estimer (données fournies par son propriétaire, à la date du ${today()}) :\n${JSON.stringify(input, null, 2)}`;

// Schéma imposé à la réponse de l'IA (sorties structurées). La validation serveur ci-dessous reste la référence.
export const SCHEMA = {
  type: "object",
  properties: {
    basse: { type: "integer" },
    haute: { type: "integer" },
    valeur_probable: { type: "integer" },
    explication: { type: "string" },
    facteurs: {
      type: "array",
      items: {
        type: "object",
        properties: { facteur: { type: "string" }, effet: { type: "string", enum: ["plus", "moins"] } },
        required: ["facteur", "effet"],
        additionalProperties: false,
      },
    },
    conseils: { type: "array", items: { type: "string" } },
  },
  required: ["basse", "haute", "valeur_probable", "explication", "facteurs", "conseils"],
  additionalProperties: false,
};

/* ---------- validation de la réponse ---------- */
// Texte brut de l'IA -> objet JSON (tolère un bloc ```json … ```). Renvoie null si illisible.
export function parseJson(text) {
  const t = String(text ?? "").trim();
  const tries = [t, (t.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)];
  for (const s of tries) {
    if (!s) continue;
    try { const v = JSON.parse(s); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch {}
  }
  return null;
}

// Renvoie { data } (nettoyé) ou { error } (raison technique, pour les journaux).
export function validateEstimation(o) {
  if (!o || typeof o !== "object") return { error: "pas un objet JSON" };
  const n = {};
  for (const k of ["basse", "haute", "valeur_probable"]) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > VALEUR_MAX) return { error: `${k} invalide` };
    n[k] = Math.round(v);
  }
  if (!(n.basse <= n.valeur_probable && n.valeur_probable <= n.haute)) return { error: "fourchette incohérente" };
  if (n.haute > n.basse * 5) return { error: "fourchette trop large" };
  if (typeof o.explication !== "string" || !o.explication.trim() || o.explication.length > 1500) return { error: "explication invalide" };
  if (!Array.isArray(o.facteurs) || o.facteurs.length < 1 || o.facteurs.length > 12) return { error: "facteurs invalides" };
  const facteurs = [];
  for (const f of o.facteurs) {
    if (!f || typeof f.facteur !== "string" || !f.facteur.trim() || f.facteur.length > 300 || !["plus", "moins"].includes(f.effet)) return { error: "facteur invalide" };
    facteurs.push({ facteur: f.facteur.trim(), effet: f.effet });
  }
  if (!Array.isArray(o.conseils) || o.conseils.length > 8 || o.conseils.some(c => typeof c !== "string" || !c.trim() || c.length > 400)) return { error: "conseils invalides" };
  return { data: { ...n, explication: o.explication.trim(), facteurs, conseils: o.conseils.map(c => c.trim()) } };
}

/* ---------- appel à l'IA ---------- */
// Renvoie une fonction estimate(input) -> { text, model }. Remplacée par une fausse IA dans les tests.
export function anthropicEstimator(client, model) {
  return async input => {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      // Si le modèle décline la demande, l'API la relance sur un autre modèle (repli côté serveur).
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: userPrompt(input) }],
    });
    if (response.stop_reason === "refusal") throw Object.assign(new Error("refus du modèle"), { code: "refused" });
    if (response.stop_reason === "max_tokens") throw Object.assign(new Error("réponse coupée"), { code: "truncated" });
    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
    return { text, model: response.model };
  };
}

/* ---------- routeur ---------- */
export function createValeur(db, { estimate, now = today, log = console.error } = {}) {
  const q = {
    owned: db.prepare("SELECT * FROM vehicles WHERE id = ? AND user_id = ?"),
    releves: db.prepare("SELECT date, km FROM releves WHERE vehicle_id = ?"),
    entretiens: db.prepare("SELECT date, km, type, facture_key FROM entretiens WHERE vehicle_id = ?"),
    list: db.prepare("SELECT * FROM estimations WHERE vehicle_id = ? ORDER BY date, id"),
    ofDay: db.prepare("SELECT * FROM estimations WHERE vehicle_id = ? AND date = ?"),
    insert: db.prepare(`INSERT INTO estimations (vehicle_id, date, km, basse, haute, valeur_probable, explication, facteurs, conseils, modele)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  };
  const toPublic = r => ({
    date: r.date, km: r.km, basse: r.basse, haute: r.haute, valeurProbable: r.valeur_probable,
    explication: r.explication, facteurs: JSON.parse(r.facteurs), conseils: JSON.parse(r.conseils),
  });
  const out = (vid, extra = {}) => {
    const list = q.list.all(vid).map(toPublic);
    return { estimations: list, derniere: list.at(-1) || null, peutEstimer: !q.ofDay.get(vid, now()), ...extra };
  };
  const pending = new Set(); // une seule estimation en cours par voiture (double clic, deux onglets)

  const router = express.Router();
  router.use("/api/garage/:id/valeur", sameSiteJson, needUser);
  const vehicleOf = (req, res) => {
    const row = /^\d+$/.test(req.params.id) ? q.owned.get(Number(req.params.id), req.user.id) : null;
    if (!row) res.status(404).json({ code: "not_found", error: "Voiture introuvable dans votre garage." });
    return row;
  };

  router.get("/api/garage/:id/valeur", (req, res) => {
    const row = vehicleOf(req, res); if (!row) return;
    res.setHeader("Cache-Control", "no-store");
    res.json(out(row.id));
  });

  router.post("/api/garage/:id/valeur", (req, res, next) => estimer(req, res).catch(next));

  async function estimer(req, res) {
    const row = vehicleOf(req, res); if (!row) return;
    // Une estimation par voiture et par jour : sinon on réaffiche la dernière, sans appeler l'IA.
    if (q.ofDay.get(row.id, now())) return res.json(out(row.id, { dejaFaiteAujourdhui: true }));
    if (pending.has(row.id)) return res.status(409).json({ code: "in_progress", error: "Une estimation est déjà en cours pour cette voiture." });
    if (!estimate) return res.status(503).json({ code: "unavailable", error: "L'estimation n'est pas disponible : clé API manquante sur le serveur." });
    pending.add(row.id);
    try {
      const releves = q.releves.all(row.id);
      const input = buildInput(row, releves, q.entretiens.all(row.id));
      let result;
      try { result = await estimate(input); }
      catch (e) {
        log("Estimation : erreur de l'IA :", e?.status || e?.code, e?.message);
        const status = e?.status === 429 ? 429 : 502;
        return res.status(status).json({ code: status === 429 ? "rate_limited" : "upstream_error",
          error: status === 429 ? "Trop de demandes en ce moment. Réessayez dans quelques minutes." : "L'estimation n'a pas pu être obtenue. Réessayez plus tard." });
      }
      const { data, error } = validateEstimation(parseJson(result?.text));
      if (error) {
        log("Estimation : réponse invalide :", error);
        return res.status(502).json({ code: "invalid_estimation", error: "L'IA a renvoyé une estimation inexploitable. Rien n'a été enregistré : réessayez plus tard." });
      }
      const km = stats(releves).dernier?.km ?? null;
      try {
        q.insert.run(row.id, now(), km, data.basse, data.haute, data.valeur_probable, data.explication,
          JSON.stringify(data.facteurs), JSON.stringify(data.conseils), result.model || null);
      } catch {
        return res.json(out(row.id, { dejaFaiteAujourdhui: true })); // estimation enregistrée entre-temps (même jour)
      }
      res.status(201).json(out(row.id));
    } finally {
      pending.delete(row.id);
    }
  }

  // Pour la carte de la voiture et l'export RGPD.
  router.latest = vid => { const l = q.list.all(vid); return l.length ? toPublic(l.at(-1)) : null; };
  router.forExport = vid => q.list.all(vid).map(toPublic);
  return router;
}
