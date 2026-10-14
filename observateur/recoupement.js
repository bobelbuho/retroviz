// Recoupement des faits : score de confiance et contradictions. Fonctions pures (testées sans réseau ni IA).

// Types de source qui peuvent confirmer un fait (un forum seul ne confirme jamais).
export const TYPES_FIABLES = ["officiel", "constructeur", "presse", "pro"];
export const SOURCES_POUR_CONFIRMER = 3;

// Domaine « racine » : forum-auto.caradisiac.com et www.caradisiac.com sont la même source.
export const domaineRacine = url => {
  const h = new URL(url).hostname.replace(/^www\./, "").split(".");
  return h.slice(-2).join(".");
};

// fait : { url, typeSource, km_min, km_max, cout_min, cout_max }. Renvoie le score d'un groupe de faits identiques.
export function confiance(faits) {
  const parDomaine = new Map();
  for (const f of faits) if (!parDomaine.has(domaineRacine(f.url))) parDomaine.set(domaineRacine(f.url), f.typeSource);
  const nbSources = parDomaine.size;
  const fiable = [...parDomaine.values()].some(t => TYPES_FIABLES.includes(t));
  return { nbSources, confiance: nbSources >= SOURCES_POUR_CONFIRMER && fiable ? "confirme" : "signale", sourceFiable: fiable };
}

const milieu = (a, b) => (a != null && b != null ? (a + b) / 2 : a ?? b ?? null);

// Contradictions : kilométrages ou coûts très différents d'une source à l'autre.
export function contradictions(faits) {
  const res = [];
  const km = faits.map(f => milieu(f.km_min, f.km_max)).filter(v => v != null && v > 0);
  if (km.length >= 2) {
    const [lo, hi] = [Math.min(...km), Math.max(...km)];
    if (hi / lo >= 1.5 && hi - lo >= 30_000) res.push({ sur: "km", min: lo, max: hi });
  }
  const cout = faits.map(f => milieu(f.cout_min, f.cout_max)).filter(v => v != null && v > 0);
  if (cout.length >= 2) {
    const [lo, hi] = [Math.min(...cout), Math.max(...cout)];
    if (hi / lo >= 2 && hi - lo >= 200) res.push({ sur: "cout", min: lo, max: hi });
  }
  return res;
}

// Fourchettes du groupe (bornes extrêmes des sources, arrondies) : jamais une valeur précise inventée.
export function fourchettes(faits) {
  const arr = (v, pas) => (v == null ? null : Math.round(v / pas) * pas);
  const vals = k => faits.map(f => f[k]).filter(v => v != null && v > 0);
  const kmMin = vals("km_min").concat(vals("km_max")), cMin = vals("cout_min").concat(vals("cout_max"));
  return {
    kmMin: kmMin.length ? arr(Math.min(...kmMin), 5000) : null, kmMax: kmMin.length ? arr(Math.max(...kmMin), 5000) : null,
    coutMin: cMin.length ? arr(Math.min(...cMin), 10) : null, coutMax: cMin.length ? arr(Math.max(...cMin), 10) : null,
  };
}

// groupes : [{ ids, titre, type, motorisation }], faits indexés par id. Renvoie les groupes enrichis.
export function recouper(groupes, faitsParId) {
  return groupes.map(g => {
    const faits = g.ids.map(i => faitsParId.get(i)).filter(Boolean);
    const sources = [];
    const vus = new Set();
    for (const f of faits) if (!vus.has(f.url)) { vus.add(f.url); sources.push({ url: f.url, type: f.typeSource, titre: f.titrePage || "", date: f.datePage || "" }); }
    return { ...g, faits, sources, ...confiance(faits), contradictions: contradictions(faits), ...fourchettes(faits) };
  });
}
