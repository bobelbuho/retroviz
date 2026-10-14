// Mon garage : les voitures de l'utilisateur, reliées si possible à une fiche de la base Rétroviz.
import express from "express";
import { findVehicle, vehicleLabel } from "./knowledge.js";
import { needUser, sameSiteJson } from "./auth.js";
import { cleanReleve, cleanDate, cleanAnyDate, incoherence, stats, kmText, MAX_RELEVES } from "./kilometrage.js";

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

  // Rappels : tous facultatifs.
  const empty = v => v === undefined || v === null || v === "";
  data.miseEnCirculation = null;
  if (!empty(b.miseEnCirculation)) {
    const d = cleanDate(b.miseEnCirculation);
    if (d.error) return { error: `Date de première mise en circulation : ${d.error.toLowerCase()}` };
    data.miseEnCirculation = d.date;
  }
  data.assuranceEcheance = null;
  if (!empty(b.assuranceEcheance)) {
    const d = cleanAnyDate(b.assuranceEcheance);
    if (d.error) return { error: "Date d'échéance de l'assurance invalide." };
    data.assuranceEcheance = d.date;
  }
  data.pneusHiver = b.pneusHiver === true;
  const int = (v, min, max, label) => {
    if (empty(v)) return { value: null };
    const n = Number(String(v).replace(/[\s\u202f\u00a0]/g, ""));
    return Number.isInteger(n) && n >= min && n <= max ? { value: n } : { error: `${label} : entre ${min.toLocaleString("fr-FR")} et ${max.toLocaleString("fr-FR")}.` };
  };
  const vk = int(b.vidangeKm, 1000, 100000, "Intervalle de vidange en km");
  if (vk.error) return { error: vk.error };
  const vm = int(b.vidangeMois, 1, 36, "Intervalle de vidange en mois");
  if (vm.error) return { error: vm.error };
  data.vidangeKm = vk.value; data.vidangeMois = vm.value;
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

// Désignation utilisée pour les questions à l'assistant (champ « Votre véhicule »), avec le dernier kilométrage connu.
export const designation = (v, km = null) =>
  [[v.marque, v.modele, v.motorisation].filter(Boolean).join(" "), v.annee, v.boite && `boîte ${v.boite}`, km !== null && kmText(km)]
    .filter(Boolean).join(", ");

/* ---------- routeur ---------- */
// carnet (facultatif) : module carnet.js, pour le résumé, l'export et l'effacement des factures.
// rappels (facultatif) : module rappels.js, pour le résumé « À venir » de chaque voiture.
export function createGarage(db, kb, { carnet = null, rappels = null } = {}) {
  const q = {
    list: db.prepare("SELECT * FROM vehicles WHERE user_id = ? ORDER BY created_at, id"),
    get: db.prepare("SELECT * FROM vehicles WHERE id = ? AND user_id = ?"),
    count: db.prepare("SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ?"),
    insert: db.prepare(`INSERT INTO vehicles (user_id, surnom, marque, modele, motorisation, annee, boite, fiche_id, fiche_refusee,
                          mise_en_circulation, assurance_echeance, pneus_hiver, vidange_km, vidange_mois)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE vehicles SET surnom = ?, marque = ?, modele = ?, motorisation = ?, annee = ?, boite = ?,
                        fiche_id = ?, fiche_refusee = ?, mise_en_circulation = ?, assurance_echeance = ?, pneus_hiver = ?,
                        vidange_km = ?, vidange_mois = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                        WHERE id = ? AND user_id = ?`),
    remove: db.prepare("DELETE FROM vehicles WHERE id = ? AND user_id = ?"),
    releves: db.prepare("SELECT id, date, km FROM releves WHERE vehicle_id = ? ORDER BY date DESC"),
    countReleves: db.prepare("SELECT COUNT(*) AS n FROM releves WHERE vehicle_id = ?"),
    upsertReleve: db.prepare(`INSERT INTO releves (vehicle_id, date, km) VALUES (?, ?, ?)
                              ON CONFLICT (vehicle_id, date) DO UPDATE SET km = excluded.km`),
    removeReleve: db.prepare("DELETE FROM releves WHERE id = ? AND vehicle_id = ?"),
  };
  const fichesById = new Map(kb.vehicules.map(f => [f.id, f]));

  const toPublic = row => {
    const fiche = row.fiche_id ? fichesById.get(row.fiche_id) : null; // fiche retirée de la base : plus de lien
    const kilometrage = stats(q.releves.all(row.id));
    return {
      id: row.id, surnom: row.surnom, marque: row.marque, modele: row.modele, motorisation: row.motorisation,
      annee: row.annee, boite: row.boite,
      miseEnCirculation: row.mise_en_circulation, assuranceEcheance: row.assurance_echeance, pneusHiver: !!row.pneus_hiver,
      vidangeKm: row.vidange_km, vidangeMois: row.vidange_mois,
      fiche: fiche ? { id: fiche.id, label: vehicleLabel(fiche), statut: fiche.statut === "verifie" ? "verifie" : "a_verifier" } : null,
      ficheRefusee: !!row.fiche_refusee,
      kilometrage,
      ...(carnet && { carnet: carnet.summary(row.id) }),
      ...(rappels && { avenir: rappels.summary(row) }),
      designation: designation(row, kilometrage.dernier?.km ?? null),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  };
  const ficheFor = d => (d.ficheRefusee ? null : matchFiche(d, kb));
  const params = d => [d.surnom, d.marque, d.modele, d.motorisation, d.annee, d.boite, ficheFor(d), d.ficheRefusee ? 1 : 0,
    d.miseEnCirculation, d.assuranceEcheance, d.pneusHiver ? 1 : 0, d.vidangeKm, d.vidangeMois];
  const notFound = res => res.status(404).json({ code: "not_found", error: "Voiture introuvable dans votre garage." });
  const vehicleId = req => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : -1);
  const releveOut = (vid, extra = {}) => {
    const list = q.releves.all(vid);
    return { releves: list, ...stats(list), ...extra };
  };

  const router = express.Router();
  router.use("/api/garage", sameSiteJson, needUser);

  router.get("/api/garage", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ vehicules: q.list.all(req.user.id).map(toPublic), max: MAX_VEHICLES });
  });

  router.post("/api/garage", (req, res) => {
    const { data, error } = cleanVehicle(req.body);
    if (error) return res.status(400).json({ code: "invalid_vehicle", error });
    // Kilométrage actuel facultatif : devient le premier relevé, daté du jour.
    const hasKm = req.body?.km !== undefined && req.body?.km !== null && req.body?.km !== "";
    const first = hasKm ? cleanReleve({ km: req.body.km }) : null;
    if (first?.error) return res.status(400).json({ code: "invalid_releve", error: first.error });
    if (q.count.get(req.user.id).n >= MAX_VEHICLES) {
      return res.status(409).json({ code: "garage_full", error: `Votre garage est plein (${MAX_VEHICLES} voitures au plus).` });
    }
    const { lastInsertRowid } = q.insert.run(req.user.id, ...params(data));
    if (first) q.upsertReleve.run(lastInsertRowid, first.data.date, first.data.km);
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

  router.delete("/api/garage/:id", async (req, res, next) => {
    const id = vehicleId(req);
    if (!q.get.get(id, req.user.id)) return notFound(res);
    const cleanup = carnet ? carnet.beforeDeleteVehicle(id) : null;
    q.remove.run(id, req.user.id); // relevés et entretiens partent avec (ON DELETE CASCADE)
    try { if (cleanup) await cleanup(); } catch (e) { return next(e); }
    res.json({ ok: true });
  });

  /* ---------- relevés de kilométrage ---------- */
  router.get("/api/garage/:id/releves", (req, res) => {
    const id = vehicleId(req);
    if (!q.get.get(id, req.user.id)) return notFound(res);
    res.setHeader("Cache-Control", "no-store");
    res.json(releveOut(id));
  });

  router.post("/api/garage/:id/releves", (req, res) => {
    const id = vehicleId(req);
    if (!q.get.get(id, req.user.id)) return notFound(res);
    const { data, error } = cleanReleve(req.body);
    if (error) return res.status(400).json({ code: "invalid_releve", error });
    const existing = q.releves.all(id);
    const problem = incoherence(existing, data);
    if (problem) return res.status(409).json({ code: "incoherent_releve", error: problem });
    if (!existing.some(r => r.date === data.date) && q.countReleves.get(id).n >= MAX_RELEVES) {
      return res.status(409).json({ code: "too_many_releves", error: `${MAX_RELEVES} relevés au plus par voiture.` });
    }
    q.upsertReleve.run(id, data.date, data.km);
    res.status(201).json(releveOut(id, { vehicule: toPublic(q.get.get(id, req.user.id)) }));
  });

  router.delete("/api/garage/:id/releves/:rid", (req, res) => {
    const id = vehicleId(req);
    if (!q.get.get(id, req.user.id)) return notFound(res);
    const rid = /^\d+$/.test(req.params.rid) ? Number(req.params.rid) : -1;
    if (!q.removeReleve.run(rid, id).changes) return res.status(404).json({ code: "not_found", error: "Relevé introuvable." });
    res.json(releveOut(id, { vehicule: toPublic(q.get.get(id, req.user.id)) }));
  });

  // Pour l'export RGPD : chaque voiture avec tous ses relevés.
  router.exportFor = userId => ({
    vehicules: q.list.all(userId).map(row => ({
      ...toPublic(row),
      releves: q.releves.all(row.id).map(({ date, km }) => ({ date, km })),
      ...(carnet && { entretiens: carnet.forExport(row.id) }),
      ...(rappels && { rappels: rappels.forExport(row.id) }),
    })),
  });
  return router;
}
