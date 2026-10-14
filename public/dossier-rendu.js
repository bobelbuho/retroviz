// Rendu du dossier d'une voiture. Le même code sert à la page publique (dossier.html) et à l'aperçu
// que voit le propriétaire avant de créer un lien : il voit exactement ce que verra le visiteur.
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtNum = n => Number(n).toLocaleString("fr-FR");
  const fmtDate = d => new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const fmtShort = d => new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
  const fmtMois = ym => new Date(ym + "-01T00:00:00").toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  const fmtEur = n => Number(n).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
  const fmtEur0 = n => Number(n).toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const STATUT = { retard: "En retard", bientot: "Bientôt", plus_tard: "Plus tard", inconnu: "À préciser", verifier: "À vérifier" };
  const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;

  // Niveau de confiance d'une entrée : preuve, saisie après coup, modification, historique reçu.
  function confianceHTML(e) {
    const t = [];
    if (e.preuve === "facture") {
      if (e.facture) t.push(`<a class="mention ok" href="${esc(e.facture)}" target="_blank" rel="noopener">avec facture${e.factureMasquee ? " (masquée)" : ""}</a>`);
      else t.push(`<span class="mention ok" title="Le propriétaire a joint une facture mais ne la montre pas dans ce dossier">avec facture (non montrée)</span>`);
    } else if (e.preuve === "declare") t.push(`<span class="mention">déclaré</span>`);
    if (e.saisiLe) t.push(`<span class="mention attention">saisi le ${esc(fmtShort(e.saisiLe))}</span>`);
    if (e.modifieLe) t.push(`<span class="mention attention">modifié le ${esc(fmtShort(e.modifieLe))}</span>`);
    if (e.recu) t.push(`<span class="mention">propriétaire précédent</span>`);
    return t.join("");
  }
  function notesHTML(notes = []) {
    return notes.length ? `<ul class="notes">${notes.map(n => `<li><strong>Note du ${esc(fmtShort(n.le))}</strong> : ${esc(n.texte)}</li>`).join("")}</ul>` : "";
  }

  // Frise : réutilisée aussi dans la page de vie (Rétroviz), d'où l'option « liens » pour les notes.
  function friseHTML(evenements, { noteBtn = false } = {}) {
    let annee = "";
    return evenements.map(e => {
      const a = e.date.slice(0, 4), entete = a !== annee ? `<li class="annee" aria-hidden="true">${a}</li>` : "";
      annee = a;
      const det = [e.detail && esc(e.detail), e.km != null && !["releve", "achat", "jalon"].includes(e.type) && `${fmtNum(e.km)} km`, e.montant != null && fmtEur(e.montant / 100)].filter(Boolean);
      const conf = confianceHTML(e);
      const bouton = noteBtn && e.recu ? `<button class="link" type="button" data-note="${e.type === "releve" ? "releve" : "entretien"}" data-oid="${e.releveId ?? e.entretienId}">Ajouter une note</button>` : "";
      return `${entete}<li class="ev" data-t="${e.type}"><div class="quand">${esc(fmtDate(e.date))}</div><div class="quoi">${e.type === "jalon" ? "★ " : ""}${esc(e.titre)}</div>
        ${det.length || conf || bouton ? `<div class="det">${det.map(d => `<span>${d}</span>`).join("")}${conf}${bouton}</div>` : ""}
        ${e.description ? `<p class="evdesc">${esc(e.description)}</p>` : ""}${notesHTML(e.notes)}</li>`;
    }).join("");
  }

  function continuiteHTML(c) {
    if (!c) return "";
    const plusieurs = c.proprietaires > 1 ? `, sur ${c.proprietaires} propriétaires` : "";
    return `<p class="continu"><strong>Kilométrage suivi sans interruption</strong> de ${fmtNum(c.de.km)} à ${fmtNum(c.a.km)} km, du ${esc(fmtShort(c.de.date))} au ${esc(fmtShort(c.a.date))}${plusieurs} (jamais plus de 6 mois sans kilométrage connu).</p>`;
  }

  function html(d) {
    const v = d.voiture;
    const sous = [v.motorisation, v.annee, v.energie, v.boite && "boîte " + v.boite, v.miseEnCirculation && "mise en circulation en " + fmtMois(v.miseEnCirculation)].filter(Boolean).map(esc).join(" · ");
    const n = d.nombres, s = d.saisieTardive;
    const synthese = [
      `${pluriel(n.releves, "relevé")} de kilométrage, ${pluriel(n.entretiens, "entretien")} dont ${n.avecFacture} avec facture.`,
      d.changementsProprietaire.length ? `${pluriel(d.changementsProprietaire.length, "changement")} de propriétaire suivi${d.changementsProprietaire.length > 1 ? "s" : ""} dans Rétroviz (${d.changementsProprietaire.map(fmtShort).map(esc).join(", ")}).` : "",
      s.entretiens ? `${pluriel(s.entretiens, "entretien")} saisi${s.entretiens > 1 ? "s" : ""} après coup (plus de 30 jours après leur date), dont ${s.entretiensAvecFacture} avec facture.` : "",
      s.releves ? `${pluriel(s.releves, "relevé")} saisi${s.releves > 1 ? "s" : ""} après coup.` : "",
      d.suppressions ? `${pluriel(d.suppressions, "entrée ancienne")} supprimée${d.suppressions > 1 ? "s" : ""} par un propriétaire.` : "",
    ].filter(Boolean).map(t => `<li>${t}</li>`).join("");
    const b = d.badge;
    const badge = `<section class="bsuivi ${b.obtenu ? "ok" : ""}" aria-label="Badge"><h3><span class="etoile ${b.obtenu ? "" : "vide"}" aria-hidden="true">★</span>${b.obtenu ? "Voiture bien suivie" : "Badge « Voiture bien suivie » : pas encore obtenu"}</h3>
      <ul class="crit">${b.criteres.map(c => `<li><span class="coche ${c.ok ? "ok" : ""}" aria-hidden="true">${c.ok ? "✓" : "✗"}</span><div><strong>${esc(c.titre)}</strong><span class="sr">${c.ok ? " : rempli" : " : pas rempli"}</span><div class="d">${esc(c.detail)}</div></div></li>`).join("")}</ul>
      <p class="hint">${esc(b.avertissement)}</p></section>`;
    const k = d.chiffres, depuis = k.source === "achat" ? "depuis l'achat par le propriétaire actuel" : "depuis le début du suivi";
    const kpi = (x, t) => `<div class="kpi"><strong>${x}</strong><span>${t}</span></div>`;
    const kpis = `<div class="kpis">${kpi(k.kmParcourus != null ? fmtNum(k.kmParcourus) + " km" : "—", `parcourus ${depuis}`)}
      ${kpi(fmtEur(k.totalDepense), `d'entretien ${depuis}`)}
      ${kpi(k.coutParKm != null ? k.coutParKm.toLocaleString("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 3, maximumFractionDigits: 3 }) : "—", "d'entretien par km")}
      ${kpi(fmtEur(k.coutParMois), `d'entretien par mois, sur ${k.moisDeSuivi || 1} mois`)}</div>`;
    const ech = d.echeances.length ? `<h3 class="sect-t">Prochaines échéances</h3><ul class="echs">${d.echeances.map(e => `<li><span class="pill" data-s="${esc(e.statut)}">${esc(STATUT[e.statut] || e.statut)}</span> <strong>${esc(e.titre)}</strong>
      <span class="hint">${[e.date && (e.dateEstimee ? "vers le " : "le ") + fmtShort(e.date), e.km != null && "à " + fmtNum(e.km) + " km", e.suppose && "date supposée : dernier contrôle non renseigné"].filter(Boolean).map(esc).join(" · ")}</span></li>`).join("")}</ul>` : "";
    const valeur = d.valeur ? `<p class="valeur">Valeur estimée le ${esc(fmtShort(d.valeur.date))} : <strong>${esc(fmtEur0(d.valeur.valeurProbable))}</strong> (de ${esc(fmtEur0(d.valeur.basse))} à ${esc(fmtEur0(d.valeur.haute))}). Estimation indicative, pas une cote.</p>` : "";
    const jalons = d.jalons.length ? `<h3 class="sect-t">Étapes marquantes</h3><ul class="jalons">${d.jalons.slice().reverse().map(j => `<li><span aria-hidden="true">★</span>${esc(j.titre)} <small>${esc(fmtShort(j.date))}</small></li>`).join("")}</ul>` : "";
    return `<header class="dhead">${d.photo ? `<img class="dphoto" src="${esc(d.photo)}" alt="Photo de la voiture">` : ""}
        <div><h1>${esc(v.marque)} ${esc(v.modele)}</h1><p class="sub">${sous}</p></div></header>
      <section class="synthese" aria-label="En bref"><ul>${synthese}</ul>${continuiteHTML(d.continuite)}</section>
      ${badge}${kpis}${ech}${valeur}${jalons}
      <h3 class="sect-t">Sa vie, de la plus récente à la plus ancienne</h3>
      <ol class="frise" aria-label="Frise de la vie de la voiture">${friseHTML(d.frise)}</ol>
      <p class="hint fin">${esc(d.avertissement)}${d.expireLe ? ` Lien valable jusqu'au ${esc(fmtDate(d.expireLe))}.` : ""}</p>`;
  }

  window.Dossier = { html, friseHTML, confianceHTML, notesHTML, continuiteHTML };
})();
