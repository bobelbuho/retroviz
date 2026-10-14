// Tests du carnet d'entretien et des factures : npm test
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { openDb } from "../db.js";
import { createAuth } from "../auth.js";
import { createGarage } from "../garage.js";
import { createCarnet, cleanCout, cleanEntretien, cleanFileName } from "../carnet.js";
import { createLocalStorage, detectType, isValidKey, MAX_FILE_SIZE } from "../storage.js";
import { loadKnowledge } from "../knowledge.js";

const PASSWORD = "un mot de passe solide";
const CLIO = { marque: "Renault", modele: "Clio IV", motorisation: "1.5 dCi 90", annee: 2016 };

// En-têtes réels de chaque format (le reste du fichier n'a pas d'importance pour la détection).
const pad = (head, n = 64) => Buffer.concat([Buffer.from(head), Buffer.alloc(n)]);
const FILES = {
  jpg: pad([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  png: pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  webp: pad([...Buffer.from("RIFF"), 0x24, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]),
  heic: pad([0, 0, 0, 0x18, ...Buffer.from("ftypheic"), 0, 0, 0, 0]),
  pdf: pad([...Buffer.from("%PDF-1.7\n")]),
};

describe("type réel des fichiers", () => {
  test("reconnaît JPEG, PNG, WebP, HEIC et PDF par leur contenu", () => {
    for (const [ext, buf] of Object.entries(FILES)) assert.equal(detectType(buf), ext);
  });
  test("refuse le reste, quelle que soit l'extension annoncée", () => {
    assert.equal(detectType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")), null);
    assert.equal(detectType(Buffer.from("MZ\x90\x00 exécutable Windows renommé en facture.pdf")), null);
    assert.equal(detectType(pad([0, 0, 0, 0x18, ...Buffer.from("ftypavif")])), null, "AVIF n'est pas du HEIC");
    assert.equal(detectType(Buffer.from("%PD")), null, "trop court");
  });
});

describe("stockage local", () => {
  test("enregistre sous un nom aléatoire, relit, supprime ; refuse les chemins", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retroviz-storage-"));
    const storage = createLocalStorage(dir);
    const key = await storage.save(FILES.pdf, { ext: "pdf" });
    assert.ok(isValidKey(key));
    assert.notEqual(key, await storage.save(FILES.pdf, { ext: "pdf" }));
    assert.deepEqual(await storage.read(key), FILES.pdf);
    await storage.remove(key);
    assert.equal(await storage.read(key), null);
    await storage.remove(key); // déjà supprimé : pas d'erreur
    await assert.rejects(storage.read("../../.env"));
    await assert.rejects(storage.save(FILES.pdf, { ext: "svg" }));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("validation d'un entretien", () => {
  test("coût en euros, virgule ou point, espaces acceptés", () => {
    assert.equal(cleanCout("89,90").centimes, 8990);
    assert.equal(cleanCout("89.9").centimes, 8990);
    assert.equal(cleanCout("1 245 €").centimes, 124500);
    assert.equal(cleanCout("").centimes, null);
    assert.ok(cleanCout("12,345").error);
    assert.ok(cleanCout("douze").error);
  });
  test("type obligatoire, kilométrage facultatif", () => {
    assert.ok(cleanEntretien({ date: "2025-03-01" }, "2026-10-14").error);
    const { data } = cleanEntretien({ date: "2025-03-01", type: "vidange", garage: "  Garage   Martin " }, "2026-10-14");
    assert.equal(data.km, null);
    assert.equal(data.alimenter, false);
    assert.equal(data.garage, "Garage Martin");
    assert.equal(cleanEntretien({ date: "2025-03-01", type: "vidange", km: "48 200" }, "2026-10-14").data.alimenter, true);
    assert.equal(cleanEntretien({ date: "2025-03-01", type: "vidange", km: 48200, alimenterReleves: false }, "2026-10-14").data.alimenter, false);
  });
  test("nom de fichier nettoyé pour l'affichage", () => {
    assert.equal(cleanFileName(encodeURIComponent("C:\\Users\\moi\\Facture vidange.pdf")), "Facture vidange.pdf");
    assert.equal(cleanFileName("../../etc/passwd"), "passwd");
    assert.equal(cleanFileName(""), "facture");
  });
});

describe("API du carnet", () => {
  let server, base, db, dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "retroviz-carnet-"));
    db = openDb(":memory:");
    const carnet = createCarnet(db, createLocalStorage(dir), { log: () => {} });
    const garage = createGarage(db, loadKnowledge(), { carnet });
    const app = express();
    app.use(express.json());
    app.use(createAuth(db, { exportData: garage.exportFor, beforeDeleteUser: carnet.beforeDeleteUser }));
    app.use(garage);
    app.use(carnet);
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://localhost:${server.address().port}`;
  });
  after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const filesOnDisk = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

  async function newUser(email) {
    let cookie = "";
    const c = async (method, p, body, headers = {}) => {
      const raw = Buffer.isBuffer(body);
      const res = await fetch(base + p, {
        method,
        headers: { ...(body !== undefined && { "Content-Type": raw ? "application/octet-stream" : "application/json" }), ...(cookie && { Cookie: cookie }), ...headers },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      const type = res.headers.get("content-type") || "";
      return { status: res.status, headers: res.headers, body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    await c("POST", "/api/auth/signup", { email, password: PASSWORD });
    return c;
  }

  test("ajout : kilométrage cohérent avec les relevés, et ajouté aux relevés", async () => {
    const c = await newUser("carnet1@exemple.fr");
    const vid = (await c("POST", "/api/garage", { ...CLIO, km: 90000 })).body.vehicule.id;
    const url = `/api/garage/${vid}/entretiens`;

    // Plus de km qu'aujourd'hui à une date passée : incohérent.
    const bad = await c("POST", url, { date: "2025-03-01", type: "vidange", km: 95000 });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.code, "incoherent_km");

    const r = await c("POST", url, { date: "2025-03-01", type: "vidange", km: "70 000", garage: "Garage Martin", cout: "89,90" });
    assert.equal(r.status, 201);
    assert.equal(r.body.entretien.typeLabel, "Vidange");
    assert.equal(r.body.entretien.cout, 89.9);
    const releves = (await c("GET", `/api/garage/${vid}/releves`)).body;
    assert.deepEqual(releves.releves.map(x => [x.date, x.km]).at(-1), ["2025-03-01", 70000]);
    assert.ok(releves.moyenneMensuelle > 0, "le kilométrage de l'entretien sert à la moyenne");

    // Case décochée : pas de nouveau relevé.
    await c("POST", url, { date: "2025-09-01", type: "pneus", km: 80000, cout: 420, alimenterReleves: false });
    assert.equal((await c("GET", `/api/garage/${vid}/releves`)).body.releves.length, 2);

    const list = (await c("GET", url)).body;
    assert.deepEqual(list.entretiens.map(e => e.type), ["pneus", "vidange"]); // le plus récent d'abord
    assert.equal(list.total, 509.9);
    const car = (await c("GET", "/api/garage")).body.vehicules[0];
    assert.deepEqual(car.carnet, { nombre: 2, dernier: { date: "2025-09-01", type: "pneus", typeLabel: "Pneus" } });

    // Modification puis suppression.
    const eid = list.entretiens[0].id;
    const put = await c("PUT", `${url}/${eid}`, { date: "2025-09-01", type: "pneus", km: 80000, cout: "450", alimenterReleves: false });
    assert.equal(put.body.total, 539.9);
    assert.equal((await c("DELETE", `${url}/${eid}`)).body.entretiens.length, 1);
    assert.equal((await c("DELETE", `${url}/${eid}`)).status, 404);
  });

  test("facture : vrai type vérifié, nom aléatoire, relue à l'identique", async () => {
    const c = await newUser("carnet2@exemple.fr");
    const vid = (await c("POST", "/api/garage", CLIO)).body.vehicule.id;
    const eid = (await c("POST", `/api/garage/${vid}/entretiens`, { date: "2025-03-01", type: "freins" })).body.entretien.id;
    const furl = `/api/garage/${vid}/entretiens/${eid}/facture`;

    const fake = await c("PUT", furl, Buffer.from("ceci n'est pas une image"), { "X-Filename": "photo.jpg" });
    assert.equal(fake.status, 415);
    const big = await c("PUT", furl, Buffer.concat([FILES.pdf, Buffer.alloc(MAX_FILE_SIZE)]));
    assert.equal(big.status, 413);
    assert.equal(big.body.code, "file_too_large");

    const up = await c("PUT", furl, FILES.png, { "X-Filename": encodeURIComponent("Facture garage.pdf") }); // extension trompeuse
    assert.equal(up.status, 200);
    assert.deepEqual(up.body.entretien.facture, { nom: "Facture garage.pdf", type: "photo PNG", taille: FILES.png.length, url: furl, image: true, pdf: false, masquee: null });
    const [stored] = filesOnDisk().filter(f => f.endsWith(".png"));
    assert.ok(isValidKey(stored), "nom aléatoire, sans le nom d'origine");

    const get = await c("GET", furl);
    assert.equal(get.headers.get("content-type"), "image/png");
    assert.equal(get.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(get.body, FILES.png);

    // Remplacer la facture efface l'ancien fichier.
    const before = filesOnDisk().length;
    await c("PUT", furl, FILES.pdf);
    assert.equal(filesOnDisk().length, before);
    assert.ok(!filesOnDisk().includes(stored));
    assert.equal((await c("GET", furl)).headers.get("content-type"), "application/pdf");

    // HEIC : proposé en téléchargement (les navigateurs ne l'affichent pas).
    await c("PUT", furl, FILES.heic);
    assert.match((await c("GET", furl)).headers.get("content-disposition"), /^attachment/);

    // Supprimer la facture seule.
    const del = await c("DELETE", furl);
    assert.equal(del.body.entretien.facture, null);
    assert.equal((await c("GET", furl)).status, 404);
  });

  test("une facture n'est accessible qu'à son propriétaire", async () => {
    const a = await newUser("carnet-proprio@exemple.fr"), b = await newUser("carnet-voisin@exemple.fr");
    const vid = (await a("POST", "/api/garage", CLIO)).body.vehicule.id;
    const eid = (await a("POST", `/api/garage/${vid}/entretiens`, { date: "2025-03-01", type: "batterie" })).body.entretien.id;
    const furl = `/api/garage/${vid}/entretiens/${eid}/facture`;
    await a("PUT", furl, FILES.jpg);
    assert.equal((await b("GET", furl)).status, 404);
    assert.equal((await b("PUT", furl, FILES.pdf)).status, 404);
    assert.equal((await b("DELETE", furl)).status, 404);
    assert.equal((await b("GET", `/api/garage/${vid}/entretiens`)).status, 404);
    assert.equal((await b("DELETE", `/api/garage/${vid}/entretiens/${eid}`)).status, 404);
    // Un entretien ne s'atteint pas par une autre voiture, même du même propriétaire.
    const other = (await a("POST", "/api/garage", CLIO)).body.vehicule.id;
    assert.equal((await a("GET", `/api/garage/${other}/entretiens/${eid}/facture`)).status, 404);
    // Sans connexion.
    assert.equal((await fetch(base + furl)).status, 401);
    assert.equal((await a("GET", furl)).status, 200);
  });

  test("factures effacées avec l'entretien, la voiture et le compte ; listées dans l'export", async () => {
    const c = await newUser("carnet3@exemple.fr");
    const add = async vid => {
      const eid = (await c("POST", `/api/garage/${vid}/entretiens`, { date: "2025-03-01", type: "autre" })).body.entretien.id;
      await c("PUT", `/api/garage/${vid}/entretiens/${eid}/facture`, FILES.pdf, { "X-Filename": "f.pdf" });
      return eid;
    };
    const v1 = (await c("POST", "/api/garage", CLIO)).body.vehicule.id;
    const v2 = (await c("POST", "/api/garage", CLIO)).body.vehicule.id;
    const start = filesOnDisk().length;

    const e1 = await add(v1);
    assert.equal(filesOnDisk().length, start + 1);
    await c("DELETE", `/api/garage/${v1}/entretiens/${e1}`);
    assert.equal(filesOnDisk().length, start, "avec l'entretien");

    await add(v1); await add(v1);
    await c("DELETE", `/api/garage/${v1}`);
    assert.equal(filesOnDisk().length, start, "avec la voiture");

    await add(v2);
    const exp = (await c("GET", "/api/account/export")).body;
    assert.equal(exp.vehicules[0].entretiens[0].facture.nom, "f.pdf");
    assert.equal(exp.vehicules[0].entretiens[0].facture.type, "PDF");

    await c("DELETE", "/api/account", { password: PASSWORD });
    assert.equal(filesOnDisk().length, start, "avec le compte");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entretiens WHERE vehicle_id = ?").get(v2).n, 0);
  });
});
