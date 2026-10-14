// Base de données Rétroviz (comptes, sessions) : SQLite intégré à Node (node:sqlite), un seul fichier.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "storage", "retroviz.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS vehicles (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  surnom        TEXT NOT NULL DEFAULT '',
  marque        TEXT NOT NULL,
  modele        TEXT NOT NULL,
  motorisation  TEXT NOT NULL DEFAULT '',
  annee         INTEGER,
  boite         TEXT NOT NULL DEFAULT '',
  fiche_id      TEXT,                       -- fiche de data/vehicules.json reliée, ou NULL
  fiche_refusee INTEGER NOT NULL DEFAULT 0, -- 1 : l'utilisateur a dit « ce n'est pas ma voiture »
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS vehicles_user ON vehicles(user_id);
CREATE TABLE IF NOT EXISTS releves (
  id         INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,              -- AAAA-MM-JJ
  km         INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (vehicle_id, date)              -- un relevé par jour : le nouveau remplace l'ancien
);
CREATE TABLE IF NOT EXISTS entretiens (
  id             INTEGER PRIMARY KEY,
  vehicle_id     INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,            -- AAAA-MM-JJ
  km             INTEGER,
  type           TEXT NOT NULL,            -- vidange, distribution, freins, pneus, batterie, controle_technique, reparation, autre
  description    TEXT NOT NULL DEFAULT '',
  garage         TEXT NOT NULL DEFAULT '',
  cout_centimes  INTEGER,
  facture_key    TEXT,                     -- clé dans storage.js (nom aléatoire), ou NULL
  facture_type   TEXT,                     -- extension détectée d'après le contenu : jpg, png, webp, heic, pdf
  facture_taille INTEGER,
  facture_nom    TEXT,                     -- nom d'origine, pour l'affichage seulement
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS entretiens_vehicle ON entretiens(vehicle_id, date);
CREATE TABLE IF NOT EXISTS rappels (
  id         INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  titre      TEXT NOT NULL,
  date       TEXT,                       -- AAAA-MM-JJ, ou NULL
  km         INTEGER,                    -- ou NULL (au moins l'un des deux)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

// Colonnes ajoutées après la création des tables : ajoutées aux bases existantes au démarrage.
const MIGRATIONS = {
  vehicles: {
    mise_en_circulation: "TEXT", // case B de la carte grise
    assurance_echeance: "TEXT",
    pneus_hiver: "INTEGER NOT NULL DEFAULT 0",
    vidange_km: "INTEGER",       // NULL : fiche Rétroviz ou valeur par défaut
    vidange_mois: "INTEGER",
  },
};

// Ouvre (et crée si besoin) la base. ":memory:" pour les tests.
export function openDb(file = process.env.DB_PATH || DEFAULT_DB_PATH) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  for (const [table, cols] of Object.entries(MIGRATIONS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const [col, def] of Object.entries(cols)) {
      if (!existing.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
  }
  return db;
}
