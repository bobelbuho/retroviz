// Coûts de l'Observateur : prix des appels à l'API Claude, conversion en euros, budget mensuel (OBSERVER_BUDGET_EUR).

// Prix publics en dollars par million de jetons [entrée, sortie]. Recherche web : 10 $ pour 1 000 recherches.
export const PRIX_USD = {
  "claude-fable-5-1": [10, 50], "claude-opus-5-5": [4, 20], "claude-opus-5": [5, 25],
  "claude-sonnet-5-5": [2, 10], "claude-sonnet-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5],
};
export const PRIX_RECHERCHE_USD = 0.01;

// Coût en euros d'une réponse de l'API (usage renvoyé par l'API). Modèle inconnu : prix le plus élevé, par prudence.
export function coutEur(model, usage = {}, eurParUsd = 0.92) {
  const [pe, ps] = PRIX_USD[model] || [10, 50];
  const lecture = usage.cache_read_input_tokens || 0, ecriture = usage.cache_creation_input_tokens || 0;
  const usd = ((usage.input_tokens || 0) * pe + lecture * pe * 0.1 + ecriture * pe * 1.25 + (usage.output_tokens || 0) * ps) / 1e6
    + (usage.server_tool_use?.web_search_requests || 0) * PRIX_RECHERCHE_USD;
  return usd * eurParUsd;
}

// Coût maximal d'un appel avant de le lancer (entrée estimée d'après la longueur du texte, sortie au maximum).
export function coutMaxEur(model, { caracteres = 0, maxTokens = 4000, recherches = 0 }, eurParUsd = 0.92) {
  return coutEur(model, { input_tokens: Math.ceil(caracteres / 3), output_tokens: maxTokens, server_tool_use: { web_search_requests: recherches } }, eurParUsd);
}

// Budget : dépense du mois (passages précédents + passage en cours). `depenseDuMois()` lit la base.
export function createBudget({ budgetEur, depenseDuMois, eurParUsd = 0.92 }) {
  let passage = 0;
  return {
    eurParUsd,
    get passage() { return passage; },
    restant() { return budgetEur - depenseDuMois() - passage; },
    // Peut-on lancer un appel qui coûtera au plus `maxEur` ?
    permet(maxEur) { return budgetEur > 0 && this.restant() >= maxEur; },
    ajouter(eur) { passage += eur; },
  };
}
