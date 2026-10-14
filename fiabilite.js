// Règles de fiabilité des fiches de data/ : partagées par les tests, la page « Relecture » et l'Observateur.
// Une fiche qui ne les respecte pas n'est jamais écrite.

export const STATUTS = ["a_verifier", "verifie"];
export const REDACTEURS = ["ia", "humain"];

// Collections modifiables depuis la Relecture : fichier, identifiant, titre affiché, mise en forme.
export const COLLECTIONS = {
  voyants: { fichier: "voyants.json", cle: "id", titre: f => f.nom, format: "ligne" },
  obd: { fichier: "obd.json", cle: "code", titre: f => `${f.code} – ${f.libelle}`, format: "ligne" },
  vehicules: { fichier: "vehicules.json", cle: "id", titre: f => `${f.marque} ${f.modele} (${(f.moteurs || []).join(", ")})`, format: "indente" },
  pieces: { fichier: "pieces.json", cle: "id", titre: f => f.nom, format: "indente" },
};
// Zones du schéma interactif (l'ordre est celui de l'affichage).
export const ZONES = ["moteur", "transmission", "freins", "direction-suspension", "electricite", "echappement-depollution", "pneus", "carrosserie"];
export const ENERGIES_PIECES = ["thermique", "hybride", "hybride_rechargeable", "electrique"];

// Contenu d'une icône de voyant : seulement path, circle, rect et text, avec des attributs de dessin (insérée telle quelle dans la page).
const BALISES = /^<\/?(path|circle|rect|text)\b/;
const ATTRS = new Set(["d", "cx", "cy", "r", "x", "y", "width", "height", "text-anchor", "font-size", "font-weight", "fill", "stroke", "stroke-dasharray"]);
export function iconeProbleme(icone) {
  if (typeof icone !== "string" || !icone.trim()) return "icône vide";
  const tags = icone.match(/<[^>]+>/g) || [];
  if (!tags.length) return "icône vide";
  for (const tag of tags) {
    if (!BALISES.test(tag)) return `balise interdite ${tag.slice(0, 40)}`;
    for (const [, attr] of tag.matchAll(/\s([a-zA-Z:-]+)\s*=/g)) if (!ATTRS.has(attr)) return `attribut interdit ${attr}`;
  }
  if (/[<>]/.test(icone.replace(/<[^>]+>/g, ""))) return "texte d'icône suspect";
  return null;
}

// Problèmes d'une fiche (liste vide si elle est valide).
export function problemesFiche(collection, f) {
  const c = COLLECTIONS[collection];
  const p = [];
  if (!c) return ["collection inconnue"];
  if (!f || typeof f !== "object" || Array.isArray(f)) return ["la fiche doit être un objet JSON"];
  if (!f[c.cle] || typeof f[c.cle] !== "string") p.push(`identifiant « ${c.cle} » manquant`);
  if (!STATUTS.includes(f.statut)) p.push("statut : « a_verifier » ou « verifie »");
  if (!Array.isArray(f.sources) || !f.sources.every(s => typeof s === "string" && s.trim())) p.push("sources : liste de textes non vides");
  if (!REDACTEURS.includes(f.redige_par)) p.push("redige_par : « ia » ou « humain »");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.mise_a_jour || "")) p.push("mise_a_jour : AAAA-MM-JJ");
  if (f.incertitudes !== undefined && !Array.isArray(f.incertitudes)) p.push("incertitudes : liste");
  if (f.statut === "verifie" && !(f.sources?.length > 0)) p.push("une fiche vérifiée doit avoir au moins une source");
  if (collection === "voyants") {
    for (const k of ["nom", "symbole", "signification", "cout"]) if (typeof f[k] !== "string" || !f[k].trim()) p.push(`${k} manquant`);
    for (const k of ["autres_noms", "couleurs", "que_faire", "causes", "variantes"]) if (!Array.isArray(f[k])) p.push(`${k} : liste`);
    if (!Array.isArray(f.couleurs) || !f.couleurs.length || !f.couleurs.every(x => ["rouge", "orange", "vert", "bleu", "blanc"].includes(x))) p.push("couleurs invalides");
    if (!["rouge", "orange", "info"].includes(f.urgence)) p.push("urgence : rouge, orange ou info");
    if (!["oui", "prudemment", "non"].includes(f.rouler)) p.push("rouler : oui, prudemment ou non");
    const ip = iconeProbleme(f.icone);
    if (ip) p.push(`icône : ${ip}`);
  }
  if (collection === "obd" && !/^[PBCU][0-3][0-9A-F]{3}$/.test(f.code || "")) p.push("code OBD invalide");
  if (collection === "vehicules" && (!f.marque || !f.modele || !Array.isArray(f.moteurs))) p.push("marque, modèle et moteurs obligatoires");
  if (collection === "pieces") {
    for (const k of ["nom", "role", "duree_vie", "prix"]) if (typeof f[k] !== "string" || !f[k].trim()) p.push(`${k} manquant`);
    if (!ZONES.includes(f.zone)) p.push(`zone : ${ZONES.join(", ")}`);
    if (!Array.isArray(f.energies) || !f.energies.length || !f.energies.every(e => ENERGIES_PIECES.includes(e))) p.push("energies invalides");
    for (const k of ["signes_usure", "voyants", "glossaire", "mots_cles", "types_carnet"]) if (!Array.isArray(f[k])) p.push(`${k} : liste`);
    const fourchette = x => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite) && x[0] <= x[1];
    if (!fourchette(f.prix_eur)) p.push("prix_eur : [minimum, maximum] en euros");
    if (f.duree_vie_km !== null && !fourchette(f.duree_vie_km)) p.push("duree_vie_km : [minimum, maximum] en km, ou null");
  }
  return p;
}

// Écrit une collection dans le format du fichier : un objet par ligne, ou indenté (fiches longues).
export function serialiser(collection, fiches) {
  return COLLECTIONS[collection].format === "ligne"
    ? "[\n" + fiches.map(f => JSON.stringify(f)).join(",\n") + "\n]\n"
    : JSON.stringify(fiches, null, 2) + "\n";
}
