// « À venir » d'une voiture (routes) et rappels libres. Le calcul lui-même est dans avenir.js.
import express from "express";
import { needUser, sameSiteJson } from "./auth.js";
import { cleanAnyDate, cleanKm, stats, today } from "./kilometrage.js";
import { computeAvenir } from "./avenir.js";

export const MAX_RAPPELS = 50; // rappels libres par voiture

// Renvoie { data: { titre, date, km } } ou { error }.
export function cleanRappel(body) {
  const b = body && typeof body === "object" ? body : {};
  const titre = typeof b.titre === "string" ? b.titre.trim().replace(/\s+/g, " ") : "";
  if (!titre) return { error: "Donnez un titre au rappel." };
  if (titre.length > 100) return { error: "Le titre doit faire au plus 100 caractères." };
  const empty = v => v === undefined || v === null || v === "";
  let date = null, km = null;
  if (!empty(b.date)) { const d = cleanAnyDate(b.date); if (d.error) return d; date = d.date; }
  if (!empty(b.km)) { const k = cleanKm(b.km); if (k.error) return k; km = k.km; }
  if (date === null && km === null) return { error: "Indiquez une date, un kilométrage, ou les deux." };
  return { data: { titre, date, km } };
}

export function createRappels(db, kb, { now = today } = {}) {
  const q = {
    owned: db.prepare("SELECT * FROM vehicles WHERE id = ? AND user_id = ?"),
    releves: db.prepare("SELECT date, km FROM releves WHERE vehicle_id = ?"),
    entretiens: db.prepare("SELECT date, km, type, description FROM entretiens WHERE vehicle_id = ?"),
    list: db.prepare("SELECT id, titre, date, km FROM rappels WHERE vehicle_id = ? ORDER BY id"),
    count: db.prepare("SELECT COUNT(*) AS n FROM rappels WHERE vehicle_id = ?"),
    insert: db.prepare("INSERT INTO rappels (vehicle_id, titre, date, km) VALUES (?, ?, ?, ?)"),
    remove: db.prepare("DELETE FROM rappels WHERE id = ? AND vehicle_id = ?"),
  };
  const ficheById = id => kb.vehicules.find(f => f.id === id); // base rechargeable (Relecture)

  // Calcul complet pour une ligne de la table vehicles.
  function forVehicle(row) {
    const releves = q.releves.all(row.id);
    return computeAvenir({
      vehicle: row,
      fiche: row.fiche_id ? ficheById(row.fiche_id) || null : null,
      releves,
      kilometrage: stats(releves),
      entretiens: q.entretiens.all(row.id),
      rappels: q.list.all(row.id),
      today: now(),
    });
  }

  const router = express.Router();
  router.use(["/api/garage/:id/avenir", "/api/garage/:id/rappels"], sameSiteJson, needUser);
  const num = s => (/^\d+$/.test(s) ? Number(s) : -1);
  const vehicleOf = (req, res) => {
    const row = q.owned.get(num(req.params.id), req.user.id);
    if (!row) res.status(404).json({ code: "not_found", error: "Voiture introuvable dans votre garage." });
    return row;
  };

  router.get("/api/garage/:id/avenir", (req, res) => {
    const row = vehicleOf(req, res); if (!row) return;
    res.setHeader("Cache-Control", "no-store");
    res.json(forVehicle(row));
  });

  router.post("/api/garage/:id/rappels", (req, res) => {
    const row = vehicleOf(req, res); if (!row) return;
    const { data, error } = cleanRappel(req.body);
    if (error) return res.status(400).json({ code: "invalid_rappel", error });
    if (q.count.get(row.id).n >= MAX_RAPPELS) return res.status(409).json({ code: "too_many_rappels", error: `${MAX_RAPPELS} rappels au plus par voiture.` });
    q.insert.run(row.id, data.titre, data.date, data.km);
    res.status(201).json(forVehicle(row));
  });

  router.delete("/api/garage/:id/rappels/:rid", (req, res) => {
    const row = vehicleOf(req, res); if (!row) return;
    if (!q.remove.run(num(req.params.rid), row.id).changes) return res.status(404).json({ code: "not_found", error: "Rappel introuvable." });
    res.json(forVehicle(row));
  });

  // Pour la carte de la voiture : le plus urgent et le nombre d'éléments en retard.
  router.forVehicle = forVehicle;
  router.summary = row => {
    const r = forVehicle(row);
    return { plusUrgent: r.plusUrgent, enRetard: r.enRetard, aCompleter: r.items.filter(it => it.statut === "inconnu").length };
  };
  // Pour l'export RGPD : les rappels libres saisis par l'utilisateur.
  router.forExport = vid => q.list.all(vid).map(({ titre, date, km }) => ({ titre, date, km }));
  return router;
}
