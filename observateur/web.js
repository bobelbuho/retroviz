// Accès poli au web pour l'Observateur : robots.txt, refus d'analyse automatisée, limite de requêtes par site,
// pages derrière une connexion ou un abonnement écartées, texte brut extrait du HTML.

export const USER_AGENT = "RetrovizObservateur/0.1 (+outil de veille de la base Rétroviz ; respecte robots.txt)";
const NOTRE_ROBOT = "retrovizobservateur";
// Robots d'IA : un site qui leur interdit tout signale qu'il refuse l'analyse automatisée par l'IA. On respecte ce refus.
export const ROBOTS_IA = ["claudebot", "claude-user", "claude-searchbot", "anthropic-ai", "gptbot", "chatgpt-user", "oai-searchbot", "ccbot", "google-extended", "perplexitybot", "bytespider", "applebot-extended"];

/* ---------- robots.txt ---------- */
// Découpe un robots.txt en groupes { agents: [...], regles: [[allow|disallow, chemin]] }.
export function parseRobots(texte) {
  const groupes = [];
  let cur = null, dernierEstAgent = false;
  for (const ligne of String(texte || "").split(/\r?\n/)) {
    const l = ligne.replace(/#.*/, "").trim();
    const m = l.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") {
      if (!dernierEstAgent) { cur = { agents: [], regles: [] }; groupes.push(cur); }
      cur.agents.push(v.toLowerCase());
      dernierEstAgent = true;
    } else {
      dernierEstAgent = false;
      if (cur && (k === "allow" || k === "disallow")) cur.regles.push([k, v]);
    }
  }
  return groupes;
}

// Le chemin correspond-il à la règle ? (* = n'importe quoi, $ = fin)
function correspond(regle, chemin) {
  if (!regle) return false;
  const re = new RegExp("^" + regle.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
  return re.test(chemin);
}

// Autorisé pour notre robot ? Groupe le plus précis (le nôtre, sinon « * ») ; la règle la plus longue l'emporte, « allow » à égalité.
export function robotsAutorise(groupes, chemin) {
  const groupe = groupes.find(g => g.agents.some(a => a && NOTRE_ROBOT.startsWith(a.replace(/\*$/, "")) && a !== "*"))
    || groupes.find(g => g.agents.includes("*"));
  if (!groupe) return true;
  let meilleure = null;
  for (const [type, regle] of groupe.regles) {
    if (type === "disallow" && regle === "") continue; // « Disallow: » vide = tout autorisé
    if (!correspond(regle, chemin)) continue;
    if (!meilleure || regle.length > meilleure[1].length || (regle.length === meilleure[1].length && type === "allow")) meilleure = [type, regle];
  }
  return !meilleure || meilleure[0] === "allow";
}

// Le site refuse-t-il les robots d'IA (Disallow: / pour l'un d'eux) ? Renvoie la liste des robots refusés.
export function refusIA(groupes) {
  return ROBOTS_IA.filter(ia => groupes.some(g => g.agents.includes(ia) && g.regles.some(([t, r]) => t === "disallow" && r === "/")));
}

/* ---------- pages ---------- */
// Signes d'une page derrière une connexion ou un abonnement.
const PAYWALL = [/réservé aux abonnés/i, /reserve aux abonnes/i, /abonnez-vous pour (lire|continuer|accéder)/i, /article réservé/i,
  /contenu réservé/i, /"isAccessibleForFree"\s*:\s*"?false"?/i, /connectez-vous pour (lire|voir|accéder)/i, /pour lire la suite/i];
export function pageFermee(html, url) {
  if (/\/(login|connexion|signin|sign-in|account|compte|abonnement|subscribe)\b/i.test(new URL(url).pathname)) return "page de connexion ou d'abonnement";
  if (/<input[^>]+type=["']?password/i.test(html)) return "formulaire de connexion";
  const p = PAYWALL.find(re => re.test(html));
  return p ? "contenu réservé aux abonnés" : null;
}

// Refus d'analyse automatisée dans la page : en-tête « tdm-reservation: 1 » ou « X-Robots-Tag: noai »,
// <meta name="tdm-reservation" content="1">, <meta name="robots" content="noai">.
export function refusDansLaPage(html, entetes = {}) {
  const get = k => String(entetes[k.toLowerCase()] ?? "").toLowerCase();
  if (get("tdm-reservation").trim() === "1") return "en-tête tdm-reservation";
  if (/\bnoai\b/.test(get("x-robots-tag"))) return "en-tête X-Robots-Tag noai";
  for (const [m] of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const nom = (m.match(/name\s*=\s*["']?([^"'\s>]+)/i) || [])[1]?.toLowerCase();
    const contenu = ((m.match(/content\s*=\s*["']([^"']*)["']/i) || m.match(/content\s*=\s*([^\s>]+)/i) || [])[1] || "").toLowerCase();
    if (nom === "tdm-reservation" && contenu.trim() === "1") return "balise tdm-reservation";
    if ((nom === "robots" || nom === "retrovizobservateur") && /\bnoai\b/.test(contenu)) return "balise robots noai";
  }
  return null;
}

// Fichier TDMRep du site (/.well-known/tdmrep.json) : la page est-elle réservée ?
export function tdmrepReserve(regles, chemin) {
  if (!Array.isArray(regles)) return false;
  return regles.some(r => r && String(r["tdm-reservation"]) === "1" && correspond(String(r.location || "/*").replace(/^(?!\/)/, "/"), chemin));
}

// HTML -> texte lisible (sans scripts, styles, menus ni pieds de page), limité en taille.
export function htmlEnTexte(html, max = 40_000) {
  const ent = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", ecirc: "ê", ocirc: "ô", ucirc: "û", icirc: "î", euro: "€" };
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|p|div|li|h[1-6]|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ent[n.toLowerCase()] ?? m)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/* ---------- client poli ---------- */
// fetchImpl : fetch (ou une fausse version dans les tests). sources : registre data/sources.json.
export function createWeb({ sources = [], fetchImpl = fetch, now = () => Date.now(), attendre = ms => new Promise(r => setTimeout(r, ms)), log = () => {} } = {}) {
  const robotsCache = new Map(); // hôte -> { groupes } ou { erreur }
  const tdmCache = new Map();    // hôte -> règles TDMRep (ou null)
  const derniersAppels = new Map(); // hôte -> horodatage du dernier appel
  const sourceDe = hote => sources.find(s => (s.domaines || []).includes(hote));

  async function patienter(hote) {
    const limite = sourceDe(hote)?.limite_par_minute || 6;
    const intervalle = 60_000 / limite;
    const dernier = derniersAppels.get(hote) || 0;
    const reste = dernier + intervalle - now();
    if (reste > 0) await attendre(reste);
    derniersAppels.set(hote, now());
  }

  async function brut(url, { accept = "text/html", max = 3_000_000 } = {}) {
    const hote = new URL(url).hostname;
    await patienter(hote);
    const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: accept, "Accept-Language": "fr-FR,fr;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    const entetes = Object.fromEntries([...res.headers.entries()]);
    const longueur = Number(entetes["content-length"] || 0);
    if (longueur > max) return { status: 413, entetes, texte: "" };
    const texte = (await res.text()).slice(0, max);
    return { status: res.status, entetes, texte, urlFinale: res.url || url };
  }

  async function robots(hote) {
    if (robotsCache.has(hote)) return robotsCache.get(hote);
    let r;
    try {
      const rep = await brut(`https://${hote}/robots.txt`, { accept: "text/plain" });
      if (rep.status === 404 || rep.status === 410) r = { groupes: [] };          // pas de robots.txt : tout est permis
      else if (rep.status >= 400) r = { erreur: `robots.txt inaccessible (${rep.status})` }; // prudence : on s'abstient
      else r = { groupes: parseRobots(rep.texte) };
    } catch (e) { r = { erreur: `robots.txt inaccessible (${e.cause?.code || e.name})` }; }
    robotsCache.set(hote, r);
    return r;
  }

  async function tdmrep(hote) {
    if (tdmCache.has(hote)) return tdmCache.get(hote);
    let regles = null;
    try {
      const rep = await brut(`https://${hote}/.well-known/tdmrep.json`, { accept: "application/json", max: 200_000 });
      if (rep.status === 200) regles = JSON.parse(rep.texte);
    } catch { regles = null; }
    tdmCache.set(hote, regles);
    return regles;
  }

  // Le site permet-il de lire cette page ? Renvoie null si oui, sinon la raison du refus.
  async function refus(url) {
    let u;
    try { u = new URL(url); } catch { return "adresse invalide"; }
    if (u.protocol !== "https:") return "adresse non sécurisée";
    const source = sourceDe(u.hostname);
    if (!source) return "site absent du registre des sources";
    if (!source.autorisee) return `site non autorisé dans le registre (${source.note || "sans motif"})`;
    const r = await robots(u.hostname);
    if (r.erreur) return r.erreur;
    const ia = refusIA(r.groupes);
    if (ia.length) return `le site refuse les robots d'IA (${ia.slice(0, 3).join(", ")})`;
    if (!robotsAutorise(r.groupes, u.pathname + u.search)) return "interdit par robots.txt";
    if (tdmrepReserve(await tdmrep(u.hostname), u.pathname)) return "refus d'analyse automatisée (TDMRep)";
    return null;
  }

  // Lit une page autorisée et renvoie { texte } ou { refus }.
  async function lirePage(url) {
    const raison = await refus(url);
    if (raison) return { refus: raison };
    let rep;
    try { rep = await brut(url); } catch (e) { return { refus: `page inaccessible (${e.cause?.code || e.name})` }; }
    if (rep.status === 401 || rep.status === 402 || rep.status === 403) return { refus: `accès refusé (${rep.status})` };
    if (rep.status >= 400) return { refus: `page inaccessible (${rep.status})` };
    if (rep.urlFinale && new URL(rep.urlFinale).hostname !== new URL(url).hostname) {
      const r2 = await refus(rep.urlFinale);
      if (r2) return { refus: `redirection vers un site non autorisé (${r2})` };
    }
    const tdm = refusDansLaPage(rep.texte, rep.entetes);
    if (tdm) return { refus: `refus d'analyse automatisée (${tdm})` };
    const fermee = pageFermee(rep.texte, rep.urlFinale || url);
    if (fermee) return { refus: fermee };
    const texte = htmlEnTexte(rep.texte);
    if (texte.length < 300) return { refus: "page presque vide" };
    return { texte, url: rep.urlFinale || url };
  }

  // Appel d'API officielle (JSON ou XML), avec la même limite de requêtes par site.
  async function api(url, accept = "application/json") {
    const rep = await brut(url, { accept, max: 10_000_000 });
    if (rep.status >= 400) throw new Error(`${new URL(url).hostname} : erreur ${rep.status}`);
    return rep.texte;
  }

  return { lirePage, refus, api, sourceDe };
}
