// Carnet d'entretien : les entretiens de chaque voiture, avec une facture facultative (photo ou PDF).
// Les fichiers passent uniquement par storage.js.
import express from "express";
import { needUser, sameSiteJson } from "./auth.js";
import { cleanDate, cleanKm, incoherence } from "./kilometrage.js";
import { detectType, FILE_TYPES, MAX_FILE_SIZE } from "./storage.js";

export const TYPES = {
  vidange: "Vidange", distribution: "Distribution", freins: "Freins", pneus: "Pneus", batterie: "Batterie",
  controle_technique: "Contrôle technique", reparation: "Réparation", autre: "Autre",
};
export const MAX_ENTRETIENS = 500; // par voiture
const LIMITS = { description: 1000, garage: 100 };
const COUT_MAX = 100_000_000; // 1 000 000 € en centimes

/* ---------- validation ---------- */
// « 89,90 », « 89.9 », « 1 245 » -> centimes. Renvoie { centimes } (null si vide) ou { error }.
export function cleanCout(raw) {
  if (raw === undefined || raw === null || raw === "") return { centimes: null };
  const s = String(raw).replace(/[\s\u202f\u00a0€]/g, "");
  const m = s.match(/^(\d{1,7})(?:[.,](\d{1,2}))?$/);
  if (!m) return { error: "Coût invalide (ex. 89,90)." };
  const centimes = Number(m[1]) * 100 + Number((m[2] || "0").padEnd(2, "0"));
  return centimes > COUT_MAX ? { error: "Coût trop élevé." } : { centimes };
}

// Renvoie { data } ou { error } à partir des champs du formulaire.
export function cleanEntretien(body, now) {
  const b = body && typeof body === "object" ? body : {};
  const d = cleanDate(b.date, now);
  if (d.error) return d;
  if (!TYPES[b.type]) return { error: "Choisissez le type d'entretien." };
  let km = null;
  if (b.km !== undefined && b.km !== null && b.km !== "") {
    const k = cleanKm(b.km);
    if (k.error) return k;
    km = k.km;
  }
  const text = {};
  for (const [k, max] of Object.entries(LIMITS)) {
    text[k] = typeof b[k] === "string" ? b[k].trim() : "";
    if (text[k].length > max) return { error: `Le champ « ${k} » doit faire au plus ${max} caractères.` };
  }
  const c = cleanCout(b.cout);
  if (c.error) return c;
  return {
    data: {
      date: d.date, km, type: b.type, description: text.description, garage: text.garage.replace(/\s+/g, " "),
      centimes: c.centimes,
      // Le kilométrage alimente les relevés de la voiture, sauf si l'utilisateur décoche la case.
      alimenter: km !== null && b.alimenterReleves !== false,
    },
  };
}

// Nom d'origine d'un fichier, pour l'affichage : sans chemin, sans caractères de contrôle, 100 caractères au plus.
export function cleanFileName(raw) {
  let name = "";
  try { name = decodeURIComponent(String(raw ?? "")); } catch { name = String(raw ?? ""); }
  name = name.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f"<>]/g, "").trim();
  return name.slice(0, 100) || "facture";
}

// Nom de fichier pour l'en-tête Content-Disposition (filename*=UTF-8''…).
const rfc5987 = s => encodeURIComponent(s).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/* ---------- routeur ---------- */
export function createCarnet(db, storage, { log = console.error } = {}) {
  const q = {
    owns: db.prepare("SELECT id FROM vehicles WHERE id = ? AND user_id = ?"),
    list: db.prepare("SELECT * FROM entretiens WHERE vehicle_id = ? ORDER BY date DESC, id DESC"),
    get: db.prepare("SELECT * FROM entretiens WHERE id = ? AND vehicle_id = ?"),
    count: db.prepare("SELECT COUNT(*) AS n FROM entretiens WHERE vehicle_id = ?"),
    insert: db.prepare(`INSERT INTO entretiens (vehicle_id, date, km, type, description, garage, cout_centimes)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE entretiens SET date = ?, km = ?, type = ?, description = ?, garage = ?, cout_centimes = ?,
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND vehicle_id = ?`),
    remove: db.prepare("DELETE FROM entretiens WHERE id = ? AND vehicle_id = ?"),
    setFacture: db.prepare(`UPDATE entretiens SET facture_key = ?, facture_type = ?, facture_taille = ?, facture_nom = ?,
                            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND vehicle_id = ?`),
    releves: db.prepare("SELECT date, km FROM releves WHERE vehicle_id = ?"),
    upsertReleve: db.prepare(`INSERT INTO releves (vehicle_id, date, km) VALUES (?, ?, ?)
                              ON CONFLICT (vehicle_id, date) DO UPDATE SET km = excluded.km`),
    keysOfVehicle: db.prepare("SELECT facture_key FROM entretiens WHERE vehicle_id = ? AND facture_key IS NOT NULL"),
    keysOfUser: db.prepare(`SELECT e.facture_key FROM entretiens e JOIN vehicles v ON v.id = e.vehicle_id
                            WHERE v.user_id = ? AND e.facture_key IS NOT NULL`),
  };

  const factureUrl = row => `/api/garage/${row.vehicle_id}/entretiens/${row.id}/facture`;
  const toPublic = row => ({
    id: row.id, date: row.date, km: row.km, type: row.type, typeLabel: TYPES[row.type] || row.type,
    description: row.description, garage: row.garage,
    cout: row.cout_centimes === null ? null : row.cout_centimes / 100,
    facture: row.facture_key
      ? { nom: row.facture_nom, type: FILE_TYPES[row.facture_type]?.label || row.facture_type, taille: row.facture_taille, url: factureUrl(row) }
      : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
  const listOut = vid => {
    const entretiens = q.list.all(vid).map(toPublic);
    const total = entretiens.reduce((n, e) => n + (e.cout === null ? 0 : Math.round(e.cout * 100)), 0) / 100;
    return { entretiens, total };
  };

  // Supprime des fichiers sans faire échouer la requête : un fichier orphelin vaut mieux qu'une erreur.
  async function removeFiles(keys) {
    for (const key of keys) {
      try { await storage.remove(key); } catch (e) { log("Suppression de facture impossible :", key, e.message); }
    }
  }

  // Express 4 ne rattrape pas les erreurs des fonctions async : on les transmet au gestionnaire d'erreurs.
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  const router = express.Router();
  const base = "/api/garage/:id/entretiens";
  router.use(base, sameSiteJson, needUser);

  // Voiture du propriétaire connecté (sinon 404) et, si demandé, entretien de cette voiture.
  const notFound = (res, what = "Voiture introuvable dans votre garage.") => res.status(404).json({ code: "not_found", error: what });
  const num = s => (/^\d+$/.test(s) ? Number(s) : -1);
  function load(req, res, withEntretien) {
    const vid = num(req.params.id);
    if (!q.owns.get(vid, req.user.id)) { notFound(res); return null; }
    if (!withEntretien) return { vid };
    const row = q.get.get(num(req.params.eid), vid);
    if (!row) { notFound(res, "Entretien introuvable."); return null; }
    return { vid, row };
  }

  // Vérifie le kilométrage par rapport aux relevés, puis l'ajoute aux relevés si demandé. Renvoie un message ou null.
  function checkKm(vid, data) {
    if (data.km === null) return null;
    return incoherence(q.releves.all(vid), data);
  }
  const feedReleves = (vid, data) => { if (data.alimenter) q.upsertReleve.run(vid, data.date, data.km); };

  router.get(base, (req, res) => {
    const ctx = load(req, res); if (!ctx) return;
    res.setHeader("Cache-Control", "no-store");
    res.json(listOut(ctx.vid));
  });

  router.post(base, (req, res) => {
    const ctx = load(req, res); if (!ctx) return;
    const { data, error } = cleanEntretien(req.body);
    if (error) return res.status(400).json({ code: "invalid_entretien", error });
    const problem = checkKm(ctx.vid, data);
    if (problem) return res.status(409).json({ code: "incoherent_km", error: problem });
    if (q.count.get(ctx.vid).n >= MAX_ENTRETIENS) {
      return res.status(409).json({ code: "carnet_full", error: `${MAX_ENTRETIENS} entretiens au plus par voiture.` });
    }
    const { lastInsertRowid } = q.insert.run(ctx.vid, data.date, data.km, data.type, data.description, data.garage, data.centimes);
    feedReleves(ctx.vid, data);
    res.status(201).json({ entretien: toPublic(q.get.get(lastInsertRowid, ctx.vid)), ...listOut(ctx.vid) });
  });

  router.put(`${base}/:eid`, (req, res) => {
    const ctx = load(req, res, true); if (!ctx) return;
    const { data, error } = cleanEntretien(req.body);
    if (error) return res.status(400).json({ code: "invalid_entretien", error });
    const problem = checkKm(ctx.vid, data);
    if (problem) return res.status(409).json({ code: "incoherent_km", error: problem });
    q.update.run(data.date, data.km, data.type, data.description, data.garage, data.centimes, ctx.row.id, ctx.vid);
    feedReleves(ctx.vid, data);
    res.json({ entretien: toPublic(q.get.get(ctx.row.id, ctx.vid)), ...listOut(ctx.vid) });
  });

  router.delete(`${base}/:eid`, wrap(async (req, res) => {
    const ctx = load(req, res, true); if (!ctx) return;
    q.remove.run(ctx.row.id, ctx.vid);
    if (ctx.row.facture_key) await removeFiles([ctx.row.facture_key]);
    res.json(listOut(ctx.vid));
  }));

  /* ---------- facture ---------- */
  // Envoi : PUT avec le fichier brut dans le corps (pas de multipart). Le nom d'origine est dans l'en-tête X-Filename.
  router.put(`${base}/:eid/facture`, express.raw({ type: () => true, limit: MAX_FILE_SIZE }), wrap(async (req, res) => {
    const ctx = load(req, res, true); if (!ctx) return;
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) return res.status(400).json({ code: "empty_file", error: "Fichier vide." });
    const ext = detectType(buf); // le vrai type, d'après le contenu
    if (!ext) return res.status(415).json({ code: "unsupported_file", error: "Seuls les photos (JPEG, PNG, WebP, HEIC) et les PDF sont acceptés." });
    const key = await storage.save(buf, { ext });
    try {
      q.setFacture.run(key, ext, buf.length, cleanFileName(req.get("X-Filename")), ctx.row.id, ctx.vid);
    } catch (e) {
      await removeFiles([key]);
      throw e;
    }
    if (ctx.row.facture_key) await removeFiles([ctx.row.facture_key]); // l'ancienne facture est remplacée
    res.json({ entretien: toPublic(q.get.get(ctx.row.id, ctx.vid)) });
  }));

  router.get(`${base}/:eid/facture`, wrap(async (req, res) => {
    const ctx = load(req, res, true); if (!ctx) return;
    const buf = ctx.row.facture_key ? await storage.read(ctx.row.facture_key) : null;
    if (!buf) return notFound(res, "Pas de facture pour cet entretien.");
    const type = FILE_TYPES[ctx.row.facture_type];
    // Les navigateurs n'affichent pas le HEIC : on le propose au téléchargement.
    const disposition = ctx.row.facture_type === "heic" ? "attachment" : "inline";
    res.set({
      "Content-Type": type.mime,
      "Content-Length": buf.length,
      "Content-Disposition": `${disposition}; filename="facture-${ctx.row.date}.${ctx.row.facture_type}"; filename*=UTF-8''${rfc5987(ctx.row.facture_nom || "facture")}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    res.end(buf);
  }));

  router.delete(`${base}/:eid/facture`, wrap(async (req, res) => {
    const ctx = load(req, res, true); if (!ctx) return;
    if (!ctx.row.facture_key) return notFound(res, "Pas de facture pour cet entretien.");
    q.setFacture.run(null, null, null, null, ctx.row.id, ctx.vid);
    await removeFiles([ctx.row.facture_key]);
    res.json({ entretien: toPublic(q.get.get(ctx.row.id, ctx.vid)) });
  }));

  // Fichier trop gros : message clair plutôt que la page d'erreur par défaut d'Express.
  router.use(base, (err, req, res, next) => {
    if (err?.type === "entity.too.large") {
      return res.status(413).json({ code: "file_too_large", error: `Fichier trop lourd (${MAX_FILE_SIZE / 1024 / 1024} Mo au plus).` });
    }
    next(err);
  });

  /* ---------- pour les autres modules ---------- */
  // Export RGPD : entretiens d'une voiture, avec la liste de leurs factures.
  router.forExport = vid => q.list.all(vid).map(toPublic);
  // Résumé pour la carte de la voiture.
  router.summary = vid => {
    const rows = q.list.all(vid);
    return { nombre: rows.length, dernier: rows[0] ? { date: rows[0].date, type: rows[0].type, typeLabel: TYPES[rows[0].type] } : null };
  };
  // Suppressions en cascade : la base efface les lignes, il reste à effacer les fichiers.
  // Renvoient une fonction à appeler APRÈS la suppression en base.
  router.beforeDeleteVehicle = vid => { const keys = q.keysOfVehicle.all(vid).map(r => r.facture_key); return () => removeFiles(keys); };
  router.beforeDeleteUser = uid => { const keys = q.keysOfUser.all(uid).map(r => r.facture_key); return () => removeFiles(keys); };
  return router;
}
