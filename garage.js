// Mon garage : les voitures de l'utilisateur, reliées si possible à une fiche de la base Rétroviz.
import express from "express";
import { findVehicle, vehicleLabel } from "./knowledge.js";
import { needUser, sameSiteJson } from "./auth.js";
import { cleanReleve, cleanDate, cleanAnyDate, incoherence, stats, kmText, MAX_RELEVES, today } from "./kilometrage.js";
import { saisiLe, estAncienne } from "./historique.js";
import { detectType, FILE_TYPES, MAX_FILE_SIZE } from "./storage.js";
import { ENERGIES, energieDe } from "./energie.js";

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
  data.dernierCt = null;
  if (!empty(b.dernierCt)) {
    const d = cleanDate(b.dernierCt);
    if (d.error) return { error: `Date du dernier contrôle technique : ${d.error.toLowerCase()}` };
    data.dernierCt = d.date;
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
  // Achat (facultatif) : point de départ de la page de vie et des chiffres clés.
  data.achatDate = null;
  if (!empty(b.achatDate)) {
    const d = cleanDate(b.achatDate);
    if (d.error) return { error: `Date d'achat : ${d.error.toLowerCase()}` };
    data.achatDate = d.date;
  }
  const ak = int(b.achatKm, 0, 2_000_000, "Kilométrage à l'achat");
  if (ak.error) return { error: ak.error };
  data.achatKm = ak.value;
  data.energie = typeof b.energie === "string" && ENERGIES.includes(b.energie) ? b.energie : null;
  if (!empty(b.energie) && !data.energie) return { error: "Énergie : thermique, hybride, hybride rechargeable ou électrique." };
  return { data };
}

// Photos de voiture : seulement des images que les navigateurs affichent (pas de PDF ni de HEIC).
export const TYPES_PHOTO = ["jpg", "png", "webp"];

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
// valeur (facultatif) : module valeur.js, pour la dernière estimation et l'export.
// storage (facultatif) : module storage.js, pour la photo de la voiture.
// badge (facultatif) : module badge.js, pour l'état du badge « Voiture bien suivie » sur la carte.
export function createGarage(db, kb, { carnet = null, rappels = null, valeur = null, storage = null, badge = null, log = console.error, now = today } = {}) {
  const q = {
    list: db.prepare("SELECT * FROM vehicles WHERE user_id = ? ORDER BY created_at, id"),
    get: db.prepare("SELECT * FROM vehicles WHERE id = ? AND user_id = ?"),
    count: db.prepare("SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ?"),
    insert: db.prepare(`INSERT INTO vehicles (user_id, surnom, marque, modele, motorisation, annee, boite, fiche_id, fiche_refusee,
                          mise_en_circulation, assurance_echeance, pneus_hiver, vidange_km, vidange_mois, dernier_ct, achat_date, achat_km, energie)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE vehicles SET surnom = ?, marque = ?, modele = ?, motorisation = ?, annee = ?, boite = ?,
                        fiche_id = ?, fiche_refusee = ?, mise_en_circulation = ?, assurance_echeance = ?, pneus_hiver = ?,
                        vidange_km = ?, vidange_mois = ?, dernier_ct = ?, achat_date = ?, achat_km = ?, energie = ?,
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                        WHERE id = ? AND user_id = ?`),
    remove: db.prepare("DELETE FROM vehicles WHERE id = ? AND user_id = ?"),
    setPhoto: db.prepare("UPDATE vehicles SET photo_key = ?, photo_type = ?, photo_maj = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND user_id = ?"),
    photosOfUser: db.prepare("SELECT photo_key FROM vehicles WHERE user_id = ? AND photo_key IS NOT NULL"),
    releves: db.prepare("SELECT id, date, km, created_at, verrouille FROM releves WHERE vehicle_id = ? ORDER BY date DESC"),
    releveDuJour: db.prepare("SELECT * FROM releves WHERE vehicle_id = ? AND date = ?"),
    releve: db.prepare("SELECT * FROM releves WHERE id = ? AND vehicle_id = ?"),
    modifs: db.prepare("SELECT objet_id, le, champs FROM modifications WHERE vehicle_id = ? AND objet = 'releve' ORDER BY le, id"),
    addModif: db.prepare("INSERT INTO modifications (vehicle_id, objet, objet_id, le, champs) VALUES (?, 'releve', ?, ?, ?)"),
    notes: db.prepare("SELECT id, objet_id, texte, verrouille, cree_le FROM notes WHERE vehicle_id = ? AND objet = 'releve' ORDER BY cree_le, id"),
    countReleves: db.prepare("SELECT COUNT(*) AS n FROM releves WHERE vehicle_id = ?"),
    upsertReleve: db.prepare(`INSERT INTO releves (vehicle_id, date, km) VALUES (?, ?, ?)
                              ON CONFLICT (vehicle_id, date) DO UPDATE SET km = excluded.km`),
    removeReleve: db.prepare("DELETE FROM releves WHERE id = ? AND vehicle_id = ?"),
  };
  // Recherche à chaque fois : la base peut être rechargée après une correction dans la Relecture.
  const ficheById = id => kb.vehicules.find(f => f.id === id);

  const toPublic = row => {
    const fiche = row.fiche_id ? ficheById(row.fiche_id) : null; // fiche retirée de la base : plus de lien
    const kilometrage = stats(q.releves.all(row.id));
    return {
      id: row.id, surnom: row.surnom, marque: row.marque, modele: row.modele, motorisation: row.motorisation,
      annee: row.annee, boite: row.boite,
      miseEnCirculation: row.mise_en_circulation, assuranceEcheance: row.assurance_echeance, pneusHiver: !!row.pneus_hiver,
      vidangeKm: row.vidange_km, vidangeMois: row.vidange_mois, dernierCt: row.dernier_ct,
      achatDate: row.achat_date, achatKm: row.achat_km,
      energie: row.energie, energieEffective: energieDe(row),
      photo: row.photo_key ? { url: `/api/garage/${row.id}/photo?v=${encodeURIComponent(row.photo_maj || "")}` } : null,
      fiche: fiche ? { id: fiche.id, label: vehicleLabel(fiche), statut: fiche.statut === "verifie" ? "verifie" : "a_verifier" } : null,
      ficheRefusee: !!row.fiche_refusee,
      kilometrage,
      ...(carnet && { carnet: carnet.summary(row.id) }),
      ...(rappels && { avenir: rappels.summary(row) }),
      ...(valeur && { valeur: valeur.latest(row.id) }),
      ...(badge && { badge: (b => ({ obtenu: b.obtenu, manquants: b.manquants, perduLe: b.perduLe }))(badge.pour(row)) }),
      designation: designation(row, kilometrage.dernier?.km ?? null),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  };
  const ficheFor = d => (d.ficheRefusee ? null : matchFiche(d, kb));
  const params = d => [d.surnom, d.marque, d.modele, d.motorisation, d.annee, d.boite, ficheFor(d), d.ficheRefusee ? 1 : 0,
    d.miseEnCirculation, d.assuranceEcheance, d.pneusHiver ? 1 : 0, d.vidangeKm, d.vidangeMois, d.dernierCt, d.achatDate, d.achatKm, d.energie];
  // Supprime des fichiers sans faire échouer la requête (un fichier orphelin vaut mieux qu'une erreur).
  const removeFiles = async keys => { for (const k of keys) { try { await storage?.remove(k); } catch (e) { log("Suppression de photo impossible :", k, e.message); } } };
  const notFound = res => res.status(404).json({ code: "not_found", error: "Voiture introuvable dans votre garage." });
  const vehicleId = req => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : -1);
  // Relevés avec leur niveau de confiance : saisi après coup, modifié, reçu d'un ancien propriétaire, notes.
  const relevesPublics = vid => {
    const modifs = new Map(), notes = new Map();
    for (const m of q.modifs.all(vid)) { if (!modifs.has(m.objet_id)) modifs.set(m.objet_id, []); modifs.get(m.objet_id).push({ le: m.le, champs: JSON.parse(m.champs) }); }
    for (const n of q.notes.all(vid)) { if (!notes.has(n.objet_id)) notes.set(n.objet_id, []); notes.get(n.objet_id).push({ id: n.id, texte: n.texte, le: n.cree_le.slice(0, 10), verrouille: !!n.verrouille }); }
    return q.releves.all(vid).map(r => ({ id: r.id, date: r.date, km: r.km, verrouille: !!r.verrouille, saisiLe: saisiLe(r),
      modifications: modifs.get(r.id) || [], notes: notes.get(r.id) || [] }));
  };
  const releveOut = (vid, extra = {}) => {
    const list = relevesPublics(vid);
    return { releves: list, ...stats(list), ...extra };
  };
  const recuMsg = "Ce relevé vient d'un ancien propriétaire : il ne peut être ni modifié ni supprimé. Vous pouvez y ajouter une note.";

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
    const row = q.get.get(id, req.user.id);
    if (!row) return notFound(res);
    const cleanup = carnet ? carnet.beforeDeleteVehicle(id) : null;
    q.remove.run(id, req.user.id); // relevés et entretiens partent avec (ON DELETE CASCADE)
    try {
      if (cleanup) await cleanup();
      if (row.photo_key) await removeFiles([row.photo_key]);
    } catch (e) { return next(e); }
    res.json({ ok: true });
  });

  /* ---------- photo de la voiture : mêmes contrôles que les factures ---------- */
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  router.put("/api/garage/:id/photo", express.raw({ type: () => true, limit: MAX_FILE_SIZE }), wrap(async (req, res) => {
    const id = vehicleId(req);
    const row = q.get.get(id, req.user.id);
    if (!row) return notFound(res);
    if (!storage) return res.status(503).json({ code: "unavailable", error: "Stockage des photos indisponible." });
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) return res.status(400).json({ code: "empty_file", error: "Fichier vide." });
    const ext = detectType(buf); // le vrai type, d'après le contenu
    if (!TYPES_PHOTO.includes(ext)) return res.status(415).json({ code: "unsupported_file", error: "Seules les photos JPEG, PNG ou WebP sont acceptées." });
    const key = await storage.save(buf, { ext });
    q.setPhoto.run(key, ext, id, req.user.id);
    if (row.photo_key) await removeFiles([row.photo_key]); // l'ancienne photo est remplacée
    res.json({ vehicule: toPublic(q.get.get(id, req.user.id)) });
  }));
  router.get("/api/garage/:id/photo", wrap(async (req, res) => {
    const row = q.get.get(vehicleId(req), req.user.id);
    const buf = row?.photo_key && storage ? await storage.read(row.photo_key) : null;
    if (!buf) return res.status(404).json({ code: "not_found", error: "Pas de photo." });
    res.set({ "Content-Type": FILE_TYPES[row.photo_type].mime, "Content-Length": buf.length, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400" });
    res.end(buf);
  }));
  router.delete("/api/garage/:id/photo", wrap(async (req, res) => {
    const id = vehicleId(req);
    const row = q.get.get(id, req.user.id);
    if (!row) return notFound(res);
    if (!row.photo_key) return res.status(404).json({ code: "not_found", error: "Pas de photo." });
    q.setPhoto.run(null, null, id, req.user.id);
    await removeFiles([row.photo_key]);
    res.json({ vehicule: toPublic(q.get.get(id, req.user.id)) });
  }));
  // Fichier trop gros : message clair.
  router.use("/api/garage/:id/photo", (err, req, res, next) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ code: "file_too_large", error: `Photo trop lourde (${MAX_FILE_SIZE / 1024 / 1024} Mo au plus).` });
    next(err);
  });
  // Suppression du compte : effacer aussi les photos (appelé avant l'effacement en base).
  router.beforeDeleteUser = uid => { const keys = q.photosOfUser.all(uid).map(r => r.photo_key); return () => removeFiles(keys); };

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
    const meme = q.releveDuJour.get(id, data.date); // le relevé du même jour est remplacé
    if (meme?.verrouille) return res.status(403).json({ code: "verrouille", error: recuMsg });
    const problem = incoherence(existing, data);
    if (problem) return res.status(409).json({ code: "incoherent_releve", error: problem });
    if (!meme && q.countReleves.get(id).n >= MAX_RELEVES) {
      return res.status(409).json({ code: "too_many_releves", error: `${MAX_RELEVES} relevés au plus par voiture.` });
    }
    if (meme && meme.km !== data.km && estAncienne(meme, now())) q.addModif.run(id, meme.id, now(), JSON.stringify([{ champ: "km", avant: meme.km, apres: data.km }]));
    q.upsertReleve.run(id, data.date, data.km);
    res.status(201).json(releveOut(id, { vehicule: toPublic(q.get.get(id, req.user.id)) }));
  });

  router.delete("/api/garage/:id/releves/:rid", (req, res) => {
    const id = vehicleId(req);
    if (!q.get.get(id, req.user.id)) return notFound(res);
    const rid = /^\d+$/.test(req.params.rid) ? Number(req.params.rid) : -1;
    const r = q.releve.get(rid, id);
    if (!r) return res.status(404).json({ code: "not_found", error: "Relevé introuvable." });
    if (r.verrouille) return res.status(403).json({ code: "verrouille", error: recuMsg });
    if (estAncienne(r, now())) q.addModif.run(id, r.id, now(), JSON.stringify([{ champ: "suppression", avant: { date: r.date, km: r.km }, apres: null }]));
    q.removeReleve.run(rid, id);
    res.json(releveOut(id, { vehicule: toPublic(q.get.get(id, req.user.id)) }));
  });

  // Pour l'export RGPD : chaque voiture avec tous ses relevés.
  router.toPublic = toPublic;
  router.exportFor = userId => ({
    vehicules: q.list.all(userId).map(row => ({
      ...toPublic(row),
      releves: relevesPublics(row.id).map(({ date, km, verrouille, saisiLe, modifications, notes }) => ({ date, km, recuDUnAncienProprietaire: verrouille, saisiLe, modifications, notes })),
      ...(carnet && { entretiens: carnet.forExport(row.id) }),
      ...(rappels && { rappels: rappels.forExport(row.id) }),
      ...(valeur && { estimations: valeur.forExport(row.id) }),
    })),
  });
  return router;
}
