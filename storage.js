// Stockage des fichiers envoyés (factures). Toute l'application passe par ce module : pour passer à un
// stockage compatible S3 hébergé en Europe (Scaleway, OVH), il suffit d'écrire un autre createXxxStorage
// avec les mêmes trois fonctions et de le choisir dans server.js.
//
// Interface :
//   save(buffer, { ext })  -> clé (nom aléatoire, ex. "3f2a…-….pdf")
//   read(key)              -> Buffer, ou null si le fichier n'existe pas
//   remove(key)            -> rien (ne fait rien si le fichier n'existe déjà plus)
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const DEFAULT_UPLOAD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "storage", "uploads");
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 Mo

/* ---------- type réel d'un fichier, d'après son contenu ---------- */
// Seuls ces types sont acceptés. L'extension et le Content-Type envoyés par le navigateur sont ignorés.
export const FILE_TYPES = {
  jpg:  { mime: "image/jpeg",      label: "photo JPEG" },
  png:  { mime: "image/png",       label: "photo PNG" },
  webp: { mime: "image/webp",      label: "photo WebP" },
  heic: { mime: "image/heic",      label: "photo HEIC" },
  pdf:  { mime: "application/pdf", label: "PDF" },
};
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

// Renvoie l'extension ("jpg", "png", "webp", "heic", "pdf") ou null si le contenu n'est pas reconnu.
export function detectType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const ascii = (start, end) => buf.toString("latin1", start, end);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(8, 12))) return "heic";
  if (ascii(0, 5) === "%PDF-") return "pdf";
  return null;
}

/* ---------- stockage local ---------- */
// Clé : UUID aléatoire + extension connue. Toute autre forme est refusée (pas de « ../ » possible).
const KEY_RE = new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(${Object.keys(FILE_TYPES).join("|")})$`);
export const isValidKey = key => typeof key === "string" && KEY_RE.test(key);

export function createLocalStorage(dir = process.env.UPLOAD_DIR || DEFAULT_UPLOAD_DIR) {
  const fileOf = key => {
    if (!isValidKey(key)) throw new Error("Clé de fichier invalide.");
    return path.join(dir, key);
  };
  return {
    async save(buffer, { ext }) {
      if (!FILE_TYPES[ext]) throw new Error("Type de fichier non pris en charge.");
      await fs.mkdir(dir, { recursive: true });
      const key = `${crypto.randomUUID()}.${ext}`;
      await fs.writeFile(fileOf(key), buffer, { flag: "wx" }); // « wx » : n'écrase jamais un fichier existant
      return key;
    },
    async read(key) {
      try { return await fs.readFile(fileOf(key)); }
      catch (e) { if (e.code === "ENOENT") return null; throw e; }
    },
    async remove(key) {
      try { await fs.unlink(fileOf(key)); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
    },
  };
}
