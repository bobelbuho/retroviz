// Tests du schéma interactif : pièces par énergie, liens avec la fiche, « À venir » et le carnet : npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadKnowledge } from "../knowledge.js";
import { piecesPourVoiture, concerne, zonesPour } from "../schema.js";

const kb = loadKnowledge();
const piece = id => kb.pieces.find(p => p.id === id);
const trouve = (r, id) => r.zones.flatMap(z => z.pieces).find(p => p.id === id);

describe("schéma interactif", () => {
  test("trois versions : thermique, hybride, électrique", () => {
    const th = piecesPourVoiture({ vehicule: { modele: "208", motorisation: "1.2 PureTech" }, pieces: kb.pieces });
    const ev = piecesPourVoiture({ vehicule: { modele: "Zoe", motorisation: "R110 52 kWh" }, pieces: kb.pieces });
    const hy = piecesPourVoiture({ vehicule: { modele: "Yaris", motorisation: "1.5 Hybrid" }, pieces: kb.pieces });
    assert.equal(th.energie, "thermique"); assert.equal(ev.energie, "electrique"); assert.equal(hy.energie, "hybride");
    assert.ok(!ev.zones.some(z => z.id === "echappement-depollution"));
    assert.equal(zonesPour("thermique").length, 8);
    assert.ok(trouve(th, "embrayage") && !trouve(ev, "embrayage"));
    assert.ok(trouve(ev, "batterie-traction") && trouve(ev, "reducteur") && !trouve(th, "batterie-traction"));
    assert.ok(trouve(hy, "batterie-traction") && trouve(hy, "catalyseur"));
  });
  test("mots-clés : début de mot seulement", () => {
    assert.ok(concerne(piece("plaquettes"), "Changement des plaquettes avant"));
    assert.ok(concerne(piece("courroie-distribution"), "Kit distribution"));
    assert.ok(!concerne(piece("injecteurs"), "Désinjection"));
  });
  test("pannes connues, entretiens proches et carnet reliés aux pièces", () => {
    const fiche = { pannes: [{ titre: "Dégradation de la courroie de distribution « humide »", km_typique: 80000, gravite: "elevee" }] };
    const avenir = { items: [{ cle: "vidange", categorie: "rappel", titre: "Vidange", statut: "retard", date: "2026-09-01", km: 90000 },
      { cle: "entretien-0", categorie: "entretien", titre: "Remplacement des plaquettes", statut: "plus_tard" }] };
    const entretiens = [{ id: 1, date: "2025-03-01", km: 70000, type: "freins", description: "" }, { id: 2, date: "2024-03-01", km: 60000, type: "autre", description: "Kit distribution complet" }];
    const r = piecesPourVoiture({ vehicule: { modele: "208", motorisation: "1.2 PureTech" }, fiche, avenir, entretiens, pieces: kb.pieces });
    assert.equal(trouve(r, "courroie-distribution").alertes[0].type, "panne");
    assert.deepEqual(trouve(r, "courroie-distribution").carnet.map(e => e.id), [2]);
    assert.equal(trouve(r, "huile-moteur").alertes[0].statut, "retard");
    assert.equal(trouve(r, "plaquettes").alertes.length, 0, "« plus tard » n'est pas mis en avant");
    assert.deepEqual(trouve(r, "plaquettes").carnet.map(e => e.id), [1]);
  });
});
