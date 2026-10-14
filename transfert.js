// Carnet qui suit la voiture : dossier partageable en lecture seule, transfert au nouveau propriétaire,
// notes sur l'historique reçu. Rien d'identifiant ne sort sans que le propriétaire l'ait coché.
import crypto from "node:crypto";
import express from "express";
import { needUser, sameSiteJson } from "./auth.js";
import { construireVie } from "./vie.js";
import { TYPES } from "./carnet.js";
import { energieDe } from "./energie.js";
import { today } from "./kilometrage.js";
import { resumeSaisie } from "./historique.js";
import { sansMetadonnees } from "./metadonnees.js";
import { FILE_TYPES } from "./storage.js";
import { MAX_VEHICLES } from "./garage.js";

export const DUREES_PARTAGE = [1, 7, 30];   // jours
export const DUREE_TRANSFERT = 7;          // jours
export const ESSAIS_PAR_HEURE = 10;        // codes de transfert faux, par compte
export const ESSAIS_PAR_IP = 30;           // et par adresse IP (comptes multiples)
export const NOTE_MAX = 500;
export const NOTES_MAX = 200;              // par voiture
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ni I, O, 0, 1 : pas de confusion à la saisie
const HEURE = 3_600_000;
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const ENERGIE_TXT = { thermique: "essence ou diesel", hybride: "hybride", hybride_rechargeable: "hybride rechargeable", electrique: "électrique" };

/* ---------- code de transfert ---------- */
export function nouveauCode() {
  let c = "";
  for (let i = 0; i < 8; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
// « abcd efgh », « ABCD-EFGH » -> « ABCDEFGH » ; null si la forme est impossible.
export function normaliserCode(raw) {
  const c = String(raw ?? "").toUpperCase().replace(/[\s-]/g, "");
  return new RegExp(`^[${ALPHABET}]{8}$`).test(c) ? c : null;
}

/* ---------- options choisies par le propriétaire ----------
   Tout est décoché par défaut : noms de garage, descriptions, factures, photo, estimations de valeur. */
export function cleanOptions(body, entretiens, { partage = false } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const ids = (list, garder) => {
    const voulus = new Set((Array.isArray(list) ? list : []).map(Number).filter(Number.isInteger));
    return entretiens.filter(e => voulus.has(e.id) && garder(e)).map(e => e.id);
  };
  const o = {
    garages: b.garages === true,
    descriptions: ids(b.descriptions, e => !!e.description),
    factures: ids(b.factures, e => !!e.facture_key),
    photo: b.photo === true,
  };
  if (partage) {
    o.valeur = b.valeur === true;
    const d = Number(b.duree ?? 7);
    if (!DUREES_PARTAGE.includes(d)) return { error: "Durée du lien : 1, 7 ou 30 jours." };
    o.duree = d;
  }
  return { options: o };
}

/**
 * Dossier de la voiture tel que le voit un visiteur (ou le nouveau propriétaire avant d'accepter).
 * donnees : résultat de vie.donnees(v) ; options : cleanOptions ; badge : badge.pour(v) ; avenir : rappels.forVehicle(v) ;
 * valeur : dernière estimation (ou null) ; urls : { facture(id), photo } ; photo : true si la voiture a une photo.
 */
export function construireDossier({ donnees, options: o, badge, avenir, valeur = null, urls, photo = false, expireLe = null }) {
  const v = donnees.vehicule;
  const vie = construireVie(donnees);
  const parId = new Map(donnees.entretiens.map(e => [e.id, e]));
  const frise = [];
  for (const ev of vie.evenements) {
    if (ev.type === "valeur" && !o.valeur) continue;
    const e = { ...ev };
    if (e.type === "ajout") e.titre = "Début du suivi dans Rétroviz";
    if (e.type === "jalon") e.titre = e.titre.replace("avec vous", "avec ce propriétaire");
    if (e.type === "entretien") {
      const row = parId.get(e.entretienId);
      e.detail = o.garages ? row.garage || null : null;
      e.description = o.descriptions.includes(row.id) ? row.description : null;
      const montree = row.facture_key && o.factures.includes(row.id);
      e.facture = montree ? urls.facture(row.id) : null;
      e.factureMasquee = montree && !!row.facture_masquee_key;
      e.factureNonMontree = !!row.facture_key && !montree;
    }
    delete e.entretienId; delete e.releveId;
    frise.push(e);
  }
  const suppressions = donnees.modifications.filter(m => m.champs && JSON.parse(m.champs).some(c => c.champ === "suppression")).length;
  return {
    voiture: {
      marque: v.marque, modele: v.modele, motorisation: v.motorisation || null, annee: v.annee ?? null, boite: v.boite || null,
      energie: ENERGIE_TXT[energieDe(v)], miseEnCirculation: v.mise_en_circulation ? v.mise_en_circulation.slice(0, 7) : null, // mois et année seulement
    },
    photo: o.photo && photo ? urls.photo : null,
    badge: { obtenu: badge.obtenu, criteres: badge.criteres.map(({ titre, ok, detail }) => ({ titre, ok, detail })), avertissement: badge.avertissement },
    chiffres: vie.chiffres,
    continuite: vie.continuite,
    jalons: vie.jalons.map(j => ({ ...j, titre: j.titre.replace("avec vous", "avec ce propriétaire") })),
    frise,
    changementsProprietaire: donnees.transferts.map(t => t.accepte_le),
    echeances: avenir.items.filter(it => it.cle === "ct" || it.cle === "vidange" || it.categorie === "entretien")
      .map(it => ({ titre: it.titre, statut: it.statut, date: it.date, dateEstimee: it.dateEstimee, km: it.km, suppose: it.cle === "ct" && it.aCompleter === "dernier_ct" })),
    valeur: o.valeur && valeur ? { date: valeur.date, basse: valeur.basse, haute: valeur.haute, valeurProbable: valeur.valeurProbable } : null,
    saisieTardive: resumeSaisie(donnees.entretiens, donnees.releves),
    suppressions,
    nombres: { releves: donnees.releves.length, entretiens: donnees.entretiens.length, avecFacture: donnees.entretiens.filter(e => e.facture_key).length },
    expireLe,
    avertissement: "Ce dossier repose sur les informations saisies par les propriétaires successifs. « Avec facture » : une facture a été jointe ; « déclaré » : sans justificatif.",
  };
}

export function createTransfert(db, { carnet, vie, badge, rappels, valeur = null, storage, now = () => Date.now(), log = console.error } = {}) {
  const iso = ms => new Date(ms).toISOString();
  const jour = () => today(new Date(now()));
  const q = {
    owned: db.prepare("SELECT * FROM vehicles WHERE id = ? AND user_id = ?"),
    vehicule: db.prepare("SELECT * FROM vehicles WHERE id = ?"),
    entretiens: db.prepare("SELECT * FROM entretiens WHERE vehicle_id = ? ORDER BY date DESC, id DESC"),
    entretien: db.prepare("SELECT * FROM entretiens WHERE id = ? AND vehicle_id = ?"),
    nbReleves: db.prepare("SELECT COUNT(*) AS n FROM releves WHERE vehicle_id = ?"),
    maxKm: db.prepare(`SELECT MAX(km) AS km FROM (SELECT km FROM releves WHERE vehicle_id = ?1 UNION ALL SELECT km FROM entretiens WHERE vehicle_id = ?1 AND km IS NOT NULL)`),
    nbVoitures: db.prepare("SELECT COUNT(*) AS n FROM vehicles WHERE user_id = ?"),
    // partages
    partages: db.prepare("SELECT * FROM partages WHERE vehicle_id = ? ORDER BY id DESC"),
    partage: db.prepare("SELECT * FROM partages WHERE token_hash = ?"),
    addPartage: db.prepare("INSERT INTO partages (vehicle_id, token_hash, options, cree_le, expire_le) VALUES (?, ?, ?, ?, ?)"),
    revoquer: db.prepare("UPDATE partages SET revoque_le = ? WHERE id = ? AND vehicle_id = ? AND revoque_le IS NULL"),
    // transferts
    enAttente: db.prepare("SELECT * FROM transferts WHERE vehicle_id = ? AND statut = 'en_attente' AND expire_le > ?"),
    parCode: db.prepare("SELECT * FROM transferts WHERE code_hash = ? AND statut = 'en_attente'"),
    annuler: db.prepare("UPDATE transferts SET statut = 'annule', code_hash = NULL, options = '{}' WHERE vehicle_id = ? AND statut = 'en_attente'"),
    addTransfert: db.prepare("INSERT INTO transferts (vehicle_id, code_hash, options, cree_le, expire_le) VALUES (?, ?, ?, ?, ?)"),
    datesTransfert: db.prepare("SELECT accepte_le FROM transferts WHERE vehicle_id = ? AND statut = 'accepte' ORDER BY accepte_le"),
    // essais
    essais: db.prepare("SELECT COUNT(*) AS n FROM essais_transfert WHERE user_id = ? AND le > ?"),
    addEssai: db.prepare("INSERT INTO essais_transfert (user_id, le) VALUES (?, ?)"),
    purgeEssais: db.prepare("DELETE FROM essais_transfert WHERE le <= ?"),
    // notes
    cible: { releve: db.prepare("SELECT verrouille FROM releves WHERE id = ? AND vehicle_id = ?"), entretien: db.prepare("SELECT verrouille FROM entretiens WHERE id = ? AND vehicle_id = ?") },
    nbNotes: db.prepare("SELECT COUNT(*) AS n FROM notes WHERE vehicle_id = ?"),
    addNote: db.prepare("INSERT INTO notes (vehicle_id, objet, objet_id, texte) VALUES (?, ?, ?, ?)"),
    note: db.prepare("SELECT * FROM notes WHERE id = ? AND vehicle_id = ?"),
    delNote: db.prepare("DELETE FROM notes WHERE id = ? AND vehicle_id = ?"),
  };

  const notFound = (res, error = "Voiture introuvable dans votre garage.") => res.status(404).json({ code: "not_found", error });
  const num = s => (/^\d+$/.test(s) ? Number(s) : -1);
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const voitureDe = (req, res) => { const v = q.owned.get(num(req.params.id), req.user.id); if (!v) notFound(res); return v; };

  // Dossier d'une voiture avec des options données. urls : selon qu'il est vu par un visiteur ou en aperçu par le propriétaire.
  const dossier = (v, options, urls, expireLe = null) => construireDossier({
    donnees: vie.donnees(v), options, badge: badge.pour(v), avenir: rappels.forVehicle(v), valeur: valeur?.latest(v.id) ?? null,
    urls, photo: !!v.photo_key, expireLe,
  });
  const urlsApercu = v => ({ facture: id => `/api/garage/${v.id}/entretiens/${id}/facture?version=partage`, photo: `/api/garage/${v.id}/partage/photo` });
  const urlsPublic = token => ({ facture: id => `/api/dossier/${token}/factures/${id}`, photo: `/api/dossier/${token}/photo` });

  // Ce que le propriétaire peut cocher : entretiens avec description, garage ou facture.
  const choix = v => ({
    entretiens: q.entretiens.all(v.id).filter(e => e.description || e.garage || e.facture_key).map(e => ({
      id: e.id, date: e.date, type: e.type, typeLabel: TYPES[e.type] || e.type, km: e.km, description: e.description, garage: e.garage, verrouille: !!e.verrouille,
      facture: e.facture_key ? { type: e.facture_type, label: FILE_TYPES[e.facture_type]?.label, image: ["jpg", "png", "webp"].includes(e.facture_type), pdf: e.facture_type === "pdf",
        masquee: !!e.facture_masquee_key, url: `/api/garage/${v.id}/entretiens/${e.id}/facture`, urlPartage: `/api/garage/${v.id}/entretiens/${e.id}/facture?version=partage` } : null,
    })),
    photo: !!v.photo_key,
    valeur: !!valeur?.latest(v.id),
    releves: q.nbReleves.get(v.id).n,
  });
  const partagePublic = p => {
    const o = JSON.parse(p.options);
    return { id: p.id, creeLe: p.cree_le, expireLe: p.expire_le, revoqueLe: p.revoque_le, actif: !p.revoque_le && p.expire_le > iso(now()),
      resume: { factures: o.factures.length, descriptions: o.descriptions.length, garages: o.garages, photo: o.photo, valeur: o.valeur } };
  };

  const router = express.Router();

  // La page du dossier ne doit être ni indexée ni transmettre son adresse (le lien contient le jeton).
  router.get("/dossier.html", (req, res, next) => { res.set({ "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" }); next(); });

  router.use(["/api/garage/:id/partage", "/api/garage/:id/partages", "/api/garage/:id/transfert", "/api/garage/:id/notes", "/api/transfert"], sameSiteJson, needUser);

  /* ---------- état : liens actifs, transfert en attente, ce qui peut être coché ---------- */
  router.get("/api/garage/:id/partage", (req, res) => {
    const v = voitureDe(req, res); if (!v) return;
    const t = q.enAttente.get(v.id, iso(now()));
    res.setHeader("Cache-Control", "no-store");
    res.json({ partages: q.partages.all(v.id).map(partagePublic), transfert: t ? { creeLe: t.cree_le, expireLe: t.expire_le, options: JSON.parse(t.options) } : null, choix: choix(v) });
  });

  // Aperçu exact du dossier avec les options cochées (mêmes données que le visiteur).
  router.post("/api/garage/:id/partage/apercu", (req, res) => {
    const v = voitureDe(req, res); if (!v) return;
    const { options, error } = cleanOptions(req.body, q.entretiens.all(v.id), { partage: true });
    if (error) return res.status(400).json({ code: "invalid_options", error });
    res.setHeader("Cache-Control", "no-store");
    res.json({ dossier: dossier(v, options, urlsApercu(v)) });
  });
  // Photo telle qu'elle serait partagée : sans métadonnées.
  router.get("/api/garage/:id/partage/photo", wrap(async (req, res) => {
    const v = voitureDe(req, res); if (!v) return;
    await envoyerPhoto(res, v);
  }));
  async function envoyerPhoto(res, v) {
    const buf = v.photo_key ? await storage.read(v.photo_key) : null;
    if (!buf) return notFound(res, "Pas de photo.");
    const propre = sansMetadonnees(buf, v.photo_type).buffer;
    res.set({ "Content-Type": FILE_TYPES[v.photo_type].mime, "Content-Length": propre.length, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" });
    res.end(propre);
  }

  router.post("/api/garage/:id/partages", (req, res) => {
    const v = voitureDe(req, res); if (!v) return;
    const { options, error } = cleanOptions(req.body, q.entretiens.all(v.id), { partage: true });
    if (error) return res.status(400).json({ code: "invalid_options", error });
    const token = crypto.randomBytes(24).toString("base64url");
    const { lastInsertRowid } = q.addPartage.run(v.id, sha256(token), JSON.stringify(options), iso(now()), iso(now() + options.duree * 86_400_000));
    // Le lien n'est montré qu'une fois : seule son empreinte est gardée.
    res.status(201).json({ lien: `/dossier.html#${token}`, partage: partagePublic(q.partages.all(v.id).find(p => p.id === Number(lastInsertRowid))) });
  });
  router.delete("/api/garage/:id/partages/:pid", (req, res) => {
    const v = voitureDe(req, res); if (!v) return;
    if (!q.revoquer.run(iso(now()), num(req.params.pid), v.id).changes) return notFound(res, "Lien introuvable ou déjà révoqué.");
    res.json({ partages: q.partages.all(v.id).map(partagePublic) });
  });

  /* ---------- dossier public (lien) ---------- */
  const partageValide = token => {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
    const p = q.partage.get(sha256(token));
    if (!p || p.revoque_le || p.expire_le <= iso(now())) return null;
    const v = q.vehicule.get(p.vehicle_id);
    return v ? { p, v, options: JSON.parse(p.options) } : null;
  };
  const publicHeaders = res => res.set({ "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
  const lienMort = res => res.status(404).json({ code: "lien_invalide", error: "Ce lien a expiré ou a été révoqué par le propriétaire de la voiture." });
  router.get("/api/dossier/:token", (req, res) => {
    publicHeaders(res);
    const s = partageValide(req.params.token);
    if (!s) return lienMort(res);
    res.json({ dossier: dossier(s.v, s.options, urlsPublic(req.params.token), s.p.expire_le) });
  });
  router.get("/api/dossier/:token/factures/:eid", wrap(async (req, res) => {
    publicHeaders(res);
    const s = partageValide(req.params.token);
    if (!s) return lienMort(res);
    const row = s.options.factures.includes(num(req.params.eid)) ? q.entretien.get(num(req.params.eid), s.v.id) : null;
    if (!row?.facture_key) return notFound(res, "Facture non partagée.");
    await carnet.envoyerVersionPartage(res, row);
  }));
  router.get("/api/dossier/:token/photo", wrap(async (req, res) => {
    publicHeaders(res);
    const s = partageValide(req.params.token);
    if (!s || !s.options.photo) return lienMort(res);
    await envoyerPhoto(res, s.v);
  }));

  /* ---------- transfert : côté vendeur ---------- */
  router.post("/api/garage/:id/transfert", (req, res) => {
    const v = voitureDe(req, res); if (!v) return;
    const { options, error } = cleanOptions(req.body, q.entretiens.all(v.id));
    if (error) return res.status(400).json({ code: "invalid_options", error });
    const code = nouveauCode();
    q.annuler.run(v.id); // un seul code valable à la fois
    const expireLe = iso(now() + DUREE_TRANSFERT * 86_400_000);
    q.addTransfert.run(v.id, sha256(normaliserCode(code)), JSON.stringify(options), iso(now()), expireLe);
    res.status(201).json({ code, expireLe, options });
  });
  router.delete("/api/garage/:id/transfert", (req, res) => {
    const v = voitureDe(req, res); if (!v) return;
    if (!q.annuler.run(v.id).changes) return notFound(res, "Aucun transfert en attente.");
    res.json({ ok: true });
  });

  /* ---------- transfert : côté acheteur ---------- */
  const essaisIp = new Map(); // ip -> [instants]
  function trouver(req, res) {
    q.purgeEssais.run(iso(now() - HEURE));
    const ip = req.ip || "?";
    const recents = (essaisIp.get(ip) || []).filter(t => t > now() - HEURE);
    essaisIp.set(ip, recents);
    if (q.essais.get(req.user.id, iso(now() - HEURE)).n >= ESSAIS_PAR_HEURE || recents.length >= ESSAIS_PAR_IP) {
      res.status(429).json({ code: "trop_d_essais", error: "Trop de codes incorrects. Pour votre sécurité, réessayez dans une heure, ou demandez au vendeur de vérifier le code." });
      return null;
    }
    const code = normaliserCode(req.body?.code);
    const t = code ? q.parCode.get(sha256(code)) : null;
    if (!t || t.expire_le <= iso(now())) {
      q.addEssai.run(req.user.id, iso(now())); recents.push(now());
      res.status(404).json({ code: "code_invalide", error: "Code inconnu ou expiré. Vérifiez-le auprès du vendeur (8 caractères, par exemple ABCD-EF23)." });
      return null;
    }
    const v = q.vehicule.get(t.vehicle_id);
    if (v.user_id === req.user.id) { res.status(409).json({ code: "deja_a_vous", error: "Cette voiture est déjà dans votre garage." }); return null; }
    return { t, v, options: JSON.parse(t.options) };
  }
  const resumePourAcheteur = ({ t, v, options }) => ({
    voiture: [[v.marque, v.modele, v.motorisation].filter(Boolean).join(" "), v.annee].filter(Boolean).join(", "),
    releves: q.nbReleves.get(v.id).n,
    entretiens: q.entretiens.all(v.id).length,
    factures: options.factures.length,
    descriptions: options.descriptions.length,
    garages: options.garages,
    photo: options.photo && !!v.photo_key,
    expireLe: t.expire_le,
  });
  router.post("/api/transfert/apercu", (req, res) => {
    const s = trouver(req, res); if (!s) return;
    res.json({ transfert: resumePourAcheteur(s) });
  });
  router.post("/api/transfert/accepter", wrap(async (req, res) => {
    const s = trouver(req, res); if (!s) return;
    if (q.nbVoitures.get(req.user.id).n >= MAX_VEHICLES) return res.status(409).json({ code: "garage_full", error: `Votre garage est plein (${MAX_VEHICLES} voitures au plus).` });
    const vid = await accepter(s, req.user.id);
    res.json({ ok: true, vehiculeId: vid });
  }));

  // Le transfert lui-même. Les fichiers sont préparés d'abord (copies sans métadonnées, ou copies masquées),
  // puis tout change en une transaction ; les anciens fichiers du vendeur sont effacés à la fin.
  async function accepter({ t, v, options: o }, acheteur) {
    const ents = q.entretiens.all(v.id);
    const nouveaux = [], aEffacer = [];
    const factures = new Map();
    try {
      for (const e of ents) {
        if (!e.facture_key) continue;
        aEffacer.push(e.facture_key, e.facture_masquee_key);
        if (!o.factures.includes(e.id)) continue;
        const vp = await carnet.versionPartage(e);
        if (!vp) continue;
        const key = await storage.save(vp.buffer, { ext: vp.ext });
        nouveaux.push(key);
        factures.set(e.id, { key, ext: vp.ext, taille: vp.buffer.length });
      }
      let photo = null;
      if (v.photo_key) {
        aEffacer.push(v.photo_key);
        const buf = o.photo ? await storage.read(v.photo_key) : null;
        if (buf) { const key = await storage.save(sansMetadonnees(buf, v.photo_type).buffer, { ext: v.photo_type }); nouveaux.push(key); photo = { key, type: v.photo_type }; }
      }
      const d = jour();
      db.exec("BEGIN");
      try {
        const majEnt = db.prepare(`UPDATE entretiens SET description = ?, garage = ?, facture_key = ?, facture_type = ?, facture_taille = ?, facture_nom = ?,
                                   facture_masquee_key = NULL, facture_masquee_type = NULL, verrouille = 1 WHERE id = ?`);
        for (const e of ents) {
          const f = factures.get(e.id);
          majEnt.run(o.descriptions.includes(e.id) ? e.description : "", o.garages ? e.garage : "",
            f?.key ?? null, f?.ext ?? null, f?.taille ?? null, f ? `facture-${e.date}.${f.ext}` : null, e.id); // nom d'origine retiré : il peut contenir un nom
        }
        db.prepare("UPDATE releves SET verrouille = 1 WHERE vehicle_id = ?").run(v.id);
        db.prepare("UPDATE notes SET verrouille = 1 WHERE vehicle_id = ?").run(v.id);
        for (const table of ["rappels", "estimations", "partages"]) db.prepare(`DELETE FROM ${table} WHERE vehicle_id = ?`).run(v.id);
        db.prepare(`UPDATE vehicles SET user_id = ?, surnom = '', assurance_echeance = NULL, pneus_hiver = 0, achat_date = ?, achat_km = ?,
                    badge_obtenu = 0, badge_change_le = NULL, photo_key = ?, photo_type = ?, photo_maj = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?`).run(acheteur, d, q.maxKm.get(v.id).km ?? null, photo?.key ?? null, photo?.type ?? null, photo ? iso(now()) : null, v.id);
        db.prepare(`UPDATE transferts SET statut = 'accepte', accepte_le = ?, code_hash = NULL, options = '{}', ancien_achat_date = ?, ancien_achat_km = ?
                    WHERE id = ?`).run(d, v.achat_date, v.achat_km, t.id);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    } catch (e) {
      await carnet.removeFiles(nouveaux);
      throw e;
    }
    await carnet.removeFiles(aEffacer.filter(Boolean));
    return v.id;
  }

  /* ---------- notes sur l'historique reçu ---------- */
  router.post("/api/garage/:id/notes", (req, res) => {
    const v = voitureDe(req, res); if (!v) return;
    const objet = req.body?.objet, id = Number(req.body?.objetId);
    const texte = typeof req.body?.texte === "string" ? req.body.texte.trim().replace(/\s+/g, " ") : "";
    if (!q.cible[objet] || !Number.isInteger(id)) return res.status(400).json({ code: "invalid_note", error: "Entrée inconnue." });
    const cible = q.cible[objet].get(id, v.id);
    if (!cible) return notFound(res, "Entrée introuvable.");
    if (!cible.verrouille) return res.status(400).json({ code: "invalid_note", error: "Les notes servent à commenter l'historique reçu d'un ancien propriétaire. Vos propres entrées se modifient directement." });
    if (!texte) return res.status(400).json({ code: "invalid_note", error: "Écrivez votre note." });
    if (texte.length > NOTE_MAX) return res.status(400).json({ code: "invalid_note", error: `${NOTE_MAX} caractères au plus.` });
    if (q.nbNotes.get(v.id).n >= NOTES_MAX) return res.status(409).json({ code: "too_many_notes", error: `${NOTES_MAX} notes au plus par voiture.` });
    q.addNote.run(v.id, objet, id, texte);
    res.status(201).json({ ok: true });
  });
  router.delete("/api/garage/:id/notes/:nid", (req, res) => {
    const v = voitureDe(req, res); if (!v) return;
    const n = q.note.get(num(req.params.nid), v.id);
    if (!n) return notFound(res, "Note introuvable.");
    if (n.verrouille) return res.status(403).json({ code: "verrouille", error: "Cette note vient d'un ancien propriétaire." });
    q.delNote.run(n.id, v.id);
    res.json({ ok: true });
  });

  // Pour l'export RGPD de l'acheteur : dates des changements de propriétaire de chaque voiture.
  router.datesTransfert = vid => q.datesTransfert.all(vid).map(r => r.accepte_le);
  return router;
}
