// « À venir » : rappels (contrôle technique, assurance, vidange, pneus hiver, rappels libres) et prochains
// entretiens d'une voiture, calculés à partir de sa fiche Rétroviz, de son carnet et de ses relevés.
// computeAvenir est une fonction pure (aucune base de données) : c'est elle que les tests vérifient.
import { normalize } from "./knowledge.js";

export const BIENTOT_JOURS = 30;
export const BIENTOT_KM = 1000;
export const VIDANGE_DEFAUT = { km: 15000, mois: 12 };
const JOURS_PAR_MOIS = 365.25 / 12;

/* ---------- dates (AAAA-MM-JJ, calculées en UTC pour éviter les décalages d'heure d'été) ---------- */
const toDate = s => new Date(`${s}T00:00:00Z`);
const toIso = d => d.toISOString().slice(0, 10);
const fr = iso => toDate(iso).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
export const diffDays = (from, to) => Math.round((toDate(to) - toDate(from)) / 86_400_000);
// Ajoute des mois en restant dans le mois visé (31 janvier + 1 mois = 28 ou 29 février).
export function addMonths(iso, n) {
  const d = toDate(iso), day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return toIso(d);
}
export const addYears = (iso, n) => addMonths(iso, 12 * n);

/* ---------- kilométrage ---------- */
// Kilométrage estimé aujourd'hui : dernier relevé + moyenne mensuelle × temps écoulé depuis.
export function kmAujourdhui(kilometrage, today) {
  const { dernier, moyenneMensuelle } = kilometrage || {};
  if (!dernier) return null;
  if (!moyenneMensuelle) return dernier.km;
  return Math.round(dernier.km + moyenneMensuelle * Math.max(0, diffDays(dernier.date, today)) / JOURS_PAR_MOIS);
}
// Date à laquelle un kilométrage sera atteint, d'après la moyenne (null si on ne peut pas l'estimer).
function dateForKm(km, kmNow, moyenne, today) {
  if (kmNow === null || !moyenne || moyenne <= 0) return null;
  const jours = Math.round(((km - kmNow) / moyenne) * JOURS_PAR_MOIS);
  const d = toDate(today);
  d.setUTCDate(d.getUTCDate() + jours);
  return toIso(d);
}
// Kilométrage à une date passée, par interpolation entre deux relevés (null si hors de la période connue).
function kmAt(date, releves) {
  const tri = [...releves].sort((a, b) => a.date.localeCompare(b.date));
  const exact = tri.find(r => r.date === date);
  if (exact) return exact.km;
  const avant = tri.filter(r => r.date < date).at(-1), apres = tri.find(r => r.date > date);
  if (!avant || !apres) return null;
  return Math.round(avant.km + (apres.km - avant.km) * diffDays(avant.date, date) / diffDays(avant.date, apres.date));
}

/* ---------- statut ---------- */
// retard / bientot / plus_tard, d'après la date et/ou le kilométrage d'échéance (le plus urgent des deux l'emporte).
function statut({ jours, kmRestants }) {
  if ((jours !== null && jours < 0) || (kmRestants !== null && kmRestants < 0)) return "retard";
  if ((jours !== null && jours < BIENTOT_JOURS) || (kmRestants !== null && kmRestants < BIENTOT_KM)) return "bientot";
  return "plus_tard";
}
const RANG = { retard: 0, bientot: 1, verifier: 2, plus_tard: 3, surveiller: 3, inconnu: 4 };

// Construit un élément : échéance (date et/ou km), jours et km restants, statut.
function item(base, { date = null, km = null, kmNow, moyenne, today, dateEstimee = false, statutForce = null }) {
  let d = date, estimee = dateEstimee;
  if (!d && km !== null) { d = dateForKm(km, kmNow, moyenne, today); estimee = d !== null; }
  const jours = d ? diffDays(today, d) : null;
  const kmRestants = km !== null && kmNow !== null ? km - kmNow : null;
  const s = statutForce || (jours === null && kmRestants === null ? "inconnu" : statut({ jours, kmRestants }));
  return { ...base, statut: s, date: d, dateEstimee: estimee, km, joursRestants: jours, kmRestants };
}

/* ---------- entretiens de la fiche ↔ carnet ---------- */
const STOP = new Set(["avec", "selon", "intervalle", "confirmer", "constructeur", "version", "versions"]);
// Ce que désigne un entretien de la fiche : type du carnet correspondant et/ou mot-clé à chercher dans la description.
export function kindOf(titre) {
  const n = normalize(titre);
  if (/\bvidange\b/.test(n) && !/\bboite\b/.test(n)) return { type: "vidange", motCle: "vidange" };
  if (/\bdistribution\b/.test(n)) return { type: "distribution", motCle: "distribution" };
  if (/\bboite\b/.test(n)) return { type: null, motCle: "boite" };
  const motCle = n.split(" ").find(w => w.length >= 5 && !STOP.has(w)) || n.split(" ")[0];
  return { type: null, motCle };
}
const matches = (e, kind) => (kind.type && e.type === kind.type) || normalize(e.description).includes(kind.motCle);
const dernier = list => [...list].sort((a, b) => b.date.localeCompare(a.date))[0] || null;

/* ---------- calcul principal ---------- */
// vehicle : { mise_en_circulation, assurance_echeance, pneus_hiver, vidange_km, vidange_mois }
// fiche : fiche de data/vehicules.json reliée, ou null. releves : [{date, km}]. entretiens : lignes du carnet.
// kilometrage : { dernier, moyenneMensuelle }. rappels : rappels libres [{id, titre, date, km}].
export function computeAvenir({ vehicle, fiche = null, releves = [], entretiens = [], kilometrage = {}, rappels = [], today }) {
  const kmNow = kmAujourdhui(kilometrage, today);
  const moyenne = kilometrage?.moyenneMensuelle ?? null;
  const ctx = { kmNow, moyenne, today };
  const items = [];

  /* Contrôle technique : avant les 4 ans, puis tous les 2 ans. Le dernier contrôle connu (carnet ou champ
     « Date du dernier contrôle technique » de la voiture, le plus récent des deux) rend le calcul exact. */
  const ctCarnet = dernier(entretiens.filter(e => e.type === "controle_technique"));
  const ctChamp = vehicle.dernier_ct || null;
  const refCT = ctCarnet && (!ctChamp || ctCarnet.date >= ctChamp) ? { date: ctCarnet.date, source: "carnet" } : ctChamp ? { date: ctChamp, source: "vehicule" } : null;
  const mec = vehicle.mise_en_circulation || null;
  const noteCT = "Estimation : vérifiez la date sur votre dernier procès-verbal (après une contre-visite, l'échéance peut différer).";
  const faitCT = { type: "controle_technique", description: "" };
  const ct = { cle: "ct", categorie: "rappel", titre: "Contrôle technique", note: noteCT, fait: faitCT, aCompleter: null, aCompleterTexte: null };
  if (refCT) {
    const texte = `2 ans après votre dernier contrôle (${fr(refCT.date)}${refCT.source === "carnet" ? ", noté dans le carnet" : ""}).`;
    items.push(item({ ...ct, texte }, { ...ctx, date: addYears(refCT.date, 2) }));
  } else if (mec) {
    let due = addYears(mec, 4), texte = "Premier contrôle : avant les 4 ans de la voiture.", extra = {};
    // Plus de 4 ans et aucun contrôle connu : on suppose les contrôles faits à temps, tous les 2 ans.
    if (due < today) {
      while (due < today) due = addYears(due, 2);
      texte = "Tous les 2 ans, en supposant les contrôles précédents faits à temps.";
      extra = { aCompleter: "dernier_ct", aCompleterTexte: "À compléter : indiquez la date de votre dernier contrôle technique pour un rappel exact." };
    }
    items.push(item({ ...ct, texte, ...extra }, { ...ctx, date: due }));
  } else {
    items.push(item({ ...ct, note: null, aCompleter: "vehicule",
      texte: "Ajoutez la date de première mise en circulation (case B de la carte grise) ou celle de votre dernier contrôle technique." },
      { ...ctx, statutForce: "inconnu" }));
  }

  /* Assurance : renouvelée chaque année à la date d'échéance. */
  if (vehicle.assurance_echeance) {
    let due = vehicle.assurance_echeance;
    while (due < today) due = addYears(due, 1);
    items.push(item({ cle: "assurance", categorie: "rappel", titre: "Échéance de l'assurance", texte: "Renouvelée chaque année. C'est le moment de comparer les offres.", note: null, fait: null, aCompleter: null }, { ...ctx, date: due }));
  }

  /* Vidange : intervalle en km et en mois ; la prochaine part de la dernière vidange du carnet. */
  const ficheVidange = (fiche?.entretiens || []).find(f => kindOf(f.titre).type === "vidange");
  const intervalle = {
    km: vehicle.vidange_km || ficheVidange?.km || VIDANGE_DEFAUT.km,
    mois: vehicle.vidange_mois || VIDANGE_DEFAUT.mois,
    source: vehicle.vidange_km ? "vous" : ficheVidange ? "fiche" : "defaut",
  };
  const derniereVidange = dernier(entretiens.filter(e => e.type === "vidange"));
  const intervalleTxt = `Tous les ${intervalle.km.toLocaleString("fr-FR")} km ou ${intervalle.mois} mois${intervalle.source === "fiche" ? " (d'après la fiche Rétroviz)" : intervalle.source === "defaut" ? " (valeur par défaut, modifiable)" : ""}, au premier des deux atteint.`;
  const faitVidange = { type: "vidange", description: "" };
  if (derniereVidange) {
    const kmBase = derniereVidange.km ?? kmAt(derniereVidange.date, releves);
    const dueDate = addMonths(derniereVidange.date, intervalle.mois);
    const dueKm = kmBase !== null ? kmBase + intervalle.km : null;
    const it = item({ cle: "vidange", categorie: "rappel", titre: "Vidange", texte: intervalleTxt, note: null, fait: faitVidange, intervalle }, { ...ctx, date: dueDate, km: dueKm });
    // La date d'échéance est certaine ; le km peut arriver avant : le statut tient compte des deux.
    items.push(it);
  } else {
    items.push(item({ cle: "vidange", categorie: "rappel", titre: "Vidange", texte: `${intervalleTxt} Notez votre dernière vidange dans le carnet pour calculer la prochaine.`, note: null, fait: faitVidange, intervalle, aCompleter: "carnet" },
      { ...ctx, statutForce: "inconnu" }));
  }

  /* Pneus hiver : monter avant le 1er novembre, démonter après le 31 mars. */
  if (vehicle.pneus_hiver) {
    const y = Number(today.slice(0, 4)), md = today.slice(5);
    const hiver = md >= "11-01" || md <= "03-31";
    const loi = "Loi Montagne : dans les communes désignées par arrêté préfectoral (48 départements de massifs), pneus hiver ou chaînes ou chaussettes dans le coffre sont obligatoires du 1er novembre au 31 mars.";
    items.push(hiver
      ? item({ cle: "pneus-hiver", categorie: "rappel", titre: "Démonter les pneus hiver", texte: "À partir du 1er avril.", note: loi, fait: { type: "pneus", description: "Démontage des pneus hiver" } },
          { ...ctx, date: `${md >= "11-01" ? y + 1 : y}-04-01` })
      : item({ cle: "pneus-hiver", categorie: "rappel", titre: "Monter les pneus hiver", texte: "Avant le 1er novembre.", note: loi, fait: { type: "pneus", description: "Montage des pneus hiver" } },
          { ...ctx, date: `${y}-11-01` }));
  }

  /* Rappels libres. */
  for (const r of rappels) {
    items.push(item({ cle: `libre-${r.id}`, categorie: "rappel", titre: r.titre, texte: "", note: null, fait: { type: "autre", description: r.titre }, rappelId: r.id },
      { ...ctx, date: r.date || null, km: r.km ?? null }));
  }

  /* Prochains entretiens de la fiche (hors vidange, traitée ci-dessus). */
  (fiche?.entretiens || []).forEach((f, i) => {
    const kind = kindOf(f.titre);
    if (kind.type === "vidange" || !Number.isFinite(f.km) || f.km <= 0) return;
    const base = { cle: `entretien-${i}`, categorie: "entretien", titre: f.titre, note: f.cout_indicatif ? `Coût indicatif : ${f.cout_indicatif}.` : null,
      fait: { type: kind.type || (kind.motCle === "pneus" ? "pneus" : "reparation"), description: f.titre.replace(/\s*\(.*\)\s*$/, "") } };
    const fait = dernier(entretiens.filter(e => matches(e, kind)));
    const every = `Tous les ${f.km.toLocaleString("fr-FR")} km environ, d'après la fiche Rétroviz.`;
    if (fait) {
      const kmBase = fait.km ?? kmAt(fait.date, releves);
      if (kmBase === null) {
        items.push(item({ ...base, texte: `${every} Le kilométrage du dernier (${fr(fait.date)}) n'est pas connu.` }, { ...ctx, statutForce: "inconnu" }));
      } else {
        items.push(item({ ...base, texte: `${every} Dernier fait d'après le carnet : ${kmBase.toLocaleString("fr-FR")} km.` }, { ...ctx, km: kmBase + f.km }));
      }
    } else if (kmNow !== null && kmNow >= f.km) {
      // Dépassé sans trace dans le carnet : peut-être fait par un ancien propriétaire.
      items.push(item({ ...base, texte: `${every} Rien dans le carnet : vérifiez sur les factures s'il a déjà été fait, puis notez-le dans le carnet.` },
        { ...ctx, km: f.km, statutForce: "verifier" }));
    } else {
      items.push(item({ ...base, texte: every }, { ...ctx, km: f.km }));
    }
  });

  /* Pannes connues de la fiche : à surveiller, pas certaines. */
  (fiche?.pannes || []).forEach((p, i) => {
    if (!Number.isFinite(p.km_typique)) return;
    const atteinte = kmNow !== null && kmNow >= p.km_typique;
    items.push(item({
      cle: `panne-${i}`, categorie: "surveiller", titre: p.titre, gravite: p.gravite || null, fait: null,
      texte: atteinte
        ? `Panne connue sur ce modèle, souvent vers ${p.km_typique.toLocaleString("fr-FR")} km : la voiture est dans cette zone. Ce n'est pas certain, soyez attentif aux signes.`
        : `Panne connue sur ce modèle, souvent vers ${p.km_typique.toLocaleString("fr-FR")} km. Ce n'est pas certain.`,
      note: p.symptomes ? `Signes : ${p.symptomes}` : null,
    }, { ...ctx, km: p.km_typique, statutForce: "surveiller" }));
  });

  /* Tri : du plus urgent au plus lointain. */
  // Horizon en jours ; sans date estimable, 1 000 km ≈ 1 mois ; sans rien, tout à la fin.
  const horizon = it => it.joursRestants ?? (it.kmRestants !== null ? Math.round(it.kmRestants / BIENTOT_KM * 30) : 1e9);
  items.sort((a, b) => RANG[a.statut] - RANG[b.statut] || horizon(a) - horizon(b));

  const plusUrgent = items.find(it => ["retard", "bientot", "verifier", "plus_tard"].includes(it.statut)) || null;
  return { kmAujourdhui: kmNow, moyenneMensuelle: moyenne, items, plusUrgent, enRetard: items.filter(it => it.statut === "retard").length };
}
