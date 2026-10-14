// Marques et modèles : un fichier JSON par marque dans data/marques/ (marque › modèles › générations › motorisations).
// Le reste de l'application voit trois collections « à plat », comme avant :
//   marques   : la marque (sans ses modèles)
//   modeles   : un modèle, avec ses générations (sans leurs motorisations)
//   vehicules : une motorisation d'une génération, avec marque, modèle, génération, années et alias hérités
// Les fiches « vehicules » gardent leur forme et leurs identifiants (garages reliés, Observateur, « À venir »).
import fs from "node:fs";
import path from "node:path";

export const DOSSIER = "marques";
// Champs hérités ou calculés d'une fiche « vehicules » : jamais écrits dans la motorisation.
const DERIVES = ["marque", "modele", "generation", "alias", "alias_generation", "marque_id", "modele_id", "generation_id", "annees"];

export const slug = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const cle = s => slug(s).replace(/-/g, "");

/* ---------- fichiers ---------- */
export const dossierMarques = dir => path.join(dir, DOSSIER);
export function lireMarques(dir) {
  const d = dossierMarques(dir);
  if (!fs.existsSync(d)) return null; // pas encore migré
  return fs.readdirSync(d).filter(f => f.endsWith(".json")).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(d, f), "utf8")));
}
export const serialiserMarque = m => JSON.stringify(m, null, 2) + "\n";
export function ecrireMarque(dir, marque) {
  const d = dossierMarques(dir);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `${marque.id}.json`), tmp = f + ".tmp";
  fs.writeFileSync(tmp, serialiserMarque(marque));
  fs.renameSync(tmp, f); // écriture atomique
}

/* ---------- vue à plat ---------- */
const sans = (o, cles) => Object.fromEntries(Object.entries(o).filter(([k]) => !cles.includes(k)));
export function aplatir(marques) {
  const out = { marques: [], modeles: [], vehicules: [] };
  for (const m of marques || []) {
    out.marques.push(sans(m, ["modeles"]));
    for (const mo of m.modeles || []) {
      out.modeles.push({ ...sans(mo, ["generations"]), marque: m.id, generations: (mo.generations || []).map(g => sans(g, ["motorisations"])) });
      for (const g of mo.generations || []) {
        for (const v of g.motorisations || []) {
          out.vehicules.push({
            id: v.id, marque: m.nom, modele: mo.nom, generation: g.nom,
            alias: [...new Set([...(g.alias || []), ...(mo.alias || [])])],
            alias_generation: g.alias || [], // seuls ces alias désignent une génération précise (« golf 7 », pas « vw golf »)
            annees: v.annees_propres || g.annees,
            marque_id: m.id, modele_id: mo.id, generation_id: g.id,
            ...sans(v, ["id", "annees_propres"]),
          });
        }
      }
    }
  }
  return out;
}

/**
 * Remet une collection modifiée dans l'arbre des marques. Renvoie { marques: arbre, modifiees: [ids] } ou { error }.
 * Une nouvelle fiche « vehicules » (proposition de l'Observateur) est rangée sous sa marque et son modèle, qui doivent exister ;
 * sa génération est créée si besoin.
 */
export function remplacer(marques, collection, fiches) {
  const arbre = structuredClone(marques);
  const modifiees = new Set();
  const parId = new Map(arbre.map(m => [m.id, m]));
  if (collection === "marques") {
    for (const f of fiches) {
      const m = parId.get(f.id);
      if (!m) return { error: `Marque « ${f.id} » inconnue : ajoutez son fichier dans data/marques/.` };
      Object.assign(m, sans(f, ["modeles"]), { modeles: m.modeles });
      for (const k of Object.keys(m)) if (!(k in f) && k !== "modeles") delete m[k];
      modifiees.add(m.id);
    }
  } else if (collection === "modeles") {
    for (const f of fiches) {
      const m = parId.get(f.marque);
      const mo = m?.modeles.find(x => x.id === f.id);
      if (!mo) return { error: `Modèle « ${f.id} » inconnu.` };
      const anciennes = new Map((mo.generations || []).map(g => [g.id, g]));
      const generations = (f.generations || []).map(g => ({ ...g, motorisations: anciennes.get(g.id)?.motorisations || [] }));
      const perdues = [...anciennes.values()].filter(g => !generations.some(x => x.id === g.id) && g.motorisations?.length);
      if (perdues.length) return { error: `La génération « ${perdues[0].nom} » a encore des motorisations : déplacez-les d'abord.` };
      const i = m.modeles.indexOf(mo);
      m.modeles[i] = { ...sans(f, ["marque", "generations"]), generations };
      modifiees.add(m.id);
    }
  } else if (collection === "vehicules") {
    const existantes = new Map();
    for (const m of arbre) for (const mo of m.modeles || []) for (const g of mo.generations || []) for (const v of g.motorisations || []) existantes.set(v.id, { m, g, v });
    for (const f of fiches) {
      const propre = sans(f, DERIVES);
      const loc = existantes.get(f.id);
      if (loc) {
        const i = loc.g.motorisations.indexOf(loc.v);
        loc.g.motorisations[i] = { ...propre, ...(f.annees && f.annees !== loc.g.annees && { annees_propres: f.annees }) };
        if (JSON.stringify(loc.g.motorisations[i]) !== JSON.stringify(loc.v)) modifiees.add(loc.m.id);
        continue;
      }
      // Nouvelle fiche : marque et modèle d'après leurs noms.
      const m = arbre.find(x => cle(x.nom) === cle(f.marque) || x.id === slug(f.marque));
      const mo = m?.modeles.find(x => cle(x.nom) === cle(f.modele) || (x.alias || []).some(a => cle(a) === cle(f.modele)));
      if (!mo) return { error: `Pas de modèle « ${f.marque} ${f.modele} » dans data/marques/ : créez d'abord le modèle.` };
      let g = mo.generations.find(x => cle(x.nom) === cle(f.generation || "") || (x.alias || []).some(a => cle(a) === cle(f.generation || "")));
      if (!g) { g = { id: `${mo.id}-${slug(f.generation || "autre")}`, nom: f.generation || mo.nom, annees: f.annees || "", alias: [], motorisations: [] }; mo.generations.push(g); }
      g.motorisations.push({ ...propre, ...(f.annees && f.annees !== g.annees && { annees_propres: f.annees }) });
      modifiees.add(m.id);
    }
  }
  return { marques: arbre, modifiees: [...modifiees] };
}
