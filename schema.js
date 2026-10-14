// Schéma interactif : pièces de la voiture par zone, reliées à ce que Rétroviz sait de CETTE voiture
// (pannes connues de sa fiche, entretiens à venir, entrées du carnet). piecesPourVoiture est une fonction pure.
import express from "express";
import { needUser, sameSiteJson } from "./auth.js";
import { normalize } from "./knowledge.js";
import { energieDe } from "./energie.js";
import { ZONES } from "./fiabilite.js";
import { TYPES } from "./carnet.js";

export const NOMS_ZONES = {
  moteur: "Moteur", transmission: "Transmission", freins: "Freins", "direction-suspension": "Direction et suspension",
  electricite: "Électricité", "echappement-depollution": "Échappement et dépollution", pneus: "Pneus", carrosserie: "Carrosserie",
};
// Zones montrées selon l'énergie : une électrique n'a pas d'échappement.
export const zonesPour = energie => ZONES.filter(z => !(z === "echappement-depollution" && energie === "electrique"));

// Mot-clé au début d'un mot : « plaquette » trouve « plaquettes », mais « nique » ne trouve pas « technique ».
const contient = (texte, mots) => { const t = ` ${normalize(texte)} `; return mots.some(m => t.includes(` ${normalize(m)}`)); };
// Une pièce est concernée par un texte si l'un de ses mots-clés y apparaît (mot entier, au début d'un mot).
export const concerne = (piece, texte) => !!texte && contient(texte, piece.mots_cles);
// Position du premier mot-clé de la pièce dans le texte (Infinity si absent).
const position = (piece, texte) => {
  const t = ` ${normalize(texte)} `;
  return Math.min(...piece.mots_cles.map(m => { const i = t.indexOf(` ${normalize(m)}`); return i < 0 ? Infinity : i; }));
};
// Pièce(s) visée(s) par un titre de panne ou d'entretien : celle dont le mot-clé vient en premier (le sujet du titre).
// « Calamine sur les soupapes et ratés d'allumage (versions turbo à injection directe) » vise l'allumage, pas le turbo.
export function sujets(pieces, titre) {
  const pos = pieces.map(p => [p.id, position(p, titre)]);
  const min = Math.min(...pos.map(([, i]) => i));
  return min === Infinity ? [] : pos.filter(([, i]) => i === min).map(([id]) => id);
}

/**
 * vehicule : ligne de la table vehicles ; fiche : fiche Rétroviz reliée (ou null) ; avenir : résultat de computeAvenir ;
 * entretiens : lignes du carnet ; pieces : data/pieces.json.
 * Renvoie { energie, zones: [{ id, nom, pieces: [{ id, alertes: [...], carnet: [...] }] }] } (seulement les pièces de cette énergie).
 */
export function piecesPourVoiture({ vehicule, fiche = null, avenir = { items: [] }, entretiens = [], pieces }) {
  const energie = energieDe(vehicule);
  const zones = zonesPour(energie).map(z => ({ id: z, nom: NOMS_ZONES[z], pieces: [] }));
  const parZone = new Map(zones.map(z => [z.id, z]));
  const presentes = pieces.filter(p => p.energies.includes(energie) && parZone.has(p.zone));
  const pannes = (fiche?.pannes || []).map(pa => ({ pa, vise: sujets(presentes, pa.titre) }));
  const aVenir = (avenir.items || []).filter(it => ["retard", "bientot"].includes(it.statut) && it.categorie !== "surveiller" && it.cle !== "ct")
    .map(it => ({ it, vise: it.cle === "vidange" ? ["huile-moteur"] : it.cle === "pneus-hiver" ? ["pneus-hiver"] : sujets(presentes, it.titre) }));
  for (const p of presentes) {
    const alertes = [];
    // Pannes connues sur ce modèle et ce moteur (fiche Rétroviz reliée).
    for (const { pa, vise } of pannes) {
      if (vise.includes(p.id)) alertes.push({ type: "panne", titre: pa.titre, km: pa.km_typique ?? null, gravite: pa.gravite || null, cout: pa.cout_indicatif || null });
    }
    // Entretiens à venir proches ou en retard.
    for (const { it, vise: cibles } of aVenir) {
      const vise = cibles.includes(p.id);
      if (vise) alertes.push({ type: "entretien", titre: it.titre, statut: it.statut, date: it.date, km: it.km });
    }
    // Entrées du carnet liées (type ou description).
    const carnet = entretiens
      .filter(e => p.types_carnet.includes(e.type) || concerne(p, e.description))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(e => ({ id: e.id, date: e.date, km: e.km ?? null, type: e.type, typeLabel: TYPES[e.type] || e.type }));
    parZone.get(p.zone).pieces.push({ id: p.id, alertes, carnet });
  }
  return { energie, zones };
}

export function createSchema(db, kb, { rappels }) {
  const q = {
    owned: db.prepare("SELECT * FROM vehicles WHERE id = ? AND user_id = ?"),
    entretiens: db.prepare("SELECT id, date, km, type, description FROM entretiens WHERE vehicle_id = ?"),
  };
  const router = express.Router();
  // Fiches des pièces : publiques (comme les voyants).
  router.get("/api/pieces", (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ zones: ZONES.map(id => ({ id, nom: NOMS_ZONES[id] })), pieces: kb.pieces || [] });
  });
  router.use("/api/garage/:id/schema", sameSiteJson, needUser);
  router.get("/api/garage/:id/schema", (req, res) => {
    const v = /^\d+$/.test(req.params.id) ? q.owned.get(Number(req.params.id), req.user.id) : null;
    if (!v) return res.status(404).json({ code: "not_found", error: "Voiture introuvable dans votre garage." });
    const fiche = v.fiche_id ? kb.vehicules.find(f => f.id === v.fiche_id) : null;
    res.setHeader("Cache-Control", "no-store");
    res.json(piecesPourVoiture({ vehicule: v, fiche, avenir: rappels.forVehicle(v), entretiens: q.entretiens.all(v.id), pieces: kb.pieces || [] }));
  });
  return router;
}
