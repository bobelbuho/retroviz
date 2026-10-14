// Page de vie d'une voiture : frise de tous ses événements, étapes marquantes et chiffres clés.
// construireVie est une fonction pure (testée sans base de données).
import express from "express";
import { needUser, sameSiteJson } from "./auth.js";
import { TYPES } from "./carnet.js";
import { today } from "./kilometrage.js";

export const PALIERS_KM = [50_000, 100_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000];
const JOURS_PAR_MOIS = 365.25 / 12;
const jours = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const fmtKm = n => `${n.toLocaleString("fr-FR")} km`;
const eur = c => (c / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
const anniversaire = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + n); return d.toISOString().slice(0, 10); };

/**
 * vehicule : ligne de la table vehicles ; releves [{date, km}] ; entretiens (lignes de la table) ; estimations (lignes).
 * Renvoie { debut, evenements (du plus récent au plus ancien), jalons, chiffres }.
 */
export function construireVie({ vehicule: v, releves = [], entretiens = [], estimations = [], aujourdhui = today() }) {
  const ajoutLe = String(v.created_at).slice(0, 10);
  const debut = { date: v.achat_date || ajoutLe, km: v.achat_km ?? null, source: v.achat_date ? "achat" : "ajout" };
  const evenements = [];

  if (v.achat_date) evenements.push({ date: v.achat_date, type: "achat", titre: "Achat", detail: v.achat_km != null ? `à ${fmtKm(v.achat_km)}` : null, km: v.achat_km ?? null });
  evenements.push({ date: ajoutLe, type: "ajout", titre: "Ajoutée à votre garage Rétroviz", detail: null });
  for (const r of releves) evenements.push({ date: r.date, type: "releve", titre: `Relevé : ${fmtKm(r.km)}`, km: r.km, preuve: "declare" });
  for (const e of entretiens) {
    evenements.push({
      date: e.date, type: "entretien", entretienId: e.id, titre: TYPES[e.type] || e.type, detail: e.garage || null,
      km: e.km ?? null, montant: e.cout_centimes ?? null, preuve: e.facture_key ? "facture" : "declare",
      facture: e.facture_key ? `/api/garage/${v.id}/entretiens/${e.id}/facture` : null,
    });
  }
  for (const s of estimations) {
    const e0 = n => n.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
    evenements.push({ date: s.date, type: "valeur", titre: `Valeur estimée : ${e0(s.valeur_probable)}`, detail: `de ${e0(s.basse)} à ${e0(s.haute)}`, km: s.km ?? null });
  }

  /* Étapes marquantes : paliers de kilométrage franchis avec vous, anniversaires. */
  const points = [...releves.map(r => ({ date: r.date, km: r.km })), ...entretiens.filter(e => e.km != null).map(e => ({ date: e.date, km: e.km }))]
    .sort((a, b) => a.date.localeCompare(b.date) || a.km - b.km);
  const kmDepart = debut.km ?? points.find(p => p.date >= debut.date)?.km ?? points[0]?.km ?? null;
  const jalons = [];
  if (kmDepart != null) {
    for (const palier of PALIERS_KM) {
      if (palier <= kmDepart) continue; // déjà dépassé à l'arrivée dans le garage : pas une étape vécue ensemble
      const p = points.find(x => x.km >= palier);
      if (p) jalons.push({ date: p.date, type: "jalon", titre: `${fmtKm(palier)} atteints`, km: palier });
    }
  }
  for (let n = 1; n <= 60; n++) {
    const d = anniversaire(debut.date, n);
    if (d > aujourdhui) break;
    jalons.push({ date: d, type: "jalon", titre: n === 1 ? "1 an avec vous" : `${n} ans avec vous` });
  }
  evenements.push(...jalons);
  // Du plus récent au plus ancien ; à date égale, les étapes marquantes d'abord.
  const ordre = { jalon: 0, achat: 5, ajout: 6 };
  evenements.sort((a, b) => b.date.localeCompare(a.date) || (ordre[a.type] ?? 3) - (ordre[b.type] ?? 3));

  /* Chiffres clés, depuis l'achat (ou l'ajout au garage). */
  const kmMaintenant = points.length ? Math.max(...points.map(p => p.km)) : null;
  const kmParcourus = kmMaintenant != null && kmDepart != null ? Math.max(0, kmMaintenant - kmDepart) : null;
  const depuis = entretiens.filter(e => e.date >= debut.date);
  const totalCentimes = depuis.reduce((n, e) => n + (e.cout_centimes || 0), 0);
  const mois = Math.max(1, jours(debut.date, aujourdhui) / JOURS_PAR_MOIS);
  const chiffres = {
    depuis: debut.date, source: debut.source,
    kmParcourus,
    totalDepense: totalCentimes / 100,
    entretiens: depuis.length,
    avecFacture: depuis.filter(e => e.facture_key).length,
    coutParKm: kmParcourus ? Math.round((totalCentimes / 100 / kmParcourus) * 1000) / 1000 : null,
    coutParMois: Math.round((totalCentimes / 100 / mois) * 100) / 100,
    moisDeSuivi: Math.floor(mois),
  };
  return { debut, evenements, jalons, chiffres };
}

export function createVie(db, { now = today } = {}) {
  const q = {
    owned: db.prepare("SELECT * FROM vehicles WHERE id = ? AND user_id = ?"),
    releves: db.prepare("SELECT date, km FROM releves WHERE vehicle_id = ? ORDER BY date"),
    entretiens: db.prepare("SELECT * FROM entretiens WHERE vehicle_id = ? ORDER BY date"),
    estimations: db.prepare("SELECT date, km, basse, haute, valeur_probable FROM estimations WHERE vehicle_id = ? ORDER BY date"),
  };
  const router = express.Router();
  router.use("/api/garage/:id/vie", sameSiteJson, needUser);
  router.get("/api/garage/:id/vie", (req, res) => {
    const v = /^\d+$/.test(req.params.id) ? q.owned.get(Number(req.params.id), req.user.id) : null;
    if (!v) return res.status(404).json({ code: "not_found", error: "Voiture introuvable dans votre garage." });
    res.setHeader("Cache-Control", "no-store");
    res.json(construireVie({ vehicule: v, releves: q.releves.all(v.id), entretiens: q.entretiens.all(v.id), estimations: q.estimations.all(v.id), aujourdhui: now() }));
  });
  return router;
}
