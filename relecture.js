// Page « Relecture » (administrateurs seulement : variable ADMIN_EMAILS) : corriger les fiches de data/,
// ajouter des sources, passer une fiche en « vérifiée ». Les corrections sont écrites dans les fichiers JSON
// (visibles dans git), avec la date et l'auteur, puis la base est rechargée en mémoire.
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { sameSiteJson } from "./auth.js";
import { COLLECTIONS, problemesFiche, serialiser } from "./fiabilite.js";
import { lireMarques, ecrireMarque, aplatir, remplacer } from "./marques.js";
class ErreurFiche extends Error {}
import { reloadKnowledge } from "./knowledge.js";
import { today } from "./kilometrage.js";

// « a@x.fr, B@y.fr » -> ensemble d'adresses en minuscules.
export const parseAdmins = raw => new Set(String(raw || "").split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean));

export function createRelecture({ dataDir, kb, admins = new Set(), now = today, extraTableau = () => ({}) }) {
  const isAdmin = user => !!user && admins.has(String(user.email).toLowerCase());
  // Non connecté : 401 ; connecté sans droits : 404, la page n'existe pas pour lui.
  const needAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ code: "not_logged_in", error: "Connectez-vous pour continuer." });
    if (!isAdmin(req.user)) return res.status(404).json({ code: "not_found", error: "Page introuvable." });
    next();
  };

  /* ---------- lecture et écriture des fichiers ---------- */
  const fichier = c => path.join(dataDir, COLLECTIONS[c].fichier);
  // Fichier pas encore créé (nouvelle collection) : collection vide.
  // Marques, modèles et motorisations : lus et écrits dans data/marques/ (marques.js).
  const lire = c => {
    if (COLLECTIONS[c].stockage === "marques") return aplatir(lireMarques(dataDir) || [])[c];
    return fs.existsSync(fichier(c)) ? JSON.parse(fs.readFileSync(fichier(c), "utf8")) : [];
  };
  function ecrire(c, fiches) {
    if (COLLECTIONS[c].stockage === "marques") {
      const r = remplacer(lireMarques(dataDir) || [], c, fiches);
      if (r.error) throw new ErreurFiche(r.error);
      for (const m of r.marques.filter(x => r.modifiees.includes(x.id))) ecrireMarque(dataDir, m);
    } else {
      const tmp = fichier(c) + ".tmp";
      fs.writeFileSync(tmp, serialiser(c, fiches));
      fs.renameSync(tmp, fichier(c)); // écriture atomique : jamais de fichier à moitié écrit
    }
    reloadKnowledge(kb, dataDir);
  }
  const trouver = (c, id) => {
    const fiches = lire(c);
    const i = fiches.findIndex(f => f[COLLECTIONS[c].cle] === id);
    return { fiches, i, fiche: fiches[i] };
  };
  const revision = (f, par, action) => {
    f.revisions = [...(Array.isArray(f.revisions) ? f.revisions : []), { date: now(), par, action }];
  };
  const resume = (c, f) => ({
    collection: c, id: f[COLLECTIONS[c].cle], titre: COLLECTIONS[c].titre(f), statut: f.statut,
    sources: f.sources?.length || 0, redige_par: f.redige_par, mise_a_jour: f.mise_a_jour,
  });

  // Modification commune : contrôles, date, auteur, écriture. Renvoie { fiche } ou { status, error }.
  function enregistrer(c, id, fiche, par, action) {
    if (!fiche || typeof fiche !== "object" || Array.isArray(fiche)) return { status: 400, error: "La fiche doit être un objet JSON." };
    const { fiches, i } = trouver(c, id);
    if (i < 0) return { status: 404, error: "Fiche introuvable." };
    const cle = COLLECTIONS[c].cle;
    if (fiche[cle] !== id) return { status: 400, error: `L'identifiant « ${cle} » ne peut pas être modifié.` };
    const avant = fiches[i];
    const f = { ...fiche, mise_a_jour: now() };
    // Passer en « vérifiée » : seulement par une validation humaine, tracée.
    if (f.statut === "verifie" && avant.statut !== "verifie") { f.verifie_par = par; f.verifie_le = now(); }
    if (f.statut !== "verifie") { delete f.verifie_par; delete f.verifie_le; }
    revision(f, par, action);
    const pb = problemesFiche(c, f);
    if (pb.length) return { status: 400, error: `Fiche refusée : ${pb.join(" ; ")}.` };
    fiches[i] = f;
    try { ecrire(c, fiches); } catch (e) { if (e instanceof ErreurFiche) return { status: 400, error: e.message }; throw e; }
    return { fiche: f };
  }

  const router = express.Router();
  router.use("/api/admin", sameSiteJson, needAdmin);
  const collectionOk = (req, res) => {
    if (COLLECTIONS[req.params.collection]) return true;
    res.status(404).json({ code: "not_found", error: "Collection inconnue." });
    return false;
  };
  const send = (res, r) => (r.error ? res.status(r.status).json({ code: "invalid_fiche", error: r.error }) : res.json({ fiche: r.fiche }));

  // Tableau de bord : fiches par statut et par collection (+ ce que fournissent les autres modules).
  router.get("/api/admin/tableau", (req, res) => {
    const fiches = {};
    for (const c of Object.keys(COLLECTIONS)) {
      const l = lire(c);
      fiches[c] = { total: l.length, a_verifier: l.filter(f => f.statut !== "verifie").length, verifie: l.filter(f => f.statut === "verifie").length };
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ fiches, ...extraTableau() });
  });

  router.get("/api/admin/fiches", (req, res) => {
    const { collection = "", statut = "", q = "" } = req.query;
    const cols = collection ? [collection].filter(c => COLLECTIONS[c]) : Object.keys(COLLECTIONS);
    const terme = String(q).toLowerCase();
    const list = cols.flatMap(c => lire(c).map(f => resume(c, f)))
      .filter(f => !statut || f.statut === statut)
      .filter(f => !terme || `${f.id} ${f.titre}`.toLowerCase().includes(terme));
    res.setHeader("Cache-Control", "no-store");
    res.json({ fiches: list });
  });

  router.get("/api/admin/fiches/:collection/:id", (req, res) => {
    if (!collectionOk(req, res)) return;
    const { fiche } = trouver(req.params.collection, req.params.id);
    if (!fiche) return res.status(404).json({ code: "not_found", error: "Fiche introuvable." });
    res.setHeader("Cache-Control", "no-store");
    res.json({ fiche });
  });

  // Corriger une fiche (contenu complet).
  router.put("/api/admin/fiches/:collection/:id", (req, res) => {
    if (!collectionOk(req, res)) return;
    send(res, enregistrer(req.params.collection, req.params.id, req.body?.fiche, req.user.email, "correction"));
  });

  // Ajouter une source.
  router.post("/api/admin/fiches/:collection/:id/sources", (req, res) => {
    if (!collectionOk(req, res)) return;
    const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
    if (!source || source.length > 500) return res.status(400).json({ code: "invalid_source", error: "Source vide ou trop longue (500 caractères au plus)." });
    const { fiche } = trouver(req.params.collection, req.params.id);
    if (!fiche) return res.status(404).json({ code: "not_found", error: "Fiche introuvable." });
    if (fiche.sources.includes(source)) return res.status(409).json({ code: "duplicate", error: "Cette source est déjà indiquée." });
    send(res, enregistrer(req.params.collection, req.params.id, { ...fiche, sources: [...fiche.sources, source] }, req.user.email, "source ajoutée"));
  });

  // Passer en « vérifiée » : impossible sans au moins une source.
  router.post("/api/admin/fiches/:collection/:id/verifier", (req, res) => {
    if (!collectionOk(req, res)) return;
    const { fiche } = trouver(req.params.collection, req.params.id);
    if (!fiche) return res.status(404).json({ code: "not_found", error: "Fiche introuvable." });
    if (!fiche.sources?.length) return res.status(400).json({ code: "no_source", error: "Ajoutez au moins une source avant de passer la fiche en « vérifiée »." });
    send(res, enregistrer(req.params.collection, req.params.id, { ...fiche, statut: "verifie" }, req.user.email, "passée en vérifiée"));
  });

  // Pour les autres modules (propositions de l'Observateur) : appliquer une modification à une fiche.
  router.lire = lire;
  router.enregistrer = enregistrer;
  router.creer = (c, fiche, par, action) => {
    const fiches = lire(c), cle = COLLECTIONS[c].cle;
    if (fiches.some(f => f[cle] === fiche[cle])) return { status: 409, error: "Une fiche porte déjà cet identifiant." };
    const f = { ...fiche, mise_a_jour: now() };
    revision(f, par, action);
    const pb = problemesFiche(c, f);
    if (pb.length) return { status: 400, error: `Fiche refusée : ${pb.join(" ; ")}.` };
    try { ecrire(c, [...fiches, f]); } catch (e) { if (e instanceof ErreurFiche) return { status: 400, error: e.message }; throw e; }
    return { fiche: f };
  };
  router.isAdmin = isAdmin;
  router.needAdmin = needAdmin;
  return router;
}
