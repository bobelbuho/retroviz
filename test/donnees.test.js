// Règles de fiabilité, communes à toutes les fiches du dossier data/ : npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../knowledge.js";
import { COLLECTIONS, problemesFiche, serialiser } from "../fiabilite.js";

// Fichiers de fiches et champ servant d'identifiant. Ajouter ici chaque nouveau fichier de data/.
export const FICHIERS = { "obd.json": "code", "vehicules.json": "id", "voyants.json": "id" };

const lire = f => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));

for (const [fichier, cle] of Object.entries(FICHIERS)) {
  test(`${fichier} : statut, sources, rédacteur, date ; « vérifiée » seulement avec une source`, t => {
    if (!fs.existsSync(path.join(DATA_DIR, fichier))) return t.skip("fichier pas encore créé");
    const fiches = lire(fichier);
    assert.ok(Array.isArray(fiches) && fiches.length > 0);
    const vus = new Set();
    for (const f of fiches) {
      const nom = `${fichier} › ${f[cle]}`;
      assert.ok(f[cle], `${nom} : identifiant manquant`);
      assert.ok(!vus.has(f[cle]), `${nom} : identifiant en double`);
      vus.add(f[cle]);
      assert.ok(["a_verifier", "verifie"].includes(f.statut), `${nom} : statut invalide`);
      assert.ok(Array.isArray(f.sources), `${nom} : sources doit être une liste (vide si aucune)`);
      assert.ok(f.sources.every(s => typeof s === "string" && s.trim()), `${nom} : source vide`);
      assert.ok(["ia", "humain"].includes(f.redige_par), `${nom} : redige_par doit être « ia » ou « humain »`);
      assert.match(f.mise_a_jour || "", /^\d{4}-\d{2}-\d{2}$/, `${nom} : mise_a_jour au format AAAA-MM-JJ`);
      if (f.incertitudes !== undefined) assert.ok(Array.isArray(f.incertitudes), `${nom} : incertitudes doit être une liste`);
      if (f.statut === "verifie") assert.ok(f.sources.length > 0, `${nom} : une fiche vérifiée doit avoir au moins une source`);
    }
  });
}

test("voyants.json : champs complets, couleurs et urgence valides, icônes SVG sans danger", () => {
  const voyants = lire("voyants.json");
  assert.ok(voyants.length >= 60 && voyants.length <= 80, `${voyants.length} voyants (60 à 80 attendus)`);
  const COULEURS = ["rouge", "orange", "vert", "bleu", "blanc"];
  // Seuls ces éléments et attributs sont autorisés dans une icône (elle est insérée telle quelle dans la page).
  const BALISES = /^<\/?(path|circle|rect|text)\b/;
  const ATTRS = new Set(["d", "cx", "cy", "r", "x", "y", "width", "height", "text-anchor", "font-size", "font-weight", "fill", "stroke", "stroke-dasharray"]);
  for (const v of voyants) {
    for (const k of ["nom", "symbole", "signification", "cout"]) assert.ok(typeof v[k] === "string" && v[k].trim(), `${v.id} : ${k}`);
    for (const k of ["autres_noms", "couleurs", "que_faire", "causes", "variantes"]) assert.ok(Array.isArray(v[k]), `${v.id} : ${k}`);
    assert.ok(v.couleurs.length && v.couleurs.every(c => COULEURS.includes(c)), `${v.id} : couleurs`);
    assert.ok(["rouge", "orange", "info"].includes(v.urgence), `${v.id} : urgence`);
    assert.ok(["oui", "prudemment", "non"].includes(v.rouler), `${v.id} : rouler`);
    assert.ok(v.que_faire.length > 0, `${v.id} : que faire`);
    assert.ok(v.signification.split(/[.!?](\s|$)/).filter(s => s && s.trim()).length <= 2, `${v.id} : signification en 2 phrases au plus`);
    for (const x of v.variantes) assert.ok(["fixe", "clignotant"].includes(x.etat) && x.sens, `${v.id} : variante`);
    const tags = v.icone.match(/<[^>]+>/g) || [];
    assert.ok(tags.length > 0, `${v.id} : icône vide`);
    for (const tag of tags) {
      assert.match(tag, BALISES, `${v.id} : balise interdite ${tag}`);
      for (const [, attr] of tag.matchAll(/\s([a-z-]+)=/g)) assert.ok(ATTRS.has(attr), `${v.id} : attribut interdit ${attr}`);
    }
    assert.doesNotMatch(v.icone.replace(/<[^>]+>/g, ""), /[<>]/, `${v.id} : texte d'icône suspect`);
  }
});

for (const [collection, def] of Object.entries(COLLECTIONS)) {
  test(`${def.fichier} : règles partagées avec la Relecture, format d'écriture stable`, () => {
    const brut = fs.readFileSync(path.join(DATA_DIR, def.fichier), "utf8");
    const fiches = JSON.parse(brut);
    for (const f of fiches) assert.deepEqual(problemesFiche(collection, f), [], `${f[def.cle]}`);
    assert.equal(brut, serialiser(collection, fiches), "le fichier doit garder le format écrit par la Relecture");
  });
}
