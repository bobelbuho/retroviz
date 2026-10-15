// « Marques et modèles » : lecture publique des fiches de data/marques/ (via la base chargée, kb).
import express from "express";

// Champs internes d'une fiche motorisation qui n'ont pas à être montrés.
const INTERNES = ["revisions", "marque_id", "modele_id", "generation_id", "alias", "alias_generation", "verifie_par"];
const propre = v => Object.fromEntries(Object.entries(v).filter(([k]) => !INTERNES.includes(k)));

export function createCatalogue(kb) {
  const router = express.Router();
  const pub = res => res.setHeader("Cache-Control", "public, max-age=300");

  // Toutes les marques, avec leurs modèles (résumé) : l'écran de départ.
  router.get("/api/marques", (req, res) => {
    pub(res);
    res.json({ marques: kb.marques.map(m => ({
      id: m.id, nom: m.nom, pays: m.pays, cout_entretien: m.cout_entretien, statut: m.statut,
      modeles: kb.modeles.filter(mo => mo.marque === m.id).map(mo => ({
        id: mo.id, nom: mo.nom, alias: mo.alias || [], generations: mo.generations.map(g => ({ id: g.id, nom: g.nom, annees: g.annees, alias: g.alias || [] })),
        motorisations: kb.vehicules.filter(v => v.modele_id === mo.id).length,
      })),
    })) });
  });

  // Un modèle complet : sa marque, ses générations et leurs motorisations.
  router.get("/api/modeles/:id", (req, res) => {
    const mo = kb.modeles.find(x => x.id === req.params.id);
    if (!mo) return res.status(404).json({ code: "not_found", error: "Modèle introuvable." });
    const m = kb.marques.find(x => x.id === mo.marque);
    pub(res);
    res.json({
      marque: m,
      modele: { ...mo, generations: mo.generations.map(g => ({ ...g, motorisations: kb.vehicules.filter(v => v.generation_id === g.id).map(propre) })) },
    });
  });
  return router;
}
