// Glossaire : souligne les termes connus dans un texte (réponses de l'assistant, fiches) ;
// un clic ou Entrée affiche la définition. Chaque terme n'est souligné qu'une fois par bloc, pour ne pas surcharger.
(function () {
  let termes = [], parId = new Map(), motif = null, parMot = new Map();
  const IGNORES = new Set(["A", "BUTTON", "CODE", "H1", "H2", "H3", "H4", "INPUT", "TEXTAREA", "SELECT", "SUMMARY", "LABEL", "svg", "SVG"]);
  const echap = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function charger(liste) {
    termes = liste; parId = new Map(liste.map(t => [t.id, t])); parMot = new Map();
    for (const t of liste) for (const m of [t.terme, ...t.variantes]) {
      const mot = m.replace(/\s*\(.*\)\s*$/, "").trim(); // « FAP (filtre à particules) » : « FAP »
      if (mot.length >= 2) parMot.set(mot.toLowerCase(), t.id);
    }
    const mots = [...parMot.keys()].sort((a, b) => b.length - a.length).map(echap);
    // Mot entier : ni lettre ni chiffre juste avant ou après (accents compris).
    motif = mots.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${mots.join("|")})(?![\\p{L}\\p{N}])`, "giu") : null;
  }

  // Souligne les termes dans un élément déjà affiché. Renvoie le nombre de termes soulignés.
  function marquer(racine) {
    if (!motif || !racine) return 0;
    const vus = new Set([...racine.querySelectorAll(".gloss")].map(b => b.dataset.g));
    const textes = [];
    const w = document.createTreeWalker(racine, NodeFilter.SHOW_TEXT, {
      acceptNode: n => {
        for (let p = n.parentElement; p && p !== racine.parentElement; p = p.parentElement) if (IGNORES.has(p.tagName) || p.classList.contains("gloss") || p.classList.contains("sans-glossaire")) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.trim().length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (w.nextNode()) textes.push(w.currentNode);
    let n = 0;
    for (const noeud of textes) {
      const s = noeud.nodeValue;
      motif.lastIndex = 0;
      let m, dernier = 0;
      const frag = document.createDocumentFragment();
      while ((m = motif.exec(s))) {
        const id = parMot.get(m[1].toLowerCase());
        if (!id || vus.has(id)) continue;
        vus.add(id); n++;
        frag.append(s.slice(dernier, m.index));
        const b = document.createElement("button");
        b.type = "button"; b.className = "gloss"; b.dataset.g = id; b.textContent = m[1];
        b.setAttribute("aria-expanded", "false"); b.title = "Définition";
        frag.append(b);
        dernier = m.index + m[1].length;
      }
      if (dernier) { frag.append(s.slice(dernier)); noeud.replaceWith(frag); }
    }
    return n;
  }

  /* ---------- fenêtre de définition ---------- */
  let ouvert = null;
  const pop = document.createElement("div");
  pop.className = "glosspop"; pop.id = "glossPop"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-modal", "false"); pop.hidden = true;
  function fermer(rendreFocus = true) {
    if (!ouvert) return;
    pop.hidden = true; ouvert.setAttribute("aria-expanded", "false");
    if (rendreFocus) ouvert.focus();
    ouvert = null;
  }
  function ouvrir(b) {
    const t = parId.get(b.dataset.g); if (!t) return;
    if (ouvert) fermer(false);
    if (!pop.isConnected) document.body.append(pop);
    pop.innerHTML = "";
    const h = document.createElement("strong"); h.textContent = t.terme; h.id = "glossTitre";
    const p = document.createElement("p"); p.textContent = t.definition;
    const pied = document.createElement("div"); pied.className = "glosspied";
    const tout = document.createElement("button"); tout.type = "button"; tout.className = "link"; tout.textContent = "Tout le glossaire"; tout.dataset.glossaireTout = t.id;
    const x = document.createElement("button"); x.type = "button"; x.className = "link"; x.textContent = "Fermer"; x.dataset.glossFermer = "1";
    pied.append(tout, x);
    pop.append(h, p, pied);
    if (t.statut !== "verifie") { const v = document.createElement("small"); v.textContent = "Définition en cours de vérification."; pop.append(v); }
    pop.setAttribute("aria-labelledby", "glossTitre");
    pop.hidden = false; b.setAttribute("aria-expanded", "true"); ouvert = b;
    // Sous le terme, sans sortir de l'écran.
    const r = b.getBoundingClientRect(), largeur = Math.min(320, window.innerWidth - 32);
    pop.style.width = largeur + "px";
    pop.style.left = Math.max(16, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - largeur - 16)) + "px";
    pop.style.top = (r.bottom + window.scrollY + 6) + "px";
    x.focus();
  }
  document.addEventListener("click", e => {
    const b = e.target.closest(".gloss");
    if (b) { e.preventDefault(); return ouvert === b ? fermer() : ouvrir(b); }
    if (e.target.closest("[data-gloss-fermer]")) return fermer();
    const tout = e.target.closest("[data-glossaire-tout]");
    if (tout) { const id = tout.dataset.glossaireTout; fermer(false); window.dispatchEvent(new CustomEvent("glossaire:tout", { detail: id })); return; }
    if (ouvert && !e.target.closest(".glosspop")) fermer(false);
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && ouvert) fermer(); });

  window.Glossaire = { charger, marquer, fermer, terme: id => parId.get(id), termes: () => termes };
})();
