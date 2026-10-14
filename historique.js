// Confiance dans l'historique d'une voiture : saisie après coup, modifications d'entrées anciennes,
// kilométrage suivi sans interruption (y compris d'un propriétaire à l'autre). Fonctions pures.

export const DELAI_JOURS = 30;      // au-delà : « saisi le … » et modifications gardées
export const TROU_MAX_JOURS = 183;  // plus de 6 mois sans kilométrage : le suivi est interrompu
const JOUR = 86_400_000;
const jours = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / JOUR);
const jourDe = iso => String(iso || "").slice(0, 10);

// Entrée (relevé ou entretien) ajoutée plus de 30 jours après sa date : renvoie la date de saisie, sinon null.
export function saisiLe(row) {
  const saisie = jourDe(row.created_at);
  return saisie && row.date && jours(row.date, saisie) > DELAI_JOURS ? saisie : null;
}

// Une modification est gardée si l'entrée est ancienne : sa date ET sa saisie remontent à plus de 30 jours.
// (Corriger tout de suite une faute de frappe dans un entretien saisi après coup ne compte pas.)
export function estAncienne(row, aujourdhui) {
  const plusRecente = [row.date, jourDe(row.created_at)].filter(Boolean).sort().at(-1);
  return !!plusRecente && jours(plusRecente, aujourdhui) > DELAI_JOURS;
}

// Champs comparés pour un entretien. Description et garage : on garde le fait qu'ils ont changé, pas leur texte.
const CHAMPS_VALEUR = { date: "date", km: "km", type: "type", cout_centimes: "cout" };
const CHAMPS_TEXTE = { description: "description", garage: "garage" };
export function differences(avant, apres) {
  const out = [];
  for (const [col, nom] of Object.entries(CHAMPS_VALEUR)) {
    if ((avant[col] ?? null) !== (apres[col] ?? null)) out.push({ champ: nom, avant: avant[col] ?? null, apres: apres[col] ?? null });
  }
  for (const [col, nom] of Object.entries(CHAMPS_TEXTE)) {
    if ((avant[col] || "") !== (apres[col] || "")) out.push({ champ: nom });
  }
  return out;
}

/**
 * Kilométrage suivi sans interruption : la dernière période sans trou de plus de 6 mois entre deux kilométrages connus.
 * points [{date, km}] (relevés et entretiens), transferts [AAAA-MM-JJ] : dates de changement de propriétaire.
 * Renvoie { de: {date, km}, a: {date, km}, mois, proprietaires } ou null (moins de 2 points).
 */
export function continuite(points, transferts = []) {
  const p = [...points].filter(x => x.km != null).sort((a, b) => a.date.localeCompare(b.date) || a.km - b.km);
  if (p.length < 2) return null;
  let debut = p.length - 1;
  while (debut > 0 && jours(p[debut - 1].date, p[debut].date) <= TROU_MAX_JOURS) debut--;
  const de = p[debut], a = p.at(-1);
  if (de.date === a.date) return null;
  const proprietaires = 1 + transferts.filter(t => t > de.date && t <= a.date).length;
  return { de: { date: de.date, km: de.km }, a: { date: a.date, km: a.km }, mois: Math.round(jours(de.date, a.date) / (365.25 / 12)), proprietaires };
}

// Résumé pour le dossier : « 3 entretiens saisis après coup, dont 2 avec facture ».
export function resumeSaisie(entretiens, releves) {
  const ent = entretiens.filter(e => saisiLe(e));
  return {
    entretiens: ent.length,
    entretiensAvecFacture: ent.filter(e => e.facture_key).length,
    releves: releves.filter(r => saisiLe(r)).length,
  };
}
