// Appels à l'API Claude pour l'Observateur : chercher des pages, extraire des faits, regrouper les faits identiques.
// Chaque appel vérifie d'abord le budget (coût maximal), puis compte le coût réel.
import { coutEur, coutMaxEur } from "./couts.js";
import { anonymiser } from "../retours.js";

export class BudgetAtteint extends Error {}

export const TYPES_FAIT = ["panne", "entretien", "point_fort", "point_faible", "cout"];

const SCHEMA_FAITS = {
  type: "object",
  properties: {
    faits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          marque: { type: "string" }, modele: { type: "string" }, generation: { type: "string" }, motorisation: { type: "string" },
          type: { type: "string", enum: TYPES_FAIT },
          contenu: { type: "string" },
          km_min: { anyOf: [{ type: "integer" }, { type: "null" }] }, km_max: { anyOf: [{ type: "integer" }, { type: "null" }] },
          cout_min: { anyOf: [{ type: "integer" }, { type: "null" }] }, cout_max: { anyOf: [{ type: "integer" }, { type: "null" }] },
        },
        required: ["marque", "modele", "generation", "motorisation", "type", "contenu", "km_min", "km_max", "cout_min", "cout_max"],
        additionalProperties: false,
      },
    },
  },
  required: ["faits"],
  additionalProperties: false,
};

const SCHEMA_GROUPES = {
  type: "object",
  properties: {
    groupes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "integer" } },
          titre: { type: "string" }, type: { type: "string", enum: TYPES_FAIT }, motorisation: { type: "string" },
        },
        required: ["ids", "titre", "type", "motorisation"],
        additionalProperties: false,
      },
    },
  },
  required: ["groupes"],
  additionalProperties: false,
};

export const CONSIGNE_EXTRACTION = `Tu extrais d'une page web des faits utiles sur une voiture d'occasion, pour une base de connaissances. Réponds uniquement avec le JSON demandé.

Règles absolues :
- Seulement des faits sur le modèle visé (et sa génération) : pannes connues, entretiens importants, points forts, points faibles, coûts de réparation. Rien d'autre.
- REFORMULE toujours en une phrase courte (25 mots au plus) avec tes propres mots. Ne recopie jamais une phrase de la page.
- Jamais de nom de personne, de pseudonyme, d'adresse, de numéro, de plaque, ni aucune donnée personnelle. Jamais de « un internaute dit que ».
- Kilométrages et coûts : des entiers (km, euros) seulement s'ils sont écrits dans la page ; sinon null. N'invente rien.
- "motorisation" : celle dont parle la page (ex. "1.2 PureTech 110"), ou "" si la page parle du modèle en général.
- Si la page ne contient rien d'utile sur ce modèle, renvoie {"faits": []}.`;

export const CONSIGNE_REGROUPEMENT = `Tu regroupes des faits sur une voiture qui disent la même chose (même panne, même entretien, même point fort ou faible), même s'ils sont formulés différemment. Un fait ne va que dans un groupe. Un fait isolé forme son propre groupe. Donne à chaque groupe un titre court, neutre et reformulé (12 mots au plus), son type, et la motorisation concernée ("" si c'est tout le modèle). Réponds uniquement avec le JSON demandé.`;

// Une phrase du fait recopiée de la page ? (8 mots consécutifs identiques ou plus)
export function recopie(contenu, page) {
  const mots = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+/g) || [];
  const m = mots(contenu);
  if (m.length < 8) return false;
  const p = ` ${mots(page).join(" ")} `;
  for (let i = 0; i + 8 <= m.length; i++) if (p.includes(` ${m.slice(i, i + 8).join(" ")} `)) return true;
  return false;
}

// client : client Anthropic (ou faux client dans les tests).
export function createIA({ client, model, budget, log = () => {} }) {
  async function appeler(params, maxEur, etape) {
    if (!budget.permet(maxEur)) throw new BudgetAtteint(`budget mensuel atteint avant l'étape « ${etape} »`);
    const r = await client.beta.messages.create({
      model, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", ...params,
    });
    const eur = coutEur(r.model || model, r.usage, budget.eurParUsd);
    budget.ajouter(eur);
    log({ type: "cout", message: `${etape} : ${eur.toFixed(4)} €` });
    if (r.stop_reason === "refusal") throw new Error(`le modèle a décliné l'étape « ${etape} »`);
    return r;
  }
  const texteDe = r => (r.content || []).filter(b => b.type === "text").map(b => b.text).join("");

  // Recherche web limitée aux domaines autorisés. Renvoie les pages trouvées [{ url, titre, date }].
  async function rechercher(question, domaines, maxRecherches = 2) {
    const r = await appeler({
      max_tokens: 2000,
      output_config: { effort: "low" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxRecherches, allowed_domains: domaines }],
      messages: [{ role: "user", content: `Fais une recherche web en français pour trouver des pages qui répondent à : « ${question} ». Cherche seulement, sans résumer : réponds simplement « fait » à la fin.` }],
    }, coutMaxEur(model, { caracteres: 30_000, maxTokens: 2000, recherches: maxRecherches }, budget.eurParUsd), `recherche « ${question} »`);
    const pages = [];
    for (const b of r.content || []) {
      if (b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue; // un objet = erreur de recherche
      for (const x of b.content) if (x.type === "web_search_result" && x.url) pages.push({ url: x.url, titre: x.title || "", date: x.page_age || "" });
    }
    return pages;
  }

  // Faits d'une page. Les faits recopiés ou vides sont écartés ; les données personnelles retirées.
  async function extraire({ texte, url, cible }) {
    const contenu = `Modèle visé : ${cible}\nAdresse de la page : ${url}\n\nTexte de la page :\n${texte}`;
    const r = await appeler({
      max_tokens: 4000,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA_FAITS } },
      system: CONSIGNE_EXTRACTION,
      messages: [{ role: "user", content: contenu }],
    }, coutMaxEur(model, { caracteres: contenu.length + CONSIGNE_EXTRACTION.length, maxTokens: 4000 }, budget.eurParUsd), `extraction ${new URL(url).hostname}`);
    let faits = [];
    try { faits = JSON.parse(texteDe(r)).faits || []; } catch { log({ type: "info", message: `réponse illisible pour ${url}` }); return []; }
    return faits
      .filter(f => TYPES_FAIT.includes(f.type) && f.contenu?.trim())
      .filter(f => { const copie = recopie(f.contenu, texte); if (copie) log({ type: "info", message: `fait écarté (recopié) : ${url}` }); return !copie; })
      .map(f => ({ ...f, contenu: anonymiser(f.contenu, 300) }));
  }

  // Regroupe les faits identiques. faits : [{ id, type, contenu, motorisation }]. Renvoie [{ ids, titre, type, motorisation }].
  async function regrouper(faits, cible) {
    if (!faits.length) return [];
    const liste = faits.map(f => ({ id: f.id, type: f.type, motorisation: f.motorisation, contenu: f.contenu }));
    const contenu = `Voiture : ${cible}\nFaits :\n${JSON.stringify(liste)}`;
    const r = await appeler({
      max_tokens: 8000,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA_GROUPES } },
      system: CONSIGNE_REGROUPEMENT,
      messages: [{ role: "user", content: contenu }],
    }, coutMaxEur(model, { caracteres: contenu.length + CONSIGNE_REGROUPEMENT.length, maxTokens: 8000 }, budget.eurParUsd), `regroupement ${cible}`);
    const ids = new Set(faits.map(f => f.id));
    let groupes = [];
    try { groupes = JSON.parse(texteDe(r)).groupes || []; } catch { groupes = []; }
    // Chaque fait dans un seul groupe ; les oubliés forment leur propre groupe.
    const vus = new Set();
    const propres = groupes.map(g => ({ ...g, ids: g.ids.filter(i => ids.has(i) && !vus.has(i) && vus.add(i)) })).filter(g => g.ids.length);
    for (const f of faits) if (!vus.has(f.id)) propres.push({ ids: [f.id], titre: f.contenu.slice(0, 90), type: f.type, motorisation: f.motorisation || "" });
    return propres;
  }

  return { rechercher, extraire, regrouper };
}
