// Comptes Rétroviz : inscription, connexion, session par cookie, export et suppression des données (RGPD).
import crypto from "node:crypto";
import { promisify } from "node:util";
import express from "express";

const scrypt = promisify(crypto.scrypt);

export const COOKIE = "rv_session";
export const SESSION_DAYS = 30;
export const PASSWORD_MIN = 12; // recommandation CNIL pour un mot de passe seul, sans règle de complexité imposée ici
const PASSWORD_MAX = 200;
const MAX_FAILS = 5;                 // échecs de connexion tolérés par adresse…
const FAIL_WINDOW_MS = 15 * 60_000;  // …sur 15 minutes

/* ---------- mots de passe ---------- */
// Format stocké : scrypt$N$r$p$sel$hash (base64). Les paramètres sont gardés pour pouvoir les durcir plus tard.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [algo, N, r, p, salt, hash] = String(stored).split("$");
  if (algo !== "scrypt" || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}

// Hachage factice : une adresse inconnue prend autant de temps qu'un mauvais mot de passe.
const DUMMY_HASH = hashPassword("retroviz-dummy-password");

/* ---------- validation ---------- */
export function normalizeEmail(raw) {
  const email = String(raw ?? "").trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) return `Le mot de passe doit faire au moins ${PASSWORD_MIN} caractères.`;
  if (password.length > PASSWORD_MAX) return `Le mot de passe doit faire au plus ${PASSWORD_MAX} caractères.`;
  return null;
}

/* ---------- cookies ---------- */
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure || process.env.NODE_ENV === "production";
  res.append("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`);
}

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

/* ---------- middlewares partagés ---------- */
// Protection CSRF : les requêtes qui modifient quelque chose doivent venir de ce site, et les POST être en JSON
// (un formulaire d'un autre site ne peut envoyer que GET ou POST ; PUT et DELETE passent par une vérification CORS).
export function sameSiteJson(req, res, next) {
  if (req.method === "GET") return next();
  const origin = req.headers.origin;
  const sameSite = () => { try { return new URL(origin).host === req.headers.host; } catch { return false; } };
  if ((req.method === "POST" && !req.is("application/json")) || (origin && !sameSite())) {
    return res.status(403).json({ code: "forbidden", error: "Requête refusée." });
  }
  next();
}

export const needUser = (req, res, next) =>
  req.user ? next() : res.status(401).json({ code: "not_logged_in", error: "Connectez-vous pour continuer." });

/* ---------- routeur ---------- */
// Monte /api/auth/* et /api/account/* ; req.user est rempli pour toutes les routes de l'application.
// exportData(userId) ajoute à l'export RGPD les données des autres modules (garage…).
export function createAuth(db, { now = () => Date.now(), exportData = () => ({}) } = {}) {
  const q = {
    userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    userById: db.prepare("SELECT id, email, created_at FROM users WHERE id = ?"),
    insertUser: db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)"),
    deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
    passwordOf: db.prepare("SELECT password_hash FROM users WHERE id = ?"),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
    sessionUser: db.prepare(`SELECT u.id, u.email, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id
                             WHERE s.token_hash = ? AND s.expires_at > ?`),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    sessionsOf: db.prepare("SELECT created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at"),
    purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  };
  const iso = ms => new Date(ms).toISOString();
  q.purgeSessions.run(iso(now()));

  const fails = new Map(); // email -> { count, since }
  const tooManyFails = email => {
    const f = fails.get(email);
    if (f && now() - f.since > FAIL_WINDOW_MS) fails.delete(email);
    return (fails.get(email)?.count ?? 0) >= MAX_FAILS;
  };
  const addFail = email => {
    const f = fails.get(email) ?? { count: 0, since: now() };
    f.count++;
    fails.set(email, f);
  };

  function startSession(req, res, userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    q.insertSession.run(sha256(token), userId, iso(now() + SESSION_DAYS * 86_400_000));
    setSessionCookie(req, res, token, SESSION_DAYS * 86_400);
  }
  function endSession(req, res) {
    const token = readCookie(req, COOKIE);
    if (token) q.deleteSession.run(sha256(token));
    setSessionCookie(req, res, "", 0);
  }
  const publicUser = u => ({ email: u.email, createdAt: u.created_at });

  const router = express.Router();

  // Utilisateur connecté (ou null) pour toutes les routes.
  router.use((req, res, next) => {
    const token = readCookie(req, COOKIE);
    req.user = token ? q.sessionUser.get(sha256(token), iso(now())) ?? null : null;
    next();
  });

  router.use(["/api/auth", "/api/account"], sameSiteJson);

  router.post("/api/auth/signup", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!email) return res.status(400).json({ code: "invalid_email", error: "Adresse e-mail invalide." });
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ code: "weak_password", error: problem });
    const taken = () => res.status(409).json({ code: "email_taken", error: "Un compte existe déjà avec cette adresse. Connectez-vous." });
    if (q.userByEmail.get(email)) return taken();
    const hash = await hashPassword(password);
    let lastInsertRowid;
    try { ({ lastInsertRowid } = q.insertUser.run(email, hash)); }
    catch { return taken(); } // inscription simultanée avec la même adresse
    startSession(req, res, Number(lastInsertRowid));
    res.status(201).json({ user: publicUser(q.userById.get(lastInsertRowid)) });
  });

  router.post("/api/auth/login", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password.slice(0, PASSWORD_MAX) : "";
    const wrong = () => res.status(401).json({ code: "bad_credentials", error: "Adresse e-mail ou mot de passe incorrect." });
    if (!email) return wrong();
    if (tooManyFails(email)) return res.status(429).json({ code: "rate_limited", error: "Trop de tentatives. Réessayez dans 15 minutes." });
    const user = q.userByEmail.get(email);
    const ok = await verifyPassword(password, user ? user.password_hash : await DUMMY_HASH);
    if (!user || !ok) { addFail(email); return wrong(); }
    fails.delete(email);
    startSession(req, res, user.id);
    res.json({ user: publicUser(user) });
  });

  router.post("/api/auth/logout", (req, res) => {
    endSession(req, res);
    res.json({ ok: true });
  });

  router.get("/api/auth/me", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ user: req.user ? publicUser(req.user) : null });
  });

  // RGPD, droit à la portabilité : toutes les données du compte, en JSON.
  router.get("/api/account/export", needUser, (req, res) => {
    const data = {
      exportedAt: iso(now()),
      account: publicUser(req.user),
      sessions: q.sessionsOf.all(req.user.id, iso(now())).map(s => ({ createdAt: s.created_at, expiresAt: s.expires_at })),
      ...exportData(req.user.id),
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="retroviz-mes-donnees-${data.exportedAt.slice(0, 10)}.json"`);
    res.json(data);
  });

  // RGPD, droit à l'effacement : suppression définitive, mot de passe redemandé.
  router.delete("/api/account", needUser, async (req, res) => {
    const { password_hash } = q.passwordOf.get(req.user.id);
    const password = typeof req.body?.password === "string" ? req.body.password.slice(0, PASSWORD_MAX) : "";
    if (!(await verifyPassword(password, password_hash))) {
      return res.status(401).json({ code: "bad_credentials", error: "Mot de passe incorrect." });
    }
    q.deleteUser.run(req.user.id); // les sessions partent avec (ON DELETE CASCADE)
    setSessionCookie(req, res, "", 0);
    res.json({ ok: true });
  });

  return router;
}
