// Badge « Voiture bien suivie » : 5 critères objectifs, calculés sur les informations saisies par le propriétaire.
// evaluerBadge est une fonction pure (testée sans base de données).
import express from "express";
import { needUser, sameSiteJson } from "./auth.js";
import { aDesVidanges, energieDe } from "./energie.js";
import { today } from "./kilometrage.js";

export const SEUILS = {
  historiqueJours: 365,     // 12 mois d'historique au moins
  relevesMin: 3,            // relevés sur les 12 derniers mois
  trouMaxJours: 183,        // pas plus de 6 mois sans relevé
  toleranceVidange: 1.10,   // +10 % sur l'intervalle prévu
  entretiensMin: 2,         // pour le critère des preuves
  scorePreuveMin: 0.75,     // facture = 1 point, sans facture = 0,5
};
const JOUR = 86_400_000;
const jours = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / JOUR);
const moins = (iso, j) => new Date(Date.parse(`${iso}T00:00:00Z`) - j * JOUR).toISOString().slice(0, 10);
const fmtDate = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const MOIS = 365.25 / 12;

/**
 * vehicule : ligne de la table vehicles ; releves [{date, km}] ; entretiens (lignes) ; avenir : résultat de computeAvenir.
 * Renvoie { obtenu, criteres: [{ id, titre, ok, detail, aide }], manquants }.
 */
export function evaluerBadge({ vehicule: v, releves = [], entretiens = [], avenir = { items: [] }, aujourdhui = today() }) {
  const criteres = [];
  const ajoute = (id, titre, ok, detail, aide) => criteres.push({ id, titre, ok: !!ok, detail, aide: ok ? null : aide });

  /* 1. Historique : depuis la plus ancienne date connue (achat, premier relevé, premier entretien, y compris reçus d'un ancien propriétaire). */
  const dates = [v.achat_date, ...releves.map(r => r.date), ...entretiens.map(e => e.date)].filter(Boolean).sort();
  const depuis = dates[0] || null;
  const age = depuis ? jours(depuis, aujourdhui) : 0;
  ajoute("historique", "Au moins 12 mois d'historique", age >= SEUILS.historiqueJours,
    depuis ? `Historique depuis le ${fmtDate(depuis)} (${Math.floor(age / MOIS)} mois).` : "Aucune date connue pour l'instant.",
    depuis ? `Encore ${Math.ceil((SEUILS.historiqueJours - age) / MOIS)} mois de suivi, ou ajoutez des entretiens ou relevés plus anciens (date d'achat, anciennes factures).`
      : "Indiquez la date d'achat, un relevé de kilométrage ou un entretien.");

  /* 2. Relevés réguliers : au moins 3 sur 12 mois, jamais plus de 6 mois sans relevé (jusqu'à aujourd'hui). Les km des entretiens comptent. */
  const debut12 = moins(aujourdhui, 365);
  const points = [...new Set([...releves.map(r => r.date), ...entretiens.filter(e => e.km != null).map(e => e.date)])].filter(d => d >= debut12 && d <= aujourdhui).sort();
  let trou = 0;
  for (let i = 1; i < points.length; i++) trou = Math.max(trou, jours(points[i - 1], points[i]));
  if (points.length) trou = Math.max(trou, jours(points.at(-1), aujourdhui));
  const relevesOk = points.length >= SEUILS.relevesMin && trou <= SEUILS.trouMaxJours;
  ajoute("releves", "Relevés de kilométrage réguliers", relevesOk,
    `${points.length} relevé${points.length > 1 ? "s" : ""} sur les 12 derniers mois${points.length ? `, ${Math.round(trou / MOIS)} mois au plus sans relevé` : ""}.`,
    [
      points.length && jours(points.at(-1), aujourdhui) > SEUILS.trouMaxJours ? `Ajoutez un relevé de kilométrage aujourd'hui : le dernier date de ${Math.round(jours(points.at(-1), aujourdhui) / MOIS)} mois.` : null,
      points.length < SEUILS.relevesMin ? `Il faut ${SEUILS.relevesMin} relevés sur 12 mois (il en manque ${SEUILS.relevesMin - points.length}) : un tous les 3 à 4 mois suffit.` : null,
      points.length >= SEUILS.relevesMin && jours(points.at(-1), aujourdhui) <= SEUILS.trouMaxJours ? "Il y a eu plus de 6 mois sans relevé sur l'année : le critère reviendra quand ce trou sortira des 12 derniers mois, si vous continuez vos relevés." : null,
    ].filter(Boolean).join(" "));

  /* 3. Vidanges (thermique et hybrides) : les 2 dernières respectent l'intervalle +10 %.
        Électrique : remplacé par « entretiens de la fiche faits à temps ». */
  if (aDesVidanges(v)) {
    const vid = avenir.items.find(it => it.cle === "vidange");
    const intervalle = vid?.intervalle || { km: 15000, mois: 12 };
    const vidanges = entretiens.filter(e => e.type === "vidange").sort((a, b) => a.date.localeCompare(b.date));
    let ok = vidanges.length >= 1, detail, aide;
    if (!vidanges.length) { detail = "Aucune vidange notée dans le carnet."; aide = "Notez votre dernière vidange dans le carnet (de préférence avec sa facture)."; }
    else if (vidanges.length === 1) { detail = `Une vidange notée (${fmtDate(vidanges[0].date)}).`; }
    else {
      const [a, b] = vidanges.slice(-2);
      const moisEcart = jours(a.date, b.date) / MOIS, kmEcart = a.km != null && b.km != null ? b.km - a.km : null;
      const okMois = moisEcart <= intervalle.mois * SEUILS.toleranceVidange;
      const okKm = kmEcart == null || kmEcart <= intervalle.km * SEUILS.toleranceVidange;
      ok = okMois && okKm;
      detail = `Entre les 2 dernières vidanges : ${Math.round(moisEcart)} mois${kmEcart != null ? ` et ${kmEcart.toLocaleString("fr-FR")} km` : ""} (intervalle prévu : ${intervalle.km.toLocaleString("fr-FR")} km ou ${intervalle.mois} mois).`;
      aide = "L'écart entre les 2 dernières vidanges dépasse l'intervalle prévu de plus de 10 % : le critère sera de nouveau rempli après 2 vidanges faites à temps.";
    }
    ajoute("vidanges", "Vidanges faites à temps", ok, detail, aide);
  } else {
    const retard = avenir.items.filter(it => it.categorie === "entretien" && it.statut === "retard");
    const suivis = avenir.items.filter(it => it.categorie === "entretien");
    ajoute("entretiens_fiche", "Entretiens de la fiche faits à temps", retard.length === 0,
      suivis.length ? (retard.length ? `En retard : ${retard.map(r => r.titre).join(", ")}.` : "Aucun entretien de la fiche en retard.") : "Pas d'entretien de fiche à suivre pour cette voiture électrique.",
      `Faites ou notez dans le carnet : ${retard.map(r => r.titre).join(", ")}.`);
  }

  /* 4. Rien en retard dans « À venir » : contrôle technique, vidange, entretiens de la fiche (pas les rappels libres). */
  const enRetard = avenir.items.filter(it => it.statut === "retard" && (it.cle === "ct" || it.cle === "vidange" || it.categorie === "entretien"));
  ajoute("a_jour", "Rien en retard dans « À venir »", enRetard.length === 0,
    enRetard.length ? `En retard : ${enRetard.map(r => r.titre).join(", ")}.` : aDesVidanges(v) ? "Contrôle technique, vidange et entretiens de la fiche sont à jour." : "Contrôle technique et entretiens de la fiche sont à jour.",
    `Faites ou notez dans le carnet : ${enRetard.map(r => r.titre).join(", ")} (bouton « C'est fait » dans « À venir »).`);

  /* 5. Preuves : au moins 2 entretiens ; score ≥ 75 % (facture = 1 point, sans facture = 0,5). */
  const n = entretiens.length, avec = entretiens.filter(e => e.facture_key).length;
  const score = n ? (avec + (n - avec) * 0.5) / n : 0;
  const preuvesOk = n >= SEUILS.entretiensMin && score >= SEUILS.scorePreuveMin;
  // Combien de factures ajouter pour atteindre 75 % ? (chaque facture ajoutée fait gagner 0,5 point)
  const manque = Math.max(0, Math.ceil((SEUILS.scorePreuveMin * n - (avec + (n - avec) * 0.5)) / 0.5));
  ajoute("preuves", "Entretiens prouvés par des factures", preuvesOk,
    n ? `${n} entretien${n > 1 ? "s" : ""}, dont ${avec} avec facture : score de preuve ${Math.round(score * 100)} % (75 % demandés).` : "Aucun entretien noté.",
    n < SEUILS.entretiensMin ? `Notez au moins ${SEUILS.entretiensMin - n} entretien${SEUILS.entretiensMin - n > 1 ? "s" : ""} de plus, si possible avec la facture.`
      : `Ajoutez la facture de ${manque} entretien${manque > 1 ? "s" : ""} déjà noté${manque > 1 ? "s" : ""} (photo ou PDF).`);

  const manquants = criteres.filter(c => !c.ok).length;
  return { obtenu: manquants === 0, criteres, manquants, energie: energieDe(v) };
}

// Module : calcule le badge d'une voiture et garde la date où il a été gagné ou perdu.
export function createBadge(db, { rappels, now = today } = {}) {
  const q = {
    owned: db.prepare("SELECT * FROM vehicles WHERE id = ? AND user_id = ?"),
    releves: db.prepare("SELECT date, km FROM releves WHERE vehicle_id = ?"),
    entretiens: db.prepare("SELECT date, km, type, facture_key FROM entretiens WHERE vehicle_id = ?"),
    etat: db.prepare("UPDATE vehicles SET badge_obtenu = ?, badge_change_le = ? WHERE id = ?"),
  };
  function pour(row) {
    const r = evaluerBadge({ vehicule: row, releves: q.releves.all(row.id), entretiens: q.entretiens.all(row.id), avenir: rappels.forVehicle(row), aujourdhui: now() });
    // Gain ou perte du badge : la date est gardée pour pouvoir dire « perdu le … ».
    let changeLe = row.badge_change_le;
    if (r.obtenu !== !!row.badge_obtenu) { changeLe = now(); q.etat.run(r.obtenu ? 1 : 0, changeLe, row.id); }
    const perdu = !r.obtenu && !!changeLe; // il l'a eu un jour, puis l'a perdu
    return { ...r, depuis: r.obtenu ? changeLe : null, perduLe: perdu ? changeLe : null,
      avertissement: "Ce badge repose sur les informations saisies par le propriétaire (relevés, entretiens, factures)." };
  }
  const router = express.Router();
  router.use("/api/garage/:id/badge", sameSiteJson, needUser);
  router.get("/api/garage/:id/badge", (req, res) => {
    const row = /^\d+$/.test(req.params.id) ? q.owned.get(Number(req.params.id), req.user.id) : null;
    if (!row) return res.status(404).json({ code: "not_found", error: "Voiture introuvable dans votre garage." });
    res.setHeader("Cache-Control", "no-store");
    res.json(pour(row));
  });
  router.pour = pour;
  return router;
}
