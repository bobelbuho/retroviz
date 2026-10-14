// Règles de fiabilité, communes à toutes les fiches du dossier data/ : npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../knowledge.js";

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
