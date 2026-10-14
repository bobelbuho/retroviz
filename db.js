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
CREATE TABLE IF NOT EXISTS estimations (
  id              INTEGER PRIMARY KEY,
  vehicle_id      INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  date            TEXT NOT NULL,         -- AAAA-MM-JJ
  km              INTEGER,               -- dernier kilométrage connu au moment de l'estimation
  basse           INTEGER NOT NULL,
  haute           INTEGER NOT NULL,
  valeur_probable INTEGER NOT NULL,
  explication     TEXT NOT NULL,
  facteurs        TEXT NOT NULL,         -- JSON [{facteur, effet}]
  conseils        TEXT NOT NULL,         -- JSON [texte]
  modele          TEXT,                  -- modèle d'IA qui a répondu
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (vehicle_id, date)              -- une estimation par voiture et par jour (coûts)
);
CREATE TABLE IF NOT EXISTS propositions (
  id          INTEGER PRIMARY KEY,
  origine     TEXT NOT NULL,             -- observateur ou utilisateur
  type        TEXT NOT NULL,             -- creation, ajout, modification, contradiction, signalement
  collection  TEXT,                      -- voyants, obd, vehicules (ou NULL pour un signalement général)
  cible_id    TEXT,                      -- identifiant de la fiche visée
  champ       TEXT,                      -- champ visé (ex. pannes), si besoin
  valeur      TEXT,                      -- JSON : ce qui est proposé
  resume      TEXT NOT NULL,             -- une phrase lisible
  sources     TEXT NOT NULL DEFAULT '[]',-- JSON [{url, type, titre, date}]
  confiance   TEXT,                      -- confirme ou signale
  nb_sources  INTEGER NOT NULL DEFAULT 0,
  statut      TEXT NOT NULL DEFAULT 'en_attente', -- en_attente, acceptee, rejetee
  motif       TEXT,                      -- motif du rejet
  decide_par  TEXT,
  decide_le   TEXT,
  passage_id  INTEGER,                   -- passage de l'Observateur qui l'a créée
  cree_le     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS propositions_statut ON propositions(statut, type);
-- Retours sous les réponses de l'assistant : anonymes (aucun lien avec un compte).
CREATE TABLE IF NOT EXISTS retours (
  id          INTEGER PRIMARY KEY,
  mode        TEXT NOT NULL,
  avis        TEXT NOT NULL,             -- oui, non, erreur
  commentaire TEXT,
  fiches      TEXT NOT NULL DEFAULT '[]',-- JSON : fiches Rétroviz citées sous la réponse
  extrait     TEXT,                      -- début de la réponse de l'IA (jamais la question)
  cree_le     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Questions sans fiche : seulement la voiture indiquée et les codes cités, jamais le texte de la question.
CREATE TABLE IF NOT EXISTS questions_sans_fiche (
  id       INTEGER PRIMARY KEY,
  mode     TEXT NOT NULL,
  vehicule TEXT NOT NULL DEFAULT '',
  codes    TEXT NOT NULL DEFAULT '[]',
  cree_le  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Passages de l'Observateur : journal et dépenses.
CREATE TABLE IF NOT EXISTS observateur_passages (
  id          INTEGER PRIMARY KEY,
  debut       TEXT NOT NULL,
  fin         TEXT,
  cible       TEXT NOT NULL,             -- modèle ou liste traitée
  statut      TEXT NOT NULL DEFAULT 'en_cours', -- en_cours, termine, budget_atteint, erreur
  sources     INTEGER NOT NULL DEFAULT 0, -- pages et API consultées
  refusees    INTEGER NOT NULL DEFAULT 0, -- pages écartées (robots.txt, refus, connexion, paywall)
  faits       INTEGER NOT NULL DEFAULT 0,
  propositions INTEGER NOT NULL DEFAULT 0,
  rappels     INTEGER NOT NULL DEFAULT 0, -- rappels officiels ajoutés automatiquement
  cout_eur    REAL NOT NULL DEFAULT 0,
  journal     TEXT NOT NULL DEFAULT '[]' -- JSON : lignes de journal
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
    dernier_ct: "TEXT",          // date du dernier contrôle technique, si connue
    achat_date: "TEXT",          // date d'achat, si connue (départ de la page de vie)
    achat_km: "INTEGER",         // kilométrage à l'achat, si connu
    photo_key: "TEXT",           // photo de la voiture : clé dans storage.js (nom aléatoire), ou NULL
    photo_type: "TEXT",          // jpg, png ou webp, d'après le contenu
    photo_maj: "TEXT",           // date de la photo (pour le cache du navigateur)
  },
  users: {
    stats_consent: "INTEGER NOT NULL DEFAULT 0", // 1 : accepte que son carnet serve aux statistiques anonymes
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
