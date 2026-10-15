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
  fiche_id      TEXT,                       -- fiche de motorisation reliée (data/marques/), ou NULL
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
-- Historique des modifications d'entrées anciennes (plus de 30 jours) : gardé et affiché « modifié le … ».
-- Pour la description et le garage, seul le nom du champ est gardé (jamais l'ancien texte).
CREATE TABLE IF NOT EXISTS modifications (
  id         INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  objet      TEXT NOT NULL,              -- releve ou entretien
  objet_id   INTEGER NOT NULL,
  le         TEXT NOT NULL,              -- AAAA-MM-JJ
  champs     TEXT NOT NULL               -- JSON [{champ, avant, apres}] ; champ « suppression » pour une entrée effacée
);
CREATE INDEX IF NOT EXISTS modifications_vehicle ON modifications(vehicle_id);
-- Notes sur l'historique reçu d'un ancien propriétaire (qui, lui, ne peut plus être modifié).
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  objet      TEXT NOT NULL,              -- releve ou entretien
  objet_id   INTEGER NOT NULL,
  texte      TEXT NOT NULL,
  verrouille INTEGER NOT NULL DEFAULT 0, -- 1 : note d'un ancien propriétaire
  cree_le    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Liens de partage en lecture seule (le lien lui-même n'est jamais stocké : seulement son empreinte).
CREATE TABLE IF NOT EXISTS partages (
  id         INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  options    TEXT NOT NULL,              -- JSON : ce que le propriétaire a choisi de montrer
  cree_le    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expire_le  TEXT NOT NULL,              -- ISO
  revoque_le TEXT
);
-- Transferts à un nouveau propriétaire. Une fois accepté, plus aucun lien vers les comptes : seulement la date.
CREATE TABLE IF NOT EXISTS transferts (
  id          INTEGER PRIMARY KEY,
  vehicle_id  INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  code_hash   TEXT UNIQUE,               -- NULL une fois le transfert terminé ou annulé
  options     TEXT NOT NULL,
  cree_le     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expire_le   TEXT NOT NULL,
  statut      TEXT NOT NULL DEFAULT 'en_attente', -- en_attente, accepte, annule
  accepte_le  TEXT,                      -- AAAA-MM-JJ : « Changement de propriétaire »
  ancien_achat_date TEXT,                -- achat par le propriétaire précédent, pour la frise
  ancien_achat_km   INTEGER
);
CREATE INDEX IF NOT EXISTS transferts_vehicle ON transferts(vehicle_id, statut);
-- Avis de propriétaires. Jamais affichés avec l'identité de l'auteur ; effacés avec son compte.
-- Une voiture vendue garde l'avis de l'ancien propriétaire (l'avis reste à son auteur).
CREATE TABLE IF NOT EXISTS avis (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id       INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  cle_modele       TEXT NOT NULL,         -- marque + modèle normalisés (ou ceux de la fiche reliée)
  cle_motorisation TEXT NOT NULL,         -- fiche:<id>, ou marque + modèle + motorisation normalisés
  fiche_id         TEXT,
  voiture          TEXT NOT NULL,         -- désignation affichée
  notes            TEXT NOT NULL,         -- JSON {fiabilite, cout_entretien, confort, consommation, rapport_qualite_prix} de 1 à 5
  pannes           TEXT NOT NULL,         -- JSON [{piece, km, cout}]
  points_forts     TEXT NOT NULL DEFAULT '',
  points_faibles   TEXT NOT NULL DEFAULT '',
  recommande       INTEGER NOT NULL,
  commentaire      TEXT NOT NULL DEFAULT '',
  possession_mois  INTEGER,               -- mois dans le garage Rétroviz, au moment de la publication ou de la dernière modification
  km_parcourus     INTEGER,
  km_actuel        INTEGER,
  cree_le          TEXT NOT NULL,
  modifie_le       TEXT NOT NULL,
  statut           TEXT NOT NULL DEFAULT 'publie', -- publie ou masque (modération)
  motif_masque     TEXT,
  masque_le        TEXT,
  UNIQUE (user_id, vehicle_id)
);
CREATE INDEX IF NOT EXISTS avis_cles ON avis(statut, cle_modele, cle_motorisation);
-- Signalements d'avis : anonymes (aucun compte enregistré).
CREATE TABLE IF NOT EXISTS avis_signalements (
  id      INTEGER PRIMARY KEY,
  avis_id INTEGER NOT NULL REFERENCES avis(id) ON DELETE CASCADE,
  motif   TEXT NOT NULL,
  detail  TEXT,
  traite  INTEGER NOT NULL DEFAULT 0,
  cree_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Essais de code de transfert ratés : limite par compte et par heure (contre les codes devinés).
CREATE TABLE IF NOT EXISTS essais_transfert (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  le      TEXT NOT NULL                  -- ISO
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
    energie: "TEXT",             // thermique, hybride, hybride_rechargeable, electrique (vide : déduite de la motorisation)
    badge_obtenu: "INTEGER NOT NULL DEFAULT 0", // badge « Voiture bien suivie » au dernier calcul
    badge_change_le: "TEXT",     // date du dernier gain ou de la dernière perte du badge
  },
  releves: {
    verrouille: "INTEGER NOT NULL DEFAULT 0", // 1 : reçu d'un ancien propriétaire, ni modifiable ni supprimable
  },
  entretiens: {
    verrouille: "INTEGER NOT NULL DEFAULT 0",
    facture_masquee_key: "TEXT",  // copie masquée de la facture (rectangles noirs), utilisée pour le partage et le transfert
    facture_masquee_type: "TEXT",
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
