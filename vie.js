// Page de vie d'une voiture : frise de tous ses événements, étapes marquantes et chiffres clés.
// construireVie est une fonction pure (testée sans base de données).
import express from "express";
import { needUser, sameSiteJson } from "./auth.js";
import { TYPES } from "./carnet.js";
import { today } from "./kilometrage.js";
import { saisiLe, continuite } from "./historique.js";

export const PALIERS_KM = [50_000, 100_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000];
const JOURS_PAR_MOIS = 365.25 / 12;
const jours = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const fmtKm = n => `${n.toLocaleString("fr-FR")} km`;
const eur = c => (c / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
const anniversaire = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + n); return d.toISOString().slice(0, 10); };

/**
 * vehicule : ligne de la table vehicles ; releves [{id, date, km, created_at, verrouille}] ; entretiens (lignes de la table) ; estimations (lignes).
 * transferts : changements de propriétaire acceptés [{accepte_le, ancien_achat_date, ancien_achat_km}] ;
 * modifications et notes : lignes des tables du même nom (objet, objet_id…).
 * Renvoie { debut, evenements (du plus récent au plus ancien), jalons, chiffres, continuite }.
 */
export function construireVie({ vehicule: v, releves = [], entretiens = [], estimations = [], transferts = [], modifications = [], notes = [], aujourdhui = today() }) {
  const ajoutLe = String(v.created_at).slice(0, 10);
  const debut = { date: v.achat_date || ajoutLe, km: v.achat_km ?? null, source: v.achat_date ? "achat" : "ajout" };
  const evenements = [];
  const datesTransfert = transferts.map(t => t.accepte_le).sort();
  // Confiance de chaque entrée : modifiée après coup (date de la dernière modification), notes ajoutées.
  const derniereModif = (objet, id) => modifications.filter(m => m.objet === objet && m.objet_id === id).map(m => m.le).sort().at(-1) || null;
  const notesDe = (objet, id) => notes.filter(n => n.objet === objet && n.objet_id === id).map(n => ({ texte: n.texte, le: String(n.cree_le).slice(0, 10) }));

  for (const t of transferts) {
    if (t.ancien_achat_date) evenements.push({ date: t.ancien_achat_date, type: "achat", titre: "Achat par un propriétaire précédent", detail: t.ancien_achat_km != null ? `à ${fmtKm(t.ancien_achat_km)}` : null, km: t.ancien_achat_km ?? null });
    evenements.push({ date: t.accepte_le, type: "proprietaire", titre: "Changement de propriétaire", detail: null });
  }
  // Après un transfert, l'achat par le propriétaire actuel est le changement de propriétaire lui-même.
  if (v.achat_date && !datesTransfert.includes(v.achat_date)) evenements.push({ date: v.achat_date, type: "achat", titre: "Achat", detail: v.achat_km != null ? `à ${fmtKm(v.achat_km)}` : null, km: v.achat_km ?? null });
  evenements.push({ date: ajoutLe, type: "ajout", titre: transferts.length ? "Début du suivi dans Rétroviz" : "Ajoutée à votre garage Rétroviz", detail: null });
  const confiance = (objet, row) => ({ saisiLe: saisiLe(row), modifieLe: derniereModif(objet, row.id), recu: !!row.verrouille, notes: notesDe(objet, row.id) });
  for (const r of releves) evenements.push({ date: r.date, type: "releve", releveId: r.id, titre: `Relevé : ${fmtKm(r.km)}`, km: r.km, preuve: "declare", ...confiance("releve", r) });
  for (const e of entretiens) {
    evenements.push({
      date: e.date, type: "entretien", entretienId: e.id, titre: TYPES[e.type] || e.type, detail: e.garage || null,
      km: e.km ?? null, montant: e.cout_centimes ?? null, preuve: e.facture_key ? "facture" : "declare",
      facture: e.facture_key ? `/api/garage/${v.id}/entretiens/${e.id}/facture` : null,
      ...confiance("entretien", e),
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
  const ordre = { jalon: 0, proprietaire: 4, achat: 5, ajout: 6 };
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
  return { debut, evenements, jalons, chiffres, continuite: continuite(points, datesTransfert) };
}

export function createVie(db, { now = today } = {}) {
  const q = {
    owned: db.prepare("SELECT * FROM vehicles WHERE id = ? AND user_id = ?"),
    releves: db.prepare("SELECT id, date, km, created_at, verrouille FROM releves WHERE vehicle_id = ? ORDER BY date"),
    entretiens: db.prepare("SELECT * FROM entretiens WHERE vehicle_id = ? ORDER BY date"),
    estimations: db.prepare("SELECT date, km, basse, haute, valeur_probable FROM estimations WHERE vehicle_id = ? ORDER BY date"),
    transferts: db.prepare("SELECT accepte_le, ancien_achat_date, ancien_achat_km FROM transferts WHERE vehicle_id = ? AND statut = 'accepte' ORDER BY accepte_le"),
    modifications: db.prepare("SELECT objet, objet_id, le, champs FROM modifications WHERE vehicle_id = ?"),
    notes: db.prepare("SELECT objet, objet_id, texte, cree_le FROM notes WHERE vehicle_id = ? ORDER BY cree_le, id"),
  };
  // Toutes les données de la page de vie d'une voiture (aussi utilisé par le dossier partagé).
  const donnees = v => ({ vehicule: v, releves: q.releves.all(v.id), entretiens: q.entretiens.all(v.id), estimations: q.estimations.all(v.id),
    transferts: q.transferts.all(v.id), modifications: q.modifications.all(v.id), notes: q.notes.all(v.id), aujourdhui: now() });
  const router = express.Router();
  router.use("/api/garage/:id/vie", sameSiteJson, needUser);
  router.get("/api/garage/:id/vie", (req, res) => {
    const v = /^\d+$/.test(req.params.id) ? q.owned.get(Number(req.params.id), req.user.id) : null;
    if (!v) return res.status(404).json({ code: "not_found", error: "Voiture introuvable dans votre garage." });
    res.setHeader("Cache-Control", "no-store");
    res.json(construireVie(donnees(v)));
  });
  router.donnees = donnees;
  return router;
}
