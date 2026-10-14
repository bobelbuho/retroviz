// Propositions d'amélioration de la base (Observateur, signalements d'utilisateurs), traitées dans la Relecture :
// accepter, modifier puis accepter, ou rejeter avec un motif. Rien ne change dans data/ sans validation humaine.
import express from "express";

export const TYPES_PROPOSITION = ["creation", "ajout", "modification", "contradiction", "signalement"];
const json = (v, def) => { try { return v == null ? def : JSON.parse(v); } catch { return def; } };

// Applique une valeur à un chemin simple dans une fiche : « pannes » (champ) ou « pannes.2.km » (élément).
export function appliquer(fiche, type, champ, valeur) {
  const f = structuredClone(fiche);
  if (type === "ajout") {
    if (!champ) throw new Error("champ manquant pour un ajout");
    if (f[champ] === undefined) f[champ] = [];
    if (!Array.isArray(f[champ])) throw new Error(`« ${champ} » n'est pas une liste`);
    f[champ].push(valeur);
    return f;
  }
  if (type === "modification" || type === "contradiction") {
    if (!champ) throw new Error("champ manquant pour une modification");
    const parts = champ.split(".");
    let o = f;
    for (const k of parts.slice(0, -1)) {
      if (o[k] === undefined || typeof o[k] !== "object") throw new Error(`chemin « ${champ} » introuvable`);
      o = o[k];
    }
    o[parts.at(-1)] = valeur;
    return f;
  }
  throw new Error(`type « ${type} » non applicable à une fiche`);
}

export function createPropositions(db, relecture) {
  const q = {
    insert: db.prepare(`INSERT INTO propositions (origine, type, collection, cible_id, champ, valeur, resume, sources, confiance, nb_sources, passage_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    get: db.prepare("SELECT * FROM propositions WHERE id = ?"),
    list: db.prepare("SELECT * FROM propositions WHERE statut = ? ORDER BY id DESC LIMIT 500"),
    decide: db.prepare("UPDATE propositions SET statut = ?, motif = ?, decide_par = ?, decide_le = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), valeur = ? WHERE id = ? AND statut = 'en_attente'"),
    counts: db.prepare("SELECT type, COUNT(*) AS n FROM propositions WHERE statut = 'en_attente' GROUP BY type"),
    dejaVue: db.prepare("SELECT id FROM propositions WHERE collection IS ? AND cible_id IS ? AND champ IS ? AND valeur IS ? AND statut != 'rejetee' LIMIT 1"),
  };
  const toPublic = r => ({
    id: r.id, origine: r.origine, type: r.type, collection: r.collection, cibleId: r.cible_id, champ: r.champ,
    valeur: json(r.valeur, null), resume: r.resume, sources: json(r.sources, []), confiance: r.confiance, nbSources: r.nb_sources,
    statut: r.statut, motif: r.motif, decidePar: r.decide_par, decideLe: r.decide_le, passageId: r.passage_id, creeLe: r.cree_le,
  });

  // Crée une proposition (sans doublon d'une proposition identique déjà en attente ou acceptée). Renvoie son id ou null.
  function creer(p) {
    if (!TYPES_PROPOSITION.includes(p.type) || !p.resume) throw new Error("proposition incomplète");
    const valeur = p.valeur === undefined ? null : JSON.stringify(p.valeur);
    if (q.dejaVue.get(p.collection ?? null, p.cibleId ?? null, p.champ ?? null, valeur)) return null;
    const sources = p.sources || [];
    const { lastInsertRowid } = q.insert.run(p.origine, p.type, p.collection ?? null, p.cibleId ?? null, p.champ ?? null, valeur,
      String(p.resume).slice(0, 500), JSON.stringify(sources), p.confiance ?? null, p.nbSources ?? sources.length, p.passageId ?? null);
    return Number(lastInsertRowid);
  }

  // Accepter : applique la valeur (éventuellement modifiée dans la Relecture) à la fiche, ajoute les sources.
  function accepter(id, par, valeurModifiee) {
    const r = q.get.get(id);
    if (!r) return { status: 404, error: "Proposition introuvable." };
    if (r.statut !== "en_attente") return { status: 409, error: "Proposition déjà traitée." };
    const valeur = valeurModifiee !== undefined ? valeurModifiee : json(r.valeur, null);
    const urls = json(r.sources, []).map(s => s.url).filter(Boolean);
    let res = { fiche: null };
    if (r.type === "signalement" || (r.type === "contradiction" && valeur == null)) {
      // Rien à écrire : le signalement est marqué comme traité.
    } else if (r.type === "creation") {
      res = relecture.creer(r.collection, { ...valeur, statut: "a_verifier", redige_par: "ia", sources: [...new Set([...(valeur?.sources || []), ...urls])] }, par, `proposition #${id} acceptée`);
    } else {
      const c = relecture.lire(r.collection).find(f => (f.id ?? f.code) === r.cible_id);
      if (!c) return { status: 404, error: "La fiche visée n'existe plus." };
      let f;
      try { f = appliquer(c, r.type, r.champ, valeur); } catch (e) { return { status: 400, error: `Impossible d'appliquer : ${e.message}.` }; }
      f.sources = [...new Set([...(f.sources || []), ...urls])];
      res = relecture.enregistrer(r.collection, r.cible_id, f, par, `proposition #${id} acceptée`);
    }
    if (res.error) return res;
    q.decide.run("acceptee", null, par, JSON.stringify(valeur), id);
    return { proposition: toPublic(q.get.get(id)), fiche: res.fiche };
  }

  function rejeter(id, par, motif) {
    const r = q.get.get(id);
    if (!r) return { status: 404, error: "Proposition introuvable." };
    if (r.statut !== "en_attente") return { status: 409, error: "Proposition déjà traitée." };
    const m = typeof motif === "string" ? motif.trim() : "";
    if (!m) return { status: 400, error: "Indiquez le motif du rejet." };
    q.decide.run("rejetee", m.slice(0, 500), par, r.valeur, id);
    return { proposition: toPublic(q.get.get(id)) };
  }

  const router = express.Router();
  // L'accès administrateur est déjà contrôlé par la Relecture sur /api/admin.
  router.get("/api/admin/propositions", (req, res) => {
    const statut = ["en_attente", "acceptee", "rejetee"].includes(req.query.statut) ? req.query.statut : "en_attente";
    const type = String(req.query.type || "");
    let list = q.list.all(statut).map(toPublic);
    if (type === "signalement") list = list.filter(p => p.type === "signalement");
    else if (type === "propositions") list = list.filter(p => p.type !== "signalement");
    res.setHeader("Cache-Control", "no-store");
    res.json({ propositions: list });
  });
  const reply = (res, r) => (r.error ? res.status(r.status).json({ code: "invalid", error: r.error }) : res.json(r));
  router.post("/api/admin/propositions/:id/accepter", (req, res) => reply(res, accepter(Number(req.params.id), req.user.email, req.body?.valeur)));
  router.post("/api/admin/propositions/:id/rejeter", (req, res) => reply(res, rejeter(Number(req.params.id), req.user.email, req.body?.motif)));

  router.creer = creer;
  router.enAttente = () => Object.fromEntries(q.counts.all().map(r => [r.type, r.n]));
  return router;
}
