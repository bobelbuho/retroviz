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
`;

// Ouvre (et crée si besoin) la base. ":memory:" pour les tests.
export function openDb(file = process.env.DB_PATH || DEFAULT_DB_PATH) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}
