// Retire les métadonnées d'une image avant de la montrer à quelqu'un d'autre (dossier partagé, transfert) :
// une photo de facture peut contenir la position GPS du téléphone, la date exacte, le modèle d'appareil.
// Sans bibliothèque : on enlève seulement les blocs de métadonnées, l'image elle-même n'est pas réencodée.
//   JPEG : segments APP1 (Exif, XMP), APP13 (IPTC) et commentaires
//   PNG  : blocs tEXt, iTXt, zTXt, eXIf, tIME
//   WebP : blocs EXIF et XMP (et leurs indicateurs dans VP8X)
// PDF et HEIC ne sont pas modifiés : renvoie { buffer, nettoye: false }.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_RETIRES = new Set(["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]);

function jpeg(buf) {
  const parts = [buf.subarray(0, 2)]; // SOI
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null; // structure inattendue : on ne touche à rien
    const marker = buf[i + 1];
    if (marker === 0xd9) { parts.push(buf.subarray(i)); return Buffer.concat(parts); } // EOI
    if (marker === 0xda) { parts.push(buf.subarray(i)); return Buffer.concat(parts); } // début de l'image : la suite est copiée telle quelle
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(buf.subarray(i, i + 2)); i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    const retire = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!retire) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

function png(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const parts = [PNG_SIG];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i), type = buf.toString("latin1", i + 4, i + 8), fin = i + 12 + len;
    if (fin > buf.length) return null;
    if (!PNG_RETIRES.has(type)) parts.push(buf.subarray(i, fin));
    i = fin;
    if (type === "IEND") return Buffer.concat(parts);
  }
  return null;
}

function webp(buf) {
  if (buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunks = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const type = buf.toString("latin1", i, i + 4), len = buf.readUInt32LE(i + 4), fin = i + 8 + len + (len % 2);
    if (i + 8 + len > buf.length) return null;
    if (type !== "EXIF" && type !== "XMP ") {
      let c = Buffer.from(buf.subarray(i, Math.min(fin, buf.length)));
      if (type === "VP8X" && c.length > 8) c[8] &= ~(0x08 | 0x04); // plus d'Exif ni de XMP annoncés
      chunks.push(c);
    }
    i = fin;
  }
  const corps = Buffer.concat(chunks);
  const tete = Buffer.alloc(12);
  tete.write("RIFF", 0, "latin1"); tete.writeUInt32LE(corps.length + 4, 4); tete.write("WEBP", 8, "latin1");
  return Buffer.concat([tete, corps]);
}

const PAR_TYPE = { jpg: jpeg, png, webp };

// ext : type détecté par storage.detectType. Renvoie { buffer, nettoye } (nettoye : false si le format n'est pas pris en charge).
export function sansMetadonnees(buf, ext) {
  const f = PAR_TYPE[ext];
  if (!f) return { buffer: buf, nettoye: false };
  const out = f(buf);
  return out ? { buffer: out, nettoye: true } : { buffer: buf, nettoye: false };
}
