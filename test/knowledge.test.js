// Tests de la base de connaissances : npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadKnowledge, findVehicle, findCodes, detectCodes, buildContext, normalize } from "../knowledge.js";

const kb = loadKnowledge(undefined, () => { throw new Error("les fichiers de data/ doivent être valides"); });
const ids = list => list.map(r => r.fiche.id);

describe("normalize", () => {
  test("enlève accents et majuscules, garde le point décimal", () => {
    assert.equal(normalize("CITROËN C3 1,2 PureTech — 2018 !"), "citroen c3 1.2 puretech 2018");
  });
});

describe("findVehicle", () => {
  test("modèle + moteur, insensible à la casse et aux accents", () => {
    const r = findVehicle("PEUGEOT 208 1.2 PURETECH 2016", kb);
    assert.equal(r[0].fiche.id, "peugeot-208-1-12-puretech");
    assert.equal(r[0].correspondance, "modele_moteur");
    // Modèle seul : les fiches de ce modèle (plusieurs générations possibles).
    assert.ok(ids(findVehicle("citroën c3", kb)).every(id => id.startsWith("citroen-c3-")));
    assert.ok(ids(findVehicle("CITROEN C3 1.2 puretech 2018", kb)).includes("citroen-c3-3-12-puretech"));
  });

  test("tolère « pure tech » et « 1,2 »", () => {
    const r = findVehicle("ma 208 1,2 pure tech", kb);
    assert.equal(r[0].fiche.id, "peugeot-208-1-12-puretech");
    assert.equal(r[0].correspondance, "modele_moteur");
  });

  test("autre modèle avec le même moteur : correspondance « moteur », 2 fiches au plus", () => {
    const r = findVehicle("DS3 1.2 puretech 2017 98000 km", kb); // modèle absent de la base
    assert.ok(r.length >= 1 && r.length <= 2);
    assert.ok(r.every(x => x.correspondance === "moteur"));
    assert.ok(ids(r).every(id => id.includes("puretech")));
  });

  test("le modèle exact écarte les fiches qui ne partagent que le moteur", () => {
    assert.deepEqual(ids(findVehicle("208 1.2 puretech", kb)).sort(), ["peugeot-208-1-12-puretech", "peugeot-208-2-12-puretech"]);
    assert.equal(ids(findVehicle("208 1.2 puretech 2016", kb))[0], "peugeot-208-1-12-puretech", "l'année départage les générations");
    assert.equal(ids(findVehicle("208 1.2 puretech 2021", kb))[0], "peugeot-208-2-12-puretech");
  });

  test("alias et génération : Clio 4 / Clio IV, Golf 7", () => {
    assert.equal(ids(findVehicle("Renault Clio 4 dCi 90", kb))[0], "renault-clio-4-15-dci");
    assert.equal(ids(findVehicle("clio IV 1.5 dci 2015", kb))[0], "renault-clio-4-15-dci");
    assert.equal(ids(findVehicle("vw golf 7 1.6 tdi", kb))[0], "volkswagen-golf-7-16-tdi");
  });

  test("une cylindrée différente écarte la fiche", () => {
    assert.deepEqual(findVehicle("Golf 1.9 TDI 2010", kb), []);
    assert.deepEqual(findVehicle("Peugeot 208 2.0 HDi", kb), []);
  });

  test("une année hors période baisse le score", () => {
    const ok = findVehicle("sandero 0.9 tce 2016", kb)[0].score; // Sandero II (2012-2020)
    const out = findVehicle("sandero 0.9 tce 2024", kb)[0].score; // aucune génération 0.9 TCe en 2024
    assert.ok(out < ok);
  });

  test("aucune correspondance", () => {
    assert.deepEqual(findVehicle("Lada Niva 1.7 2020", kb), []);
    assert.deepEqual(findVehicle("", kb), []);
    assert.deepEqual(findVehicle(undefined, kb), []);
  });
});

describe("findCodes", () => {
  test("détecte plusieurs codes, en minuscules, sans doublons", () => {
    assert.deepEqual(detectCodes("p0300 puis P0171, P0300 et u0100."), ["P0300", "P0171", "U0100"]);
    assert.deepEqual(findCodes("p0300 puis P0171, P0300 et u0100.", kb).map(c => c.code), ["P0300", "P0171", "U0100"]);
  });

  test("codes à lettres hexadécimales", () => {
    assert.deepEqual(findCodes("défaut P20EE et P242f", kb).map(c => c.code), ["P20EE", "P242F"]);
  });

  test("ignore les mots et nombres qui ressemblent à des codes", () => {
    assert.deepEqual(detectCodes("BAFFE, P03001, XP0300, 2016, Peugeot"), []);
  });

  test("code absent de la base ou aucun code", () => {
    assert.deepEqual(findCodes("P1234 code constructeur", kb), []);
    assert.deepEqual(findCodes("ma voiture fait un bruit", kb), []);
  });
});

describe("buildContext", () => {
  test("véhicule + code : texte et sources avec statut", () => {
    const { text, sources } = buildContext({ vehicule: "Peugeot 208 1.2 PureTech 2016", texte: "J'ai le code P0300" }, kb);
    assert.match(text, /Peugeot 208/);
    assert.match(text, /Code P0300/);
    assert.match(text, /à vérifier/);
    assert.deepEqual(sources.map(s => s.id || s.code), ["peugeot-208-1-12-puretech", "P0300"]);
    assert.ok(sources.every(s => s.statut === "a_verifier"));
    assert.equal(sources[0].label, "Peugeot 208 1.2 PureTech");
  });

  test("véhicule cherché dans le message si le champ véhicule est vide", () => {
    const { sources } = buildContext({ vehicule: "", texte: "P0300 sur ma 208 1.2 PureTech de 2016" }, kb);
    assert.deepEqual(sources.map(s => s.id || s.code), ["peugeot-208-1-12-puretech", "P0300"]);
  });

  test("plusieurs messages : un code cité dans un message précédent est retrouvé", () => {
    const texte = ["et combien ça coûte ?", "c'est grave ?", "J'ai le code P0300 sur ma 208 1.2 PureTech de 2015"].join("\n");
    const { sources } = buildContext({ vehicule: "", texte }, kb);
    assert.deepEqual(sources.map(s => s.id || s.code), ["peugeot-208-1-12-puretech", "P0300"]);
  });

  test("signale les codes absents de la base", () => {
    const { text, sources } = buildContext({ texte: "P0300 et P1234" }, kb);
    assert.match(text, /absents de la base Rétroviz : P1234/);
    assert.deepEqual(sources.map(s => s.code), ["P0300"]);
  });

  test("aucune correspondance : texte vide", () => {
    assert.deepEqual(buildContext({ vehicule: "Lada Niva", texte: "bruit au freinage" }, kb), { text: "", sources: [] });
    assert.deepEqual(buildContext({}, kb), { text: "", sources: [] });
  });

  test("respecte la limite de taille et tronque proprement", () => {
    const big = {
      id: "test-big", marque: "Testa", modele: "Zeta", moteurs: ["2.0 Test 150"], statut: "a_verifier", sources: [],
      pannes: Array.from({ length: 200 }, (_, i) => ({ titre: `Panne ${i}`, km_typique: 1000 * i, gravite: "moyenne", symptomes: "x".repeat(60), solution: "y".repeat(60), cout_indicatif: "100 €" }))
    };
    const fake = { vehicules: [big], codes: kb.codes };
    const { text, sources } = buildContext({ vehicule: "Testa Zeta", texte: "P0300 P0171" }, fake);
    assert.ok(text.length <= 6000, `longueur ${text.length}`);
    assert.match(text, /fiche tronquée/);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].tronque, true);

    const small = buildContext({ texte: "P0300 P0171 P0420 P0299" }, kb, 1200);
    assert.ok(small.text.length <= 1200);
    assert.ok(small.sources.length < 4);
  });

  test("la taille par défaut tient même avec beaucoup de codes", () => {
    const all = [...kb.codes.keys()].join(" ");
    const { text } = buildContext({ texte: all }, kb);
    assert.ok(text.length <= 6000);
  });
});

describe("chargement des fichiers", () => {
  test("un fichier invalide est ignoré avec un message, sans planter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retroviz-"));
    fs.writeFileSync(path.join(dir, "vehicules.json"), "{ pas du json");
    fs.writeFileSync(path.join(dir, "obd.json"), JSON.stringify([{ code: "p0300", libelle: "Test" }]));
    const logs = [];
    const k = loadKnowledge(dir, m => logs.push(m));
    assert.equal(k.vehicules.length, 0);
    assert.equal(k.codes.get("P0300").libelle, "Test");
    assert.equal(logs.length, 1);
    assert.match(logs[0], /vehicules\.json ignoré/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("données : statuts valides, sources obligatoires pour « verifie », codes uniques", () => {
    for (const v of kb.vehicules) {
      assert.ok(["a_verifier", "verifie"].includes(v.statut), `${v.id} : statut invalide`);
      if (v.statut === "verifie") assert.ok(v.sources?.length > 0, `${v.id} : une fiche vérifiée doit avoir une source`);
      for (const p of v.pannes || []) assert.ok(["faible", "moyenne", "elevee"].includes(p.gravite), `${v.id} : gravité invalide`);
    }
    assert.equal(new Set(kb.vehicules.map(v => v.id)).size, kb.vehicules.length);
    for (const code of kb.codes.keys()) assert.match(code, /^[PBCU][0-3][0-9A-F]{3}$/);
    const raw = JSON.parse(fs.readFileSync(new URL("../data/obd.json", import.meta.url), "utf8"));
    assert.equal(kb.codes.size, raw.length, "code OBD en double dans obd.json");
  });
});

describe("voyants", () => {
  test("les pastilles « Un voyant s'est allumé » retrouvent la bonne fiche", async () => {
    const { findVoyants } = await import("../knowledge.js");
    const cas = {
      "voyant moteur orange": "moteur", "voyant huile rouge": "pression-huile", "voyant température rouge": "temperature-moteur",
      "voyant freins rouge": "freins", "voyant batterie allumé en roulant": "batterie-charge", "voyant ABS": "abs",
      "voyant airbag": "airbag", "voyant pression des pneus": "pression-pneus", "voyant préchauffage qui clignote": "prechauffage",
      "le voyant FAP est allumé": "fap", "j'ai un triangle orange": "alerte-generale",
    };
    for (const [texte, id] of Object.entries(cas)) assert.equal(findVoyants(texte, kb)[0]?.id, id, texte);
  });
  test("pas de fiche voyant pour des phrases sans rapport", async () => {
    const { findVoyants } = await import("../knowledge.js");
    for (const texte of ["codes défaut P0300 sur ma 208", "le radar m'a flashé", "moteur fatigué", "mon FAP est bouché", "prise de courant"]) {
      assert.deepEqual(findVoyants(texte, kb), [], texte);
    }
  });
  test("la fiche voyant est envoyée à l'IA avec sa source", () => {
    const { text, sources } = buildContext({ vehicule: "", texte: "voyant huile rouge" }, kb);
    assert.match(text, /Voyant « Pression d'huile »/);
    assert.deepEqual(sources, [{ type: "voyant", id: "pression-huile", label: "Pression d'huile", statut: "a_verifier" }]);
  });
});
