// Collecteurs de données officielles ouvertes, vérifiés le 2026-10-14 :
// - RappelConso : API Opendatasoft de data.economie.gouv.fr, jeu « rappelconso-v2-gtin-espaces » ;
// - Safety Gate : pas d'API documentée, rapports hebdomadaires XML officiels (liste puis détail) ;
// - NHTSA : api.nhtsa.gov, rappels et plaintes par marque, modèle et année (marché américain) ;
// - ADEME Car Labelling : data.ademe.fr (voitures neuves actuelles seulement).
import { normalize } from "../knowledge.js";

const RAPPELCONSO = "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/rappelconso-v2-gtin-espaces/records";
const SG_LISTE = "https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/list/xml/en";
const NHTSA = "https://api.nhtsa.gov";
const ADEME = "https://data.ademe.fr/data-fair/api/v1/datasets/ademe-car-labelling/lines";

// Termes qui désignent la génération d'un modèle dans un texte de rappel : « clio iv », « clio 4 », « golf vii »…
// Un alias sans génération (« vw golf », « 208 phase 1 ») ne suffit pas : il rattacherait des rappels d'autres générations.
export function termesModele(fiche) {
  const n = numeroGeneration(fiche);
  const t = new Set([fiche.generation, ...(fiche.alias || [])].filter(Boolean).map(normalize));
  return [...t].filter(x => x.length >= 3 && n && generationsCitees(x, fiche).includes(n));
}
// Le texte du rappel vise-t-il ce modèle ? (« clio iv » ne doit pas attraper « clio v »)
export function viseModele(texte, fiche) {
  const n = ` ${normalize(texte)} `;
  return termesModele(fiche).some(t => n.includes(` ${t} `));
}

/* ---------- génération visée par un rappel ---------- */
const ROMAINS = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9 };
// Numéro de génération d'une fiche : « 208 I » -> 1, « Clio IV » -> 4, « Golf VII » -> 7 (null si inconnu).
export function numeroGeneration(fiche) {
  const m = normalize(fiche.generation || "").match(/\b(i{1,3}|iv|v|vi{1,3}|ix|\d)$/);
  return m ? ROMAINS[m[1]] ?? +m[1] : null;
}
// Générations du modèle citées dans un texte (« 208 v2 », « 208 ii », « clio 5 », « golf vii » -> [2, 2, 5, 7]).
export function generationsCitees(texte, fiche) {
  const mod = normalize(fiche.modele).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${mod} ?(v ?(\\d)|(i{1,3}|iv|vi{0,3}|ix)|(\\d))\\b(?![.,]\\d)`, "g");
  return [...` ${normalize(texte)} `.matchAll(re)].map(m => (m[2] ? +m[2] : m[3] ? ROMAINS[m[3]] : +m[4])).filter(n => n >= 1 && n <= 9);
}
// Périodes de production indiquées pour ce modèle (lignes qui citent une autre génération ignorées), en années.
export function periodesProduction(identification, fiche) {
  const n = numeroGeneration(fiche);
  const res = [];
  for (const ligne of String(identification || "").split(/\n|\/\/(?=[^/]*\d{4})/)) {
    const gens = generationsCitees(ligne, fiche);
    if (gens.length && n && !gens.includes(n)) continue;
    const annees = [...ligne.matchAll(/\b\d{1,2}[./-]\d{1,2}[./-]((?:19|20)\d{2})\b/g)].map(m => +m[1]);
    if (annees.length >= 2) res.push([Math.min(...annees), Math.max(...annees)]);
  }
  return res;
}
// Un rappel qui cite le modèle sans sa génération peut-il concerner cette fiche ?
// Non s'il ne cite que d'autres générations, ou si ses périodes de production ne recouvrent pas celles de la fiche.
export function peutConcerner(rappel, fiche) {
  const n = numeroGeneration(fiche);
  const gens = generationsCitees(`${rappel.modeles} ${rappel.identification || ""}`, fiche);
  if (n && gens.length && !gens.includes(n)) return false;
  const span = String(fiche.annees || "").match(/(\d{4})\D+(\d{4})/);
  const periodes = periodesProduction(rappel.identification, fiche);
  if (span && periodes.length) return periodes.some(([a, b]) => a <= +span[2] && b >= +span[1]);
  return true;
}

/* ---------- RappelConso ---------- */
export function parseRappelConso(json) {
  return (json?.results || []).map(r => ({
    source: "RappelConso", date: String(r.date_publication || "").slice(0, 10), marque: r.marque_produit || "",
    modeles: r.modeles_ou_references || "", motif: r.motif_rappel || "", risques: r.risques_encourus || "",
    identification: [].concat(r.identification_produits || []).join("\n"),
    url: r.lien_vers_la_fiche_rappel || "",
  })).filter(r => r.url);
}
export async function rappelConso(web, marque, modele) {
  const qs = new URLSearchParams({
    where: `categorie_produit like "automobiles*" and search("${String(`${marque} ${modele}`).replace(/["\\]/g, "")}")`,
    order_by: "date_publication desc", limit: "100",
    select: "date_publication,marque_produit,modeles_ou_references,identification_produits,motif_rappel,risques_encourus,lien_vers_la_fiche_rappel",
  });
  return parseRappelConso(JSON.parse(await web.api(`${RAPPELCONSO}?${qs}`)));
}

/* ---------- Safety Gate ---------- */
const cdata = s => String(s ?? "").replace(/^<!\[CDATA\[|\]\]>$/g, "").trim();
const balise = (xml, nom) => cdata((xml.match(new RegExp(`<${nom}>([\\s\\S]*?)</${nom}>`)) || [])[1]);
export function parseSafetyGateListe(xml) {
  return [...String(xml).matchAll(/<weeklyReport>([\s\S]*?)<\/weeklyReport>/g)].map(m => {
    const [j, mo, a] = balise(m[1], "publicationDate").split("/");
    return { date: `${a}-${mo}-${j}`, url: balise(m[1], "URL").replace(/&amp;/g, "&") };
  }).filter(r => r.url && /^\d{4}-\d{2}-\d{2}$/.test(r.date)).sort((x, y) => y.date.localeCompare(x.date));
}
export function parseSafetyGateRapport(xml) {
  return [...String(xml).matchAll(/<notifications\b[^>]*>([\s\S]*?)<\/notifications>/g)].map(m => ({
    source: "Safety Gate", categorie: balise(m[1], "category"), produit: balise(m[1], "product"), marque: balise(m[1], "brand"),
    modeles: `${balise(m[1], "name")} ${balise(m[1], "type_numberOfModel")}`.trim(), motif: balise(m[1], "danger"),
    risques: balise(m[1], "riskType"), url: balise(m[1], "reference"), date: "",
  })).filter(a => /motor vehicles/i.test(a.categorie));
}
// Alertes « Motor vehicles » des `semaines` derniers rapports (lecture limitée : un rapport fait ~200 ko).
export async function safetyGate(web, semaines = 8) {
  const liste = parseSafetyGateListe(await web.api(SG_LISTE, "application/xml")).slice(0, semaines);
  const alertes = [];
  for (const rap of liste) {
    for (const a of parseSafetyGateRapport(await web.api(rap.url, "application/xml"))) alertes.push({ ...a, date: rap.date });
  }
  return alertes;
}

/* ---------- NHTSA ---------- */
export function parseNhtsaRappels(json) {
  return (json?.results || []).map(r => ({
    source: "NHTSA", numero: r.NHTSACampaignNumber, date: r.ReportReceivedDate, organe: r.Component || "",
    resume: r.Summary || "", consequence: r.Consequence || "", remede: r.Remedy || "",
    url: r.NHTSACampaignNumber ? `https://www.nhtsa.gov/recalls?nhtsaId=${r.NHTSACampaignNumber}` : "",
  }));
}
// Plaintes : seulement le nombre par organe. Le texte des plaintes (témoignages, parfois un numéro de série) n'est jamais gardé.
export function parseNhtsaPlaintes(json) {
  const parOrgane = {};
  for (const r of json?.results || []) for (const o of String(r.components || "").split(",").map(s => s.trim()).filter(Boolean)) parOrgane[o] = (parOrgane[o] || 0) + 1;
  return { total: json?.count ?? (json?.results || []).length, parOrgane };
}
export async function nhtsa(web, make, model, annees) {
  const rappels = [], plaintes = { total: 0, parOrgane: {} };
  for (const y of annees) {
    const q = `make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${y}`;
    rappels.push(...parseNhtsaRappels(JSON.parse(await web.api(`${NHTSA}/recalls/recallsByVehicle?${q}`))));
    const p = parseNhtsaPlaintes(JSON.parse(await web.api(`${NHTSA}/complaints/complaintsByVehicle?${q}`)));
    plaintes.total += p.total;
    for (const [o, n] of Object.entries(p.parOrgane)) plaintes.parOrgane[o] = (plaintes.parOrgane[o] || 0) + n;
  }
  const vus = new Set();
  return { rappels: rappels.filter(r => r.numero && !vus.has(r.numero) && vus.add(r.numero)), plaintes };
}

/* ---------- ADEME ---------- */
export async function ademe(web, marque, modele) {
  const qs = new URLSearchParams({ size: "50", q: `${marque} ${modele}`, select: "Marque,Modèle,Description_Commerciale,Energie,Puissance_maximale,Conso_vitesse_mixte_Min,Conso_vitesse_mixte_Max,CO2_vitesse_mixte_Min,CO2_vitesse_mixte_Max" });
  const json = JSON.parse(await web.api(`${ADEME}?${qs}`));
  return (json.results || []).filter(r => normalize(r.Marque) === normalize(marque));
}
