// Avis de vrais propriétaires : publiés depuis le garage Rétroviz, jamais avec l'identité de l'auteur.
// Règles pures (eligibilite, cleanAvis, problemesTexte, synthese) testées sans base de données.
import express from "express";
import { needUser, sameSiteJson } from "./auth.js";
import { today } from "./kilometrage.js";
import { normalize } from "./knowledge.js";

export const NOTES = {
  fiabilite: "Fiabilité", cout_entretien: "Coût d'entretien", confort: "Confort", consommation: "Consommation", rapport_qualite_prix: "Rapport qualité-prix",
};
export const CONDITIONS = { moisMin: 3, relevesMin: 2 };
export const SEUIL_SYNTHESE = 5;       // en dessous : avis un par un ; à partir de 5 : moyennes et pannes les plus citées
export const DUREE_PUBLICATION_ANS = 5; // après la dernière modification
export const MOTIFS_SIGNALEMENT = {
  coordonnees: "Coordonnées ou informations personnelles", injure: "Injure ou propos haineux", hors_sujet: "Hors sujet (ne parle pas de la voiture)",
  faux: "Avis qui semble faux", autre: "Autre",
};
// Motifs de masquage par la modération. « Avis négatif » n'en fait jamais partie.
export const MOTIFS_MASQUAGE = {
  coordonnees: "Contient des coordonnées ou des informations personnelles", injure: "Contient des injures ou des propos haineux",
  hors_sujet: "Ne parle pas de la voiture", illicite: "Contenu illicite (diffamation, dénigrement d'une personne nommée…)", faux: "Avis manifestement faux",
};
const LIMITES = { points_forts: 500, points_faibles: 500, commentaire: 1000, piece: 60 };
const MAX_PANNES = 10;
const JOUR = 86_400_000;
const jours = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / JOUR);
const MOIS = 365.25 / 12;

/* ---------- filtre automatique : coordonnées et injures ---------- */
const COORDONNEES = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/, "une adresse e-mail"],
  [/(?:\+33\s*|\b0)[1-9](?:[\s.-]*\d{2}){4}\b/, "un numéro de téléphone"],
  [/https?:\/\/|\bwww\.[\w-]+\./i, "un lien vers un site"],
  [/\b[A-Z]{2}-?\d{3}-?[A-Z]{2}\b/, "une plaque d'immatriculation"], // AB-123-CD ou AB123CD (pas « le 130 ch »)
];
// Injures visant des personnes (normalisées, sans accents). Un avis peut être très négatif sur la voiture : ce n'est pas filtré.
const INJURES = /\b(connards?|connasses?|encules?|enculees?|salopes?|salauds?|batards?|fdp|ntm|putes?|abrutis?|cretins?|ta gueule|nique[rsz]?|niquez|pd|tg|debiles? mentale?s?|sous[- ]merdes?)\b/;
export function problemesTexte(texte) {
  const t = String(texte || "");
  const out = COORDONNEES.filter(([re]) => re.test(t)).map(([, quoi]) => quoi);
  if (INJURES.test(normalize(t))) out.push("une injure");
  return out;
}

/* ---------- validation ---------- */
const texte = (v, max) => (typeof v === "string" ? v.trim().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n") : "").slice(0, max + 1);
export function cleanAvis(body) {
  const b = body && typeof body === "object" ? body : {};
  const notes = {};
  for (const [k, nom] of Object.entries(NOTES)) {
    const n = Number(b.notes?.[k]);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { error: `Donnez une note de 1 à 5 pour « ${nom} ».` };
    notes[k] = n;
  }
  if (typeof b.recommande !== "boolean") return { error: "Dites si vous recommanderiez cette voiture." };
  const data = { notes, recommande: b.recommande };
  for (const k of ["points_forts", "points_faibles", "commentaire"]) {
    data[k] = texte(b[k], LIMITES[k]);
    if (data[k].length > LIMITES[k]) return { error: `${LIMITES[k]} caractères au plus par champ.` };
  }
  const pannes = Array.isArray(b.pannes) ? b.pannes : [];
  if (pannes.length > MAX_PANNES) return { error: `${MAX_PANNES} pannes au plus.` };
  data.pannes = [];
  for (const p of pannes) {
    const piece = texte(p?.piece, LIMITES.piece);
    if (!piece) continue;
    if (piece.length > LIMITES.piece) return { error: `Pièce : ${LIMITES.piece} caractères au plus.` };
    const km = p.km === "" || p.km == null ? null : Number(String(p.km).replace(/[\s  ]/g, ""));
    const cout = p.cout === "" || p.cout == null ? null : Number(String(p.cout).replace(/[\s  €]/g, "").replace(",", "."));
    if (km !== null && !(Number.isInteger(km) && km >= 0 && km <= 2_000_000)) return { error: `Kilométrage de la panne « ${piece} » invalide.` };
    if (cout !== null && !(Number.isFinite(cout) && cout >= 0 && cout <= 100_000)) return { error: `Coût de la panne « ${piece} » invalide.` };
    data.pannes.push({ piece, km, cout: cout === null ? null : Math.round(cout) });
  }
  if (!data.points_forts && !data.points_faibles && !data.commentaire && !data.pannes.length) {
    return { error: "Ajoutez au moins un point fort, un point faible, une panne ou un commentaire." };
  }
  const tous = [data.points_forts, data.points_faibles, data.commentaire, ...data.pannes.map(p => p.piece)].join("\n");
  const pb = problemesTexte(tous);
  if (pb.length) return { error: `Votre avis contient ${pb.join(", ")}. Retirez-le pour pouvoir publier : les avis restent anonymes et ne visent pas de personnes.`, code: "filtre" };
  return { data };
}

/**
 * Peut-on publier un avis sur cette voiture ? Au moins 3 mois dans le garage (depuis l'ajout, ou depuis le transfert
 * pour une voiture reçue) et au moins 2 relevés faits par ce propriétaire (pas ceux reçus de l'ancien).
 */
export function eligibilite({ depuis, relevesPropres, aujourdhui = today() }) {
  const age = jours(depuis, aujourdhui);
  const raisons = [];
  // 3 mois calendaires : ajoutée le 1er septembre, avis possible dès le 1er décembre.
  const d = new Date(`${depuis}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + CONDITIONS.moisMin);
  const possible = d.toISOString().slice(0, 10);
  if (aujourdhui < possible) {
    raisons.push({ id: "duree", texte: `La voiture doit être dans votre garage depuis au moins ${CONDITIONS.moisMin} mois : possible à partir du ${d.toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" })}.` });
  }
  if (relevesPropres < CONDITIONS.relevesMin) {
    const n = CONDITIONS.relevesMin - relevesPropres;
    raisons.push({ id: "releves", texte: `Il faut au moins ${CONDITIONS.relevesMin} relevés de kilométrage : ajoutez-en encore ${n}.` });
  }
  return { ok: !raisons.length, raisons, mois: Math.floor(age / MOIS) };
}

// Médiane, arrondie (moyenne des deux valeurs du milieu pour un nombre pair).
const mediane = l => {
  const s = [...l].sort((a, b) => a - b), m = s.length >> 1;
  return !s.length ? null : s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
// Clé d'une pièce pour regrouper les pannes citées : « Embrayage », « l'embrayage » -> « embrayage ».
export const clePiece = p => normalize(p).replace(/^(l|la|le|les|un|une|des|du|de)\s+/, "").replace(/s\b/g, "").trim();

/** Synthèse d'une liste d'avis publiés : moyennes, part qui recommande, pannes les plus citées (au moins 2 avis). */
export function synthese(avis) {
  const n = avis.length;
  const moyennes = {};
  for (const k of Object.keys(NOTES)) moyennes[k] = n ? Math.round((avis.reduce((s, a) => s + a.notes[k], 0) / n) * 10) / 10 : null;
  const pannes = new Map();
  for (const a of avis) {
    const vues = new Set();
    for (const p of a.pannes) {
      const cle = clePiece(p.piece);
      if (!cle || vues.has(cle)) continue;
      vues.add(cle);
      if (!pannes.has(cle)) pannes.set(cle, { piece: p.piece, nombre: 0, km: [], cout: [] });
      const g = pannes.get(cle);
      g.nombre++;
      if (p.km != null) g.km.push(p.km);
      if (p.cout != null) g.cout.push(p.cout);
    }
  }
  const citees = [...pannes.values()].filter(g => g.nombre >= 2).sort((a, b) => b.nombre - a.nombre || a.piece.localeCompare(b.piece))
    .map(g => ({ piece: g.piece, nombre: g.nombre, kmMedian: mediane(g.km), kmMin: g.km.length ? Math.min(...g.km) : null, kmMax: g.km.length ? Math.max(...g.km) : null, coutMedian: mediane(g.cout) }));
  return { nombre: n, moyennes, recommandent: n ? Math.round((avis.filter(a => a.recommande).length / n) * 100) : null, pannes: citees };
}

export function createAvis(db, { kb, isAdmin = () => false, now = today } = {}) {
  const q = {
    owned: db.prepare("SELECT * FROM vehicles WHERE id = ? AND user_id = ?"),
    dernierTransfert: db.prepare("SELECT MAX(accepte_le) AS d FROM transferts WHERE vehicle_id = ? AND statut = 'accepte'"),
    relevesPropres: db.prepare("SELECT COUNT(*) AS n FROM releves WHERE vehicle_id = ? AND verrouille = 0"),
    kms: db.prepare(`SELECT MIN(km) AS mini, MAX(km) AS maxi FROM (SELECT km FROM releves WHERE vehicle_id = ?1 AND verrouille = 0
                     UNION ALL SELECT km FROM entretiens WHERE vehicle_id = ?1 AND verrouille = 0 AND km IS NOT NULL)`),
    kmMax: db.prepare(`SELECT MAX(km) AS km FROM (SELECT km FROM releves WHERE vehicle_id = ?1 UNION ALL SELECT km FROM entretiens WHERE vehicle_id = ?1 AND km IS NOT NULL)`),
    mien: db.prepare("SELECT * FROM avis WHERE user_id = ? AND vehicle_id = ?"),
    parId: db.prepare("SELECT * FROM avis WHERE id = ?"),
    insert: db.prepare(`INSERT INTO avis (user_id, vehicle_id, cle_modele, cle_motorisation, fiche_id, voiture, notes, pannes, points_forts, points_faibles,
                        recommande, commentaire, possession_mois, km_parcourus, km_actuel, cree_le, modifie_le)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE avis SET cle_modele = ?, cle_motorisation = ?, fiche_id = ?, voiture = ?, notes = ?, pannes = ?, points_forts = ?, points_faibles = ?,
                        recommande = ?, commentaire = ?, possession_mois = ?, km_parcourus = ?, km_actuel = ?, modifie_le = ? WHERE id = ?`),
    supprimer: db.prepare("DELETE FROM avis WHERE id = ? AND user_id = ?"),
    miens: db.prepare("SELECT * FROM avis WHERE user_id = ? ORDER BY modifie_le DESC"),
    publies: db.prepare("SELECT * FROM avis WHERE statut = 'publie' AND modifie_le >= ? AND (cle_motorisation = ? OR cle_modele = ?) ORDER BY modifie_le DESC, id DESC"),
    publiesModele: db.prepare("SELECT * FROM avis WHERE statut = 'publie' AND modifie_le >= ? AND cle_modele = ?"),
    signaler: db.prepare("INSERT INTO avis_signalements (avis_id, motif, detail) VALUES (?, ?, ?)"),
    aModerer: db.prepare(`SELECT a.*, COUNT(s.id) AS nb_signalements FROM avis a JOIN avis_signalements s ON s.avis_id = a.id AND s.traite = 0
                          GROUP BY a.id ORDER BY MIN(s.cree_le)`),
    signalementsDe: db.prepare("SELECT motif, detail, cree_le FROM avis_signalements WHERE avis_id = ? AND traite = 0 ORDER BY cree_le"),
    traiter: db.prepare("UPDATE avis_signalements SET traite = 1 WHERE avis_id = ?"),
    masquer: db.prepare("UPDATE avis SET statut = 'masque', motif_masque = ?, masque_le = ? WHERE id = ?"),
    republier: db.prepare("UPDATE avis SET statut = 'publie', motif_masque = NULL, masque_le = NULL WHERE id = ?"),
  };
  const ficheById = id => kb.vehicules.find(f => f.id === id);
  // Clés de regroupement : la fiche Rétroviz reliée si elle existe, sinon marque + modèle (+ motorisation) normalisés.
  function cles({ marque, modele, motorisation = "", ficheId = null }) {
    const f = ficheId ? ficheById(ficheId) : null;
    const m = f ? `${f.marque} ${f.modele}` : `${marque} ${modele}`;
    return { cleModele: normalize(m), cleMotorisation: f ? `fiche:${f.id}` : normalize(`${m} ${motorisation}`), fiche: f };
  }
  const limitePublication = () => new Date(Date.parse(`${now()}T00:00:00Z`) - DUREE_PUBLICATION_ANS * 365.25 * JOUR).toISOString();

  function etat(v) {
    const depuis = [String(v.created_at).slice(0, 10), q.dernierTransfert.get(v.id).d].filter(Boolean).sort().at(-1);
    return { depuis, ...eligibilite({ depuis, relevesPropres: q.relevesPropres.get(v.id).n, aujourdhui: now() }) };
  }
  // Ce qui est affiché avec l'avis : durée de possession, km parcourus et au compteur. Jamais l'identité.
  function contexte(v, e) {
    const debut = v.achat_date && v.achat_date >= e.depuis ? v.achat_date : e.depuis;
    const k = q.kms.get(v.id), kmActuel = q.kmMax.get(v.id).km ?? null;
    const kmDebut = v.achat_km ?? k.mini;
    return { possession_mois: Math.max(0, Math.floor(jours(debut, now()) / MOIS)), km_parcourus: kmActuel != null && kmDebut != null ? Math.max(0, kmActuel - kmDebut) : null, km_actuel: kmActuel };
  }
  // Désignation affichée : celle saisie par le propriétaire (marque, modèle, motorisation, année).
  const voitureTxt = v => [[v.marque, v.modele, v.motorisation].filter(Boolean).join(" "), v.annee].filter(Boolean).join(", ");

  const publicAvis = a => ({
    id: a.id, voiture: a.voiture, notes: JSON.parse(a.notes), pannes: JSON.parse(a.pannes), pointsForts: a.points_forts, pointsFaibles: a.points_faibles,
    recommande: !!a.recommande, commentaire: a.commentaire, possessionMois: a.possession_mois, kmParcourus: a.km_parcourus, kmActuel: a.km_actuel,
    publieLe: a.cree_le.slice(0, 10), modifieLe: a.modifie_le.slice(0, 10) !== a.cree_le.slice(0, 10) ? a.modifie_le.slice(0, 10) : null,
    verifie: true, // publié depuis un garage Rétroviz qui remplissait les conditions (voir CONDITIONS)
  });
  const pourAuteur = a => ({ ...publicAvis(a), statut: a.statut, motifMasque: a.motif_masque ? MOTIFS_MASQUAGE[a.motif_masque] || a.motif_masque : null, masqueLe: a.masque_le });
  function bloc(list) {
    const avis = list.map(publicAvis);
    return { nombre: avis.length, synthese: avis.length >= SEUIL_SYNTHESE ? synthese(avis) : null, avis };
  }

  const router = express.Router();
  router.use(["/api/garage/:id/avis", "/api/avis/miens"], sameSiteJson, needUser);
  router.use("/api/avis", sameSiteJson);
  const notFound = (res, error = "Voiture introuvable dans votre garage.") => res.status(404).json({ code: "not_found", error });
  const voitureDe = (req, res) => { const v = /^\d+$/.test(req.params.id) ? q.owned.get(Number(req.params.id), req.user.id) : null; if (!v) notFound(res); return v; };

  /* ---------- l'auteur, depuis sa voiture ---------- */
  router.get("/api/garage/:id/avis", (req, res) => {
    const v = voitureDe(req, res); if (!v) return;
    const a = q.mien.get(req.user.id, v.id);
    res.setHeader("Cache-Control", "no-store");
    res.json({ eligibilite: etat(v), avis: a ? pourAuteur(a) : null, conditions: CONDITIONS });
  });
  router.put("/api/garage/:id/avis", (req, res) => {
    const v = voitureDe(req, res); if (!v) return;
    const e = etat(v);
    if (!e.ok) return res.status(403).json({ code: "pas_encore", error: e.raisons.map(r => r.texte).join(" ") });
    const { data, error, code } = cleanAvis(req.body);
    if (error) return res.status(400).json({ code: code || "invalid_avis", error });
    const c = cles({ marque: v.marque, modele: v.modele, motorisation: v.motorisation, ficheId: v.fiche_id });
    const ctx = contexte(v, e), ts = new Date().toISOString();
    const vals = [c.cleModele, c.cleMotorisation, c.fiche?.id ?? null, voitureTxt(v), JSON.stringify(data.notes), JSON.stringify(data.pannes),
      data.points_forts, data.points_faibles, data.recommande ? 1 : 0, data.commentaire, ctx.possession_mois, ctx.km_parcourus, ctx.km_actuel];
    const deja = q.mien.get(req.user.id, v.id);
    if (deja) {
      q.update.run(...vals, ts, deja.id);
      // Avis masqué puis corrigé par son auteur : il revient dans la file de modération.
      if (deja.statut === "masque") q.signaler.run(deja.id, "autre", "Avis modifié par son auteur après masquage : à réexaminer.");
    } else q.insert.run(req.user.id, v.id, ...vals, ts, ts);
    res.status(deja ? 200 : 201).json({ avis: pourAuteur(q.mien.get(req.user.id, v.id)) });
  });
  router.delete("/api/garage/:id/avis", (req, res) => {
    const v = voitureDe(req, res); if (!v) return;
    const a = q.mien.get(req.user.id, v.id);
    if (!a) return notFound(res, "Pas d'avis sur cette voiture.");
    q.supprimer.run(a.id, req.user.id);
    res.json({ ok: true });
  });
  // Tous mes avis, y compris sur une voiture vendue depuis (l'avis reste à son auteur).
  router.get("/api/avis/miens", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ avis: q.miens.all(req.user.id).map(pourAuteur) });
  });
  router.delete("/api/avis/miens/:aid", (req, res) => {
    if (!q.supprimer.run(Number(req.params.aid) || -1, req.user.id).changes) return notFound(res, "Avis introuvable.");
    res.json({ ok: true });
  });

  /* ---------- lecture publique ---------- */
  // ?marque=&modele=&motorisation=&fiche= : avis de la motorisation, et de tout le modèle.
  router.get("/api/avis", (req, res) => {
    const { marque = "", modele = "", motorisation = "", fiche = "" } = req.query;
    if ((!marque || !modele) && !fiche) return res.status(400).json({ code: "invalid", error: "Indiquez la marque et le modèle." });
    const c = cles({ marque: String(marque), modele: String(modele), motorisation: String(motorisation), ficheId: String(fiche) || null });
    const tous = q.publies.all(limitePublication(), c.cleMotorisation, c.cleModele);
    const moto = tous.filter(a => a.cle_motorisation === c.cleMotorisation);
    res.setHeader("Cache-Control", "no-store");
    res.json({ motorisation: (c.fiche || motorisation) ? bloc(moto) : null, modele: bloc(tous), seuil: SEUIL_SYNTHESE });
  });

  /* ---------- signalement (sans compte) ---------- */
  const signalementsIp = new Map();
  router.post("/api/avis/:aid/signaler", (req, res) => {
    const a = q.parId.get(Number(req.params.aid) || -1);
    if (!a || a.statut !== "publie") return notFound(res, "Avis introuvable.");
    const motif = req.body?.motif;
    if (!MOTIFS_SIGNALEMENT[motif]) return res.status(400).json({ code: "invalid", error: "Choisissez un motif." });
    const ip = req.ip || "?", t = Date.now(), recents = (signalementsIp.get(ip) || []).filter(x => x > t - 3_600_000);
    if (recents.length >= 20) return res.status(429).json({ code: "trop", error: "Trop de signalements envoyés. Réessayez plus tard." });
    signalementsIp.set(ip, [...recents, t]);
    const detail = typeof req.body?.detail === "string" ? req.body.detail.trim().slice(0, 300) : "";
    q.signaler.run(a.id, motif, detail || null);
    res.status(201).json({ ok: true });
  });

  /* ---------- modération (administrateurs) ---------- */
  const admin = (req, res, next) => (isAdmin(req.user) ? next() : res.status(404).json({ code: "not_found", error: "Page introuvable." }));
  router.get("/api/admin/avis", admin, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ avis: q.aModerer.all().map(a => ({ ...publicAvis(a), statut: a.statut, signalements: q.signalementsDe.all(a.id).map(s => ({ motif: MOTIFS_SIGNALEMENT[s.motif], detail: s.detail, le: s.cree_le.slice(0, 10) })) })),
      motifs: MOTIFS_MASQUAGE });
  });
  router.post("/api/admin/avis/:aid", sameSiteJson, admin, (req, res) => {
    const a = q.parId.get(Number(req.params.aid) || -1);
    if (!a) return notFound(res, "Avis introuvable.");
    const { action, motif } = req.body || {};
    if (action === "garder") { q.traiter.run(a.id); if (a.statut === "masque") q.republier.run(a.id); }
    else if (action === "masquer") {
      if (!MOTIFS_MASQUAGE[motif]) return res.status(400).json({ code: "invalid", error: "Choisissez un motif de masquage. Un avis n'est jamais masqué parce qu'il est négatif." });
      q.masquer.run(motif, now(), a.id); q.traiter.run(a.id);
    } else return res.status(400).json({ code: "invalid", error: "Action inconnue." });
    res.json({ ok: true });
  });

  /* ---------- pour les autres modules ---------- */
  router.aModerer = () => q.aModerer.all().length;
  router.exportFor = uid => q.miens.all(uid).map(pourAuteur);
  /**
   * Faits « propriétaires » pour l'Observateur : pannes citées par au moins 2 avis publiés du modèle.
   * Tous ces faits partagent la même adresse : ensemble, ils comptent pour UNE source, de type « proprietaires »
   * (jamais suffisante seule pour confirmer).
   */
  router.faitsPourObservateur = ({ marque, modele }) => {
    const c = cles({ marque, modele });
    const avis = q.publiesModele.all(limitePublication(), c.cleModele).map(publicAvis);
    const s = synthese(avis);
    return s.pannes.map(p => ({
      marque, modele, generation: "", motorisation: "", type: "panne",
      contenu: `${p.piece} : panne citée par ${p.nombre} propriétaires sur ${avis.length} avis Rétroviz${p.kmMedian != null ? `, vers ${p.kmMedian.toLocaleString("fr-FR")} km` : ""}${p.coutMedian != null ? `, pour environ ${p.coutMedian} €` : ""}.`,
      km_min: p.kmMin, km_max: p.kmMax, cout_min: p.coutMedian, cout_max: p.coutMedian,
      url: `https://retroviz.local/avis/${encodeURIComponent(c.cleModele)}`, typeSource: "proprietaires", titrePage: `Avis de propriétaires Rétroviz (${avis.length})`, datePage: now(),
    }));
  };
  return router;
}
