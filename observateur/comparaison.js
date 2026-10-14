// Comparaison des faits recoupés avec la base : propositions (ajout, contradiction, nouvelle fiche) et rappels officiels.
// Fonctions pures : elles décrivent les propositions, sans rien écrire.
import { normalize, findVehicle } from "../knowledge.js";

const STOP = new Set(["avec", "dans", "pour", "plus", "moins", "tres", "trop", "cette", "leur", "sont", "peut", "etre", "fait", "souvent", "certains", "moteur",
  "les", "des", "une", "sur", "par", "est", "pas", "qui", "que", "aux", "son", "ses", "mal", "bon", "tot", "peu"]);
// Racine grossière : « encrassée », « encrassés » et « encrassé » donnent le même mot. Les sigles (EGR, FAP) comptent.
const racine = w => (w.length > 4 ? w.replace(/(ees|ee|es|e|s|x)$/, "") : w);
const motsCles = s => new Set(normalize(s).split(" ").filter(w => w.length >= 3 && !STOP.has(w) && !/^\d/.test(w)).map(racine));
// Ressemblance de deux titres (mots en commun / mots du plus court). Un seul mot commun ne suffit pas :
// « Capteur de pression de turbo » n'est pas « Turbo fatigué ».
export function ressemblance(a, b) {
  const x = motsCles(a), y = motsCles(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  if (n < 2 && !(x.size === 1 && y.size === 1 && n === 1)) return 0;
  return n / Math.min(x.size, y.size);
}
const SEUIL = 0.5;
const fmtKm = n => `${n.toLocaleString("fr-FR")} km`;
const fourchetteCout = g => (g.coutMin != null ? (g.coutMax && g.coutMax !== g.coutMin ? `${g.coutMin} à ${g.coutMax} €` : `environ ${g.coutMin} €`) : null);
const kmTypique = g => (g.kmMin != null ? Math.round(((g.kmMin + (g.kmMax ?? g.kmMin)) / 2) / 5000) * 5000 : null);
const libelleConfiance = g => (g.confiance === "confirme" ? `confirmé par ${g.nbSources} sources indépendantes` : `signalé par ${g.nbSources} source${g.nbSources > 1 ? "s" : ""}`);

// Élément de fiche correspondant à un groupe (champ de la fiche véhicule).
export function elementDeFiche(g) {
  if (g.type === "panne") {
    const e = { titre: g.titre };
    const km = kmTypique(g);
    if (km) e.km_typique = km;
    e.symptomes = g.faits?.[0]?.contenu || g.titre;
    const c = fourchetteCout(g);
    if (c) e.cout_indicatif = c;
    return { champ: "pannes", valeur: e };
  }
  if (g.type === "entretien") {
    const e = { titre: g.titre };
    const km = kmTypique(g);
    if (km) e.km = km;
    const c = fourchetteCout(g);
    if (c) e.cout_indicatif = c;
    return { champ: "entretiens", valeur: e };
  }
  if (g.type === "point_fort") return { champ: "points_forts", valeur: g.titre };
  if (g.type === "point_faible") return { champ: "points_faibles", valeur: g.titre };
  return null; // un coût seul s'ajoute à une panne ou un entretien existant (voir plus bas)
}

// Propositions pour une fiche existante. groupes : sortie de recouper(). Renvoie des propositions prêtes à créer.
export function proposerPourFiche(fiche, groupes) {
  const props = [];
  for (const g of groupes) {
    const base = { origine: "observateur", collection: "vehicules", cibleId: fiche.id, sources: g.sources, confiance: g.confiance, nbSources: g.nbSources };
    for (const c of g.contradictions || []) {
      props.push({ ...base, type: "contradiction", champ: null, valeur: null,
        resume: `Sources en désaccord sur « ${g.titre} » : ${c.sur === "km" ? `de ${fmtKm(c.min)} à ${fmtKm(c.max)}` : `de ${Math.round(c.min)} à ${Math.round(c.max)} €`} selon les sources (${libelleConfiance(g)}).` });
    }
    if (g.type === "cout") {
      // Un coût s'accroche à la panne ou à l'entretien qui lui ressemble le plus, s'il n'a pas déjà un coût.
      const cible = ["pannes", "entretiens"].flatMap(ch => (fiche[ch] || []).map((e, i) => ({ ch, i, e, r: ressemblance(e.titre, g.titre) })))
        .filter(x => x.r >= SEUIL && !x.e.cout_indicatif).sort((a, b) => b.r - a.r)[0];
      const c = fourchetteCout(g);
      if (cible && c) props.push({ ...base, type: "modification", champ: `${cible.ch}.${cible.i}.cout_indicatif`, valeur: c, resume: `Coût de « ${cible.e.titre} » : ${c} (${libelleConfiance(g)}).` });
      continue;
    }
    const el = elementDeFiche(g);
    if (!el) continue;
    const existants = fiche[el.champ] || [];
    const titreDe = e => (typeof e === "string" ? e : e.titre);
    const proche = existants.map((e, i) => ({ e, i, r: ressemblance(titreDe(e), g.titre) })).filter(x => x.r >= SEUIL).sort((a, b) => b.r - a.r)[0];
    if (!proche) {
      props.push({ ...base, type: "ajout", champ: el.champ, valeur: el.valeur, resume: `Ajouter « ${g.titre} » (${el.champ.replace("_", " ")}) : ${libelleConfiance(g)}.` });
      continue;
    }
    // Déjà dans la fiche : on signale seulement un kilométrage très différent de celui des sources.
    const kmFiche = proche.e.km_typique ?? proche.e.km;
    const kmSources = kmTypique(g);
    if (kmFiche && kmSources && g.kmMin != null && (kmFiche < g.kmMin * 0.8 || kmFiche > (g.kmMax ?? g.kmMin) * 1.2)) {
      const champKm = proche.e.km_typique != null ? "km_typique" : "km";
      props.push({ ...base, type: "contradiction", champ: `${el.champ}.${proche.i}.${champKm}`, valeur: kmSources,
        resume: `« ${titreDe(proche.e)} » : la fiche dit ${fmtKm(kmFiche)}, les sources ${fmtKm(g.kmMin)} à ${fmtKm(g.kmMax ?? g.kmMin)} (${libelleConfiance(g)}).` });
    }
  }
  return props;
}

const slug = s => normalize(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// Nouvelle fiche véhicule (motorisation sans fiche), toujours « à vérifier », à partir des groupes de cette motorisation.
export function proposerNouvelleFiche({ marque, modele, generation, motorisation }, groupes, today) {
  const fiche = {
    id: slug(`${marque} ${generation || modele} ${motorisation}`), marque, modele, generation: generation || modele,
    moteurs: [motorisation], pannes: [], entretiens: [], points_forts: [], points_faibles: [],
    sources: [], statut: "a_verifier", redige_par: "ia", mise_a_jour: today,
    incertitudes: ["Fiche proposée par l'Observateur à partir de sources du web : chaque information est à recouper."],
  };
  const urls = new Set();
  for (const g of groupes) {
    const el = elementDeFiche(g);
    if (el) fiche[el.champ].push(el.valeur);
    for (const s of g.sources) urls.add(s.url);
  }
  const n = groupes.length;
  const confirmes = groupes.filter(g => g.confiance === "confirme").length;
  return {
    origine: "observateur", type: "creation", collection: "vehicules", cibleId: fiche.id, champ: null, valeur: fiche,
    sources: [...urls].map(url => ({ url, type: groupes.flatMap(g => g.sources).find(s => s.url === url)?.type || "" })),
    confiance: confirmes ? "confirme" : "signale", nbSources: urls.size,
    resume: `Nouvelle fiche ${marque} ${generation || modele} ${motorisation} : ${n} information${n > 1 ? "s" : ""}, dont ${confirmes} confirmée${confirmes > 1 ? "s" : ""}.`,
  };
}

// Fiche existante pour une motorisation donnée (même modèle ET même moteur), ou null.
export function ficheDe(kb, { marque, modele, generation, motorisation }) {
  const r = findVehicle([marque, generation || modele, motorisation].filter(Boolean).join(" "), kb, 1)[0];
  return r && r.correspondance === "modele_moteur" ? r.fiche : null;
}

// Rappel officiel -> élément du champ « rappels » d'une fiche (ajout automatique, sans relecture).
export const elementRappel = r => ({
  source: r.source, mention: "source officielle", date: r.date || null,
  titre: String(r.motif || r.resume || "Rappel").slice(0, 300), risques: String(r.risques || "").slice(0, 200) || null, url: r.url,
});
