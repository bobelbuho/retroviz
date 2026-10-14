// Schéma interactif de la voiture : dessins SVG faits main (vue d'ensemble de profil, puis une vue par zone).
// Les couleurs viennent des classes CSS (variables du système de design), jamais du dessin lui-même.
// Les connaissances (rôle, usure, prix…) sont dans data/pieces.json ; ici, seulement la géométrie.
(function () {
  /* ---------- vue d'ensemble : la voiture de profil, avant à gauche ---------- */
  const CAISSE = "M40 200 L40 160 Q44 140 80 136 L172 126 L232 82 Q246 70 272 70 L430 70 Q456 70 472 86 L540 130 Q590 136 600 160 L600 200 Q600 210 590 210 L548 210 A50 50 0 0 0 448 210 L250 210 A50 50 0 0 0 150 210 L50 210 Q40 210 40 200 Z";
  const VITRES = "M186 126 L238 88 Q248 80 266 80 L330 80 L330 126 Z M342 80 L428 80 Q446 80 458 92 L514 126 L342 126 Z";
  const ressort = (x, y1, y2) => { let d = `M${x} ${y1}`; const n = 6, h = (y2 - y1) / n; for (let i = 0; i < n; i++) d += ` L${x + (i % 2 ? -9 : 9)} ${y1 + h * (i + 0.5)}`; return d + ` L${x} ${y2}`; };
  const roue = (cx, cy) => `<circle cx="${cx}" cy="${cy}" r="38" class="sch-pneu"/>`;
  const disque = (cx, cy) => `<circle cx="${cx}" cy="${cy}" r="18"/><circle cx="${cx}" cy="${cy}" r="5" class="sch-trait"/>`;
  // Zones de la vue d'ensemble : formes cliquables et point où afficher une alerte.
  function zonesVue(energie) {
    const ev = energie === "electrique", elec = energie !== "thermique";
    return {
      carrosserie: { forme: `<path d="${CAISSE}"/><path d="${VITRES}" class="sch-vitre"/><path d="M336 78 L336 206" class="sch-trait"/>`, alerte: [400, 60] },
      "echappement-depollution": ev ? null : { forme: `<path d="M120 196 L150 216 L452 216" class="sch-tube"/><rect x="552" y="204" width="44" height="18" rx="9"/><path d="M452 216 L552 213" class="sch-tube"/><rect x="280" y="208" width="46" height="16" rx="8"/>`, alerte: [575, 238] },
      electricite: { forme: `<rect x="120" y="128" width="30" height="20" rx="3"/><path d="M131 132 l-4 8 h6 l-4 8" class="sch-trait"/>${elec ? `<rect x="262" y="196" width="178" height="14" rx="4"/><path d="M345 199 l-5 5 h8 l-5 5" class="sch-trait"/>` : ""}`, alerte: [135, 118] },
      transmission: { forme: `<rect x="${ev ? 120 : 150}" y="170" width="40" height="28" rx="5"/><path d="M${ev ? 160 : 190} 184 L200 210" class="sch-tube"/>`, alerte: [170, 166] },
      moteur: { forme: ev ? `<rect x="64" y="160" width="54" height="40" rx="14"/><circle cx="91" cy="180" r="9" class="sch-trait"/>` : `<rect x="58" y="152" width="90" height="48" rx="8"/><path d="M70 152 v-8 h66 v8" class="sch-trait"/>`, alerte: [80, 145] },
      "direction-suspension": { forme: `<path d="${ressort(200, 140, 178)}" class="sch-ressort"/><path d="${ressort(498, 140, 178)}" class="sch-ressort"/>`, alerte: [222, 140] },
      pneus: { forme: roue(200, 210) + roue(498, 210), alerte: [238, 248] },
      freins: { forme: disque(200, 210) + disque(498, 210), alerte: [520, 192] },
    };
  }
  const ORDRE_VUE = ["carrosserie", "echappement-depollution", "electricite", "transmission", "moteur", "direction-suspension", "pneus", "freins"];

  // zones : [{id, nom, nbPieces, alerte: null|"info"|"grave"}]
  function vueGenerale(energie, zones) {
    const formes = zonesVue(energie);
    const parId = new Map(zones.map(z => [z.id, z]));
    const groupes = ORDRE_VUE.filter(id => formes[id] && parId.has(id)).map(id => {
      const z = parId.get(id), f = formes[id];
      const etat = z.alerte ? ` : ${z.alerte === "grave" ? "point important" : "à surveiller"} pour votre voiture` : "";
      return `<g class="sch-zone" data-zone="${id}" tabindex="0" role="button" aria-label="${z.nom}, ${z.nbPieces} pièces${etat}"><title>${z.nom}</title>${f.forme}</g>`;
    }).join("");
    const alertes = ORDRE_VUE.filter(id => formes[id] && parId.get(id)?.alerte).map(id => {
      const [x, y] = formes[id].alerte, g = parId.get(id).alerte === "grave";
      return `<g class="sch-badge ${g ? "grave" : ""}" aria-hidden="true"><circle cx="${x}" cy="${y}" r="11"/><text x="${x}" y="${y + 5}" text-anchor="middle">!</text></g>`;
    }).join("");
    return `<svg class="sch" viewBox="20 40 600 220" role="group" aria-label="Schéma de la voiture, vue de profil, l'avant à gauche"><path d="M30 254 H610" class="sch-sol"/>${groupes}${alertes}</svg>`;
  }

  /* ---------- vues détaillées : une par zone ---------- */
  // Décor (non cliquable) de chaque zone, selon l'énergie.
  const DECOR = {
    moteur: e => e === "electrique"
      ? `<rect x="120" y="230" width="260" height="60" rx="10" class="sch-fantome"/><text x="250" y="266" class="sch-legende" text-anchor="middle">batterie</text>`
      : `<rect x="140" y="110" width="190" height="122" rx="10" class="sch-fantome"/><rect x="150" y="70" width="170" height="40" rx="6" class="sch-fantome"/>`,
    transmission: () => `<rect x="420" y="20" width="48" height="76" rx="10" class="sch-fantome"/><rect x="420" y="224" width="48" height="76" rx="10" class="sch-fantome"/><text x="444" y="318" class="sch-legende" text-anchor="middle">roues</text>`,
    freins: () => `<circle cx="170" cy="165" r="138" class="sch-fantome"/><text x="170" y="316" class="sch-legende" text-anchor="middle">roue avant, vue de côté</text>`,
    "direction-suspension": () => `<path d="M60 40 H460" class="sch-fantome-trait"/><text x="64" y="32" class="sch-legende">caisse</text>`,
    electricite: () => "",
    "echappement-depollution": () => `<rect x="10" y="150" width="50" height="70" rx="8" class="sch-fantome"/><text x="35" y="240" class="sch-legende" text-anchor="middle">moteur</text><path d="M60 185 H470" class="sch-tube-fond"/>`,
    pneus: () => "",
    carrosserie: () => `<path d="M20 230 L20 180 Q24 160 60 156 L150 146 L210 100 Q224 88 250 88 L370 88 Q396 88 412 104 L470 150 Q480 156 480 180 L480 230 Z" class="sch-fantome"/><circle cx="120" cy="232" r="34" class="sch-fantome"/><circle cx="380" cy="232" r="34" class="sch-fantome"/>`,
  };
  // Forme et repère (numéro) de chaque pièce. Une pièce absente d'ici est placée dans les emplacements libres.
  const ev = e => e === "electrique";
  const P = {
    // moteur
    "refroidissement": () => ({ f: `<rect x="20" y="90" width="28" height="150" rx="4"/><path d="M24 110 h20 M24 130 h20 M24 150 h20 M24 170 h20 M24 190 h20 M24 210 h20" class="sch-trait"/>`, r: [34, 78] }),
    "filtre-air": () => ({ f: `<rect x="62" y="28" width="84" height="38" rx="10"/>`, r: [104, 20] }),
    "courroie-accessoires": () => ({ f: `<rect x="92" y="150" width="36" height="88" rx="18" class="sch-courroie"/>`, r: [110, 140] }),
    "courroie-distribution": () => ({ f: `<rect x="340" y="80" width="34" height="146" rx="17" class="sch-courroie"/>`, r: [357, 68] }),
    "bobines-allumage": () => ({ f: [176, 216, 256, 296].map(x => `<rect x="${x - 2}" y="50" width="22" height="14" rx="3"/>`).join(""), r: [176, 40] }),
    "bougies-allumage": () => ({ f: [176, 216, 256, 296].map(x => `<rect x="${x + 4}" y="74" width="10" height="22" rx="2"/>`).join(""), r: [296, 40] }),
    "injecteurs": () => ({ f: [190, 230, 270, 310].map(x => `<path d="M${x} 100 l8 22" class="sch-epais"/>`).join(""), r: [318, 132] }),
    "bougies-prechauffage": () => ({ f: [180, 220, 260, 300].map(x => `<circle cx="${x}" cy="146" r="6"/>`).join(""), r: [160, 146] }),
    "joint-culasse": () => ({ f: `<rect x="150" y="106" width="170" height="8" rx="2"/>`, r: [136, 110] }),
    "huile-moteur": () => ({ f: `<path d="M160 232 H310 L298 266 H172 Z"/>`, r: [235, 282] }),
    "filtre-carburant": () => ({ f: `<rect x="60" y="262" width="62" height="24" rx="12"/>`, r: [91, 302] }),
    "turbo": () => ({ f: `<circle cx="404" cy="196" r="26"/><circle cx="404" cy="196" r="9" class="sch-trait"/>`, r: [440, 170] }),
    "vanne-egr": () => ({ f: `<rect x="386" y="110" width="46" height="30" rx="6"/>`, r: [446, 112] }),
    "moteur-electrique": e => ev(e) ? { f: `<rect x="150" y="110" width="180" height="100" rx="40"/><circle cx="240" cy="160" r="22" class="sch-trait"/>`, r: [240, 98] }
      : { f: `<rect x="392" y="236" width="74" height="50" rx="16"/><circle cx="429" cy="261" r="10" class="sch-trait"/>`, r: [429, 302] },
    "onduleur": e => ev(e) ? { f: `<rect x="170" y="30" width="140" height="56" rx="6"/><path d="M200 58 h80" class="sch-trait"/>`, r: [240, 20] }
      : { f: `<rect x="392" y="30" width="74" height="44" rx="6"/>`, r: [429, 20] },
    // transmission (vue de dessus, avant à droite)
    "volant-bimasse": () => ({ f: `<circle cx="160" cy="160" r="46"/>`, r: [160, 100] }),
    "embrayage": () => ({ f: `<circle cx="190" cy="160" r="34"/><circle cx="190" cy="160" r="10" class="sch-trait"/>`, r: [214, 112] }),
    "boite-vitesses": () => ({ f: `<rect x="236" y="116" width="110" height="88" rx="10"/><path d="M262 136 v48 M290 136 v48 M318 136 v48 M262 160 h56" class="sch-trait"/>`, r: [291, 104] }),
    "reducteur": () => ({ f: `<rect x="236" y="116" width="110" height="88" rx="10"/><circle cx="270" cy="160" r="18" class="sch-trait"/><circle cx="312" cy="160" r="10" class="sch-trait"/>`, r: [291, 104] }),
    "cardans": () => ({ f: `<path d="M346 140 L420 60 M346 180 L420 260" class="sch-epais"/><circle cx="383" cy="100" r="8"/><circle cx="383" cy="220" r="8"/>`, r: [372, 72] }),
    // freins (roue vue de côté)
    "disques": () => ({ f: `<circle cx="170" cy="165" r="92"/><circle cx="170" cy="165" r="34" class="sch-trait"/>`, r: [92, 108] }),
    "etriers": () => ({ f: `<path d="M212 70 A102 102 0 0 1 268 128 L240 140 A72 72 0 0 0 200 98 Z"/>`, r: [262, 80] }),
    "plaquettes": () => ({ f: `<path d="M214 104 A80 80 0 0 1 236 126" class="sch-epais"/>`, r: [232, 158] }),
    "abs": () => ({ f: `<rect x="96" y="226" width="34" height="14" rx="4" transform="rotate(-35 113 233)"/>`, r: [90, 264] }),
    "liquide-frein": () => ({ f: `<rect x="350" y="40" width="80" height="54" rx="8"/><path d="M350 66 H290 L262 104" class="sch-tube-fin"/>`, r: [390, 28] }),
    "frein-stationnement": () => ({ f: `<rect x="350" y="200" width="80" height="22" rx="11"/><path d="M350 211 H300 L250 196" class="sch-tube-fin"/>`, r: [390, 244] }),
    // direction et suspension (vue de face d'une roue avant, à droite)
    "amortisseurs": () => ({ f: `<rect x="300" y="50" width="22" height="122" rx="8"/>`, r: [276, 64] }),
    "ressorts": () => ({ f: `<path d="${ressort(311, 70, 150)}" class="sch-ressort-fort"/>`, r: [346, 96] }),
    "triangles-silentblocs": () => ({ f: `<path d="M150 252 L330 256 L180 214 Z"/><circle cx="150" cy="252" r="8" class="sch-trait"/><circle cx="180" cy="214" r="8" class="sch-trait"/>`, r: [210, 276] }),
    "rotules-biellettes": () => ({ f: `<circle cx="336" cy="252" r="9"/><path d="M322 170 L250 196" class="sch-epais"/>`, r: [270, 162] }),
    "direction": () => ({ f: `<rect x="40" y="196" width="190" height="18" rx="9"/><path d="M230 205 L340 222" class="sch-epais"/><circle cx="76" cy="150" r="26" class="sch-trait"/><path d="M76 176 V196" class="sch-trait"/>`, r: [130, 236] }),
    "geometrie": () => ({ f: `<path d="M360 90 L372 300 M384 92 L372 300" class="sch-pointille"/>`, r: [404, 110] }),
    // électricité
    "batterie-12v": () => ({ f: `<rect x="40" y="56" width="104" height="68" rx="6"/><path d="M62 52 v-8 M122 52 v-8 M56 86 h14 M116 86 h14 M123 79 v14" class="sch-trait"/>`, r: [92, 140] }),
    "alternateur": () => ({ f: `<circle cx="232" cy="92" r="36"/><path d="M220 92 h24 M232 80 v24" class="sch-trait"/>`, r: [232, 42] }),
    "demarreur": () => ({ f: `<rect x="186" y="170" width="96" height="40" rx="20"/>`, r: [234, 226] }),
    "eclairage": () => ({ f: `<path d="M354 50 H446 Q460 50 456 64 L446 96 H354 Z"/><path d="M372 64 h50 M372 80 h40" class="sch-trait"/>`, r: [404, 36] }),
    "climatisation": () => ({ f: `<circle cx="404" cy="190" r="34"/><path d="M404 166 v48 M383 178 l42 24 M383 202 l42 -24" class="sch-trait"/>`, r: [446, 160] }),
    "batterie-traction": () => ({ f: `<rect x="40" y="246" width="300" height="56" rx="8"/><path d="M90 246 v56 M140 246 v56 M190 246 v56 M240 246 v56 M290 246 v56" class="sch-trait"/>`, r: [190, 236] }),
    "chargeur-embarque": () => ({ f: `<rect x="360" y="252" width="96" height="46" rx="6"/><circle cx="440" cy="275" r="10" class="sch-trait"/>`, r: [408, 240] }),
    // échappement et dépollution
    "sonde-lambda": () => ({ f: `<path d="M84 185 v-34" class="sch-epais"/><circle cx="84" cy="146" r="7"/><path d="M226 185 v-34" class="sch-epais"/><circle cx="226" cy="146" r="7"/>`, r: [84, 128] }),
    "catalyseur": () => ({ f: `<rect x="104" y="166" width="96" height="38" rx="19"/>`, r: [152, 226] }),
    "fap": () => ({ f: `<rect x="246" y="164" width="96" height="42" rx="8"/><path d="M262 172 v26 M278 172 v26 M294 172 v26 M310 172 v26 M326 172 v26" class="sch-trait"/>`, r: [294, 226] }),
    "adblue": () => ({ f: `<rect x="250" y="40" width="88" height="62" rx="8"/><path d="M294 102 V150 L360 176" class="sch-tube-fin"/>`, r: [294, 28] }),
    "silencieux": () => ({ f: `<rect x="380" y="160" width="96" height="50" rx="25"/>`, r: [428, 230] }),
    // pneus
    "pneus": () => ({ f: `<circle cx="160" cy="165" r="130" class="sch-pneu-fort"/>`, r: [60, 52] }),
    "capteurs-pression": () => ({ f: `<rect x="152" y="54" width="16" height="26" rx="4"/>`, r: [196, 52] }),
    "pneus-hiver": () => ({ f: `<circle cx="390" cy="165" r="66" class="sch-pneu-fort"/><path d="M390 141 v48 M369 153 l42 24 M369 177 l42 -24" class="sch-trait"/>`, r: [390, 84] }),
    // carrosserie
    "pare-brise": () => ({ f: `<path d="M156 142 L212 104 Q224 94 244 94 L262 94 L262 142 Z"/>`, r: [204, 82] }),
    "essuie-glaces": () => ({ f: `<path d="M168 144 L230 128 M200 146 L262 130" class="sch-epais"/>`, r: [148, 128] }),
    "ouvrants": () => ({ f: `<path d="M270 94 H366 Q386 94 396 108 L432 152 V206 H270 Z"/><path d="M290 166 h22" class="sch-epais"/>`, r: [350, 78] }),
    "corrosion": () => ({ f: `<path d="M154 222 H346" class="sch-epais-large"/><path d="M86 230 A34 34 0 0 1 154 230 M346 230 A34 34 0 0 1 414 230" class="sch-epais"/>`, r: [250, 252] }),
  };
  // Emplacements libres (pièce sans dessin prévu) : en bas à droite.
  const LIBRES = [[440, 290], [400, 290], [360, 290]];

  // pieces : [{id, n (numéro), nom, alerte}]
  function zone(zoneId, energie, nomZone, pieces) {
    let libre = 0;
    // Deux couches : toutes les formes d'abord, puis tous les repères numérotés, pour qu'aucun repère ne soit caché.
    // Les repères portent le focus clavier ; les formes restent cliquables.
    const defs = pieces.map(p => {
      const def = P[p.id] ? P[p.id](energie) : null;
      return { p, def, r: def ? def.r : LIBRES[libre++ % LIBRES.length], cls: p.alerte ? (p.alerte === "grave" ? " grave" : " alerte") : "" };
    });
    const formes = defs.filter(d => d.def).map(({ p, def, cls }) => `<g class="sch-piece${cls}" data-piece="${p.id}" aria-hidden="true"><title>${p.nom}</title>${def.f}</g>`).join("");
    const reperes = defs.map(({ p, r: [x, y], cls }) => `<g class="sch-piece sch-marque${cls}" data-piece="${p.id}" tabindex="0" role="button" aria-label="${p.n}. ${p.nom}${p.alerte ? " : à surveiller sur votre voiture" : ""}"><title>${p.nom}</title>
        <g class="sch-repere"><circle cx="${x}" cy="${y}" r="13"/><text x="${x}" y="${y + 5}" text-anchor="middle">${p.n}</text></g></g>`).join("");
    return `<svg class="sch sch-detail" viewBox="0 0 480 320" role="group" aria-label="${nomZone} : schéma détaillé, ${pieces.length} pièces numérotées">${(DECOR[zoneId] || (() => ""))(energie)}${formes}${reperes}</svg>`;
  }

  window.SchemaDessin = { vueGenerale, zone };
})();
