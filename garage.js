// Mon garage : les voitures de l'utilisateur, reliées si possible à une fiche de la base Rétroviz.
import express from "express";
import { findVehicle, vehicleLabel } from "./knowledge.js";
import { needUser, sameSiteJson } from "./auth.js";

export const MAX_VEHICLES = 30;
const BOITES = ["manuelle", "automatique"];
const LIMITS = { surnom: 40, marque: 40, modele: 60, motorisation: 80 };

/* ---------- validation ---------- */
// Renvoie { data } ou { error } à partir des champs envoyés par le formulaire.
export function cleanVehicle(body, thisYear = new Date().getFullYear()) {
  const b = body && typeof body === "object" ? body : {};
  const data = {};
  for (const [k, max] of Object.entries(LIMITS)) {
    data[k] = typeof b[k] === "string" ? b[k].trim().replace(/\s+/g, " ") : "";
    if (data[k].length > max) return { error: `Le champ « ${k} » doit faire au plus ${max} caractères.` };
  }
  if (!data.marque || !data.modele) return { error: "Indiquez au moins la marque et le modèle." };

  const year = b.annee === undefined || b.annee === null || b.annee === "" ? null : Number(String(b.annee).trim());
  if (year !== null && !(Number.isInteger(year) && year >= 1900 && year <= thisYear + 1)) {
    return { error: `Année invalide (entre 1900 et ${thisYear + 1}).` };
  }
  data.annee = year;

  data.boite = typeof b.boite === "string" ? b.boite.trim().toLowerCase() : "";
  if (data.boite && !BOITES.includes(data.boite)) return { error: "Boîte : « manuelle », « automatique » ou vide." };

  data.ficheRefusee = b.ficheRefusee === true;
  return { data };
}

/* ---------- fiche Rétroviz ---------- */
// On ne relie que si le modèle ET le moteur correspondent, et que l'année tombe dans la période de la fiche :
// une fiche fausse est pire que pas de fiche.
export function matchFiche(v, kb) {
  const text = [v.marque, v.modele, v.motorisation].filter(Boolean).join(" ");
  const best = findVehicle(text, kb, 1)[0];
  if (!best || best.correspondance !== "modele_moteur") return null;
  const span = String(best.fiche.annees || "").match(/(\d{4})\D+(\d{4})/);
  if (v.annee && span && (v.annee < +span[1] || v.annee > +span[2])) return null;
  return best.fiche.id;
}

// Désignation utilisée pour les questions à l'assistant (champ « Votre véhicule »).
export const designation = v =>
  [[v.marque, v.modele, v.motorisation].filter(Boolean).join(" "), v.annee, v.boite && `boîte ${v.boite}`].filter(Boolean).join(", ");

/* ---------- routeur ---------- */
export function createGarage(db, kb) {
  const q = {
    list: db.prepare("SELECT * FROM vehicles WHERE user_id = ? ORDER BY created_at, id"),
    get: db.prepare("SELECT * FROM vehicles WHERE id = ? AND user_id = ?"),
    count: db.prepare("SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ?"),
    insert: db.prepare(`INSERT INTO vehicles (user_id, surnom, marque, modele, motorisation, annee, boite, fiche_id, fiche_refusee)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE vehicles SET surnom = ?, marque = ?, modele = ?, motorisation = ?, annee = ?, boite = ?,
                        fiche_id = ?, fiche_refusee = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                        WHERE id = ? AND user_id = ?`),
    remove: db.prepare("DELETE FROM vehicles WHERE id = ? AND user_id = ?"),
  };
  const fichesById = new Map(kb.vehicules.map(f => [f.id, f]));

  const toPublic = row => {
    const fiche = row.fiche_id ? fichesById.get(row.fiche_id) : null; // fiche retirée de la base : plus de lien
    return {
      id: row.id, surnom: row.surnom, marque: row.marque, modele: row.modele, motorisation: row.motorisation,
      annee: row.annee, boite: row.boite,
      fiche: fiche ? { id: fiche.id, label: vehicleLabel(fiche), statut: fiche.statut === "verifie" ? "verifie" : "a_verifier" } : null,
      ficheRefusee: !!row.fiche_refusee,
      designation: designation(row),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  };
  const ficheFor = d => (d.ficheRefusee ? null : matchFiche(d, kb));
  const params = d => [d.surnom, d.marque, d.modele, d.motorisation, d.annee, d.boite, ficheFor(d), d.ficheRefusee ? 1 : 0];
  const notFound = res => res.status(404).json({ code: "not_found", error: "Voiture introuvable dans votre garage." });
  const vehicleId = req => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : -1);

  const router = express.Router();
  router.use("/api/garage", sameSiteJson, needUser);

  router.get("/api/garage", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ vehicules: q.list.all(req.user.id).map(toPublic), max: MAX_VEHICLES });
  });

  router.post("/api/garage", (req, res) => {
    const { data, error } = cleanVehicle(req.body);
    if (error) return res.status(400).json({ code: "invalid_vehicle", error });
    if (q.count.get(req.user.id).n >= MAX_VEHICLES) {
      return res.status(409).json({ code: "garage_full", error: `Votre garage est plein (${MAX_VEHICLES} voitures au plus).` });
    }
    const { lastInsertRowid } = q.insert.run(req.user.id, ...params(data));
    res.status(201).json({ vehicule: toPublic(q.get.get(lastInsertRowid, req.user.id)) });
  });

  router.put("/api/garage/:id", (req, res) => {
    const id = vehicleId(req);
    if (!q.get.get(id, req.user.id)) return notFound(res);
    const { data, error } = cleanVehicle(req.body);
    if (error) return res.status(400).json({ code: "invalid_vehicle", error });
    q.update.run(...params(data), id, req.user.id);
    res.json({ vehicule: toPublic(q.get.get(id, req.user.id)) });
  });

  router.delete("/api/garage/:id", (req, res) => {
    const { changes } = q.remove.run(vehicleId(req), req.user.id);
    if (!changes) return notFound(res);
    res.json({ ok: true });
  });

  // Pour l'export RGPD.
  router.exportFor = userId => ({ vehicules: q.list.all(userId).map(toPublic) });
  return router;
}
