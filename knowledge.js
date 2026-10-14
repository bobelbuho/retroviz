// Base de connaissances Rétroviz : charge les fiches JSON du dossier data/ et les retrouve par mots-clés.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
export const MAX_CONTEXT = 6000;
export const STATUT_LABEL = { verifie: "vérifiée", a_verifier: "à vérifier" };
const statutOf = f => (f.statut === "verifie" ? "verifie" : "a_verifier");

/* ---------- chargement ---------- */
function readList(file, log) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(data)) throw new Error("le fichier doit contenir un tableau [ ... ]");
    return data;
  } catch (e) {
    log(`⚠️  Base Rétroviz : ${path.basename(file)} ignoré (${e.message}). Le serveur continue sans ces fiches.`);
    return [];
  }
}

// Renvoie { vehicules: [...], codes: Map(code -> fiche) }. Un fichier invalide est ignoré avec un message clair.
export function loadKnowledge(dir = DATA_DIR, log = console.warn) {
  const vehicules = readList(path.join(dir, "vehicules.json"), log).filter(v => v && v.id && v.marque && v.modele);
  const codes = new Map();
  for (const c of readList(path.join(dir, "obd.json"), log)) {
    if (c && c.code) codes.set(String(c.code).toUpperCase(), { ...c, code: String(c.code).toUpperCase() });
  }
  return { vehicules, codes };
}

let defaultKb = null;
const kbOrDefault = kb => kb || (defaultKb ??= loadKnowledge());

/* ---------- normalisation ---------- */
// Minuscules, sans accents, « 1,2 » -> « 1.2 », ponctuation remplacée par des espaces (sauf le point décimal).
export function normalize(s) {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\.(?!\d)|(?<!\d)\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function prepare(text) {
  const n = normalize(text);
  return { n, padded: ` ${n} `, compact: n.replace(/ /g, "") };
}

// Le terme apparaît-il dans le texte ? Mot entier, ou version sans espaces (« pure tech » = « puretech »).
function has(t, term) {
  const n = normalize(term);
  if (!n) return false;
  if (t.padded.includes(` ${n} `)) return true;
  const c = n.replace(/ /g, "");
  return c.length >= 5 && /[a-z]/.test(c) && t.compact.includes(c);
}

const withoutPower = m => String(m).replace(/\s+\d{2,3}\s*(ch|cv)?$/i, "").trim();
const displacements = s => new Set(normalize(s).match(/\b\d\.\d\b/g) || []);

/* ---------- véhicules ---------- */
// Renvoie au plus `max` fiches : [{ fiche, score, correspondance: "modele_moteur" | "modele" | "moteur" }].
// « moteur » = autre modèle équipé du même moteur (seules les infos moteur sont alors utiles).
export function findVehicle(text, kb, max = 2) {
  const t = prepare(text);
  if (!t.n) return [];
  const years = (t.n.match(/\b(19[5-9]\d|20[0-4]\d)\b/g) || []).map(Number);
  const asked = displacements(t.n);
  const results = [];

  for (const v of kbOrDefault(kb).vehicules) {
    const moteurs = Array.isArray(v.moteurs) ? v.moteurs : [];
    const engineTerms = [...new Set(moteurs.flatMap(m => [m, withoutPower(m)]))];
    const modelHit = has(t, v.modele) || has(t, v.generation) || (v.alias || []).some(a => has(t, a));
    const engineHit = engineTerms.some(m => has(t, m)) || (v.codes_moteur || []).some(c => has(t, c));

    if (!modelHit && !engineHit) continue;
    // Une cylindrée indiquée qui ne correspond à aucun moteur de la fiche : autre motorisation, on écarte.
    const own = new Set(moteurs.flatMap(m => [...displacements(m)]));
    if (asked.size && own.size && ![...asked].some(d => own.has(d))) continue;

    let score = 0;
    if (has(t, v.marque)) score += 2;
    if (modelHit) score += 6;
    if ((v.alias || []).some(a => has(t, a)) || has(t, v.generation)) score += 2;
    if (engineHit) score += 4;
    const span = String(v.annees || "").match(/(\d{4})\D+(\d{4})/);
    if (span && years.length) score += years.some(y => y >= +span[1] && y <= +span[2]) ? 1 : -4;

    const correspondance = modelHit ? (engineHit ? "modele_moteur" : "modele") : "moteur";
    if (score > 0) results.push({ fiche: v, score, correspondance });
  }

  // Si au moins un modèle correspond, on ne garde pas les fiches qui ne partagent que le moteur.
  const byModel = results.filter(r => r.correspondance !== "moteur");
  return (byModel.length ? byModel : results).sort((a, b) => b.score - a.score).slice(0, max);
}

/* ---------- codes OBD ---------- */
// Codes OBD-II du texte (P, B, C ou U, puis 0 à 3, puis 3 caractères hexadécimaux), sans doublons, en majuscules.
export function detectCodes(text) {
  const found = String(text ?? "").toUpperCase().match(/\b[PBCU][0-3][0-9A-F]{3}\b/g) || [];
  return [...new Set(found)];
}

// Fiches des codes OBD présents dans le texte (les codes absents de la base sont ignorés).
export function findCodes(text, kb) {
  const { codes } = kbOrDefault(kb);
  return detectCodes(text).map(c => codes.get(c)).filter(Boolean);
}

/* ---------- contexte pour l'IA ---------- */
export function vehicleLabel(v) {
  const engines = [...new Set((v.moteurs || []).map(withoutPower))];
  return `${v.marque} ${v.modele}${engines.length ? " " + engines.join(" / ") : ""}`;
}

const join = a => (Array.isArray(a) && a.length ? a.join(" ; ") : "");
const km = n => (n != null && n !== "" && Number.isFinite(+n) ?`${Number(n).toLocaleString("fr-FR")} km` : "");
const GRAVITE = { faible: "faible", moyenne: "moyenne", elevee: "élevée" };

function vehicleBlock(v, correspondance) {
  const lines = [`## Fiche véhicule « ${v.id} » : ${v.marque} ${v.generation || v.modele}${v.annees ? ` (${v.annees})` : ""} [fiche ${STATUT_LABEL[statutOf(v)]}${v.mise_a_jour ? `, mise à jour ${v.mise_a_jour}` : ""}]`];
  if (correspondance === "moteur") lines.push("Attention : cette fiche concerne un autre modèle équipé du même moteur. N'utilise que les informations liées au moteur.");
  if (v.moteurs?.length) lines.push(`Moteurs : ${join(v.moteurs)}${v.codes_moteur?.length ? ` (codes moteur : ${join(v.codes_moteur)})` : ""}`);
  if (v.pannes?.length) {
    lines.push("Pannes connues :");
    for (const p of v.pannes) {
      const meta = [km(p.km_typique) && `vers ${km(p.km_typique)}`, GRAVITE[p.gravite] && `gravité ${GRAVITE[p.gravite]}`].filter(Boolean).join(", ");
      lines.push(`- ${p.titre}${meta ? ` (${meta})` : ""}.${p.symptomes ? ` Symptômes : ${p.symptomes}` : ""}${p.solution ? ` Solution : ${p.solution}` : ""}${p.cout_indicatif ? ` Coût : ${p.cout_indicatif}.` : ""}`);
    }
  }
  if (v.entretiens?.length) lines.push(`Entretiens : ${v.entretiens.map(e => `${e.titre}${km(e.km) ? ` (${km(e.km)})` : ""}${e.cout_indicatif ? `, ${e.cout_indicatif}` : ""}`).join(" ; ")}`);
  if (v.points_forts?.length) lines.push(`Points forts : ${join(v.points_forts)}`);
  if (v.points_faibles?.length) lines.push(`Points faibles : ${join(v.points_faibles)}`);
  lines.push(`Sources : ${join(v.sources) || "aucune"}`);
  return lines.join("\n");
}

function codeBlock(c) {
  return [
    `## Code ${c.code} : ${c.libelle} [fiche ${STATUT_LABEL[statutOf(c)]}]`,
    c.causes_frequentes?.length ? `Causes fréquentes : ${join(c.causes_frequentes)}` : "",
    c.verifications?.length ? `Vérifications : ${join(c.verifications)}` : ""
  ].filter(Boolean).join("\n");
}

// Assemble les fiches utiles en un bloc texte compact (au plus `max` caractères).
// Renvoie { text, sources } ; text vaut "" et sources [] si aucune fiche ne correspond.
export function buildContext({ vehicule = "", texte = "" } = {}, kb, max = MAX_CONTEXT) {
  kb = kbOrDefault(kb);
  const veh = String(vehicule ?? ""), txt = String(texte ?? "");
  let matches = findVehicle(veh, kb);
  if (!matches.length) matches = findVehicle(txt, kb);

  const detected = detectCodes(`${veh} ${txt}`);
  const codeFiches = detected.map(c => kb.codes.get(c)).filter(Boolean);
  const missing = detected.filter(c => !kb.codes.has(c));

  const parts = [
    ...matches.map(m => ({ text: vehicleBlock(m.fiche, m.correspondance), source: { type: "vehicule", id: m.fiche.id, label: vehicleLabel(m.fiche), statut: statutOf(m.fiche), correspondance: m.correspondance } })),
    ...codeFiches.map(c => ({ text: codeBlock(c), source: { type: "code", code: c.code, statut: statutOf(c) } }))
  ];
  if (!parts.length) return { text: "", sources: [] };
  if (missing.length) parts.push({ text: `Codes absents de la base Rétroviz : ${missing.join(", ")}.`, source: null });

  const sep = "\n\n", cut = "\n[… fiche tronquée]";
  let text = "";
  const sources = [];
  for (const p of parts) {
    const room = max - text.length - (text ? sep.length : 0);
    if (p.text.length <= room) {
      text += (text ? sep : "") + p.text;
      if (p.source) sources.push(p.source);
      continue;
    }
    // Pas assez de place : on tronque proprement la fiche (si ça vaut la peine) puis on s'arrête.
    if (room > 300) {
      const slice = p.text.slice(0, room - cut.length);
      const end = slice.lastIndexOf("\n");
      text += (text ? sep : "") + (end > 0 ? slice.slice(0, end) : slice) + cut;
      if (p.source) sources.push({ ...p.source, tronque: true });
    }
    break;
  }
  return { text, sources };
}
