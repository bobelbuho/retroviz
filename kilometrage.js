// Relevés de kilométrage : validation, cohérence dans le temps et moyenne par mois.

export const KM_MAX = 2_000_000;
export const MAX_RELEVES = 500;          // par voiture
export const MIN_JOURS_MOYENNE = 30;     // écart minimal entre premier et dernier relevé pour calculer une moyenne
const JOURS_PAR_MOIS = 365.25 / 12;
const DAY_MS = 86_400_000;

// Date du jour du serveur, au format AAAA-MM-JJ (heure locale).
export const today = (d = new Date()) => d.toLocaleDateString("sv-SE");

const isoDate = s => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === s ? s : null; // refuse le 31 février
};
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
export const kmText = n => `${n.toLocaleString("fr-FR")} km`;
const dateText = s => new Date(`${s}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC" });

// Date AAAA-MM-JJ, ni future ni avant 1950. Renvoie { date } ou { error }.
export function cleanDate(raw, now = today()) {
  const date = isoDate(raw ?? now);
  if (!date) return { error: "Date invalide." };
  // Un jour de marge : le navigateur peut être dans un autre fuseau horaire que le serveur.
  if (days(now, date) > 1) return { error: "La date ne peut pas être dans le futur." };
  if (date < "1950-01-01") return { error: "Date trop ancienne." };
  return { date };
}

// Date AAAA-MM-JJ, passée ou future (ex. échéance d'assurance), entre 1950 et 2100. Renvoie { date } ou { error }.
export function cleanAnyDate(raw) {
  const date = isoDate(raw);
  if (!date || date < "1950-01-01" || date > "2100-12-31") return { error: "Date invalide." };
  return { date };
}

// Kilométrage entier. Chiffres seulement, espaces acceptés (« 85 000 ») ;
// « 85.000 » ou « 85,5 » sont refusés plutôt que mal lus. Renvoie { km } ou { error }.
export function cleanKm(raw) {
  const s = typeof raw === "number" ? String(raw) : String(raw ?? "").replace(/[\s\u202f\u00a0]/g, "");
  const km = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isInteger(km) || km > KM_MAX) return { error: `Kilométrage invalide (nombre entier entre 0 et ${kmText(KM_MAX)}).` };
  return { km };
}

// Renvoie { data: { date, km } } ou { error }.
export function cleanReleve(body, now = today()) {
  const b = body && typeof body === "object" ? body : {};
  const d = cleanDate(b.date, now);
  if (d.error) return d;
  const k = cleanKm(b.km);
  if (k.error) return k;
  return { data: { date: d.date, km: k.km } };
}

// Le nouveau relevé est-il cohérent avec les autres ? Un compteur ne recule pas.
// `releves` : relevés existants ; celui de la même date est ignoré (il sera remplacé). Renvoie un message ou null.
export function incoherence(releves, { date, km }) {
  const autres = releves.filter(r => r.date !== date);
  const avant = autres.filter(r => r.date < date).sort((a, b) => b.date.localeCompare(a.date))[0];
  const apres = autres.filter(r => r.date > date).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (avant && km < avant.km) return `Ce kilométrage est inférieur à celui du ${dateText(avant.date)} (${kmText(avant.km)}).`;
  if (apres && km > apres.km) return `Ce kilométrage est supérieur à celui du ${dateText(apres.date)} (${kmText(apres.km)}).`;
  return null;
}

// Dernier relevé et moyenne de km par mois (entre le premier et le dernier relevé).
export function stats(releves) {
  if (!releves.length) return { dernier: null, moyenneMensuelle: null };
  const tri = [...releves].sort((a, b) => a.date.localeCompare(b.date));
  const premier = tri[0], dernier = tri[tri.length - 1];
  const ecart = days(premier.date, dernier.date);
  const moyenneMensuelle = ecart >= MIN_JOURS_MOYENNE
    ? Math.round((dernier.km - premier.km) / (ecart / JOURS_PAR_MOIS))
    : null;
  return { dernier: { date: dernier.date, km: dernier.km }, moyenneMensuelle };
}
