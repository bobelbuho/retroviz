// Énergie d'une voiture : thermique, hybride, hybride rechargeable ou électrique.
// Champ « energie » de la voiture s'il est rempli, sinon déduit de la motorisation et du modèle.
import { normalize } from "./knowledge.js";

export const ENERGIES = ["thermique", "hybride", "hybride_rechargeable", "electrique"];
export const ENERGIE_LABEL = { thermique: "Essence ou diesel", hybride: "Hybride", hybride_rechargeable: "Hybride rechargeable", electrique: "Électrique" };

export function energieDe(v) {
  if (ENERGIES.includes(v?.energie)) return v.energie;
  const t = ` ${normalize(`${v?.modele || ""} ${v?.motorisation || ""}`)} `;
  if (/ (phev|plug in|hybride rechargeable|rechargeable|e hybrid|gte) /.test(t)) return "hybride_rechargeable";
  if (/ (electrique|ev|bev|kwh|e \d{3,4}|zoe|e tron|id\.?\d|id \d|ioniq 5|model [3ysx]) /.test(t)) return "electrique";
  if (/ (hybrid|hybride|hev|mhev|e tech|full hybrid|hybrid4|self charging) /.test(t)) return "hybride";
  return "thermique";
}

// Un moteur thermique (donc des vidanges) ? Oui pour les thermiques et toutes les hybrides.
export const aDesVidanges = v => energieDe(v) !== "electrique";
