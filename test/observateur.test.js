// Tests de l'Observateur, sans réseau ni IA (faux sites, fausse IA) : npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRobots, robotsAutorise, refusIA, pageFermee, refusDansLaPage, tdmrepReserve, htmlEnTexte, createWeb } from "../observateur/web.js";
import { parseRappelConso, parseSafetyGateListe, parseSafetyGateRapport, parseNhtsaPlaintes, viseModele, peutConcerner, generationsCitees } from "../observateur/officiels.js";
import { recopie, createIA, BudgetAtteint } from "../observateur/ia.js";
import { confiance, contradictions, recouper, domaineRacine } from "../observateur/recoupement.js";
import { proposerPourFiche, proposerNouvelleFiche, ressemblance } from "../observateur/comparaison.js";
import { coutEur, createBudget } from "../observateur/couts.js";
import { passage } from "../observateur/index.js";
import { problemesFiche } from "../fiabilite.js";
import { openDb } from "../db.js";
import { loadKnowledge, DATA_DIR } from "../knowledge.js";
import { lireMarques, aplatir } from "../marques.js";
import { createRelecture } from "../relecture.js";
import { createPropositions } from "../propositions.js";

const SOURCES = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "sources.json"), "utf8"));

describe("registre des sources", () => {
  test("chaque source : nom, URL, domaines, type, poids, méthode, autorisée, limite ; motif si refusée", () => {
    const TYPES = ["officiel", "constructeur", "presse", "pro", "forum", "proprietaires"];
    for (const s of SOURCES) {
      assert.ok(s.id && s.nom && /^https:\/\//.test(s.url), s.id);
      assert.ok(Array.isArray(s.domaines) && s.domaines.length, s.id);
      assert.ok(TYPES.includes(s.type), `${s.id} : type`);
      assert.ok(s.poids > 0 && s.poids <= 1, `${s.id} : poids`);
      assert.ok(["api", "recherche_web"].includes(s.methode), `${s.id} : méthode`);
      assert.equal(typeof s.autorisee, "boolean");
      assert.ok(s.limite_par_minute > 0 && s.limite_par_minute <= 60, `${s.id} : limite`);
      if (!s.autorisee) assert.ok(s.note, `${s.id} : une source refusée doit dire pourquoi`);
    }
  });
});

describe("respect des sites", () => {
  const ROBOTS = `User-agent: *\nDisallow: /forum/\nAllow: /forum/public/\nDisallow: /*.pdf$\n\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n`;
  test("robots.txt : règle la plus précise, Allow à égalité, jokers", () => {
    const g = parseRobots(ROBOTS);
    assert.equal(robotsAutorise(g, "/article/clio"), true);
    assert.equal(robotsAutorise(g, "/forum/sujet-1"), false);
    assert.equal(robotsAutorise(g, "/forum/public/sujet-2"), true);
    assert.equal(robotsAutorise(g, "/doc/notice.pdf"), false);
    assert.equal(robotsAutorise(parseRobots("User-agent: *\nDisallow:\n"), "/tout"), true, "Disallow vide");
    assert.equal(robotsAutorise(parseRobots("User-agent: RetrovizObservateur\nDisallow: /\n\nUser-agent: *\nAllow: /\n"), "/x"), false, "groupe à notre nom");
  });
  test("refus des robots d'IA détecté (refus d'analyse automatisée)", () => {
    assert.deepEqual(refusIA(parseRobots(ROBOTS)).sort(), ["claudebot", "gptbot"]);
    assert.deepEqual(refusIA(parseRobots("User-agent: GPTBot\nDisallow: /private\n")), [], "refus partiel : pas un refus global");
  });
  test("refus dans la page : TDM, noai ; pages fermées", () => {
    assert.ok(refusDansLaPage("<html></html>", { "tdm-reservation": "1" }));
    assert.ok(refusDansLaPage('<meta name="robots" content="index, noai">'));
    assert.ok(refusDansLaPage('<meta name="tdm-reservation" content="1">'));
    assert.equal(refusDansLaPage('<meta name="robots" content="index, follow">'), null);
    assert.ok(tdmrepReserve([{ location: "/articles/*", "tdm-reservation": 1 }], "/articles/clio"));
    assert.equal(tdmrepReserve([{ location: "/articles/*", "tdm-reservation": 1 }], "/forum/x"), false);
    assert.ok(pageFermee("<p>Cet article est réservé aux abonnés</p>", "https://x.fr/a"));
    assert.ok(pageFermee('<form><input type="password"></form>', "https://x.fr/a"));
    assert.ok(pageFermee("<p>ok</p>", "https://x.fr/connexion?retour=/a"));
    assert.equal(pageFermee("<p>Article libre</p>", "https://x.fr/a"), null);
  });
  test("HTML en texte : sans scripts, menus ni pieds de page", () => {
    const t = htmlEnTexte("<nav>Menu</nav><script>pirate()</script><h1>Clio IV</h1><p>Le 1.5 dCi&nbsp;tient bien.</p><footer>©</footer>");
    assert.equal(t, "Clio IV\nLe 1.5 dCi tient bien.");
  });

  test("client poli : registre, autorisation, robots, IA refusée, paywall, limite de requêtes", async () => {
    const pages = {
      "https://www.turbo.fr/robots.txt": [200, "User-agent: *\nDisallow: /prive/\n"],
      "https://www.turbo.fr/.well-known/tdmrep.json": [404, ""],
      "https://www.turbo.fr/essai-clio": [200, "<h1>Essai</h1><p>" + "La Clio IV est fiable. ".repeat(30) + "</p>"],
      "https://www.turbo.fr/abonnes": [200, "<p>Article réservé aux abonnés</p>" + "x ".repeat(400)],
      "https://www.autojournal.fr/robots.txt": [200, "User-agent: ClaudeBot\nDisallow: /\n"],
    };
    const appels = [], attentes = [];
    let horloge = 0;
    const fetchImpl = async url => {
      appels.push(url);
      const [status, body] = pages[url] || [404, ""];
      return { status, url, headers: new Map(), text: async () => body };
    };
    const web = createWeb({ sources: SOURCES, fetchImpl, now: () => horloge, attendre: async ms => { attentes.push(ms); horloge += ms; } });
    assert.match((await web.lirePage("https://www.inconnu.fr/a")).refus, /absent du registre/);
    assert.match((await web.lirePage("https://www.largus.fr/a")).refus, /non autorisé/);
    assert.match((await web.lirePage("https://www.autojournal.fr/a")).refus, /refuse les robots d'IA/);
    assert.match((await web.lirePage("https://www.turbo.fr/prive/a")).refus, /robots\.txt/);
    assert.match((await web.lirePage("https://www.turbo.fr/abonnes")).refus, /abonnés/);
    const ok = await web.lirePage("https://www.turbo.fr/essai-clio");
    assert.match(ok.texte, /La Clio IV est fiable/);
    assert.ok(!appels.includes("https://www.largus.fr/robots.txt"), "un site non autorisé n'est même pas contacté");
    assert.equal(appels.filter(u => u.endsWith("turbo.fr/robots.txt")).length, 1, "robots.txt lu une seule fois");
    assert.ok(attentes.some(ms => ms >= 9000), "6 requêtes par minute : environ 10 s entre deux pages du même site");
  });
});

describe("collecteurs officiels", () => {
  test("RappelConso, Safety Gate (XML hebdomadaire), NHTSA (plaintes comptées, jamais leur texte)", () => {
    const rc = parseRappelConso({ results: [{ date_publication: "2019-01-11T00:00:00+00:00", marque_produit: "renault", modeles_ou_references: "captur, clio iv, kangoo ii", motif_rappel: "Soudure du catalyseur", identification_produits: ["01.01.2016 - 01.06.2017"], lien_vers_la_fiche_rappel: "https://rappel.conso.gouv.fr/fiche-rappel/49129/rapex" }] });
    assert.equal(rc[0].identification, "01.01.2016 - 01.06.2017");
    const liste = parseSafetyGateListe(`<weeklyReport><publicationDate>02/10/2026</publicationDate><URL>https://x/2?a=1&amp;b=2</URL></weeklyReport><weeklyReport><publicationDate>09/10/2026</publicationDate><URL>https://x/1</URL></weeklyReport>`);
    assert.deepEqual(liste.map(l => l.date), ["2026-10-09", "2026-10-02"]);
    assert.equal(liste[1].url, "https://x/2?a=1&b=2");
    const alertes = parseSafetyGateRapport(`<notifications xmlns:xsi="x" xsi:type="y"><category><![CDATA[Motor vehicles]]></category><brand><![CDATA[Renault]]></brand><name><![CDATA[Clio V]]></name><danger><![CDATA[Airbag]]></danger><reference><![CDATA[https://ec.europa.eu/a/1]]></reference></notifications><notifications><category><![CDATA[Toys]]></category></notifications>`);
    assert.equal(alertes.length, 1);
    assert.equal(alertes[0].marque, "Renault");
    const p = parseNhtsaPlaintes({ count: 3, results: [{ components: "ENGINE, AIR BAGS", summary: "My name is John, VIN 3VW…" }, { components: "ENGINE" }, { components: "" }] });
    assert.deepEqual(p, { total: 3, parOrgane: { ENGINE: 2, "AIR BAGS": 1 } });
    assert.ok(!JSON.stringify(p).includes("John"));
  });

  test("rattachement d'un rappel à une génération", () => {
    const kb = loadKnowledge();
    const clio = kb.vehicules.find(f => f.id === "renault-clio-4-15-dci"), golf = kb.vehicules.find(f => f.id.includes("golf")), p208 = kb.vehicules.find(f => f.id.includes("208"));
    assert.equal(viseModele("captur, clio iv, kangoo ii", clio), true);
    assert.equal(viseModele("captur ii, clio v, zoe", clio), false, "Clio V n'est pas Clio IV");
    assert.equal(viseModele("vw golf 1.4", golf), false, "alias sans génération : pas de rattachement");
    assert.deepEqual(generationsCitees("208 v2, 2008 v2, 208 ii", p208), [2, 2]);
    assert.equal(peutConcerner({ modeles: "208 v2", identification: "02.11.2025 - 24.02.2026" }, p208), false);
    assert.equal(peutConcerner({ modeles: "208, 2008", identification: "7.11.2016 - 2.10.2020 // vin // 208" }, p208), true);
    assert.equal(peutConcerner({ modeles: "208", identification: "18.1.2023 - 14.3.2023" }, p208), false, "produite après la fin de la 208 I");
  });
});

describe("extraction, recoupement, comparaison", () => {
  test("un fait recopié de la page est détecté", () => {
    const page = "Sur ce moteur la courroie de distribution baigne dans l'huile et se dégrade souvent vers 80 000 km selon les garagistes.";
    assert.equal(recopie("La courroie de distribution baigne dans l'huile et se dégrade souvent vers 80 000 km", page), true);
    assert.equal(recopie("Courroie humide qui s'abîme tôt : surveiller dès 80 000 km", page), false);
  });

  const f = (url, typeSource, extra = {}) => ({ url, typeSource, km_min: null, km_max: null, cout_min: null, cout_max: null, ...extra });
  test("confirmé : 3 sources indépendantes dont une fiable ; un même site ne compte qu'une fois", () => {
    assert.equal(confiance([f("https://www.turbo.fr/a", "presse"), f("https://www.forum-peugeot.com/b", "forum"), f("https://www.idgarages.com/c", "pro")]).confiance, "confirme");
    assert.equal(confiance([f("https://a.forum.fr/1", "forum"), f("https://b.forum2.fr/2", "forum"), f("https://c.forum3.fr/3", "forum")]).confiance, "signale", "forums seuls : jamais confirmé");
    const meme = confiance([f("https://www.caradisiac.com/a", "presse"), f("https://forum-auto.caradisiac.com/b", "forum"), f("https://www.turbo.fr/c", "presse")]);
    assert.equal(meme.nbSources, 2);
    assert.equal(meme.confiance, "signale");
    assert.equal(domaineRacine("https://forum-auto.caradisiac.com/x"), "caradisiac.com");
  });
  test("contradictions de kilométrage et de coût", () => {
    assert.deepEqual(contradictions([f("https://a.fr", "presse", { km_min: 60000, km_max: 80000 }), f("https://b.fr", "pro", { km_min: 150000, km_max: 160000 })]).map(c => c.sur), ["km"]);
    assert.deepEqual(contradictions([f("https://a.fr", "presse", { km_min: 80000 }), f("https://b.fr", "pro", { km_min: 90000 })]), []);
    assert.deepEqual(contradictions([f("https://a.fr", "presse", { cout_min: 300 }), f("https://b.fr", "pro", { cout_min: 1500 })]).map(c => c.sur), ["cout"]);
  });

  test("comparaison avec la fiche : ajout, déjà présent, contradiction, coût, nouvelle fiche valide", () => {
    const kb = loadKnowledge();
    const fiche = kb.vehicules.find(x => x.id === "peugeot-208-1-12-puretech");
    const g = (titre, type, faits, extra = {}) => recouper([{ ids: faits.map((_, i) => i + 1), titre, type, motorisation: "1.2 PureTech 110", ...extra }], new Map(faits.map((x, i) => [i + 1, x])))[0];
    const trois = extra => [f("https://www.turbo.fr/a", "presse", extra), f("https://www.idgarages.com/b", "pro", extra), f("https://www.forum-peugeot.com/c", "forum", extra)];
    const nouvelle = g("Sonde de température d'eau défaillante", "panne", trois({ km_min: 100000, km_max: 120000 }));
    const p1 = proposerPourFiche(fiche, [nouvelle]);
    assert.equal(p1.length, 1);
    assert.equal(p1[0].type, "ajout");
    assert.equal(p1[0].champ, "pannes");
    assert.equal(p1[0].confiance, "confirme");
    assert.equal(p1[0].valeur.km_typique, 110000);
    const existante = fiche.pannes[0];
    assert.ok(ressemblance(existante.titre, existante.titre) === 1);
    assert.deepEqual(proposerPourFiche(fiche, [g(existante.titre, "panne", trois({ km_min: existante.km_typique - 5000, km_max: existante.km_typique + 5000 }))]), [], "déjà dans la fiche, km cohérent : rien");
    const contra = proposerPourFiche(fiche, [g(existante.titre, "panne", trois({ km_min: existante.km_typique * 2, km_max: existante.km_typique * 2 + 10000 }))]);
    assert.equal(contra[0].type, "contradiction");
    assert.match(contra[0].champ, /^pannes\.0\.km_typique$/);
    const creation = proposerNouvelleFiche({ marque: "Peugeot", modele: "208", generation: "208 I", motorisation: "1.6 BlueHDi 100" }, [nouvelle], "2026-10-15");
    assert.equal(creation.type, "creation");
    assert.deepEqual(problemesFiche("vehicules", creation.valeur), []);
    assert.equal(creation.valeur.statut, "a_verifier");
    assert.equal(creation.valeur.redige_par, "ia");
  });
});

describe("coûts et budget", () => {
  test("coût en euros d'après l'usage, recherche web comprise ; budget mensuel respecté", () => {
    const eur = coutEur("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 100_000, server_tool_use: { web_search_requests: 10 } }, 1);
    assert.equal(Math.round(eur * 100) / 100, 2 + 1 + 0.1);
    const b = createBudget({ budgetEur: 5, depenseDuMois: () => 4 });
    assert.equal(b.permet(0.5), true);
    b.ajouter(0.8);
    assert.equal(b.permet(0.5), false);
    assert.equal(createBudget({ budgetEur: 0, depenseDuMois: () => 0 }).permet(0.01), false, "sans budget : aucun appel payant");
  });
  test("l'IA refuse de lancer un appel au-delà du budget", async () => {
    let appels = 0;
    const client = { beta: { messages: { create: async () => { appels++; return { content: [], usage: {} }; } } } };
    const ia = createIA({ client, model: "claude-sonnet-5-5", budget: createBudget({ budgetEur: 0.001, depenseDuMois: () => 0 }) });
    await assert.rejects(ia.rechercher("Clio IV pannes", ["turbo.fr"]), BudgetAtteint);
    assert.equal(appels, 0);
  });
});

describe("un passage complet (faux sites, fausse IA)", () => {
  const RC = { results: [
    { date_publication: "2019-01-11T00:00:00", marque_produit: "renault", modeles_ou_references: "captur, clio iv, kangoo ii", motif_rappel: "Catalyseur mal soudé.", identification_produits: [], lien_vers_la_fiche_rappel: "https://rappel.conso.gouv.fr/fiche-rappel/1/rapex" },
    { date_publication: "2021-03-01T00:00:00", marque_produit: "renault", modeles_ou_references: "clio, megane", motif_rappel: "Vis de roue.", identification_produits: ["01.02.2015 - 01.03.2016"], lien_vers_la_fiche_rappel: "https://rappel.conso.gouv.fr/fiche-rappel/2/rapex" },
    { date_publication: "2022-03-01T00:00:00", marque_produit: "renault", modeles_ou_references: "clio v", motif_rappel: "Airbag.", identification_produits: [], lien_vers_la_fiche_rappel: "https://rappel.conso.gouv.fr/fiche-rappel/3/rapex" },
  ] };
  const fauxWeb = {
    sourceDe: h => SOURCES.find(s => s.domaines.includes(h)),
    async api(url) {
      if (url.includes("rappelconso")) return JSON.stringify(RC);
      if (url.includes("weeklyReport/list")) return "<weeklyReport><publicationDate>09/10/2026</publicationDate><URL>https://sg/1</URL></weeklyReport>";
      if (url.startsWith("https://sg/")) return "<Safety-Gate></Safety-Gate>";
      if (url.includes("ademe")) return JSON.stringify({ results: [] });
      throw new Error("adresse inattendue " + url);
    },
    async lirePage(url) {
      if (url.includes("largus")) return { refus: "site non autorisé dans le registre" };
      return { texte: "Texte d'article sur la Clio IV 1.5 dCi. ".repeat(20), url };
    },
  };
  const fausseIA = {
    async rechercher(q) { return [{ url: "https://www.turbo.fr/clio-fiabilite", titre: "Fiabilité Clio IV" }, { url: "https://www.idgarages.com/clio-volant", titre: "Volant moteur" }, { url: "https://www.largus.fr/clio", titre: "Argus" }]; },
    async extraire({ url }) { return [{ marque: "Renault", modele: "Clio", generation: "Clio IV", motorisation: "1.5 dCi 90", type: "panne", contenu: "Capteur de pression de turbo qui lâche", km_min: 90000, km_max: 110000, cout_min: 150, cout_max: 250 }]; },
    async regrouper(faits) { return [{ ids: faits.map(f => f.id), titre: "Capteur de pression de turbo défaillant", type: "panne", motorisation: "1.5 dCi 90" }]; },
  };
  function monter() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retroviz-obs-"));
    for (const f of ["voyants.json", "obd.json", "sources.json"]) fs.copyFileSync(path.join(DATA_DIR, f), path.join(dir, f));
    fs.cpSync(path.join(DATA_DIR, "marques"), path.join(dir, "marques"), { recursive: true });
    const kb = loadKnowledge(dir), db = openDb(":memory:");
    const relecture = createRelecture({ dataDir: dir, kb, now: () => "2026-10-15" });
    return { dir, kb, db, relecture, propositions: createPropositions(db, relecture) };
  }

  test("rappels officiels ajoutés une fois, ambigus proposés, faits recoupés en propositions, journal et coût", async () => {
    const { dir, kb, db, relecture, propositions } = monter();
    const budget = createBudget({ budgetEur: 5, depenseDuMois: () => 0 });
    budget.ajouter(0.12); // coût d'un passage précédent du même lancement : ne doit pas compter dans celui-ci
    const deps = { db, kb, web: fauxWeb, ia: fausseIA, relecture, propositions, budget, sources: SOURCES, model: "claude-sonnet-5-5", today: () => "2026-10-15" };
    const b = await passage("Renault Clio IV", deps);
    assert.equal(b.statut, "termine");
    assert.equal(b.rappels, 3, "Clio IV explicite : ajouté automatiquement à ses 3 motorisations");
    assert.equal(b.refusees, 1, "page refusée comptée");
    assert.equal(b.coutEur, 0);
    const fiche = aplatir(lireMarques(dir)).vehicules.find(f => f.id === "renault-clio-4-15-dci");
    assert.deepEqual(fiche.rappels.map(r => [r.source, r.mention, r.url]), [["RappelConso", "source officielle", "https://rappel.conso.gouv.fr/fiche-rappel/1/rapex"]]);
    assert.equal(fiche.statut, "a_verifier");
    const props = db.prepare("SELECT type, champ, resume, confiance, nb_sources FROM propositions").all();
    assert.ok(props.some(p => p.champ === "rappels" && /sans préciser la génération/.test(p.resume)), "rappel « clio » 2015 : à trancher");
    assert.ok(!props.some(p => /Airbag/.test(p.resume)), "rappel Clio V écarté");
    const panne = props.find(p => p.champ === "pannes");
    assert.equal(panne.type, "ajout");
    assert.equal(panne.nb_sources, 2);
    assert.equal(panne.confiance, "signale", "2 sources seulement : signalé");
    const row = db.prepare("SELECT * FROM observateur_passages").get();
    assert.equal(row.statut, "termine");
    assert.ok(JSON.parse(row.journal).some(l => l.type === "refus" && l.url.includes("largus")));
    // Second passage : rien en double.
    const b2 = await passage("Renault Clio IV", { ...deps, kb: loadKnowledge(dir) });
    assert.equal(b2.rappels, 0);
    assert.equal(b2.propositions, 0, "propositions identiques déjà en attente : pas de doublon");
  });

  test("simulation : rien n'est écrit ; budget atteint : arrêt propre", async () => {
    const { dir, kb, db, relecture, propositions } = monter();
    const avant = fs.readFileSync(path.join(dir, "marques", "renault.json"), "utf8");
    const deps = { db, kb, web: fauxWeb, ia: fausseIA, relecture, propositions, budget: createBudget({ budgetEur: 5, depenseDuMois: () => 0 }), sources: SOURCES, model: "claude-sonnet-5-5", today: () => "2026-10-15" };
    const s = await passage("Renault Clio IV", deps, { simulation: true });
    assert.ok(s.propositions > 0 && s.exemples.length > 0);
    assert.equal(fs.readFileSync(path.join(dir, "marques", "renault.json"), "utf8"), avant);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM propositions").get().n, 0);
    const iaChere = { ...fausseIA, rechercher: async () => { throw new BudgetAtteint("budget mensuel atteint"); } };
    const b = await passage("Renault Clio IV", { ...deps, ia: iaChere }, { officiels: false });
    assert.equal(b.statut, "budget_atteint");
  });
});

test("ressemblance de deux titres : un seul mot commun ne suffit pas", () => {
  assert.equal(ressemblance("Capteur de pression de turbo défaillant", "Turbo fatigué"), 0);
  assert.ok(ressemblance("Vanne EGR encrassée", "Vanne EGR ou refroidisseur EGR encrassé") >= 0.5);
});
