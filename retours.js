// Apprentissage depuis l'usage, toujours anonyme :
// - retours sous les réponses (« Cette réponse vous a aidé ? Oui / Non / Signaler une erreur ») ;
// - questions pour lesquelles aucune fiche n'existait (voiture indiquée et codes cités seulement) ;
// - statistiques des carnets, pour les seuls comptes qui l'ont accepté, publiées à partir de 10 véhicules.
import express from "express";
import { sameSiteJson } from "./auth.js";
import { normalize } from "./knowledge.js";

export const SEUIL_STATS = 10; // véhicules différents au minimum pour publier une statistique
const MODES = ["particulier", "pro", "achat"];
const AVIS = ["oui", "non", "erreur"];

// Texte libre nettoyé de ce qui pourrait identifier quelqu'un : e-mails, téléphones, plaques, longues suites de chiffres.
export function anonymiser(texte, max = 1000) {
  return String(texte ?? "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[adresse retirée]")
    .replace(/(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/g, "[numéro retiré]")
    // Plaques au format AB-123-CD ou AB123CD (pas « GT 130 ch », qui est une désignation de voiture).
    .replace(/\b[A-Z]{2}-?\d{3}-?[A-Z]{2}\b/gi, "[plaque retirée]")
    .replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, "[VIN retiré]")
    .replace(/\d{9,}/g, "[nombre retiré]")
    .trim()
    .slice(0, max);
}

// Voiture indiquée, réduite à ce qui sert à chercher une fiche (marque, modèle, moteur, année).
export const vehiculeAnonyme = v => anonymiser(v, 100).replace(/\[[^\]]+\]/g, "").replace(/\s+/g, " ").trim();

export function createRetours(db, { now = () => Date.now(), limiteParHeure = 30 } = {}) {
  const q = {
    insertRetour: db.prepare("INSERT INTO retours (mode, avis, commentaire, fiches, extrait) VALUES (?, ?, ?, ?, ?)"),
    insertSansFiche: db.prepare("INSERT INTO questions_sans_fiche (mode, vehicule, codes) VALUES (?, ?, ?)"),
    sansFiche: db.prepare("SELECT mode, vehicule, codes, cree_le FROM questions_sans_fiche ORDER BY id DESC LIMIT 5000"),
    statsRetours: db.prepare("SELECT avis, COUNT(*) AS n FROM retours WHERE cree_le >= ? GROUP BY avis"),
    consentement: db.prepare("UPDATE users SET stats_consent = ? WHERE id = ?"),
    lireConsentement: db.prepare("SELECT stats_consent FROM users WHERE id = ?"),
    // Entretiens des comptes consentants, avec la fiche de la voiture ou, à défaut, marque et modèle.
    entretiensConsentis: db.prepare(`SELECT v.id AS vid, v.fiche_id, v.marque, v.modele, e.type, e.km
      FROM entretiens e JOIN vehicles v ON v.id = e.vehicle_id JOIN users u ON u.id = v.user_id
      WHERE u.stats_consent = 1 AND e.km IS NOT NULL`),
  };

  // Limite simple par adresse IP (en mémoire) : évite qu'un robot remplisse la table.
  const compteurs = new Map();
  const tropDeRetours = ip => {
    const t = now(), c = compteurs.get(ip) || { n: 0, depuis: t };
    if (t - c.depuis > 3_600_000) { c.n = 0; c.depuis = t; }
    c.n++; compteurs.set(ip, c);
    return c.n > limiteParHeure;
  };

  // Appelé par l'assistant quand aucune fiche ne correspond (ou aucune fiche pour la voiture indiquée).
  function noterSansFiche({ mode, vehicule = "", codes = [] }) {
    const v = vehiculeAnonyme(vehicule);
    if (!v && !codes.length) return; // rien d'exploitable
    q.insertSansFiche.run(MODES.includes(mode) ? mode : "particulier", v, JSON.stringify(codes.slice(0, 10)));
  }

  // Liste prioritaire pour l'Observateur : voitures les plus demandées sans fiche.
  function prioritaires(limit = 30) {
    const groupes = new Map();
    for (const r of q.sansFiche.all()) {
      // Même voiture avec ou sans année ni kilométrage : un seul groupe.
      const cle = normalize(r.vehicule).replace(/\b(19|20)\d{2}\b|\b\d+ ?(km|000 km)\b/g, " ").replace(/\s+/g, " ").trim() || "(voiture non précisée)";
      const g = groupes.get(cle) || { vehicule: r.vehicule || "(voiture non précisée)", nombre: 0, codes: new Set(), dernier: r.cree_le };
      g.nombre++;
      for (const c of JSON.parse(r.codes)) g.codes.add(c);
      groupes.set(cle, g);
    }
    return [...groupes.values()].sort((a, b) => b.nombre - a.nombre).slice(0, limit).map(g => ({ ...g, codes: [...g.codes] }));
  }

  // Statistiques anonymes : km où un type d'entretien a été fait, par modèle, à partir de SEUIL_STATS véhicules.
  function statistiques() {
    const groupes = new Map();
    for (const r of q.entretiensConsentis.all()) {
      const sujet = r.fiche_id || normalize(`${r.marque} ${r.modele}`);
      const cle = `${sujet}|${r.type}`;
      const g = groupes.get(cle) || { sujet, marqueModele: `${r.marque} ${r.modele}`, type: r.type, vehicules: new Set(), kms: [] };
      g.vehicules.add(r.vid); g.kms.push(r.km);
      groupes.set(cle, g);
    }
    const quantile = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
    return [...groupes.values()].filter(g => g.vehicules.size >= SEUIL_STATS).map(g => {
      const kms = g.kms.sort((a, b) => a - b);
      // Fourchette du milieu (25 % à 75 %), arrondie au millier : jamais un relevé individuel.
      return { sujet: g.sujet, marqueModele: g.marqueModele, type: g.type, vehicules: g.vehicules.size,
        kmBas: Math.round(quantile(kms, 0.25) / 1000) * 1000, kmHaut: Math.round(quantile(kms, 0.75) / 1000) * 1000 };
    });
  }

  const router = express.Router();
  router.use(["/api/retours", "/api/account/consentement"], sameSiteJson);

  router.post("/api/retours", (req, res) => {
    if (tropDeRetours(req.ip)) return res.status(429).json({ code: "rate_limited", error: "Trop de retours envoyés. Merci, réessayez plus tard." });
    const b = req.body || {};
    if (!MODES.includes(b.mode) || !AVIS.includes(b.avis)) return res.status(400).json({ code: "invalid", error: "Retour invalide." });
    const fiches = (Array.isArray(b.fiches) ? b.fiches : []).slice(0, 6)
      .map(f => ({ type: String(f?.type || "").slice(0, 20), id: String(f?.id || f?.code || "").slice(0, 80), label: String(f?.label || "").slice(0, 120) }));
    const commentaire = b.avis === "erreur" ? anonymiser(b.commentaire) : null;
    if (b.avis === "erreur" && !commentaire) return res.status(400).json({ code: "invalid", error: "Dites en quelques mots ce qui est faux." });
    // L'extrait de la réponse de l'IA aide à comprendre le signalement ; la question, elle, n'est jamais gardée.
    const extrait = anonymiser(b.extrait, 600) || null;
    q.insertRetour.run(b.mode, b.avis, commentaire, JSON.stringify(fiches), extrait);
    if (b.avis === "erreur" && router.onSignalement) {
      const f = fiches.find(x => x.type === "vehicule" || x.type === "voyant" || x.type === "code");
      router.onSignalement({
        origine: "utilisateur", type: "signalement",
        collection: f ? { vehicule: "vehicules", voyant: "voyants", code: "obd" }[f.type] : null, cibleId: f?.id || null,
        resume: commentaire, valeur: { commentaire, extrait, fiches, mode: b.mode },
      });
    }
    res.status(201).json({ ok: true });
  });

  // Consentement aux statistiques anonymes (désactivé par défaut).
  router.put("/api/account/consentement", (req, res) => {
    if (!req.user) return res.status(401).json({ code: "not_logged_in", error: "Connectez-vous pour continuer." });
    const ok = req.body?.stats === true;
    q.consentement.run(ok ? 1 : 0, req.user.id);
    res.json({ statsConsent: ok });
  });

  // Statistiques publiables (anonymes, seuil de 10 véhicules).
  router.get("/api/stats/entretiens", (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({ seuil: SEUIL_STATS, statistiques: statistiques() });
  });

  // Questions sans fiche (Relecture : l'accès administrateur est contrôlé sur /api/admin).
  router.get("/api/admin/questions-sans-fiche", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ prioritaires: prioritaires(50) });
  });

  router.noterSansFiche = noterSansFiche;
  router.prioritaires = prioritaires;
  router.statistiques = statistiques;
  router.statsRetours = (depuis = new Date(now() - 30 * 86_400_000).toISOString()) => Object.fromEntries(q.statsRetours.all(depuis).map(r => [r.avis, r.n]));
  router.consentementDe = uid => !!q.lireConsentement.get(uid)?.stats_consent;
  return router;
}
