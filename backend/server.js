"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");

// STEP 22/PHASE 2: PostgreSQL persistence is optional until DATABASE_URL is configured.
let PgPool = null;
try {
  ({ Pool: PgPool } = require("pg"));
} catch (error) {
  console.warn("[ERA] pg package not installed. Persistent DB mode will remain unavailable until dependency is installed.");
}

// STEP 3 PHASE 2: Upstox V3 real-time market feed SDK
let UpstoxClient = null;
try {
  UpstoxClient = require("upstox-js-sdk");
} catch (error) {
  console.warn("[ERA] upstox-js-sdk not installed. Real-time engine will remain OFFLINE until dependency is installed.");
}

const app = express();

const PORT = process.env.PORT || 10000;
const VERSION = "10.2.0-phase2-persistent-auth-foundation";

// STEP 22: security/cloud hardening. Existing auth/UI behavior is preserved.
const ALLOWED_ORIGIN = String(process.env.ERA_ALLOWED_ORIGIN || "*").trim();
app.use(cors({ origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN, credentials: ALLOWED_ORIGIN !== "*" }));
app.disable("x-powered-by");
app.use((req, res, next) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  req.eraRequestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
app.use(express.json({ limit: "2mb" }));

const rateBuckets = new Map();
function eraRateLimit({ windowMs = 60000, max = 60, keyPrefix = "api" } = {}) {
  return (req, res, next) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
    const key = `${keyPrefix}:${ip}`; const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) { bucket = { startedAt: now, count: 0 }; rateBuckets.set(key, bucket); }
    bucket.count += 1;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((windowMs - (now - bucket.startedAt)) / 1000)));
      return res.status(429).json({ ok:false, error:"Too many requests", requestId:req.eraRequestId });
    }
    next();
  };
}
setInterval(() => { const cutoff = Date.now() - 10 * 60_000; for (const [key, b] of rateBuckets) if (b.startedAt < cutoff) rateBuckets.delete(key); }, 5 * 60_000).unref();

// Serve the test UI from the root index.html shipped with this package.
// This avoids accidentally serving an older public/index.html from a previous deploy.
app.get("/", (req, res) => {
  const rootIndex = path.join(__dirname, "index.html");
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  const publicIndex = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);
  res.status(404).send("Era AI UI not found");
});

// Root-level PWA assets are explicitly served because the ERA UI is deployed from index.html at the project root.
for (const asset of ["service-worker.js", "manifest.json", "icon-192.png", "icon-512.png"]) {
  app.get(`/${asset}`, (req, res) => {
    const file = path.join(__dirname, asset);
    if (fs.existsSync(file)) return res.sendFile(file);
    res.status(404).end();
  });
}

app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// ENV
// ============================================================

const BACKEND_URL =
  process.env.BACKEND_URL ||
  "https://era-ai.onrender.com";

const UPSTOX_ACCESS_TOKEN =
  process.env.UPSTOX_ACCESS_TOKEN || "";

// STEP 20: Broker execution is OFF by default. Live orders require an explicit
// environment enable flag AND an explicit live=true request.
const BROKER_EXECUTION_ENABLED = String(process.env.ERA_BROKER_EXECUTION_ENABLED || "false").toLowerCase() === "true";
const BROKER_NAME = String(process.env.ERA_BROKER_NAME || "upstox").toLowerCase();
const BROKER_ORDER_BASE_URL = process.env.ERA_BROKER_ORDER_BASE_URL || "https://api-hft.upstox.com/v3";
const BROKER_STATUS_BASE_URL = process.env.ERA_BROKER_STATUS_BASE_URL || "https://api.upstox.com/v2";
const BROKER_PRODUCT = process.env.ERA_BROKER_PRODUCT || "I";

const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY || "";

const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ||
  "openai/gpt-4o-mini";

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || "";

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || "";

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT ||
  "mailto:admin@era-ai.app";

// STEP 22/PHASE 2 — persistent database readiness.
async function ensurePersistentDatabase() {
  if (!DATABASE_URL || !dbPool) return false;
  try {
    await initPersistentDatabase();
    return true;
  } catch (error) {
    dbReady = false;
    console.error("[ERA] Persistent DB initialization failed:", error.message);
    return false;
  }
}

// ============================================================
// TEST AUTH / EMAIL OTP
// ============================================================
const authOtps = new Map();
const AUTH_OTP_TTL_MS = 5 * 60 * 1000;
const AUTH_RESEND_MS = 10 * 1000;
const AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_MAX_OTP_ATTEMPTS = 5;
const authSessions = new Map();
const AUTH_SESSION_SECRET = process.env.ERA_AUTH_SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const DATABASE_URL = String(process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
const DB_SSL = String(process.env.ERA_DB_SSL || "true").toLowerCase() !== "false";
const dbPool = PgPool && DATABASE_URL ? new PgPool({ connectionString: DATABASE_URL, ssl: DB_SSL ? { rejectUnauthorized: false } : false, max: 5 }) : null;
let dbReady = false;

async function initPersistentDatabase() {
  if (!dbPool) return false;
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS era_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      mobile TEXT UNIQUE,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      login_method TEXT NOT NULL DEFAULT 'email',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS era_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES era_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_era_sessions_user ON era_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_era_sessions_expiry ON era_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS era_user_state (
      user_id TEXT PRIMARY KEY REFERENCES era_users(id) ON DELETE CASCADE,
      state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  dbReady = true;
  return true;
}

function userIdFor(user) {
  const identity = normalizeAuthEmail(user?.email || user?.mobile || "");
  return crypto.createHash("sha256").update(`${user?.loginMethod || user?.login_method || "email"}:${identity}`).digest("hex").slice(0, 32);
}

async function upsertPersistentUser(user) {
  if (!dbReady || !dbPool) return userIdFor(user);
  const id = userIdFor(user);
  await dbPool.query(`
    INSERT INTO era_users(id,email,mobile,verified,login_method) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,mobile=EXCLUDED.mobile,verified=EXCLUDED.verified,login_method=EXCLUDED.login_method,updated_at=NOW()
  `, [id, user.email || null, user.mobile || null, Boolean(user.verified), user.loginMethod || "email"]);
  return id;
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function persistAuthSession(token, user, expiresAt) {
  if (!dbReady || !dbPool) return;
  const userId = await upsertPersistentUser(user);
  await dbPool.query(`INSERT INTO era_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3) ON CONFLICT(token_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at`, [hashSessionToken(token), userId, new Date(expiresAt)]);
}

async function loadPersistentSession(token) {
  if (!dbReady || !dbPool || !token) return null;
  const r = await dbPool.query(`SELECT s.expires_at,u.email,u.mobile,u.verified,u.login_method FROM era_sessions s JOIN era_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()`, [hashSessionToken(token)]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { token, user: { ...(row.email ? { email: row.email } : {}), ...(row.mobile ? { mobile: row.mobile } : {}), verified: row.verified, loginMethod: row.login_method }, createdAt: Date.now(), expiresAt: new Date(row.expires_at).getTime() };
}

async function deletePersistentSession(token) {
  if (dbReady && dbPool && token) await dbPool.query("DELETE FROM era_sessions WHERE token_hash=$1", [hashSessionToken(token)]);
}

async function createAuthSessionPersistent(user) {
  const token = createAuthSession(user);
  const expiresAt = Date.now() + AUTH_SESSION_TTL_MS;
  await persistAuthSession(token, user, expiresAt);
  return token;
}

function createAuthSession(user) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const token = crypto.createHmac("sha256", AUTH_SESSION_SECRET).update(sessionId).digest("hex");
  authSessions.set(token, { user: { ...user }, createdAt: Date.now(), expiresAt: Date.now() + AUTH_SESSION_TTL_MS });
  return token;
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getAuthSession(req) {
  const token = parseCookies(req).era_session;
  if (!token) return null;
  const session = authSessions.get(token);
  if (!session || Date.now() > session.expiresAt) {
    if (session) authSessions.delete(token);
    return null;
  }
  return { token, ...session };
}

const USER_SCOPED_STATE_KEYS = [
  "settings",
  "alerts",
  "pushSubscriptions",
  "history",
  "setupMemory",
  "notificationHistory",
  "tradeAlerts",
  "paper",
  "journal",
  "executionLedger",
  "backtests",
  "risk"
];

const userStateLocks = new Map();

function cloneJson(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

function getUserScopedStateSnapshot() {
  const snapshot = {};
  for (const key of USER_SCOPED_STATE_KEYS) snapshot[key] = cloneJson(state[key]);
  snapshot.aiSelfAudit = cloneJson(state.aiSelfAudit || null);
  return snapshot;
}

function applyUserScopedState(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  for (const key of USER_SCOPED_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) state[key] = cloneJson(snapshot[key]);
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, "aiSelfAudit")) state.aiSelfAudit = cloneJson(snapshot.aiSelfAudit);
}

async function loadUserScopedState(userId) {
  if (!dbReady || !dbPool || !userId) return;
  const result = await dbPool.query("SELECT state_json FROM era_user_state WHERE user_id=$1", [userId]);
  if (result.rows.length) {
    applyUserScopedState(result.rows[0].state_json || {});
    return;
  }
  // One-time compatibility bootstrap: the first authenticated user receives the
  // existing legacy file state. New users receive clean defaults thereafter.
  const bootstrap = getUserScopedStateSnapshot();
  await dbPool.query(
    "INSERT INTO era_user_state(user_id,state_json) VALUES($1,$2::jsonb) ON CONFLICT(user_id) DO NOTHING",
    [userId, JSON.stringify(bootstrap)]
  );
}

async function saveUserScopedState(userId) {
  if (!dbReady || !dbPool || !userId) return;
  const snapshot = getUserScopedStateSnapshot();
  await dbPool.query(
    `INSERT INTO era_user_state(user_id,state_json,updated_at) VALUES($1,$2::jsonb,NOW())
     ON CONFLICT(user_id) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=NOW()`,
    [userId, JSON.stringify(snapshot)]
  );
}

async function withUserStateLock(userId, task) {
  const previous = userStateLocks.get(userId) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  userStateLocks.set(userId, current);
  await previous;
  try { return await task(); } finally {
    release();
    if (userStateLocks.get(userId) === current) userStateLocks.delete(userId);
  }
}

async function requireAuth(req, res, next) {
  try {
    const token = parseCookies(req).era_session;
    const session = getAuthSession(req) || await loadPersistentSession(token);
    if (!session) return res.status(401).json({ ok:false, error:"Authentication required.", code:"AUTH_REQUIRED", requestId:req.eraRequestId });
    req.eraUser = session.user;
    req.eraUserId = userIdFor(session.user);
    if (!dbReady || !dbPool) {
      return res.status(503).json({ok:false,error:"Persistent user database is required for authenticated data access.",code:"USER_DB_REQUIRED",requestId:req.eraRequestId});
    }
    const previous = userStateLocks.get(req.eraUserId) || Promise.resolve();
    let releaseLock;
    const lockPromise = new Promise(resolve => { releaseLock = resolve; });
    userStateLocks.set(req.eraUserId, lockPromise);
    await previous;
    await loadUserScopedState(req.eraUserId);
    let released = false;
    const finish = async () => {
      if (released) return;
      released = true;
      try { await saveUserScopedState(req.eraUserId); }
      catch (error) { console.error("[ERA] User state persistence error:", error.message); }
      releaseLock();
      if (userStateLocks.get(req.eraUserId) === lockPromise) userStateLocks.delete(req.eraUserId);
    };
    res.once("finish", finish);
    res.once("close", finish);
    next();
  } catch (error) {
    return res.status(503).json({ ok:false, error:"Authentication service unavailable.", code:"AUTH_SERVICE_UNAVAILABLE", requestId:req.eraRequestId });
  }
}
function setAuthCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `era_session=${encodeURIComponent(token)}; Max-Age=${Math.floor(AUTH_SESSION_TTL_MS/1000)}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function normalizeAuthEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeAuthEmail(value));
}

function isValidMobile(value) {
  return /^[+]?[0-9\s-]{10,16}$/.test(String(value || "").trim());
}

function maskEmail(email) {
  const [name, domain] = email.split("@");
  if (!name) return email;
  return `${name.length <= 2 ? name[0] + "*" : name[0] + "***" + name.slice(-1)}@${domain}`;
}

async function sendEmailOtp(email, otp) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Resend is not configured. Add RESEND_API_KEY in Render Environment.");
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
  const fromName = process.env.RESEND_FROM_NAME || "ERA AI";

  const response = await axios.post(
    "https://api.resend.com/emails",
    {
      from: `${fromName} <${fromEmail}>`,
      to: [email],
      subject: `${otp} is your ERA AI login OTP`,
      text: `Your ERA AI login OTP is ${otp}. It expires in 5 minutes. If you did not request this, ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px"><h2>ERA AI Login</h2><p>Your 6-digit OTP is:</p><div style="font-size:34px;font-weight:700;letter-spacing:8px;padding:16px 0">${otp}</div><p>This OTP expires in 5 minutes.</p><p style="color:#777">If you did not request this code, you can ignore this email.</p></div>`
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );

  if (!response.data?.id) {
    throw new Error("Resend did not accept the email request.");
  }
  return response.data;
}

app.post("/api/auth/send-otp", eraRateLimit({windowMs:10*60_000,max:8,keyPrefix:"otp-send"}), async (req, res) => {
  try {
    const mode = req.body?.mode === "mobile" ? "mobile" : "email";
    const value = String(req.body?.value || "").trim();

    if (mode === "email" && !isValidEmail(value)) {
      return res.status(400).json({ ok: false, error: "Enter a valid Gmail or email address." });
    }
    if (mode === "mobile" && !isValidMobile(value)) {
      return res.status(400).json({ ok: false, error: "Enter a valid mobile number." });
    }

    const key = `${mode}:${mode === "email" ? normalizeAuthEmail(value) : value.replace(/\D/g, "")}`;
    const previous = authOtps.get(key);
    if (previous && Date.now() - previous.sentAt < AUTH_RESEND_MS) {
      return res.status(429).json({ ok: false, error: "Please wait a few seconds before requesting another OTP." });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    authOtps.set(key, { otp, sentAt: Date.now(), expiresAt: Date.now() + AUTH_OTP_TTL_MS, attempts: 0 });

    if (mode === "email") {
      await sendEmailOtp(normalizeAuthEmail(value), otp);
      return res.json({ ok: true, destination: normalizeAuthEmail(value), message: `OTP sent to ${maskEmail(normalizeAuthEmail(value))}.` });
    }

    authOtps.delete(key);
    return res.status(503).json({ ok: false, error: "Mobile OTP is not configured yet. Add an SMS provider in Render Environment Variables." });
  } catch (error) {
    console.error("[ERA] OTP send error:", error.message);
    return res.status(500).json({ ok: false, error: error.message || "Could not send OTP." });
  }
});

app.post("/api/auth/verify-otp", eraRateLimit({windowMs:10*60_000,max:20,keyPrefix:"otp-verify"}), async (req, res) => {
  const mode = req.body?.mode === "mobile" ? "mobile" : "email";
  const value = String(req.body?.value || "").trim();
  const otp = String(req.body?.otp || "").trim();
  const normalized = mode === "email" ? normalizeAuthEmail(value) : value.replace(/\D/g, "");
  const key = `${mode}:${normalized}`;
  const record = authOtps.get(key);

  if (!/^\d{6}$/.test(otp)) return res.status(400).json({ ok: false, error: "Enter the 6-digit OTP." });
  if (!record) return res.status(400).json({ ok: false, error: "OTP not found. Please request a new OTP." });
  if (Date.now() > record.expiresAt) { authOtps.delete(key); return res.status(400).json({ ok: false, error: "OTP expired. Please request a new OTP." }); }
  if (record.otp !== otp) {
    record.attempts = Number(record.attempts || 0) + 1;
    if (record.attempts >= AUTH_MAX_OTP_ATTEMPTS) authOtps.delete(key);
    return res.status(400).json({ ok: false, error: record.attempts >= AUTH_MAX_OTP_ATTEMPTS ? "Too many incorrect OTP attempts. Please request a new OTP." : "Incorrect OTP. Please try again." });
  }

  authOtps.delete(key);
  const user = mode === "email" ? { email: normalized, verified: true, loginMethod: "email" } : { mobile: normalized, verified: true, loginMethod: "mobile" };
  let sessionToken;
  try {
    sessionToken = await createAuthSessionPersistent(user);
  } catch (error) {
    console.error("[ERA] Persistent auth session error:", error.message);
    return res.status(503).json({ ok:false, error:"Authentication persistence is temporarily unavailable.", code:"AUTH_PERSISTENCE_UNAVAILABLE" });
  }
  setAuthCookie(res, sessionToken);
  return res.json({ ok: true, user });
});

app.get("/api/auth/me", async (req, res) => {
  const session = getAuthSession(req) || await loadPersistentSession(parseCookies(req).era_session);
  if (!session) return res.status(401).json({ ok:false, authenticated:false });
  res.json({ ok:true, authenticated:true, user:session.user, expiresAt:new Date(session.expiresAt).toISOString() });
});

app.post("/api/auth/logout", async (req, res) => {
  const token = parseCookies(req).era_session;
  if (token) authSessions.delete(token);
  await deletePersistentSession(token);
  res.setHeader("Set-Cookie", "era_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
  res.json({ ok:true });
});

if (
  VAPID_PUBLIC_KEY &&
  VAPID_PRIVATE_KEY
) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

// ============================================================
// INDEX CONFIGURATION
// ============================================================

const INDICES = {
  NIFTY: {
    symbol: "NSE_INDEX|Nifty 50",
    name: "NIFTY 50",
    exchange: "NSE",
    lotSize: 65
  },

  BANKNIFTY: {
    symbol: "NSE_INDEX|Nifty Bank",
    name: "BANK NIFTY",
    exchange: "NSE",
    lotSize: 30
  },

  FINNIFTY: {
    symbol: "NSE_INDEX|Nifty Fin Service",
    name: "FIN NIFTY",
    exchange: "NSE",
    lotSize: 60
  },

  SENSEX: {
    symbol: "BSE_INDEX|SENSEX",
    name: "SENSEX",
    exchange: "BSE",
    lotSize: 20
  }
};

const EXTRA_SYMBOLS = {
  GIFT_NIFTY: "GLOBAL_INDEX|SGX NIFTY",
  INDIA_VIX: "NSE_INDEX|India VIX"
};

// ============================================================
// STATE
// ============================================================

const state = {
  engineRunning: true,

  lastSuccess: null,
  lastError: null,
  lastScan: null,
  lastNewsFetch: null,

  market: {
    NIFTY: null,
    BANKNIFTY: null,
    FINNIFTY: null,
    SENSEX: null,
    GIFT_NIFTY: null,
    INDIA_VIX: null
  },

  analysis: {},

  activeTrades: [],

  alerts: [],

  news: [],

  // STEP 16 — NEWS + GLOBAL INTELLIGENCE
  globalIntelligence: {
    status: "UNAVAILABLE",
    updatedAt: null,
    sourceStatus: {},
    riskLevel: "LOW",
    riskScore: 0,
    marketBias: "NEUTRAL",
    themes: [],
    events: [],
    sources: [],
    failures: []
  },

  history: [],

  pushSubscriptions: [],

  previousPrices: {},

  previousSignals: {},

  // STEP 11 — SETUP MEMORY / ANTI-REPEAT
  // Keeps the current setup lifecycle so the same trade is not emitted
  // repeatedly while the market remains in the same setup.
  setupMemory: {},

  notificationHistory: {},

  // STEP 13 — TRADE ALERT / POPUP ACTION STATE
  tradeAlerts: [],

  settings: {
    movementThreshold: 20,
    minConfidence: 65,
    scanIntervalMs: 60000,
    newsIntervalMs: 300000,
    notificationCooldownMs: 15 * 60 * 1000,
    notifications: {
      marketOpen: true,
      movement: true,
      tradeSetup: true,
      news: true,
      marketClose: true
    }
  },

  paper: {
    startingCapital: 100000,
    cash: 100000,
    positions: [],
    orders: [],
    realizedPnl: 0,
    unrealizedPnl: 0,
    closedTrades: []
  },

  journal: [],

  // STEP 15 — PERMANENT APPEND-ONLY EXECUTION LEDGER
  // This is the canonical execution/history source for paper trades and future broker trades.
  executionLedger: [],

  // STEP 17 — PROFESSIONAL BACKTESTING
  backtests: [],

  risk: {
    riskPerTrade: 1,
    maxDailyLoss: 2,
    maxTradeLoss: 1,
    maxPositions: 3,
    maxTradesPerDay: 5,
    maxExposure: 50,
    killSwitch: false
  }
};

// ============================================================
// STEP 3 PHASE 2 — REAL-TIME TICK ENGINE
// ============================================================
// The existing REST scanner remains untouched. This layer adds a persistent
// Upstox V3 MarketDataStreamerV3 connection and keeps the latest tick state
// in memory. OpenAI is NOT called for every tick.
const realtime = {
  status: "OFFLINE",
  connectedAt: null,
  lastTickAt: null,
  lastError: null,
  reconnects: 0,
  ticks: 0,
  perIndex: {},
  clients: new Set(),
  streamer: null,
  started: false,
  reconnectTimer: null
};

for (const index of Object.keys(INDICES)) {
  realtime.perIndex[index] = {
    instrumentKey: INDICES[index].symbol,
    price: null,
    previousPrice: null,
    tickChange: 0,
    tickChangePct: 0,
    tickVelocity: 0,
    tickCount: 0,
    lastTradeQty: 0,
    cumulativeVolume: 0,
    oi: 0,
    bid: null,
    ask: null,
    spread: null,
    spreadPct: null,
    high: null,
    low: null,
    open: null,
    close: null,
    timestamp: null,
    stale: true
  };
}

function realtimeBroadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of realtime.clients) {
    try { client.write(message); } catch (_) { realtime.clients.delete(client); }
  }
}

function realtimeSnapshot() {
  return {
    ok: true,
    version: VERSION,
    status: realtime.status,
    connectedAt: realtime.connectedAt,
    lastTickAt: realtime.lastTickAt,
    lastError: realtime.lastError,
    reconnects: realtime.reconnects,
    ticks: realtime.ticks,
    marketOpen: isMarketHours(),
    indices: realtime.perIndex,
    updatedAt: nowISO()
  };
}

function safeRealtimeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function extractRealtimeFeed(message) {
  if (!message) return null;
  if (typeof message === "object" && !Buffer.isBuffer(message)) return message;
  const buffer = Buffer.isBuffer(message) ? message : Buffer.from(String(message));
  try { return JSON.parse(buffer.toString("utf8")); } catch (_) { return null; }
}

function findRealtimeFeed(feed, instrumentKey) {
  const feeds = feed?.feeds || feed?.data?.feeds || feed?.data || {};
  return feeds[instrumentKey] || feeds[instrumentKey.replace("|", ":")] || null;
}

function normalizeRealtimeTick(index, rawFeed) {
  const raw = rawFeed || {};

  // Upstox V3 full-mode index payload:
  // feeds[INSTRUMENT].fullFeed.indexFF.ltpc
  // feeds[INSTRUMENT].fullFeed.indexFF.marketOHLC
  const indexFF =
    raw.fullFeed?.indexFF ||
    raw.ff?.indexFF ||
    raw.indexFF ||
    raw.full_feed?.indexFF ||
    {};

  const ltpc = indexFF.ltpc || raw.ltpc || raw.LTPC || {};
  const ohlc = indexFF.marketOHLC?.ohlc ||
    raw.marketOHLC?.ohlc ||
    raw.market_ohlc?.ohlc ||
    [];

  const day = Array.isArray(ohlc)
    ? (ohlc.find(x => x?.interval === "1d") || ohlc[0] || {})
    : {};

  const depth =
    indexFF.marketLevel?.bidAskQuote ||
    raw.fullFeed?.marketLevel?.bidAskQuote ||
    raw.marketLevel?.bidAskQuote ||
    raw.bidAskQuote ||
    {};

  const price = safeRealtimeNumber(ltpc.ltp ?? raw.ltp, null);
  if (!Number.isFinite(price)) return null;

  const now = Date.now();
  const current = realtime.perIndex[index];
  const previous = current.price;
  const dt = current.timestamp
    ? Math.max(1, now - new Date(current.timestamp).getTime())
    : 0;

  const delta = previous == null ? 0 : price - previous;
  const velocity = dt > 0 ? delta / (dt / 1000) : 0;

  const bid = safeRealtimeNumber(depth.bidP ?? depth.bidPrice ?? depth.bid, null);
  const ask = safeRealtimeNumber(depth.askP ?? depth.askPrice ?? depth.ask, null);
  const spread = Number.isFinite(bid) && Number.isFinite(ask) ? ask - bid : null;
  const spreadPct = spread !== null && price ? (spread / price) * 100 : null;

  const volume = safeRealtimeNumber(
    ltpc.volume ?? indexFF.volume ?? raw.volume ?? day.vol ?? day.volume,
    current.cumulativeVolume || 0
  );

  const oi = safeRealtimeNumber(
    indexFF.oi ?? raw.oi ?? raw.eFeedDetails?.oi ?? current.oi,
    current.oi || 0
  );

  const tradeQty = safeRealtimeNumber(
    ltpc.ltq ?? ltpc.ltqQty ?? raw.ltq ?? raw.ltqQty,
    0
  );

  const timestampMs = safeRealtimeNumber(
    ltpc.ltt ?? feedTimestamp(rawFeed),
    now
  );

  current.previousPrice = previous;
  current.price = price;
  current.tickChange = delta;
  current.tickChangePct = previous ? (delta / previous) * 100 : 0;
  current.tickVelocity = velocity;
  current.tickCount += 1;
  current.lastTradeQty = tradeQty;
  current.cumulativeVolume = volume;
  current.oi = oi;
  current.bid = Number.isFinite(bid) ? bid : current.bid;
  current.ask = Number.isFinite(ask) ? ask : current.ask;
  current.spread = spread;
  current.spreadPct = spreadPct;
  current.high = safeRealtimeNumber(day.high ?? raw.high, current.high || price);
  current.low = safeRealtimeNumber(day.low ?? raw.low, current.low || price);
  current.open = safeRealtimeNumber(day.open ?? raw.open, current.open || price);
  current.close = safeRealtimeNumber(
    day.close ?? raw.close ?? ltpc.cp,
    current.close || price
  );
  current.timestamp = new Date(timestampMs).toISOString();
  current.stale = false;

  state.market[index] = {
    ...(state.market[index] || {}),
    price,
    volume,
    oi,
    open: current.open,
    high: current.high,
    low: current.low,
    close: current.close,
    timestamp: current.timestamp,
    stale: false,
    source: "upstox-v3-websocket",
    realtime: {
      tickChange: round(current.tickChange, 4),
      tickChangePct: round(current.tickChangePct, 5),
      tickVelocity: round(current.tickVelocity, 5),
      bid: current.bid,
      ask: current.ask,
      spread: current.spread,
      spreadPct: current.spreadPct,
      lastTradeQty: current.lastTradeQty,
      tickCount: current.tickCount
    }
  };

  return current;
}

function feedTimestamp(rawFeed) {
  return rawFeed?.currentTs || rawFeed?.current_ts || Date.now();
}

function handleRealtimeMessage(message) {
  const feed = extractRealtimeFeed(message);

  if (!feed) {
    // Some SDK versions expose decoded feed objects; if this is an opaque
    // protobuf buffer, the SDK/dependency must decode it before this handler.
    return;
  }

  realtime.ticks += 1;
  realtime.lastTickAt = nowISO();
  realtime.lastError = null;

  for (const index of Object.keys(INDICES)) {
    const raw = findRealtimeFeed(feed, INDICES[index].symbol);
    if (!raw) continue;
    const tick = normalizeRealtimeTick(index, raw);
    if (!tick) continue;
    realtimeBroadcast("tick", {
      index,
      tick: {
        ...tick,
        price: round(tick.price, 2),
        tickChange: round(tick.tickChange, 4),
        tickChangePct: round(tick.tickChangePct, 5),
        tickVelocity: round(tick.tickVelocity, 5)
      },
      at: realtime.lastTickAt
    });
  }
}

function markRealtimeStale() {
  const last = realtime.lastTickAt ? Date.now() - new Date(realtime.lastTickAt).getTime() : Infinity;
  const stale = last > 10000;
  for (const index of Object.keys(realtime.perIndex)) {
    realtime.perIndex[index].stale = stale;
  }
  if (stale && realtime.status === "LIVE") {
    realtime.status = "RECONNECTING";
    realtimeBroadcast("status", realtimeSnapshot());
  }
}

function startRealtimeMarketFeed() {
  if (realtime.started) return;
  realtime.started = true;

  if (!UPSTOX_ACCESS_TOKEN) {
    realtime.status = "OFFLINE";
    realtime.lastError = "UPSTOX_ACCESS_TOKEN is not configured.";
    console.warn("[ERA] Real-time engine OFFLINE: UPSTOX_ACCESS_TOKEN missing.");
    return;
  }

  if (!UpstoxClient?.MarketDataStreamerV3) {
    realtime.status = "OFFLINE";
    realtime.lastError = "upstox-js-sdk dependency is missing.";
    console.warn("[ERA] Real-time engine OFFLINE: install upstox-js-sdk.");
    return;
  }

  try {
    const oauth = UpstoxClient.ApiClient.instance.authentications["OAUTH2"];
    oauth.accessToken = UPSTOX_ACCESS_TOKEN;

    const keys = Object.values(INDICES).map(x => x.symbol);
    const streamer = new UpstoxClient.MarketDataStreamerV3(keys, "full");
    realtime.streamer = streamer;

    if (typeof streamer.autoReconnect === "function") {
      streamer.autoReconnect(true, 5, 0);
    }

    streamer.on("open", () => {
      realtime.status = "LIVE";
      realtime.connectedAt = nowISO();
      realtime.lastError = null;
      realtimeBroadcast("status", realtimeSnapshot());
      console.log("[ERA] Upstox V3 realtime LIVE");
    });

    streamer.on("message", handleRealtimeMessage);

    streamer.on("reconnecting", () => {
      realtime.status = "RECONNECTING";
      realtime.reconnects += 1;
      realtimeBroadcast("status", realtimeSnapshot());
      console.warn("[ERA] Upstox realtime reconnecting...");
    });

    streamer.on("close", () => {
      realtime.status = "RECONNECTING";
      realtimeBroadcast("status", realtimeSnapshot());
      console.warn("[ERA] Upstox realtime connection closed.");
    });

    streamer.on("error", error => {
      realtime.status = "RECONNECTING";
      realtime.lastError = apiError(error);
      realtimeBroadcast("status", realtimeSnapshot());
      console.error("[ERA] Upstox realtime error:", realtime.lastError);
    });

    streamer.on("autoReconnectStopped", data => {
      realtime.status = "OFFLINE";
      realtime.lastError = apiError(data);
      realtimeBroadcast("status", realtimeSnapshot());
    });

    streamer.connect();
  } catch (error) {
    realtime.status = "OFFLINE";
    realtime.lastError = apiError(error);
    realtime.started = false;
    console.error("[ERA] Realtime startup error:", realtime.lastError);
  }
}

app.get("/api/realtime/status", (req, res) => {
  res.json(realtimeSnapshot());
});

app.get("/api/realtime/ticks", (req, res) => {
  res.json(realtimeSnapshot());
});

app.get("/api/realtime/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const send = () => {
    try { res.write(`event: snapshot\ndata: ${JSON.stringify(realtimeSnapshot())}\n\n`); } catch (_) {}
  };
  realtime.clients.add(res);
  send();
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat ${Date.now()}\\n\\n`); } catch (_) {}
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    realtime.clients.delete(res);
  });
});

setInterval(markRealtimeStale, 2000);

// ============================================================
// FILE STORAGE
// ============================================================

const DATA_DIR =
  path.join(__dirname, "data");

const STATE_FILE =
  path.join(DATA_DIR, "era-state.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return;
    }

    const saved =
      JSON.parse(
        fs.readFileSync(
          STATE_FILE,
          "utf8"
        )
      );

    if (
      Array.isArray(
        saved.pushSubscriptions
      )
    ) {
      state.pushSubscriptions =
        saved.pushSubscriptions;
    }

    if (
      Array.isArray(saved.history)
    ) {
      state.history =
        saved.history;
    }

    if (
      Array.isArray(saved.alerts)
    ) {
      state.alerts =
        saved.alerts;
    }

    if (Array.isArray(saved.tradeAlerts)) {
      state.tradeAlerts = saved.tradeAlerts;
    }

    if (saved.settings && typeof saved.settings === "object") {
      state.settings = {
        ...state.settings,
        ...saved.settings,
        notifications: {
          ...state.settings.notifications,
          ...(saved.settings.notifications || {})
        }
      };
    }

    if (saved.globalIntelligence && typeof saved.globalIntelligence === "object") {
      state.globalIntelligence = {
        ...state.globalIntelligence,
        ...saved.globalIntelligence,
        sourceStatus: saved.globalIntelligence.sourceStatus || {},
        themes: Array.isArray(saved.globalIntelligence.themes) ? saved.globalIntelligence.themes : [],
        events: Array.isArray(saved.globalIntelligence.events) ? saved.globalIntelligence.events : [],
        sources: Array.isArray(saved.globalIntelligence.sources) ? saved.globalIntelligence.sources : [],
        failures: Array.isArray(saved.globalIntelligence.failures) ? saved.globalIntelligence.failures : []
      };
    }

    if (saved.notificationHistory && typeof saved.notificationHistory === "object") {
      state.notificationHistory = saved.notificationHistory;
    }

    if (saved.setupMemory && typeof saved.setupMemory === "object") {
      state.setupMemory = saved.setupMemory;
    }

    if (Array.isArray(saved.backtests)) {
      state.backtests = saved.backtests;
    }

    if (saved.paper && typeof saved.paper === "object") {
      state.paper = { ...state.paper, ...saved.paper, positions: Array.isArray(saved.paper.positions) ? saved.paper.positions : [], orders: Array.isArray(saved.paper.orders) ? saved.paper.orders : [], closedTrades: Array.isArray(saved.paper.closedTrades) ? saved.paper.closedTrades : [] };
    }

    if (Array.isArray(saved.journal)) state.journal = saved.journal;
    if (Array.isArray(saved.executionLedger)) state.executionLedger = saved.executionLedger;
    if (saved.risk && typeof saved.risk === "object") state.risk = { ...state.risk, ...saved.risk };

  } catch (error) {
    console.error(
      "[ERA] State load error:",
      error.message
    );
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          globalIntelligence:
            state.globalIntelligence
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      "[ERA] State save error:",
      error.message
    );
  }
}

function migrateLegacyPaperHistory() {
  if (Array.isArray(state.executionLedger) && state.executionLedger.length) return;
  const orders = Array.isArray(state.paper?.orders) ? state.paper.orders : [];
  const closed = Array.isArray(state.paper?.closedTrades) ? state.paper.closedTrades : [];
  const migrated = [];
  const tradeIdByPosition = new Map();

  for (const order of [...orders].reverse()) {
    if (String(order?.side || "").toUpperCase() !== "BUY") continue;
    const tradeId = `LEGACY-${order.positionId || order.id}`;
    if (tradeIdByPosition.has(order.positionId || order.id)) continue;
    tradeIdByPosition.set(order.positionId || order.id, tradeId);
    migrated.push({
      id:`EX-LEGACY-${order.id}`, tradeId, eventType:"OPEN", executionType:"PAPER", side:"BUY",
      index:order.index||null, optionType:order.optionType||null, strike:Number(order.strike||0)||null, expiry:order.expiry||null,
      instrumentKey:order.instrumentKey||null, quantity:Number(order.quantity||0), price:Number(order.price||0),
      source:order.source||"LEGACY_PAPER", positionId:order.positionId||null, alertId:order.alertId||null,
      executedAt:order.createdAt||nowISO(), stopLoss:0, targets:[], pnl:null, pnlPercent:null, result:null, reason:null, confidence:null, reasoning:null
    });
  }

  for (const c of [...closed].reverse()) {
    const tradeId = tradeIdByPosition.get(c.positionId) || `LEGACY-${c.positionId || c.id}`;
    if (!tradeIdByPosition.has(c.positionId)) tradeIdByPosition.set(c.positionId, tradeId);
    migrated.push({
      id:`EX-LEGACY-CLOSE-${c.id}`, tradeId, eventType:"CLOSE", executionType:"PAPER", side:"SELL",
      index:c.index||null, optionType:c.optionType||null, strike:Number(c.strike||0)||null, expiry:c.expiry||null, instrumentKey:c.instrumentKey||null,
      quantity:Number(c.quantity||0), price:Number(c.exit||0), stopLoss:Number(c.stopLoss||0), targets:Array.isArray(c.targets)?c.targets:[],
      pnl:Number(c.pnl||0), pnlPercent:Number(c.pnlPercent||0), reason:c.reason||null, result:c.reason||null, confidence:c.confidence??null,
      reasoning:c.reasoning||null, source:"LEGACY_PAPER", alertId:c.alertId||null, positionId:c.positionId||null, executedAt:c.closedAt||nowISO()
    });
  }

  if (migrated.length) {
    state.executionLedger = migrated;
    saveState();
  }
}

migrateLegacyPaperHistory();

// ============================================================
// HELPERS
// ============================================================

function round(
  value,
  decimals = 2
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return 0;
  }

  const factor =
    Math.pow(
      10,
      decimals
    );

  return (
    Math.round(
      number * factor
    ) / factor
  );
}

function safeNumber(
  value,
  fallback = 0
) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function clamp(
  value,
  min,
  max
) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function nowISO() {
  return new Date().toISOString();
}

function normalizeIndex(index) {
  return String(index || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

// ============================================================
// MARKET HOURS
// ============================================================

function getIndiaTimeParts() {
  const formatter =
    new Intl.DateTimeFormat(
      "en-IN",
      {
        timeZone: "Asia/Kolkata",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }
    );

  const parts =
    formatter.formatToParts(
      new Date()
    );

  const map = {};

  for (const part of parts) {
    map[part.type] =
      part.value;
  }

  return {
    weekday: map.weekday,
    hour:
      Number(map.hour),
    minute:
      Number(map.minute)
  };
}

function isMarketHours() {
  const {
    weekday,
    hour,
    minute
  } = getIndiaTimeParts();

  const weekdays = [
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri"
  ];

  if (
    !weekdays.includes(
      weekday
    )
  ) {
    return false;
  }

  const totalMinutes =
    hour * 60 + minute;

  return (
    totalMinutes >= 555 &&
    totalMinutes <= 930
  );
}

// ============================================================
// UPSTOX REQUEST
// ============================================================

async function upstoxRequest(
  url,
  params = {},
  timeout = 20000
) {
  if (
    !UPSTOX_ACCESS_TOKEN
  ) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is not configured"
    );
  }

  const response =
    await axios.get(
      url,
      {
        params,
        timeout,
        headers: {
          Accept:
            "application/json",

          Authorization:
            `Bearer ${UPSTOX_ACCESS_TOKEN}`
        }
      }
    );

  return response.data;
}

// STEP 20: authenticated broker request helper for order operations.
async function upstoxOrderRequest(method, url, body = null, timeout = 20000) {
  if (!UPSTOX_ACCESS_TOKEN) throw new Error("UPSTOX_ACCESS_TOKEN is not configured");
  const config = {
    method,
    url,
    timeout,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}`
    }
  };
  if (body !== null) config.data = body;
  const response = await axios(config);
  return response.data;
}

// ============================================================
// MARKET QUOTE V3
// ============================================================

async function fetchFullMarketQuotes() {
  const instrumentKeys =
    Object.values(INDICES)
      .map(
        item => item.symbol
      )
      .join(",");

  const response =
    await upstoxRequest(
      "https://api.upstox.com/v3/market-quote/quotes",
      {
        instrument_key:
          instrumentKeys
      }
    );

  return response.data || {};
}

// ============================================================
// FIND QUOTE
// ============================================================

function findQuoteForIndex(
  rawData,
  index
) {
  const config =
    INDICES[index];

  if (
    !config ||
    !rawData
  ) {
    return null;
  }

  const keys = [
    config.symbol,

    config.symbol
      .replace("|", ":"),

    index,

    config.name
  ];

  for (const key of keys) {
    if (
      key &&
      rawData[key]
    ) {
      return rawData[key];
    }
  }

  const target =
    config.symbol
      .toUpperCase();

  const found =
    Object.entries(
      rawData
    ).find(
      ([key]) => {
        const upper =
          String(key)
            .toUpperCase();

        return (
          upper === target ||
          upper.includes(index)
        );
      }
    );

  return found
    ? found[1]
    : null;
}

// ============================================================
// NORMALIZE FULL QUOTE
// ============================================================

function normalizeFullQuote(
  index,
  raw
) {
  if (!raw) {
    return {
      index,
      name:
        INDICES[index]?.name ||
        index,
      instrumentKey:
        INDICES[index]?.symbol ||
        null,
      available: false,
      error:
        "No quote data",
      source:
        "upstox-v3"
    };
  }

  const ltpc =
    raw.ltpc || {};

  const ohlc =
    raw.ohlc || {};

  const ltp =
    safeNumber(
      raw.last_price ??
      raw.lastPrice ??
      ltpc.ltp ??
      raw.ltp ??
      ohlc.close ??
      0
    );

  let previousClose =
    raw.prev_close_price ??
    raw.previous_close ??
    raw.previousClose ??
    ltpc.cp ??
    null;

  let change =
    raw.net_change ??
    raw.netChange ??
    raw.change ??
    null;

  const open =
    raw.open ??
    raw.open_price ??
    ohlc.open ??
    null;

  const high =
    raw.high ??
    raw.high_price ??
    ohlc.high ??
    null;

  const low =
    raw.low ??
    raw.low_price ??
    ohlc.low ??
    null;

  let close =
    raw.close ??
    raw.close_price ??
    ohlc.close ??
    ltp;

  /*
   * Most reliable case:
   * previous close exists.
   */
  if (
    Number.isFinite(
      Number(previousClose)
    ) &&
    Number(previousClose) > 0
  ) {
    previousClose =
      Number(previousClose);

    change =
      ltp -
      previousClose;
  }

  /*
   * Fallback:
   * derive previous close from net change.
   */
  if (
    (!previousClose ||
      Number(previousClose) <= 0) &&
    Number.isFinite(
      Number(change)
    ) &&
    Number(change) !== 0
  ) {
    const calculated =
      ltp -
      Number(change);

    if (
      calculated > 0
    ) {
      previousClose =
        calculated;
    }
  }

  if (
    !Number.isFinite(
      Number(previousClose)
    ) ||
    Number(previousClose) <= 0
  ) {
    previousClose = 0;
  }

  if (
    !Number.isFinite(
      Number(change)
    )
  ) {
    change =
      previousClose > 0
        ? ltp - previousClose
        : 0;
  }

  const changePercent =
    previousClose > 0
      ? (
          change /
          previousClose
        ) * 100
      : 0;

  /*
   * V3 quote timestamp.
   */
  const timestamp =
    raw.timestamp ??
    raw.last_trade_time ??
    ltpc.ltt ??
    nowISO();

  return {
    index,

    name:
      INDICES[index]?.name ||
      index,

    instrumentKey:
      INDICES[index]?.symbol ||
      null,

    available:
      true,

    price:
      round(ltp),

    previousClose:
      round(previousClose),

    change:
      round(change),

    changePercent:
      round(
        changePercent,
        3
      ),

    open:
      open !== null
        ? round(open)
        : null,

    high:
      high !== null
        ? round(high)
        : null,

    low:
      low !== null
        ? round(low)
        : null,

    close:
      close !== null
        ? round(close)
        : round(ltp),

    sessionClose:
      close !== null
        ? round(close)
        : round(ltp),

    volume:
      safeNumber(
        raw.volume ??
        ohlc.volume ??
        0
      ),

    averagePrice:
      safeNumber(
        raw.average_price ??
        raw.averagePrice ??
        0
      ),

    oi:
      safeNumber(
        raw.oi ??
        0
      ),

    lowerCircuit:
      safeNumber(
        raw.lower_circuit_limit ??
        0
      ),

    upperCircuit:
      safeNumber(
        raw.upper_circuit_limit ??
        0
      ),

    timestamp,

    lastTradeTime:
      raw.last_trade_time ??
      ltpc.ltt ??
      null,

    stale: false,

    source:
      "upstox-v3"
  };
}

// ============================================================
// FETCH MAIN MARKET
// ============================================================

async function fetchQuotes() {
  const rawData =
    await fetchFullMarketQuotes();

  const result = {};

  for (
    const index of Object.keys(
      INDICES
    )
  ) {
    const raw =
      findQuoteForIndex(
        rawData,
        index
      );

    result[index] =
      normalizeFullQuote(
        index,
        raw
      );
  }

  return result;
}

// ============================================================
// EXTRA MARKET
// ============================================================

async function fetchExtraMarketData() {
  const result = {
    GIFT_NIFTY: {
      available: false
    },

    INDIA_VIX: {
      available: false
    }
  };

  try {
    const keys =
      Object.values(
        EXTRA_SYMBOLS
      ).join(",");

    const data =
      (
        await upstoxRequest(
          "https://api.upstox.com/v3/market-quote/quotes",
          {
            instrument_key:
              keys
          }
        )
      ).data || {};

    for (
      const [name, symbol]
      of Object.entries(
        EXTRA_SYMBOLS
      )
    ) {
      let raw =
        data[symbol] ||
        data[
          symbol.replace(
            "|",
            ":"
          )
        ] ||
        data[name];

      if (!raw) {
        const found =
          Object.entries(
            data
          ).find(
            ([key]) =>
              String(key)
                .toUpperCase()
                .includes(
                  name
                )
          );

        if (found) {
          raw =
            found[1];
        }
      }

      if (!raw) {
        continue;
      }

      const ltpc =
        raw.ltpc || {};

      const price =
        safeNumber(
          raw.last_price ??
          ltpc.ltp ??
          raw.ltp ??
          raw.close ??
          0
        );

      let previousClose =
        safeNumber(
          raw.prev_close_price ??
          raw.previous_close ??
          ltpc.cp ??
          0
        );

      let change =
        safeNumber(
          raw.net_change ??
          raw.change ??
          0
        );

      if (
        previousClose > 0
      ) {
        change =
          price -
          previousClose;
      } else if (
        change !== 0
      ) {
        previousClose =
          price - change;
      }

      const changePercent =
        previousClose > 0
          ? (
              change /
              previousClose
            ) * 100
          : 0;

      result[name] = {
        available: true,

        price:
          round(price),

        previousClose:
          round(
            previousClose
          ),

        change:
          round(change),

        changePercent:
          round(
            changePercent,
            3
          ),

        timestamp:
          raw.timestamp ??
          raw.last_trade_time ??
          ltpc.ltt ??
          nowISO(),

        source:
          "upstox-v3"
      };
    }

  } catch (error) {
    console.error(
      "[ERA] Extra market error:",
      error.response?.data ||
      error.message
    );
  }

  return result;
}

// ============================================================
// REFRESH MARKET
// ============================================================

async function refreshMarketData(requestedIndex = null) {
  const quotes =
    await fetchQuotes();

  if (requestedIndex && INDICES[requestedIndex]) {
    state.market[requestedIndex] = quotes[requestedIndex];
  } else {
    state.market = {
      ...state.market,
      ...quotes
    };
  }

  const extra =
    await fetchExtraMarketData();

  state.market.GIFT_NIFTY =
    extra.GIFT_NIFTY;

  state.market.INDIA_VIX =
    extra.INDIA_VIX;

  state.lastSuccess =
    nowISO();

  state.lastError =
    null;

  return state.market;
}

// ============================================================
// INTRADAY CANDLES V3
// ============================================================

async function fetchIntradayCandles(
  index,
  interval = 5
) {
  const config =
    INDICES[index];

  if (!config) {
    return [];
  }

  try {
    const response =
      await upstoxRequest(
        `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(
          config.symbol
        )}/minutes/${interval}`
      );

    let candles =
      response.data?.candles ||
      [];

    candles =
      candles.filter(
        candle =>
          Array.isArray(candle) &&
          candle.length >= 6 &&
          Number.isFinite(
            Number(candle[4])
          )
      );

    candles.sort(
      (a, b) =>
        new Date(a[0]).getTime() -
        new Date(b[0]).getTime()
    );

    console.log(
      `[ERA] ${index} intraday candles: ${candles.length}`
    );

    return candles;

  } catch (error) {
    console.error(
      `[ERA] Intraday candle error ${index}:`,
      error.response?.data ||
      error.message
    );

    return [];
  }
}

// ============================================================
// HISTORICAL CANDLES
// Used for technical fallback when intraday is unavailable.
// ============================================================

async function fetchHistoricalCandles(
  index,
  interval = 5
) {
  const config =
    INDICES[index];

  if (!config) {
    return [];
  }

  try {
    const endDate =
      new Date();

    const startDate =
      new Date(
        endDate.getTime() -
        7 *
          24 *
          60 *
          60 *
          1000
      );

    const to =
      endDate
        .toISOString()
        .slice(0, 10);

    const from =
      startDate
        .toISOString()
        .slice(0, 10);

    const response =
      await upstoxRequest(
        `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(
          config.symbol
        )}/minutes/${interval}/${to}/${from}`
      );

    let candles =
      response.data?.candles ||
      [];

    candles =
      candles.filter(
        candle =>
          Array.isArray(candle) &&
          candle.length >= 6
      );

    candles.sort(
      (a, b) =>
        new Date(a[0]).getTime() -
        new Date(b[0]).getTime()
    );

    return candles;

  } catch (error) {
    console.error(
      `[ERA] Historical candle error ${index}:`,
      error.response?.data ||
      error.message
    );

    return [];
  }
}

// ============================================================
// CANDLE SYNC WITH LIVE PRICE
// ============================================================

function syncLatestCandle(
  candles,
  livePrice
) {
  if (
    !Array.isArray(candles) ||
    candles.length === 0 ||
    !Number.isFinite(
      Number(livePrice)
    )
  ) {
    return candles || [];
  }

  const result =
    candles.map(
      candle => [...candle]
    );

  const last =
    result[
      result.length - 1
    ];

  if (
    !last ||
    last.length < 5
  ) {
    return result;
  }

  const price =
    Number(livePrice);

  last[4] =
    price;

  if (
    Number(last[2]) < price
  ) {
    last[2] =
      price;
  }

  if (
    Number(last[3]) > price
  ) {
    last[3] =
      price;
  }

  return result;
}

// ============================================================
// EMA
// ============================================================

function ema(
  values,
  period
) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const first =
    values
      .slice(0, period)
      .reduce(
        (a, b) =>
          a + Number(b),
        0
      ) / period;

  const multiplier =
    2 / (period + 1);

  let result =
    first;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      (
        Number(values[i]) -
        result
      ) *
        multiplier +
      result;
  }

  return result;
}

// ============================================================
// RSI
// ============================================================

function rsi(
  values,
  period = 14
) {
  if (
    !Array.isArray(values) ||
    values.length <= period
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const previous =
      Number(values[i - 1]);

    const current =
      Number(values[i]);

    const diff =
      current - previous;

    if (diff > 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  const avgGain =
    gains / period;

  const avgLoss =
    losses / period;

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

// ============================================================
// VWAP
// ============================================================

function calculateVWAP(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length === 0
  ) {
    return null;
  }

  let totalPV = 0;
  let totalVolume = 0;

  /*
   * Calculate latest trading session only.
   */
  const last =
    candles[
      candles.length - 1
    ];

  const lastDate =
    new Date(
      last[0]
    ).toLocaleDateString(
      "en-IN",
      {
        timeZone:
          "Asia/Kolkata"
      }
    );

  for (
    const candle of candles
  ) {
    const date =
      new Date(
        candle[0]
      ).toLocaleDateString(
        "en-IN",
        {
          timeZone:
            "Asia/Kolkata"
        }
      );

    if (
      date !== lastDate
    ) {
      continue;
    }

    const high =
      Number(candle[2]);

    const low =
      Number(candle[3]);

    const close =
      Number(candle[4]);

    const volume =
      Number(candle[5]);

    if (
      !Number.isFinite(
        high
      ) ||
      !Number.isFinite(
        low
      ) ||
      !Number.isFinite(
        close
      ) ||
      !Number.isFinite(
        volume
      ) ||
      volume <= 0
    ) {
      continue;
    }

    const typical =
      (
        high +
        low +
        close
      ) / 3;

    totalPV +=
      typical * volume;

    totalVolume +=
      volume;
  }

  if (
    totalVolume <= 0
  ) {
    return null;
  }

  return (
    totalPV /
    totalVolume
  );
}

// ============================================================
// STEP 6 — ADVANCED TECHNICAL ENGINE HELPERS
// ============================================================

function calculateATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i]?.[2]);
    const low = Number(candles[i]?.[3]);
    const previousClose = Number(candles[i - 1]?.[4]);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(previousClose)) continue;
    trueRanges.push(Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    ));
  }

  if (trueRanges.length < period) return null;
  const recent = trueRanges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function calculateMomentum(candles, lookback = 5) {
  if (!Array.isArray(candles) || candles.length <= lookback) return null;
  const current = Number(candles[candles.length - 1]?.[4]);
  const previous = Number(candles[candles.length - 1 - lookback]?.[4]);
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return {
    points: current - previous,
    percent: ((current - previous) / previous) * 100,
    direction: current > previous ? "UP" : current < previous ? "DOWN" : "FLAT",
    lookback
  };
}

function calculateVolatility(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period) return null;
  const ranges = candles.slice(-period).map(c => {
    const high = Number(c?.[2]);
    const low = Number(c?.[3]);
    return Number.isFinite(high) && Number.isFinite(low) && high >= low ? high - low : null;
  }).filter(v => v !== null);

  if (!ranges.length) return null;
  const averageRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const latest = ranges[ranges.length - 1];
  const ratio = averageRange > 0 ? latest / averageRange : 1;

  return {
    averageRange,
    latestRange: latest,
    ratio,
    state: ratio >= 1.5 ? "EXPANDING" : ratio <= 0.65 ? "CONTRACTING" : "NORMAL"
  };
}

function calculateVolumeProfile(candles, period = 20) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const recent = candles.slice(-period);
  const volumes = recent.map(c => Number(c?.[5])).filter(v => Number.isFinite(v) && v > 0);
  if (!volumes.length) return null;
  const average = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const latest = volumes[volumes.length - 1];
  return {
    average,
    latest,
    ratio: average > 0 ? latest / average : null,
    state: latest >= average * 1.5 ? "HIGH" : latest <= average * 0.65 ? "LOW" : "NORMAL"
  };
}

function calculateLevels(candles, price, lookback = 50) {
  if (!Array.isArray(candles) || !candles.length || !Number.isFinite(Number(price))) {
    return { support: null, resistance: null, rangeHigh: null, rangeLow: null };
  }

  const recent = candles.slice(-lookback);
  const lows = recent.map(c => Number(c?.[3])).filter(Number.isFinite);
  const highs = recent.map(c => Number(c?.[2])).filter(Number.isFinite);
  if (!lows.length || !highs.length) return { support: null, resistance: null, rangeHigh: null, rangeLow: null };

  const current = Number(price);
  const supports = lows.filter(v => v <= current).sort((a, b) => b - a);
  const resistances = highs.filter(v => v >= current).sort((a, b) => a - b);

  return {
    support: supports.length ? supports[0] : Math.min(...lows),
    resistance: resistances.length ? resistances[0] : Math.max(...highs),
    rangeHigh: Math.max(...highs),
    rangeLow: Math.min(...lows)
  };
}

function buildTimeframeTechnical(candles, price) {
  if (!Array.isArray(candles) || !candles.length) {
    return { available: false, candleCount: 0, trend: "UNKNOWN", ema20: null, ema50: null, rsi: null, atr: null, momentum: null };
  }

  const closes = candles.map(c => Number(c?.[4])).filter(Number.isFinite);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const current = Number(price);

  let trend = "SIDEWAYS";
  if (Number.isFinite(current) && ema20 !== null && ema50 !== null) {
    if (current > ema20 && ema20 > ema50) trend = "BULLISH";
    else if (current < ema20 && ema20 < ema50) trend = "BEARISH";
  } else if (Number.isFinite(current) && ema20 !== null) {
    if (current > ema20) trend = "BULLISH";
    else if (current < ema20) trend = "BEARISH";
  }

  return {
    available: true,
    candleCount: candles.length,
    trend,
    ema20: ema20 !== null ? round(ema20) : null,
    ema50: ema50 !== null ? round(ema50) : null,
    rsi: rsi14 !== null ? round(rsi14, 2) : null,
    atr: (() => { const v = calculateATR(candles, 14); return v !== null ? round(v) : null; })(),
    momentum: calculateMomentum(candles, 3)
      ? {
          points: round(calculateMomentum(candles, 3).points),
          percent: round(calculateMomentum(candles, 3).percent, 3),
          direction: calculateMomentum(candles, 3).direction
        }
      : null
  };
}

// ============================================================
// MARKET STRUCTURE
// ============================================================

function detectStructure(candles) {
  // Confirmed swing-based structure. A swing needs candles on both sides,
  // so the newest unconfirmed candle is never used as a structural pivot.
  if (!Array.isArray(candles) || candles.length < 12) {
    return { label: "RANGE", bos: false, choch: false, details: null };
  }

  const lookback = Math.min(candles.length, 80);
  const data = candles.slice(-lookback);
  const pivot = 2;
  const swingHighs = [];
  const swingLows = [];

  for (let i = pivot; i < data.length - pivot; i++) {
    const high = Number(data[i]?.[2]);
    const low = Number(data[i]?.[3]);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= pivot; j++) {
      if (high <= Number(data[i - j]?.[2]) || high <= Number(data[i + j]?.[2])) isHigh = false;
      if (low >= Number(data[i - j]?.[3]) || low >= Number(data[i + j]?.[3])) isLow = false;
    }
    if (isHigh) swingHighs.push({ index: i, price: high });
    if (isLow) swingLows.push({ index: i, price: low });
  }

  const lastHighs = swingHighs.slice(-2);
  const lastLows = swingLows.slice(-2);
  if (lastHighs.length < 2 || lastLows.length < 2) {
    return { label: "RANGE", bos: false, choch: false, details: null };
  }

  const prevHigh = lastHighs[0].price;
  const lastHigh = lastHighs[1].price;
  const prevLow = lastLows[0].price;
  const lastLow = lastLows[1].price;
  const lastClose = Number(data[data.length - 1]?.[4]);

  const bullishStructure = lastHigh > prevHigh && lastLow > prevLow;
  const bearishStructure = lastHigh < prevHigh && lastLow < prevLow;
  const label = bullishStructure ? "BULLISH" : bearishStructure ? "BEARISH" : "RANGE";

  // BOS is a close through the latest confirmed swing in the current direction.
  const bosUp = bullishStructure && lastClose > lastHigh;
  const bosDown = bearishStructure && lastClose < lastLow;
  // CHOCH is a close through the swing protecting the previous structure.
  const chochDown = bullishStructure && lastClose < lastLow;
  const chochUp = bearishStructure && lastClose > lastHigh;

  return {
    label,
    bos: bosUp || bosDown,
    choch: chochDown || chochUp,
    details: {
      previousSwingHigh: round(prevHigh),
      lastSwingHigh: round(lastHigh),
      previousSwingLow: round(prevLow),
      lastSwingLow: round(lastLow),
      bosDirection: bosUp ? "UP" : bosDown ? "DOWN" : null,
      chochDirection: chochUp ? "UP" : chochDown ? "DOWN" : null
    }
  };
}


// ============================================================
// PRICE ACTION ENGINE — STEP 7
// ============================================================

function detectPriceAction(candles, price, market = null) {
  const empty = {
    available: false,
    breakout: { detected: false, direction: null, level: null },
    fakeBreakout: { detected: false, direction: null, level: null },
    retest: { detected: false, direction: null, level: null },
    rejection: { detected: false, direction: null, strength: null },
    range: { state: "UNKNOWN", width: null, widthPercent: null },
    gap: { detected: false, direction: null, percent: null },
    orb: { available: false, openingHigh: null, openingLow: null, breakout: false, direction: null },
    pdhPdl: { available: false, pdh: null, pdl: null, relation: null },
    liquiditySweep: { detected: false, direction: null, level: null },
    momentumConfirmation: { confirmed: false, direction: null, reason: null }
  };

  if (!Array.isArray(candles) || candles.length < 3) return empty;

  const rows = candles.filter(c => Array.isArray(c) && c.length >= 5);
  if (rows.length < 3) return empty;
  const current = Number(price);
  const latest = rows[rows.length - 1];
  const open = Number(latest[1]);
  const high = Number(latest[2]);
  const low = Number(latest[3]);
  const close = Number(latest[4]);
  if (![open, high, low, close].every(Number.isFinite)) return empty;

  const previous = rows[rows.length - 2];
  const prevClose = Number(previous?.[4]);
  const prior20 = rows.slice(Math.max(0, rows.length - 21), -1);
  const priorHighs = prior20.map(c => Number(c[2])).filter(Number.isFinite);
  const priorLows = prior20.map(c => Number(c[3])).filter(Number.isFinite);
  const rangeHigh = priorHighs.length ? Math.max(...priorHighs) : null;
  const rangeLow = priorLows.length ? Math.min(...priorLows) : null;
  const atr = calculateATR(rows, 14);
  const tolerance = Number.isFinite(atr) && atr > 0 ? atr * 0.25 : Math.max(Math.abs(close) * 0.001, 0.01);

  const breakoutUp = Number.isFinite(rangeHigh) && close > rangeHigh;
  const breakoutDown = Number.isFinite(rangeLow) && close < rangeLow;
  const fakeUp = Number.isFinite(rangeHigh) && high > rangeHigh && close <= rangeHigh;
  const fakeDown = Number.isFinite(rangeLow) && low < rangeLow && close >= rangeLow;

  let retestDirection = null;
  let retestLevel = null;
  const recentForRetest = rows.slice(Math.max(0, rows.length - 4));
  if (Number.isFinite(rangeHigh)) {
    for (let i = 0; i < recentForRetest.length - 1; i++) {
      const c = recentForRetest[i];
      const cClose = Number(c[4]);
      if (cClose > rangeHigh) {
        const last = latest;
        if (Number(last[3]) <= rangeHigh + tolerance && close >= rangeHigh) {
          retestDirection = "UP"; retestLevel = rangeHigh; break;
        }
      }
    }
  }
  if (!retestDirection && Number.isFinite(rangeLow)) {
    for (let i = 0; i < recentForRetest.length - 1; i++) {
      const c = recentForRetest[i];
      const cClose = Number(c[4]);
      if (cClose < rangeLow) {
        const last = latest;
        if (Number(last[2]) >= rangeLow - tolerance && close <= rangeLow) {
          retestDirection = "DOWN"; retestLevel = rangeLow; break;
        }
      }
    }
  }

  const candleRange = high - low;
  const upperWick = Math.max(0, high - Math.max(open, close));
  const lowerWick = Math.max(0, Math.min(open, close) - low);
  const body = Math.abs(close - open);
  const rejectionUp = candleRange > 0 && upperWick / candleRange >= 0.55 && close < open;
  const rejectionDown = candleRange > 0 && lowerWick / candleRange >= 0.55 && close > open;

  let rangeState = "NORMAL";
  let rangeWidth = null;
  let rangeWidthPercent = null;
  if (Number.isFinite(rangeHigh) && Number.isFinite(rangeLow) && rangeHigh >= rangeLow) {
    rangeWidth = rangeHigh - rangeLow;
    rangeWidthPercent = close > 0 ? (rangeWidth / close) * 100 : null;
    const recentRanges = rows.slice(-14).map(c => Number(c[2]) - Number(c[3])).filter(v => Number.isFinite(v) && v >= 0);
    if (recentRanges.length >= 5) {
      const avg = recentRanges.reduce((a, b) => a + b, 0) / recentRanges.length;
      const latestRange = candleRange;
      if (avg > 0 && latestRange >= avg * 1.5) rangeState = "EXPANSION";
      else if (avg > 0 && latestRange <= avg * 0.65) rangeState = "CONTRACTION";
    }
  }

  let gapDetected = false;
  let gapDirection = null;
  let gapPercent = null;
  const referenceClose = Number(market?.previousClose);
  const firstOpen = Number(rows[0]?.[1]);
  if (Number.isFinite(referenceClose) && referenceClose > 0 && Number.isFinite(firstOpen)) {
    gapPercent = ((firstOpen - referenceClose) / referenceClose) * 100;
    if (Math.abs(gapPercent) >= 0.20) {
      gapDetected = true;
      gapDirection = gapPercent > 0 ? "UP" : "DOWN";
    }
  }

  // Opening Range Breakout: first 3 five-minute candles = first 15 minutes.
  const orbRows = rows.slice(0, Math.min(3, rows.length));
  const orbHighs = orbRows.map(c => Number(c[2])).filter(Number.isFinite);
  const orbLows = orbRows.map(c => Number(c[3])).filter(Number.isFinite);
  const openingHigh = orbHighs.length ? Math.max(...orbHighs) : null;
  const openingLow = orbLows.length ? Math.min(...orbLows) : null;
  const orbUp = Number.isFinite(openingHigh) && close > openingHigh;
  const orbDown = Number.isFinite(openingLow) && close < openingLow;

  // Previous-day high/low from available candle dates. If only one session is present,
  // the engine reports unavailable instead of treating today's range as PDH/PDL.
  let pdh = null, pdl = null, previousDate = null;
  const dateBuckets = new Map();
  for (const c of rows) {
    const d = new Date(c[0]);
    if (!Number.isNaN(d.getTime())) {
      const key = d.toISOString().slice(0, 10);
      if (!dateBuckets.has(key)) dateBuckets.set(key, []);
      dateBuckets.get(key).push(c);
    }
  }
  const dates = [...dateBuckets.keys()].sort();
  if (dates.length >= 2) {
    previousDate = dates[dates.length - 2];
    const prevDayRows = dateBuckets.get(previousDate) || [];
    const highs = prevDayRows.map(c => Number(c[2])).filter(Number.isFinite);
    const lows = prevDayRows.map(c => Number(c[3])).filter(Number.isFinite);
    if (highs.length && lows.length) { pdh = Math.max(...highs); pdl = Math.min(...lows); }
  }

  let relation = null;
  if (Number.isFinite(pdh) && Number.isFinite(pdl)) {
    relation = close > pdh ? "ABOVE_PDH" : close < pdl ? "BELOW_PDL" : "INSIDE_PDH_PDL";
  }

  let sweepDirection = null, sweepLevel = null;
  if (Number.isFinite(rangeHigh) && high > rangeHigh && close <= rangeHigh) {
    sweepDirection = "UP"; sweepLevel = rangeHigh;
  } else if (Number.isFinite(rangeLow) && low < rangeLow && close >= rangeLow) {
    sweepDirection = "DOWN"; sweepLevel = rangeLow;
  }

  const lastMomentum = calculateMomentum(rows, 3);
  let momentumConfirmed = false;
  let momentumDirection = null;
  let momentumReason = null;
  if (lastMomentum && Number.isFinite(lastMomentum.percent)) {
    if (breakoutUp && lastMomentum.direction === "UP") {
      momentumConfirmed = true; momentumDirection = "UP"; momentumReason = "Breakout and 3-candle momentum agree.";
    } else if (breakoutDown && lastMomentum.direction === "DOWN") {
      momentumConfirmed = true; momentumDirection = "DOWN"; momentumReason = "Breakdown and 3-candle momentum agree.";
    } else if ((orbUp || orbDown) && ((orbUp && lastMomentum.direction === "UP") || (orbDown && lastMomentum.direction === "DOWN"))) {
      momentumConfirmed = true; momentumDirection = orbUp ? "UP" : "DOWN"; momentumReason = "ORB direction agrees with 3-candle momentum.";
    }
  }

  return {
    available: true,
    breakout: {
      detected: breakoutUp || breakoutDown,
      direction: breakoutUp ? "UP" : breakoutDown ? "DOWN" : null,
      level: breakoutUp ? round(rangeHigh) : breakoutDown ? round(rangeLow) : null
    },
    fakeBreakout: {
      detected: fakeUp || fakeDown,
      direction: fakeUp ? "UP" : fakeDown ? "DOWN" : null,
      level: fakeUp ? round(rangeHigh) : fakeDown ? round(rangeLow) : null
    },
    retest: {
      detected: Boolean(retestDirection), direction: retestDirection, level: retestLevel !== null ? round(retestLevel) : null
    },
    rejection: {
      detected: rejectionUp || rejectionDown,
      direction: rejectionUp ? "UP_REJECTION" : rejectionDown ? "DOWN_REJECTION" : null,
      strength: rejectionUp || rejectionDown ? round(Math.max(upperWick, lowerWick) / Math.max(candleRange, 0.000001), 2) : null
    },
    range: {
      state: rangeState,
      width: rangeWidth !== null ? round(rangeWidth) : null,
      widthPercent: rangeWidthPercent !== null ? round(rangeWidthPercent, 3) : null
    },
    gap: {
      detected: gapDetected,
      direction: gapDirection,
      percent: gapPercent !== null ? round(gapPercent, 3) : null
    },
    orb: {
      available: orbRows.length >= 3,
      openingHigh: openingHigh !== null ? round(openingHigh) : null,
      openingLow: openingLow !== null ? round(openingLow) : null,
      breakout: orbUp || orbDown,
      direction: orbUp ? "UP" : orbDown ? "DOWN" : null
    },
    pdhPdl: {
      available: Number.isFinite(pdh) && Number.isFinite(pdl),
      pdh: pdh !== null ? round(pdh) : null,
      pdl: pdl !== null ? round(pdl) : null,
      relation,
      sourceDate: previousDate
    },
    liquiditySweep: {
      detected: Boolean(sweepDirection), direction: sweepDirection, level: sweepLevel !== null ? round(sweepLevel) : null
    },
    momentumConfirmation: {
      confirmed: momentumConfirmed,
      direction: momentumDirection,
      reason: momentumReason
    }
  };
}

// ============================================================
// TECHNICAL ANALYSIS
// ============================================================

function technicalAnalysis(
  candles,
  price,
  market = null
) {
  if (
    !Array.isArray(candles) ||
    candles.length === 0
  ) {
    return {
      candleCount: 0,
      ema9: null,
      ema20: null,
      ema50: null,
      rsi: null,
      vwap: null,
      support: null,
      resistance: null,
      trend: "UNKNOWN",
      structure: "RANGE",
      structureDetails: null
    };
  }

  const closes =
    candles.map(
      c => Number(c[4])
    );

  const ema9 =
    ema(closes, 9);

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  const current =
    Number(price);

  let trend =
    "SIDEWAYS";

  if (
    ema9 !== null &&
    ema20 !== null &&
    ema50 !== null
  ) {
    if (
      current > ema9 &&
      ema9 > ema20 &&
      ema20 > ema50
    ) {
      trend =
        "BULLISH";
    } else if (
      current < ema9 &&
      ema9 < ema20 &&
      ema20 < ema50
    ) {
      trend =
        "BEARISH";
    }
  } else if (
    ema9 !== null &&
    ema20 !== null
  ) {
    if (
      current > ema9 &&
      ema9 > ema20
    ) {
      trend =
        "BULLISH";
    } else if (
      current < ema9 &&
      ema9 < ema20
    ) {
      trend =
        "BEARISH";
    }
  }

  const recent =
    candles.slice(-20);

  const support =
    Math.min(
      ...recent.map(
        c => Number(c[3])
      )
    );

  const resistance =
    Math.max(
      ...recent.map(
        c => Number(c[2])
      )
    );

  const structure =
    detectStructure(
      candles
    );

  const atr = calculateATR(candles, 14);
  const momentum = calculateMomentum(candles, 5);
  const volatility = calculateVolatility(candles, 14);
  const volumeProfile = calculateVolumeProfile(candles, 20);
  const levels = calculateLevels(candles, current, 50);
  const priceAction = detectPriceAction(candles, current, market);

  const latestCandle =
    candles[candles.length - 1] || null;

  const latestCandleVolume =
    latestCandle ? Number(latestCandle[5]) : 0;

  const marketVolume =
    market ? Number(market.volume) : 0;

  // Prefer the latest candle volume. If that candle reports zero/missing
  // volume, use the sum of all available intraday candle volumes so the
  // dashboard does not incorrectly show 0 when earlier candles contain
  // valid exchange volume. Never invent volume when the source provides none.
  const sessionCandleVolume = candles.reduce((sum, c) => {
    const v = Number(c?.[5]);
    return sum + (Number.isFinite(v) && v > 0 ? v : 0);
  }, 0);

  const volume =
    Number.isFinite(latestCandleVolume) && latestCandleVolume > 0
      ? latestCandleVolume
      : sessionCandleVolume > 0
        ? sessionCandleVolume
        : Number.isFinite(marketVolume) && marketVolume > 0
          ? marketVolume
          : null;

  let vwap =
    calculateVWAP(candles);

  let vwapSource =
    vwap !== null ? "volume-weighted" : "";

  // Index candles can report zero volume. In that case use the quote's
  // average price, then a session typical-price average as a clearly
  // identified fallback so the indicator never silently shows blank.
  if (vwap === null && market) {
    const averagePrice = Number(market.averagePrice);
    if (Number.isFinite(averagePrice) && averagePrice > 0) {
      vwap = averagePrice;
      vwapSource = "quote-average-price";
    }
  }

  if (vwap === null && candles.length) {
    const typicals = candles
      .map(c => (Number(c[2]) + Number(c[3]) + Number(c[4])) / 3)
      .filter(Number.isFinite);
    if (typicals.length) {
      vwap = typicals.reduce((a, b) => a + b, 0) / typicals.length;
      vwapSource = "typical-price-proxy";
    }
  }

  return {
    candleCount:
      candles.length,

    ema9:
      ema9 !== null
        ? round(ema9)
        : null,

    ema20:
      ema20 !== null
        ? round(ema20)
        : null,

    ema50:
      ema50 !== null
        ? round(ema50)
        : null,

    rsi:
      rsiValue(
        closes
      ),

    vwap:
      vwap !== null ? round(vwap) : null,

    vwapSource,

    volume:
      volume !== null ? round(volume, 0) : null,

    support:
      levels.support !== null ? round(levels.support) : round(support),

    resistance:
      levels.resistance !== null ? round(levels.resistance) : round(resistance),

    levels: {
      support: levels.support !== null ? round(levels.support) : null,
      resistance: levels.resistance !== null ? round(levels.resistance) : null,
      rangeHigh: levels.rangeHigh !== null ? round(levels.rangeHigh) : null,
      rangeLow: levels.rangeLow !== null ? round(levels.rangeLow) : null
    },

    atr:
      atr !== null ? round(atr) : null,

    momentum: momentum
      ? {
          points: round(momentum.points),
          percent: round(momentum.percent, 3),
          direction: momentum.direction,
          lookback: momentum.lookback
        }
      : null,

    volatility: volatility
      ? {
          averageRange: round(volatility.averageRange),
          latestRange: round(volatility.latestRange),
          ratio: round(volatility.ratio, 3),
          state: volatility.state
        }
      : null,

    volumeProfile: volumeProfile
      ? {
          average: round(volumeProfile.average, 0),
          latest: round(volumeProfile.latest, 0),
          ratio: volumeProfile.ratio !== null ? round(volumeProfile.ratio, 3) : null,
          state: volumeProfile.state
        }
      : null,

    priceAction,

    trend,

    structure:
      structure.label,

    structureDetails:
      structure.details,

    bos:
      structure.bos,

    choch:
      structure.choch
  };
}

function rsiValue(
  closes
) {
  const value =
    rsi(
      closes,
      14
    );

  return value !== null
    ? round(value, 2)
    : null;
}

// ============================================================
// OPTION CONTRACTS
// KEEPING EXISTING WORKING FLOW
// ============================================================

async function fetchOptionContracts(
  index
) {
  const config =
    INDICES[index];

  if (!config) {
    throw new Error(
      `Invalid index: ${index}`
    );
  }

  const response =
    await upstoxRequest(
      "https://api.upstox.com/v2/option/contract",
      {
        instrument_key:
          config.symbol
      }
    );

  const payload = response && response.data;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.contracts)) return payload.contracts;
  return [];
}

// ============================================================
// NEAREST EXPIRY
// ============================================================

async function findNearestExpiry(
  index
) {
  const contracts =
    await fetchOptionContracts(
      index
    );

  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  const expiries =
    [
      ...new Set(
        contracts
          .map(
            item =>
              item.expiry || item.expiry_date || item.expiryDate
          )
          .filter(Boolean)
      )
    ]
      .filter(
        expiry =>
          expiry >= today
      )
      .sort();

  return (
    expiries[0] ||
    null
  );
}

// ============================================================
// OPTION EXPIRIES
// ============================================================

app.get('/api/options/expiries', async (req, res) => {
  try {
    const index = normalizeIndex(req.query.index || 'NIFTY');
    if (!INDICES[index]) return res.status(400).json({ ok:false, error:'Invalid index' });
    const contracts = await fetchOptionContracts(index);
    const today = new Date().toISOString().slice(0,10);
    const expiries = [...new Set((contracts || []).map(x => x.expiry || x.expiry_date || x.expiryDate).filter(Boolean))]
      .map(x => String(x).slice(0,10))
      .filter(x => x >= today).sort();
    res.json({ ok:true, index, expiries, nearest: expiries[0] || null, count: expiries.length, updatedAt: nowISO() });
  } catch (error) {
    console.error('[ERA] Option expiries endpoint:', error.response?.data || error.message);
    res.status(500).json({ ok:false, error: apiError(error) });
  }
});

// ============================================================
// OPTION CHAIN
// ============================================================

async function fetchOptionChain(
  index,
  expiryDate = null
) {
  const config =
    INDICES[index];

  let expiry =
    expiryDate;

  if (!expiry) {
    expiry =
      await findNearestExpiry(
        index
      );
  }

  if (!expiry) {
    throw new Error(
      `No expiry found for ${index}`
    );
  }

  const response =
    await upstoxRequest(
      "https://api.upstox.com/v2/option/chain",
      {
        instrument_key:
          config.symbol,

        expiry_date:
          expiry
      }
    );

  return {
    expiry,

    data:
      response.data || []
  };
}

// ============================================================
// OPTION GREEKS
// ============================================================

async function fetchOptionGreeks(
  instrumentKeys
) {
  if (
    !Array.isArray(
      instrumentKeys
    ) ||
    instrumentKeys.length === 0
  ) {
    return {};
  }

  const unique =
    [
      ...new Set(
        instrumentKeys.filter(
          Boolean
        )
      )
    ].slice(0, 50);

  if (!unique.length) {
    return {};
  }

  try {
    const response =
      await upstoxRequest(
        "https://api.upstox.com/v3/market-quote/option-greek",
        {
          instrument_key:
            unique.join(",")
        }
      );

    return response.data || {};

  } catch (error) {
    console.error(
      "[ERA] Greeks error:",
      error.response?.data ||
      error.message
    );

    return {};
  }
}

// ============================================================
// NORMALIZE OPTION SIDE
// ============================================================

function normalizeOptionSide(
  side,
  strikeFallback
) {
  if (!side) {
    return null;
  }

  const marketData =
    side.market_data ||
    side.marketData ||
    side;

  const greeks =
    side.option_greeks ||
    side.optionGreeks ||
    side.greeks ||
    {};

  const instrumentKey =
    side.instrument_key ||
    side.instrumentKey ||
    marketData.instrument_key ||
    marketData.instrumentKey ||
    null;

  const strike =
    safeNumber(
      side.strike_price ??
      side.strikePrice ??
      strikeFallback
    );

  return {
    type: side.type ||
      side.option_type ||
      side.optionType ||
      null,

    strike,

    instrumentKey,

    ltp:
      safeNumber(
        marketData.ltp ??
        marketData.last_price ??
        marketData.lastPrice ??
        side.ltp ??
        0
      ),

    bidPrice:
      safeNumber(
        marketData.bid_price ??
        marketData.bidPrice ??
        marketData.best_bid_price ??
        marketData.bestBidPrice ??
        side.bidPrice ??
        side.bid_price ??
        0
      ),

    askPrice:
      safeNumber(
        marketData.ask_price ??
        marketData.askPrice ??
        marketData.best_ask_price ??
        marketData.bestAskPrice ??
        side.askPrice ??
        side.ask_price ??
        0
      ),

    oi:
      safeNumber(
        marketData.oi ??
        marketData.open_interest ??
        side.oi ??
        0
      ),

    changeOI:
      safeNumber(
        marketData.change_oi ??
        marketData.changeOi ??
        side.change_oi ??
        0
      ),

    volume:
      safeNumber(
        marketData.volume ??
        side.volume ??
        0
      ),

    iv:
      safeNumber(
        greeks.iv ??
        greeks.implied_volatility ??
        side.iv ??
        0
      ),

    delta:
      safeNumber(
        greeks.delta ??
        side.delta ??
        0
      ),

    gamma:
      safeNumber(
        greeks.gamma ??
        side.gamma ??
        0
      ),

    theta:
      safeNumber(
        greeks.theta ??
        side.theta ??
        0
      ),

    vega:
      safeNumber(
        greeks.vega ??
        side.vega ??
        0
      ),

    rho:
      safeNumber(
        greeks.rho ??
        side.rho ??
        0
      )
  };
}

// ============================================================
// NORMALIZE OPTION CHAIN
// ============================================================

function normalizeOptionChain(
  chainData
) {
  const rows = [];

  for (
    const item of chainData || []
  ) {
    const strike =
      safeNumber(
        item.strike_price ??
        item.strikePrice ??
        item.strike
      );

    const callRaw =
      item.call_options ||
      item.callOptions ||
      item.CE ||
      item.ce ||
      null;

    const putRaw =
      item.put_options ||
      item.putOptions ||
      item.PE ||
      item.pe ||
      null;

    const call =
      normalizeOptionSide(
        callRaw,
        strike
      );

    const put =
      normalizeOptionSide(
        putRaw,
        strike
      );

    if (
      !call &&
      !put
    ) {
      continue;
    }

    rows.push({
      strike,

      expiry:
        item.expiry ||
        item.expiry_date ||
        null,

      call,

      put
    });
  }

  rows.sort(
    (a, b) =>
      a.strike -
      b.strike
  );

  return rows;
}

// ============================================================
// MERGE GREEKS
// ============================================================

function mergeGreeks(
  rows,
  greeks
) {
  for (
    const row of rows
  ) {
    for (
      const sideName of [
        "call",
        "put"
      ]
    ) {
      const side =
        row[sideName];

      if (
        !side ||
        !side.instrumentKey
      ) {
        continue;
      }

      const data =
        greeks[
          side.instrumentKey
        ];

      if (!data) {
        continue;
      }

      side.iv =
        safeNumber(
          data.iv ??
          data.implied_volatility ??
          side.iv
        );

      side.delta =
        safeNumber(
          data.delta ??
          side.delta
        );

      side.gamma =
        safeNumber(
          data.gamma ??
          side.gamma
        );

      side.theta =
        safeNumber(
          data.theta ??
          side.theta
        );

      side.vega =
        safeNumber(
          data.vega ??
          side.vega
        );

      side.rho =
        safeNumber(
          data.rho ??
          side.rho
        );
    }
  }

  return rows;
}

// ============================================================
// OPTION SUMMARY
// ============================================================

function calculateOptionSummary(
  rows,
  spot
) {
  let callOI = 0;
  let putOI = 0;

  let maxCallOI = null;
  let maxPutOI = null;

  let atm = null;
  let atmDistance =
    Infinity;

  for (
    const row of rows
  ) {
    const callOIValue =
      safeNumber(
        row.call?.oi
      );

    const putOIValue =
      safeNumber(
        row.put?.oi
      );

    callOI +=
      callOIValue;

    putOI +=
      putOIValue;

    if (
      !maxCallOI ||
      callOIValue >
        maxCallOI.oi
    ) {
      maxCallOI = {
        strike:
          row.strike,
        oi:
          callOIValue
      };
    }

    if (
      !maxPutOI ||
      putOIValue >
        maxPutOI.oi
    ) {
      maxPutOI = {
        strike:
          row.strike,
        oi:
          putOIValue
      };
    }

    const distance =
      Math.abs(
        row.strike -
        spot
      );

    if (
      distance <
      atmDistance
    ) {
      atmDistance =
        distance;

      atm =
        row.strike;
    }
  }

  const pcr =
    callOI > 0
      ? putOI / callOI
      : 0;

  let sentiment =
    "NEUTRAL";

  if (
    pcr >= 1.05
  ) {
    sentiment =
      "BULLISH";
  } else if (
    pcr <= 0.80
  ) {
    sentiment =
      "BEARISH";
  }

  return {
    callOI,
    putOI,

    pcr:
      round(pcr, 3),

    sentiment,

    atm,

    maxCallOI,

    maxPutOI
  };
}

// ============================================================
// STEP 8 — ADVANCED OPTIONS ANALYTICS
// OI buildup, IV, Greeks, Max Pain, liquidity and expiry behavior.
// ============================================================

function calculateAdvancedOptionAnalytics(rows, spot, expiry = null) {
  const data = Array.isArray(rows) ? rows : [];
  const currentSpot = Number(spot);
  const validSpot = Number.isFinite(currentSpot) && currentSpot > 0 ? currentSpot : null;
  const sorted = data.filter(r => Number.isFinite(Number(r?.strike))).sort((a,b) => Math.abs(Number(a.strike) - (validSpot || 0)) - Math.abs(Number(b.strike) - (validSpot || 0)));
  const atmRows = sorted.slice(0, 7);

  let callOI = 0, putOI = 0, callVolume = 0, putVolume = 0, callChangeOI = 0, putChangeOI = 0;
  let callIvWeighted = 0, putIvWeighted = 0, callIvWeight = 0, putIvWeight = 0;
  let totalSpread = 0, spreadCount = 0;

  for (const row of data) {
    const ce = row?.call || {};
    const pe = row?.put || {};
    const ceOI = Math.max(0, Number(ce.oi) || 0);
    const peOI = Math.max(0, Number(pe.oi) || 0);
    const ceVol = Math.max(0, Number(ce.volume) || 0);
    const peVol = Math.max(0, Number(pe.volume) || 0);
    callOI += ceOI; putOI += peOI;
    callVolume += ceVol; putVolume += peVol;
    callChangeOI += Number(ce.changeOI) || 0;
    putChangeOI += Number(pe.changeOI) || 0;
    const ceIV = Number(ce.iv) || 0, peIV = Number(pe.iv) || 0;
    if (ceIV > 0 && ceOI > 0) { callIvWeighted += ceIV * ceOI; callIvWeight += ceOI; }
    if (peIV > 0 && peOI > 0) { putIvWeighted += peIV * peOI; putIvWeight += peOI; }
    for (const side of [ce, pe]) {
      const bid = Number(side.bidPrice) || 0, ask = Number(side.askPrice) || 0;
      if (bid > 0 && ask >= bid) { totalSpread += ask - bid; spreadCount++; }
    }
  }

  const pcrOI = callOI > 0 ? putOI / callOI : 0;
  const pcrVolume = callVolume > 0 ? putVolume / callVolume : 0;
  const avgCallIV = callIvWeight > 0 ? callIvWeighted / callIvWeight : null;
  const avgPutIV = putIvWeight > 0 ? putIvWeighted / putIvWeight : null;
  const atmIVs = atmRows.flatMap(r => [r?.call?.iv, r?.put?.iv]).map(Number).filter(v => Number.isFinite(v) && v > 0);
  const atmIV = atmIVs.length ? atmIVs.reduce((a,b) => a+b, 0) / atmIVs.length : null;

  // Max Pain: strike with the lowest aggregate intrinsic payout to option holders.
  let maxPain = null, minPain = Infinity;
  for (const candidate of data) {
    const k = Number(candidate?.strike);
    if (!Number.isFinite(k)) continue;
    let pain = 0;
    for (const row of data) {
      const strike = Number(row?.strike);
      if (!Number.isFinite(strike)) continue;
      pain += Math.max(0, k - strike) * Math.max(0, Number(row?.call?.oi) || 0);
      pain += Math.max(0, strike - k) * Math.max(0, Number(row?.put?.oi) || 0);
    }
    if (pain < minPain) { minPain = pain; maxPain = k; }
  }

  const callBuildup = callChangeOI > 0 ? (callChangeOI > Math.max(1, callOI * 0.01) ? "RISING" : "MILD_RISE") : callChangeOI < 0 ? "FALLING" : "FLAT";
  const putBuildup = putChangeOI > 0 ? (putChangeOI > Math.max(1, putOI * 0.01) ? "RISING" : "MILD_RISE") : putChangeOI < 0 ? "FALLING" : "FLAT";
  let oiBuildup = "NEUTRAL";
  if (putChangeOI > 0 && callChangeOI < 0) oiBuildup = "PUT_BUILDUP";
  else if (callChangeOI > 0 && putChangeOI < 0) oiBuildup = "CALL_BUILDUP";
  else if (putChangeOI > 0 && callChangeOI > 0) oiBuildup = "TWO_SIDED_BUILDUP";
  else if (putChangeOI < 0 && callChangeOI < 0) oiBuildup = "TWO_SIDED_UNWINDING";

  const expiryText = expiry ? String(expiry).slice(0,10) : null;
  let daysToExpiry = null, expiryBehavior = "UNKNOWN";
  if (expiryText) {
    const target = new Date(`${expiryText}T15:30:00+05:30`);
    if (!Number.isNaN(target.getTime())) {
      daysToExpiry = Math.max(0, Math.ceil((target.getTime() - Date.now()) / 86400000));
      expiryBehavior = daysToExpiry <= 1 ? "EXPIRY_DAY" : daysToExpiry <= 7 ? "EXPIRY_WEEK" : "NORMAL";
    }
  }

  const avgSpread = spreadCount ? totalSpread / spreadCount : null;
  const totalVolume = callVolume + putVolume;
  const totalOI = callOI + putOI;
  const liquidity = totalVolume > 0 || totalOI > 0 ? (totalVolume > totalOI * 0.05 ? "HIGH" : "MODERATE") : "LOW";

  return {
    available: data.length > 0,
    totalOI: Math.round(totalOI),
    totalVolume: Math.round(totalVolume),
    callOI: Math.round(callOI),
    putOI: Math.round(putOI),
    callVolume: Math.round(callVolume),
    putVolume: Math.round(putVolume),
    callChangeOI: Math.round(callChangeOI),
    putChangeOI: Math.round(putChangeOI),
    pcrOI: round(pcrOI, 3),
    pcrVolume: round(pcrVolume, 3),
    oiBuildup,
    callBuildup,
    putBuildup,
    avgCallIV: avgCallIV !== null ? round(avgCallIV, 2) : null,
    avgPutIV: avgPutIV !== null ? round(avgPutIV, 2) : null,
    atmIV: atmIV !== null ? round(atmIV, 2) : null,
    maxPain: maxPain !== null ? round(maxPain) : null,
    liquidity,
    averageSpread: avgSpread !== null ? round(avgSpread, 3) : null,
    expiry: expiryText,
    daysToExpiry,
    expiryBehavior
  };
}

// ============================================================
// STEP 8 — MARKET REGIME ENGINE
// ============================================================

function calculateMarketRegime(technical, optionSummary, optionAdvanced) {
  const t = technical || {};
  const pa = t.priceAction || {};
  const mtf = t.multiTimeframe || {};
  const trend = String(t.trend || t.emaTrend || "SIDEWAYS").toUpperCase();
  const momentum = String(t.momentum?.direction || "FLAT").toUpperCase();
  const volatility = String(t.volatility?.state || "NORMAL").toUpperCase();
  const rangeState = String(pa.range?.state || "NORMAL").toUpperCase();
  const alignment = String(mtf.alignment || "NEUTRAL").toUpperCase();
  const optionSentiment = String(optionSummary?.sentiment || "NEUTRAL").toUpperCase();

  let direction = "NEUTRAL";
  if (trend === "BULLISH" && (momentum === "UP" || alignment === "ALIGNED")) direction = "BULLISH";
  else if (trend === "BEARISH" && (momentum === "DOWN" || alignment === "ALIGNED")) direction = "BEARISH";
  else if (optionSentiment === "BULLISH" && trend !== "BEARISH") direction = "BULLISH";
  else if (optionSentiment === "BEARISH" && trend !== "BULLISH") direction = "BEARISH";

  let structure = "RANGE";
  if (rangeState === "EXPANSION" || pa.breakout?.detected || pa.orb?.breakout) structure = "TRENDING";
  else if (rangeState === "CONTRACTION" || trend === "SIDEWAYS") structure = "RANGE";
  else if (trend === "BULLISH" || trend === "BEARISH") structure = "TRENDING";

  const volState = volatility === "HIGH" ? "HIGH_VOLATILITY" : volatility === "LOW" ? "LOW_VOLATILITY" : "NORMAL_VOLATILITY";
  const bias = direction === "NEUTRAL" ? optionSentiment === "NEUTRAL" ? "NEUTRAL" : optionSentiment : direction;

  return {
    structure,
    direction,
    bias,
    volatility: volState,
    timeframeAlignment: alignment,
    optionBias: optionSentiment,
    optionOIState: optionAdvanced?.oiBuildup || "NEUTRAL",
    label: `${structure}_${direction}_${volState}`
  };
}

// ============================================================
// MOVEMENT ENGINE
// ============================================================

function movementFromPrevious(index, currentPrice, candles = []) {
  const current = Number(currentPrice);
  const previousPoll = Number(state.previousPrices[index]);
  state.previousPrices[index] = current;

  if (!Number.isFinite(current)) {
    return { points: 0, percent: 0, significant: false, direction: "NONE", source: "unavailable" };
  }

  // Use completed candle movement rather than the last API refresh. This keeps
  // movement stable and prevents UP/DOWN flicker when the quote refreshes.
  const closes = Array.isArray(candles)
    ? candles.map(c => Number(c?.[4])).filter(Number.isFinite)
    : [];
  const lookback = 3;
  const base = closes.length > lookback ? closes[closes.length - 1 - lookback] : null;
  const candleMove = Number.isFinite(base) ? current - base : 0;
  const candlePercent = Number.isFinite(base) && base !== 0 ? (candleMove / base) * 100 : 0;

  const ranges = Array.isArray(candles)
    ? candles.slice(-14).map(c => Number(c?.[2]) - Number(c?.[3])).filter(v => Number.isFinite(v) && v > 0)
    : [];
  const avgRange = ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : 0;
  const threshold = Number(state.settings.movementThreshold) || 20;
  const effectiveThreshold = Math.max(threshold, avgRange * 0.75);
  const direction = candleMove > avgRange * 0.15 ? "UP" : candleMove < -avgRange * 0.15 ? "DOWN" : "FLAT";
  const significant = Math.abs(candleMove) >= effectiveThreshold;

  return {
    points: round(candleMove),
    percent: round(candlePercent, 3),
    significant,
    direction,
    source: "3-candle-momentum",
    avgRange: round(avgRange),
    pollingPoints: Number.isFinite(previousPoll) ? round(current - previousPoll) : 0
  };
}

// ============================================================
// CONFIDENCE ENGINE
// ============================================================

function calculateConfidence(
  market,
  technical,
  movement,
  optionSummary
) {
  let confidence = 50;

  const reasons = [];
  const risks = [];

  if (
    movement.significant
  ) {
    confidence += 8;

    reasons.push(
      `${Math.abs(
        movement.points
      )} point movement confirmed`
    );
  }

  if (
    movement.direction ===
    "UP"
  ) {
    if (
      technical.trend ===
      "BULLISH"
    ) {
      confidence += 10;
      reasons.push(
        "EMA trend supports upside"
      );
    }

    if (
      technical.trend ===
      "BEARISH"
    ) {
      confidence -= 10;
      risks.push(
        "EMA trend conflicts with upside"
      );
    }

    if (
      technical.structure ===
      "BULLISH"
    ) {
      confidence += 8;
      reasons.push(
        "Higher-high / higher-low structure"
      );
    }

    if (
      optionSummary?.sentiment ===
      "BULLISH"
    ) {
      confidence += 8;
      reasons.push(
        "Option sentiment supports upside"
      );
    }

    if (
      optionSummary?.sentiment ===
      "BEARISH"
    ) {
      confidence -= 6;
      risks.push(
        "Option sentiment conflicts with upside"
      );
    }
  }

  if (
    movement.direction ===
    "DOWN"
  ) {
    if (
      technical.trend ===
      "BEARISH"
    ) {
      confidence += 10;
      reasons.push(
        "EMA trend supports downside"
      );
    }

    if (
      technical.trend ===
      "BULLISH"
    ) {
      confidence -= 10;
      risks.push(
        "EMA trend conflicts with downside"
      );
    }

    if (
      technical.structure ===
      "BEARISH"
    ) {
      confidence += 8;
      reasons.push(
        "Lower-high / lower-low structure"
      );
    }

    if (
      optionSummary?.sentiment ===
      "BEARISH"
    ) {
      confidence += 8;
      reasons.push(
        "Option sentiment supports downside"
      );
    }

    if (
      optionSummary?.sentiment ===
      "BULLISH"
    ) {
      confidence -= 6;
      risks.push(
        "Option sentiment conflicts with downside"
      );
    }
  }

  if (
    technical.vwap !== null
  ) {
    confidence += 3;
  }

  if (
    technical.rsi !== null
  ) {
    if (
      movement.direction ===
        "UP" &&
      technical.rsi >= 50 &&
      technical.rsi <= 70
    ) {
      confidence += 6;
      reasons.push(
        "RSI confirms bullish momentum"
      );
    }

    if (
      movement.direction ===
        "DOWN" &&
      technical.rsi <= 50 &&
      technical.rsi >= 30
    ) {
      confidence += 6;
      reasons.push(
        "RSI confirms bearish momentum"
      );
    }

    if (
      technical.rsi > 75
    ) {
      confidence -= 4;
      risks.push(
        "RSI is overheated"
      );
    }

    if (
      technical.rsi < 25
    ) {
      confidence -= 4;
      risks.push(
        "RSI is deeply oversold"
      );
    }
  }

  const threshold =
    Number(
      state.settings
        .movementThreshold
    );

  if (
    !movement.significant
  ) {
    risks.push(
      `${threshold}+ point movement not confirmed`
    );
  }

  confidence =
    clamp(
      confidence,
      20,
      95
    );

  const tradeMinConfidence = 61;
  let suggestion;

  if (
    confidence >= tradeMinConfidence &&
    movement.significant
  ) {
    suggestion =
      "TRADE CONSIDER";
  } else if (
    confidence >= tradeMinConfidence
  ) {
    suggestion =
      "WAIT FOR CONFIRMATION";
  } else {
    suggestion =
      "AVOID / NO TRADE";
  }

  return {
    confidence:
      Math.round(
        confidence
      ),

    suggestion,

    reasons,

    risks
  };
}

// ============================================================
// OPTION TRADE SETUP
// ============================================================

// ============================================================
// STEP 9 — EXACT STRIKE SELECTION ENGINE
// Select one concrete option contract using deterministic market + Greeks +
// liquidity scoring. The AI does not invent a strike; this engine supplies it.
// ============================================================

function createOptionTrades(
  index,
  market,
  movement,
  confidenceData,
  rows,
  expiry = null,
  optionAdvanced = null,
  technical = null
) {
  if (!market || !market.available || !movement?.significant) {
    return [];
  }

  // ERA trade signals remain gated at 65% confidence or higher.
  const tradeMinConfidence = Math.max(
    65,
    Math.max(65, Number(state.settings?.minConfidence || 65))
  );

  if (Number(confidenceData?.confidence || 0) < tradeMinConfidence) {
    return [];
  }

  const direction = movement.direction;
  const optionType =
    direction === "UP" ? "CE" :
    direction === "DOWN" ? "PE" : null;

  if (!optionType || !Array.isArray(rows) || !rows.length) {
    return [];
  }

  const spot = Number(market.price);
  if (!Number.isFinite(spot) || spot <= 0) return [];

  const validRows = rows
    .filter(row => Number.isFinite(Number(row?.strike)))
    .sort((a, b) => Math.abs(Number(a.strike) - spot) - Math.abs(Number(b.strike) - spot));

  if (!validRows.length) return [];

  // Infer the exchange strike step from the option chain instead of hard-coding
  // one value, so NIFTY/BANKNIFTY/FINNIFTY/SENSEX can use their own spacing.
  const uniqueStrikes = [...new Set(validRows.map(r => Number(r.strike)).filter(Number.isFinite))].sort((a, b) => a - b);
  const stepCandidates = [];
  for (let i = 1; i < uniqueStrikes.length; i++) {
    const d = uniqueStrikes[i] - uniqueStrikes[i - 1];
    if (d > 0) stepCandidates.push(d);
  }
  const strikeStep = stepCandidates.length
    ? stepCandidates.sort((a, b) => a - b)[Math.floor(stepCandidates.length / 2)]
    : Math.max(1, Math.round(spot * 0.005));

  const maxDistance = Math.max(strikeStep * 6, spot * 0.025);
  const candidates = [];

  for (const row of validRows) {
    const strike = Number(row.strike);
    const distance = Math.abs(strike - spot);
    if (distance > maxDistance) continue;

    const side = optionType === "CE" ? row.call : row.put;
    if (!side || !side.instrumentKey) continue;

    const entry = Number(side.ltp);
    if (!Number.isFinite(entry) || entry <= 0) continue;

    const volume = Math.max(0, Number(side.volume) || 0);
    const oi = Math.max(0, Number(side.oi) || 0);
    if (volume <= 0 && oi <= 0) continue;

    const bid = Number(side.bidPrice) || 0;
    const ask = Number(side.askPrice) || 0;
    let spreadPct = null;
    if (bid > 0 && ask >= bid) {
      spreadPct = ((ask - bid) / Math.max(entry, 0.01)) * 100;
      // Avoid contracts whose quoted spread is too wide for a deterministic
      // entry price. Missing bid/ask is allowed when LTP/OI/volume are valid.
      if (spreadPct > 15) continue;
    }

    const rawDelta = Number(side.delta);
    const absDelta = Number.isFinite(rawDelta) && rawDelta !== 0 ? Math.abs(rawDelta) : null;
    if (absDelta !== null && (absDelta < 0.20 || absDelta > 0.80)) continue;

    candidates.push({ row, side, strike, distance, entry, volume, oi, spreadPct, absDelta });
  }

  if (!candidates.length) return [];

  const maxVolume = Math.max(...candidates.map(c => c.volume), 1);
  const maxOI = Math.max(...candidates.map(c => c.oi), 1);
  const atmIV = Number(optionAdvanced?.atmIV);

  for (const c of candidates) {
    const distanceScore = Math.max(0, 1 - c.distance / maxDistance) * 30;

    let deltaScore = 15;
    if (c.absDelta !== null) {
      deltaScore = Math.max(0, 1 - Math.abs(c.absDelta - 0.50) / 0.30) * 25;
    }

    const liquidityScore =
      (Math.log1p(c.volume) / Math.log1p(maxVolume)) * 10 +
      (Math.log1p(c.oi) / Math.log1p(maxOI)) * 10;

    // Scoring weights total exactly 100: distance 30 + delta 25 +
    // liquidity 20 + spread 20 + IV 5.
    let spreadScore = 20;
    if (c.spreadPct !== null) {
      spreadScore = Math.max(0, 20 - c.spreadPct * 2);
    }

    let ivScore = 5;
    const sideIV = Number(c.side.iv);
    if (Number.isFinite(atmIV) && atmIV > 0 && Number.isFinite(sideIV) && sideIV > 0) {
      const ivDistance = Math.abs(sideIV - atmIV) / atmIV;
      ivScore = Math.max(0, 5 - ivDistance * 10);
    }

    c.score = distanceScore + deltaScore + liquidityScore + spreadScore + ivScore;
  }

  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates[0];

  // A weak contract should result in NO TRADE rather than forcing an exact strike.
  if (!selected || selected.score < 55) return [];

  const entry = selected.entry;

  // Step 9 uses the underlying ATR + option delta to estimate a dynamic
  // premium risk instead of applying one fixed 20% stop to every contract.
  // Step 10 can later refine these levels with the full risk/decision engine.
  const underlyingATR = Number(technical?.atr);
  const deltaForRisk = selected.absDelta ?? 0.50;
  const volatilityLabel = String(technical?.volatility?.state || '').toUpperCase();
  let rawRisk = Number.isFinite(underlyingATR) && underlyingATR > 0
    ? underlyingATR * Math.max(0.20, Math.min(0.80, deltaForRisk))
    : entry * 0.20;

  if (volatilityLabel.includes('HIGH')) rawRisk *= 1.15;
  if (volatilityLabel.includes('LOW')) rawRisk *= 0.85;

  // Keep the provisional premium risk bounded so a missing/noisy ATR cannot
  // create an unusable stop distance.
  const minRisk = entry * 0.10;
  const maxRisk = entry * 0.35;
  const risk = Math.max(minRisk, Math.min(maxRisk, rawRisk));
  const stopLoss = entry - risk;
  if (!Number.isFinite(risk) || risk <= 0 || stopLoss <= 0) return [];

  const target1 = entry + risk * 1.5;
  const target2 = entry + risk * 2.5;
  const target3 = entry + risk * 3.5;

  const deltaText = selected.absDelta === null ? "delta unavailable" : `Δ ${round(selected.absDelta, 2)}`;
  const spreadText = selected.spreadPct === null ? "spread unavailable" : `spread ${round(selected.spreadPct, 2)}%`;
  const reason =
    `${optionType} ${round(selected.strike)} selected near ATM with ${deltaText}, ` +
    `OI ${Math.round(selected.oi)}, volume ${Math.round(selected.volume)}, ${spreadText}; ` +
    `selection score ${round(selected.score, 1)}/100.`;

  return [{
    index,
    instrumentKey: selected.side.instrumentKey,
    optionType,
    strike: round(selected.strike),
    expiry: expiry || selected.row.expiry || null,
    signal: "BUY",
    direction,
    entry: round(entry),
    stopLoss: round(stopLoss),
    targets: [round(target1), round(target2), round(target3)],
    rr: 3.5,
    riskModel: {
      method: 'UNDERLYING_ATR_X_DELTA',
      underlyingATR: Number.isFinite(underlyingATR) ? round(underlyingATR) : null,
      deltaUsed: round(deltaForRisk, 3),
      volatility: volatilityLabel || null,
      premiumRisk: round(risk),
      riskPercent: round((risk / entry) * 100, 2)
    },
    confidence: Number(confidenceData.confidence),
    status: Number(confidenceData.confidence) >= 75 ? "CONFIRMED" : "SETUP",
    invalidation: `Option price below ${round(stopLoss)}`,
    strikeSelection: {
      method: "ATM_DELTA_LIQUIDITY_SCORE",
      score: round(selected.score, 1),
      spot: round(spot),
      strikeStep: round(strikeStep),
      distanceFromSpot: round(selected.distance, 2),
      delta: selected.absDelta === null ? null : round(selected.absDelta, 3),
      volume: Math.round(selected.volume),
      oi: Math.round(selected.oi),
      spreadPct: selected.spreadPct === null ? null : round(selected.spreadPct, 3),
      reason
    },
    generatedAt: nowISO()
  }];
}

// ============================================================
// STEP 11 — SETUP MEMORY / ANTI-REPEAT ENGINE
// Lifecycle: NO_SETUP → WATCH → CONFIRMING → TRADE → RUNNING
// → TARGET/SL/INVALIDATED → COOLDOWN → NEW SETUP.
// Step 11 owns only setup memory. It does not execute broker orders.
// ============================================================

const SETUP_MEMORY_CONFIG = {
  requiredConfirmations: 2,
  staleMemoryMs: 24 * 60 * 60 * 1000,
  cooldownMs: 10 * 60 * 1000,
  // Prevent repeated API/UI calls from counting as separate confirmations
  // before the next scanner cycle has had time to produce a new observation.
  minimumConfirmationGapMs: 45 * 1000
};

function setupFingerprint({ index, direction, optionType, strike, expiry }) {
  return [
    String(index || "").toUpperCase(),
    String(direction || "").toUpperCase(),
    String(optionType || "").toUpperCase(),
    Number(strike) || 0,
    String(expiry || "")
  ].join("|");
}

function setupGroupFingerprint({ index, direction, optionType }) {
  return [
    String(index || "").toUpperCase(),
    String(direction || "").toUpperCase(),
    String(optionType || "").toUpperCase()
  ].join("|");
}

function cleanupSetupMemory() {
  const memory = state.setupMemory || {};
  const cutoff = Date.now() - SETUP_MEMORY_CONFIG.staleMemoryMs;
  let changed = false;

  for (const [key, item] of Object.entries(memory)) {
    const lastSeen = new Date(item?.lastSeenAt || 0).getTime();
    if (!lastSeen || lastSeen < cutoff) {
      delete memory[key];
      changed = true;
    }
  }

  return changed;
}

function getSetupMemory(candidate) {
  if (!candidate) return null;
  const key = setupFingerprint(candidate);
  return { key, item: state.setupMemory?.[key] || null };
}

function evaluateSetupMemory(candidate, { marketPrice = null } = {}) {
  if (!candidate) {
    return {
      allowed: false,
      decision: "NO TRADE",
      state: "NO_SETUP",
      reason: "No candidate setup is available.",
      fingerprint: null,
      confirmations: 0
    };
  }

  const changed = cleanupSetupMemory();
  const key = setupFingerprint(candidate);
  const groupKey = setupGroupFingerprint(candidate);
  const now = Date.now();
  const nowText = nowISO();
  const existing = state.setupMemory[key];

  // A new strike/expiry in the same directional setup replaces the old
  // candidate rather than allowing several near-identical setups to fire.
  for (const [otherKey, other] of Object.entries(state.setupMemory)) {
    if (otherKey === key) continue;
    if (other?.groupKey === groupKey && ["TRADE", "RUNNING", "CONFIRMING", "WATCH"].includes(other?.state)) {
      other.state = "INVALIDATED";
      other.invalidatedAt = nowText;
      other.lastSeenAt = nowText;
    }
  }

  let item = existing;
  if (!item) {
    item = {
      fingerprint: key,
      groupKey,
      index: candidate.index,
      direction: candidate.direction,
      optionType: candidate.optionType,
      strike: Number(candidate.strike),
      expiry: candidate.expiry || null,
      state: "WATCH",
      confirmations: 0,
      firstSeenAt: nowText,
      lastSeenAt: nowText,
      lastDecisionAt: null,
      lastConfirmationAt: null,
      lastEntry: Number(candidate.entry) || null,
      lastUnderlyingPrice: Number.isFinite(Number(marketPrice)) ? Number(marketPrice) : null,
      cooldownUntil: null,
      invalidatedAt: null
    };
    state.setupMemory[key] = item;
  } else {
    item.lastSeenAt = nowText;
    item.lastEntry = Number(candidate.entry) || item.lastEntry;
    if (Number.isFinite(Number(marketPrice))) item.lastUnderlyingPrice = Number(marketPrice);
  }

  const cooldownUntilMs = item.cooldownUntil ? new Date(item.cooldownUntil).getTime() : 0;
  if (item.state === "COOLDOWN" && cooldownUntilMs > now) {
    if (changed) saveState();
    return {
      allowed: false,
      decision: "WAIT",
      state: "COOLDOWN",
      reason: "Same setup is inside the anti-repeat cooldown.",
      fingerprint: key,
      confirmations: Number(item.confirmations || 0)
    };
  }

  if (item.state === "COOLDOWN" && cooldownUntilMs <= now) {
    item.state = "WATCH";
    item.confirmations = 0;
    item.lastConfirmationAt = null;
    item.cooldownUntil = null;
  }

  // Once a setup has already produced a TRADE signal, do not emit it again
  // until its fingerprint is invalidated by a new setup. This is the core
  // anti-repeat rule.
  if (item.state === "TRADE" || item.state === "RUNNING") {
    if (changed) saveState();
    return {
      allowed: false,
      decision: "WAIT",
      state: item.state,
      reason: "Same setup is already active; waiting for invalidation or a new setup.",
      fingerprint: key,
      confirmations: Number(item.confirmations || 0)
    };
  }

  const lastConfirmationMs = item.lastConfirmationAt
    ? new Date(item.lastConfirmationAt).getTime()
    : 0;

  // /api/analysis and AI Brain can both trigger fresh analysis. Do not let
  // repeated requests within the same scanner window fake the required
  // consecutive confirmation count.
  if (lastConfirmationMs && now - lastConfirmationMs < SETUP_MEMORY_CONFIG.minimumConfirmationGapMs) {
    if (changed) saveState();
    return {
      allowed: false,
      decision: "WAIT",
      state: item.state === "TRADE" ? "TRADE" : "CONFIRMING",
      reason: "Waiting for the next distinct market observation before counting another confirmation.",
      fingerprint: key,
      confirmations: Number(item.confirmations || 0)
    };
  }

  item.confirmations = Number(item.confirmations || 0) + 1;
  item.lastConfirmationAt = nowText;

  if (item.confirmations < SETUP_MEMORY_CONFIG.requiredConfirmations) {
    item.state = "CONFIRMING";
    if (changed || true) saveState();
    return {
      allowed: false,
      decision: "WAIT",
      state: "CONFIRMING",
      reason: `Setup confirmation ${item.confirmations}/${SETUP_MEMORY_CONFIG.requiredConfirmations}; waiting for the next consistent scan.`,
      fingerprint: key,
      confirmations: item.confirmations
    };
  }

  item.state = "TRADE";
  item.lastDecisionAt = nowText;
  item.invalidatedAt = null;
  item.cooldownUntil = null;
  saveState();

  return {
    allowed: true,
    decision: "TRADE",
    state: "TRADE",
    reason: "Setup confirmed across consecutive scans and has not previously fired.",
    fingerprint: key,
    confirmations: item.confirmations
  };
}

function invalidateSetupMemory({ index, direction, optionType, strike, expiry, reason = "Setup invalidated." }) {
  const key = setupFingerprint({ index, direction, optionType, strike, expiry });
  const item = state.setupMemory?.[key];
  if (!item) return false;

  item.state = "INVALIDATED";
  item.invalidatedAt = nowISO();
  item.lastSeenAt = nowISO();
  item.invalidatedReason = reason;
  item.lastConfirmationAt = null;
  item.confirmations = 0;
  item.cooldownUntil = new Date(Date.now() + SETUP_MEMORY_CONFIG.cooldownMs).toISOString();
  saveState();
  return true;
}

// ============================================================
// STEP 10 — TRADE DECISION ENGINE
// Final deterministic gate after technical, price action, regime,
// options and exact-strike selection. The engine decides TRADE / WAIT /
// NO TRADE; AI does not override this gate.
// ============================================================

function countTradesToday() {
  // Step 10 uses the Step 15 canonical execution ledger.
  // Daily boundaries are explicitly Asia/Kolkata.
  const dayKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const ledger = Array.isArray(state.executionLedger) ? state.executionLedger : [];
  const ids = new Set();
  for (const event of ledger) {
    if (!event || String(event.executionType).toUpperCase() !== "PAPER") continue;
    if (String(event.eventType).toUpperCase() !== "OPEN") continue;
    if (String(event.side).toUpperCase() !== "BUY") continue;
    const ts = new Date(event.executedAt || 0);
    if (Number.isNaN(ts.getTime())) continue;
    if (ts.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) === dayKey) ids.add(event.tradeId || event.id);
  }
  return ids.size;
}

function tradeDecisionEngine({
  index,
  market,
  technical,
  movement,
  regime,
  optionSummary,
  optionAdvanced,
  confidenceData,
  candidates
}) {
  const blockers = [];
  const reasons = [];
  const risks = [];
  const baseConfidence = Number(confidenceData?.confidence || 0);
  const minConfidence = Math.max(65, Number(state.settings?.minConfidence || 65));
  const maxPositions = Number(state.risk?.maxPositions || 0);
  const maxTradesPerDay = Number(state.risk?.maxTradesPerDay || 0);
  const openPositions = Array.isArray(state.paper?.positions)
    ? state.paper.positions.length
    : 0;
  const tradesToday = countTradesToday();

  if (!state.engineRunning) blockers.push("ERA engine is stopped.");
  if (!isMarketHours()) blockers.push("Market session is closed.");
  if (!market?.available) blockers.push("Live market data is unavailable.");
  if (market?.stale) blockers.push("Live market data is stale.");
  if (state.risk?.killSwitch) blockers.push("ERA risk kill switch is ON.");
  if (!movement?.significant) blockers.push("Price movement is not sufficiently confirmed.");
  if (baseConfidence < minConfidence) blockers.push(`Confidence ${baseConfidence}% is below ERA minimum ${minConfidence}%.`);
  if (!Array.isArray(candidates) || !candidates.length) blockers.push("No valid exact-strike option contract passed selection.");
  if (maxPositions > 0 && openPositions >= maxPositions) blockers.push(`Maximum open paper positions reached (${openPositions}/${maxPositions}).`);
  if (maxTradesPerDay > 0 && tradesToday >= maxTradesPerDay) blockers.push(`Maximum trades for today reached (${tradesToday}/${maxTradesPerDay}).`);

  const direction = String(movement?.direction || "NONE").toUpperCase();
  const expectedRegimeDirection = direction === "UP" ? "BULLISH" : direction === "DOWN" ? "BEARISH" : "NEUTRAL";
  const regimeDirection = String(regime?.direction || "NEUTRAL").toUpperCase();
  const mtfAlignment = String(technical?.multiTimeframe?.alignment || "NEUTRAL").toUpperCase();
  const optionBias = String(regime?.optionBias || optionSummary?.sentiment || "NEUTRAL").toUpperCase();
  const pa = technical?.priceAction || {};

  let decisionScore = baseConfidence;

  if (regimeDirection === expectedRegimeDirection) {
    decisionScore += 5;
    reasons.push("Market regime agrees with the directional move.");
  } else if (regimeDirection !== "NEUTRAL") {
    decisionScore -= 10;
    risks.push(`Market regime conflicts with ${expectedRegimeDirection.toLowerCase()} direction.`);
  } else {
    risks.push("Market regime is neutral.");
  }

  if (mtfAlignment === "ALIGNED") {
    decisionScore += 5;
    reasons.push("Multi-timeframe direction is aligned.");
  } else if (mtfAlignment === "CONFLICT") {
    decisionScore -= 10;
    risks.push("Multi-timeframe structure is conflicting.");
  }

  const optionExpected = expectedRegimeDirection === "BULLISH" ? "BULLISH" : expectedRegimeDirection === "BEARISH" ? "BEARISH" : "NEUTRAL";
  if (optionBias === optionExpected) {
    decisionScore += 5;
    reasons.push("Options sentiment supports the trade direction.");
  } else if (optionBias !== "NEUTRAL") {
    decisionScore -= 7;
    risks.push("Options sentiment conflicts with the trade direction.");
  }

  const paMomentum = String(pa.momentumConfirmation?.direction || "NONE").toUpperCase();
  if (paMomentum === direction) {
    decisionScore += 5;
    reasons.push("Price-action momentum confirms the direction.");
  } else if (paMomentum !== "NONE" && paMomentum !== "NEUTRAL") {
    decisionScore -= 7;
    risks.push("Price-action momentum conflicts with the direction.");
  }

  const breakoutDirection = String(pa.breakout?.direction || "NONE").toUpperCase();
  if (pa.breakout?.detected && breakoutDirection === direction) {
    decisionScore += 3;
    reasons.push("Breakout direction agrees with the setup.");
  } else if (pa.breakout?.detected && breakoutDirection !== direction) {
    decisionScore -= 5;
    risks.push("Detected breakout conflicts with the setup direction.");
  }

  const selected = Array.isArray(candidates) ? candidates[0] : null;
  const strikeScore = Number(selected?.strikeSelection?.score);
  if (Number.isFinite(strikeScore)) {
    if (strikeScore >= 80) {
      decisionScore += 5;
      reasons.push(`Exact-strike selection score is strong at ${round(strikeScore, 1)}/100.`);
    } else if (strikeScore >= 65) {
      decisionScore += 2;
      reasons.push(`Exact-strike selection score is acceptable at ${round(strikeScore, 1)}/100.`);
    } else {
      decisionScore -= 5;
      risks.push(`Exact-strike selection score is weak at ${round(strikeScore, 1)}/100.`);
    }
  }

  const finalScore = Math.round(clamp(decisionScore, 0, 100));

  if (selected) {
    const entry = Number(selected.entry);
    const stopLoss = Number(selected.stopLoss);
    const targets = Array.isArray(selected.targets) ? selected.targets.map(Number) : [];
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stopLoss) || stopLoss <= 0 || stopLoss >= entry) {
      blockers.push("Selected trade has invalid entry/stop values.");
    }
    if (targets.length < 1 || targets.some(v => !Number.isFinite(v) || v <= entry)) {
      blockers.push("Selected trade does not have valid upside targets.");
    }
    if (!selected.expiry) blockers.push("Option expiry is missing.");
    if (!selected.instrumentKey) blockers.push("Option instrument key is missing.");
  }

  const hardConflict =
    regimeDirection !== "NEUTRAL" && regimeDirection !== expectedRegimeDirection;

  let setupMemoryDecision = {
    allowed: false,
    decision: "NO TRADE",
    state: "NO_SETUP",
    reason: "No valid setup memory candidate.",
    fingerprint: null,
    confirmations: 0
  };

  if (selected && blockers.length === 0 && !hardConflict && finalScore >= minConfidence) {
    setupMemoryDecision = evaluateSetupMemory(selected, { marketPrice: market?.price });
    if (!setupMemoryDecision.allowed) {
      blockers.push(setupMemoryDecision.reason);
    }
  }

  const finalTradeAllowed =
    blockers.length === 0 &&
    !hardConflict &&
    finalScore >= minConfidence &&
    setupMemoryDecision.allowed;

  if (hardConflict && blockers.length === 0) {
    blockers.push("Market regime direction is materially against the proposed trade.");
  }

  let decision = "NO TRADE";
  if (finalTradeAllowed) decision = "TRADE";
  else if (
    blockers.length === 0 &&
    finalScore >= 55 &&
    !state.risk?.killSwitch &&
    isMarketHours()
  ) decision = "WAIT";

  let finalTrade = null;
  if (selected) {
    finalTrade = {
      ...selected,
      status: finalTradeAllowed ? (finalScore >= 75 ? "CONFIRMED" : "SETUP") : "WAIT",
      decision,
      decisionScore: finalScore,
      decisionReasons: reasons.slice(0, 8),
      decisionRisks: [...risks, ...blockers].slice(0, 10),
      setupMemory: setupMemoryDecision,
      decisionAt: nowISO()
    };
  }

  return {
    decision,
    score: finalScore,
    allowed: finalTradeAllowed,
    trade: finalTradeAllowed ? finalTrade : null,
    candidate: finalTrade,
    reasons: reasons.slice(0, 8),
    risks: [...risks, ...blockers].slice(0, 10),
    blockers,
    setupMemory: setupMemoryDecision,
    context: {
      baseConfidence,
      minConfidence,
      regimeDirection,
      timeframeAlignment: mtfAlignment,
      optionBias,
      strikeScore: Number.isFinite(strikeScore) ? round(strikeScore, 1) : null,
      openPositions,
      tradesToday,
      maxPositions,
      maxTradesPerDay
    }
  };
}

// ============================================================
// STEP 12 — NO-TRADE INTELLIGENCE
// Converts deterministic trade blockers into structured, actionable
// explanations. This layer never creates or overrides a trade.
// ============================================================

function classifyNoTradeReason(reason) {
  const text = String(reason || "").toLowerCase();

  if (text.includes("market session is closed")) return { code: "MARKET_CLOSED", category: "MARKET", severity: "INFO", action: "Wait for the next valid market session." };
  if (text.includes("engine is stopped")) return { code: "ENGINE_STOPPED", category: "SYSTEM", severity: "BLOCKING", action: "Start the ERA engine before evaluating a setup." };
  if (text.includes("market data unavailable")) return { code: "MARKET_DATA_UNAVAILABLE", category: "DATA", severity: "BLOCKING", action: "Wait for valid live market data." };
  if (text.includes("market data is stale")) return { code: "MARKET_DATA_STALE", category: "DATA", severity: "BLOCKING", action: "Wait for a fresh live tick/data refresh." };
  if (text.includes("movement is not sufficiently confirmed")) return { code: "INSUFFICIENT_MOVEMENT", category: "PRICE_ACTION", severity: "WAIT", action: "Wait for a clearer directional move and confirmation." };
  if (text.includes("confidence") && text.includes("below era minimum")) return { code: "LOW_CONFIDENCE", category: "MODEL", severity: "WAIT", action: "Wait until the validated confidence clears ERA's minimum threshold." };
  if (text.includes("no valid exact-strike option contract")) return { code: "NO_EXACT_STRIKE", category: "OPTIONS", severity: "BLOCKING", action: "Wait for an option contract that passes the exact-strike selection rules." };
  if (text.includes("maximum open paper positions")) return { code: "MAX_OPEN_POSITIONS", category: "RISK", severity: "BLOCKING", action: "Do not add another position until an existing position is closed or the risk limit changes." };
  if (text.includes("maximum trades for today")) return { code: "MAX_TRADES_DAY", category: "RISK", severity: "BLOCKING", action: "Wait for the next trading day or an explicitly changed risk limit." };
  if (text.includes("kill switch")) return { code: "KILL_SWITCH", category: "RISK", severity: "BLOCKING", action: "Keep trading blocked until the risk kill switch is intentionally turned off." };
  if (text.includes("regime direction is materially against") || text.includes("market regime conflicts")) return { code: "REGIME_CONFLICT", category: "MARKET_REGIME", severity: "BLOCKING", action: "Wait for regime and setup direction to align." };
  if (text.includes("market regime is neutral")) return { code: "REGIME_NEUTRAL", category: "MARKET_REGIME", severity: "WAIT", action: "Wait for a clearer market regime before taking a directional setup." };
  if (text.includes("multi-timeframe structure is conflicting")) return { code: "MTF_CONFLICT", category: "MULTI_TIMEFRAME", severity: "WAIT", action: "Wait for the 5m and 15m directional context to align." };
  if (text.includes("options sentiment conflicts")) return { code: "OPTIONS_CONFLICT", category: "OPTIONS", severity: "WAIT", action: "Wait for options positioning to stop conflicting with the proposed direction." };
  if (text.includes("options sentiment is neutral")) return { code: "OPTIONS_NEUTRAL", category: "OPTIONS", severity: "WAIT", action: "Wait for stronger options confirmation or a clearer directional setup." };
  if (text.includes("price-action momentum conflicts")) return { code: "MOMENTUM_CONFLICT", category: "PRICE_ACTION", severity: "WAIT", action: "Wait for price-action momentum to confirm the proposed direction." };
  if (text.includes("breakout conflicts")) return { code: "BREAKOUT_CONFLICT", category: "PRICE_ACTION", severity: "WAIT", action: "Wait for breakout direction to agree with the setup." };
  if (text.includes("exact-strike selection score is weak")) return { code: "WEAK_STRIKE_SCORE", category: "OPTIONS", severity: "WAIT", action: "Wait for a stronger-liquidity, better-aligned strike candidate." };
  if (text.includes("setup confirmation")) return { code: "SETUP_CONFIRMATION_PENDING", category: "SETUP_MEMORY", severity: "WAIT", action: "Wait for the next distinct market observation to confirm the same setup." };
  if (text.includes("selected trade has invalid entry/stop")) return { code: "INVALID_RISK_LEVELS", category: "RISK", severity: "BLOCKING", action: "Wait for a candidate with valid entry and stop-loss levels." };
  if (text.includes("does not have valid upside targets")) return { code: "INVALID_TARGETS", category: "RISK", severity: "BLOCKING", action: "Wait for a candidate with valid targets." };
  if (text.includes("option expiry is missing")) return { code: "MISSING_EXPIRY", category: "OPTIONS", severity: "BLOCKING", action: "Wait for a contract with a valid expiry." };
  if (text.includes("instrument key is missing")) return { code: "MISSING_INSTRUMENT", category: "OPTIONS", severity: "BLOCKING", action: "Wait for a contract with a valid broker instrument key." };

  return { code: "UNSPECIFIED_RISK", category: "CONTEXT", severity: "WAIT", action: "Wait for the market conditions to become clearer and re-evaluate." };
}

function buildNoTradeIntelligence({ index, market, technical, movement, regime, confidenceData, decisionEngine }) {
  const decision = String(decisionEngine?.decision || "NO TRADE").toUpperCase();
  const blockers = Array.isArray(decisionEngine?.blockers) ? decisionEngine.blockers.filter(Boolean) : [];
  const risks = Array.isArray(decisionEngine?.risks) ? decisionEngine.risks.filter(Boolean) : [];
  const rawReasons = [...new Set([...blockers, ...risks])];

  if (decision === "TRADE") {
    return { available: false, status: "TRADE_ALLOWED", decision: "TRADE", primaryReason: null, reasons: [], whatMustChange: [], evaluatedAt: nowISO() };
  }

  const reasonMap = new Map();
  for (const reason of rawReasons) {
    const item = classifyNoTradeReason(reason);
    if (!reasonMap.has(item.code)) {
      reasonMap.set(item.code, { code: item.code, category: item.category, severity: item.severity, reason, action: item.action });
    }
  }

  const setupMemory = decisionEngine?.setupMemory || {};
  if (setupMemory?.state === "CONFIRMING" && !reasonMap.has("SETUP_CONFIRMATION_PENDING")) {
    const confirmationReason = setupMemory.reason || `Setup confirmation ${setupMemory.confirmations || 0}/2 is pending.`;
    reasonMap.set("SETUP_CONFIRMATION_PENDING", { code: "SETUP_CONFIRMATION_PENDING", category: "SETUP_MEMORY", severity: "WAIT", reason: confirmationReason, action: "Wait for the next distinct market observation to confirm the same setup." });
  }

  const reasons = Array.from(reasonMap.values());
  if (!reasons.length) {
    reasons.push({ code: "NO_QUALIFIED_SETUP", category: "SETUP", severity: "WAIT", reason: "No qualified trade setup passed ERA's deterministic decision gate.", action: "Wait for the required market, technical and options conditions to align." });
  }

  const priority = { BLOCKING: 0, WAIT: 1, INFO: 2 };
  reasons.sort((a, b) => {
    const severityDiff = (priority[a.severity] ?? 9) - (priority[b.severity] ?? 9);
    return severityDiff || a.category.localeCompare(b.category);
  });

  const primary = reasons[0];
  const whatMustChange = [...new Set(reasons.filter(item => item.action).map(item => item.action))].slice(0, 8);

  return {
    available: true,
    status: decision === "WAIT" ? "WAIT" : "NO_TRADE",
    decision,
    index,
    primaryReason: primary.reason,
    primaryCode: primary.code,
    reasons: reasons.slice(0, 10),
    whatMustChange,
    snapshot: {
      marketOpen: isMarketHours(),
      marketAvailable: Boolean(market?.available),
      marketStale: Boolean(market?.stale),
      price: Number.isFinite(Number(market?.price)) ? Number(market.price) : null,
      movement: movement?.significant ? { significant: true, direction: movement.direction || null } : { significant: false, direction: movement?.direction || null },
      confidence: Number.isFinite(Number(confidenceData?.confidence)) ? Number(confidenceData.confidence) : null,
      regime: regime?.label || regime?.direction || null,
      timeframeAlignment: technical?.multiTimeframe?.alignment || null
    },
    evaluatedAt: nowISO()
  };
}

// ============================================================
// COMPLETE INDEX ANALYSIS
// ============================================================

async function analyzeIndex(
  index
) {
  const market =
    state.market[index];

  if (
    !market ||
    !market.available
  ) {
    return {
      index,
      available: false,
      error:
        "Market data unavailable",
      generatedAt:
        nowISO()
    };
  }

  let candles =
    await fetchIntradayCandles(
      index,
      5
    );

  /*
   * If intraday candles are unavailable,
   * fallback to historical candles.
   */
  if (
    candles.length === 0
  ) {
    candles =
      await fetchHistoricalCandles(
        index,
        5
      );
  }

  candles =
    syncLatestCandle(
      candles,
      market.price
    );

  const technical =
    technicalAnalysis(
      candles,
      market.price,
      market
    );

  // Multi-timeframe confirmation: 5m is the execution context and 15m is
  // the higher-timeframe trend context. If 15m data is unavailable, the
  // existing 5m analysis remains fully usable.
  let higherTimeframeCandles = [];
  try {
    higherTimeframeCandles = await fetchIntradayCandles(index, 15);
    if (!higherTimeframeCandles.length) {
      higherTimeframeCandles = await fetchHistoricalCandles(index, 15);
    }
  } catch (error) {
    console.warn(`[ERA] Higher timeframe analysis unavailable ${index}:`, error.message);
  }

  const higherTimeframe = buildTimeframeTechnical(
    higherTimeframeCandles,
    market.price
  );

  technical.multiTimeframe = {
    execution: "5m",
    higher: "15m",
    alignment: technical.trend !== "SIDEWAYS" &&
      higherTimeframe.trend === technical.trend
      ? "ALIGNED"
      : higherTimeframe.trend === "SIDEWAYS" || technical.trend === "SIDEWAYS"
        ? "NEUTRAL"
        : "CONFLICT",
    fiveMinute: {
      trend: technical.trend,
      rsi: technical.rsi,
      atr: technical.atr
    },
    fifteenMinute: higherTimeframe
  };

  let optionRows = [];
  let optionSummary = null;
  let expiry = null;

  /*
   * Existing working Option Chain flow.
   */
  try {
    const chain =
      await fetchOptionChain(
        index
      );

    expiry =
      chain.expiry;

    optionRows =
      normalizeOptionChain(
        chain.data
      );

    // Volume fallback only: when index/candle volume is unavailable, use
    // actual CE+PE traded volume from the option chain. No other logic is changed.
    if (
      (!Number.isFinite(Number(technical.volume)) || Number(technical.volume) <= 0) &&
      optionRows.length
    ) {
      const optionVolume = optionRows.reduce((sum, row) => {
        const ce = Number(row?.call?.volume || 0);
        const pe = Number(row?.put?.volume || 0);
        return sum + (Number.isFinite(ce) && ce > 0 ? ce : 0) + (Number.isFinite(pe) && pe > 0 ? pe : 0);
      }, 0);
      if (optionVolume > 0) technical.volume = optionVolume;
    }

    if (
      optionRows.length
    ) {
      const relevant =
        [...optionRows]
          .sort(
            (a, b) =>
              Math.abs(
                a.strike -
                market.price
              ) -
              Math.abs(
                b.strike -
                market.price
              )
          )
          .slice(0, 25);

      const instrumentKeys =
        [];

      for (
        const row of relevant
      ) {
        if (
          row.call?.instrumentKey
        ) {
          instrumentKeys.push(
            row.call.instrumentKey
          );
        }

        if (
          row.put?.instrumentKey
        ) {
          instrumentKeys.push(
            row.put.instrumentKey
          );
        }
      }

      const greeks =
        await fetchOptionGreeks(
          instrumentKeys
        );

      optionRows =
        mergeGreeks(
          optionRows,
          greeks
        );

      optionSummary =
        calculateOptionSummary(
          optionRows,
          market.price
        );
    }

  } catch (error) {
    console.error(
      `[ERA] Option analysis error ${index}:`,
      error.response?.data ||
      error.message
    );

    optionSummary = null;
  }

  const optionAdvanced =
    calculateAdvancedOptionAnalytics(
      optionRows,
      market.price,
      expiry
    );

  const marketRegime =
    calculateMarketRegime(
      technical,
      optionSummary,
      optionAdvanced
    );

  const movement =
    movementFromPrevious(
      index,
      market.price,
      candles
    );

  let signal =
    "NONE";

  if (
    movement.significant
  ) {
    if (
      movement.direction ===
      "UP"
    ) {
      signal =
        "BUY";
    } else if (
      movement.direction ===
      "DOWN"
    ) {
      signal =
        "SELL";
    }
  }

  const confidenceData =
    calculateConfidence(
      market,
      technical,
      movement,
      optionSummary
    );

  const candidateTrades =
    createOptionTrades(
      index,
      market,
      movement,
      confidenceData,
      optionRows,
      expiry,
      optionAdvanced,
      technical
    );

  const decisionEngine =
    tradeDecisionEngine({
      index,
      market,
      technical,
      movement,
      regime: marketRegime,
      optionSummary,
      optionAdvanced,
      confidenceData,
      candidates: candidateTrades
    });

  const noTradeIntelligence = buildNoTradeIntelligence({ index, market, technical, movement, regime: marketRegime, confidenceData, decisionEngine });

  const trades = decisionEngine.allowed && decisionEngine.trade
    ? [decisionEngine.trade]
    : [];

  recordGeneratedTrades(trades);

  return {
    index,

    available: true,

    market,

    candles: {
      interval: 5,

      count:
        candles.length,

      latest:
        candles.length
          ? candles[
              candles.length - 1
            ]
          : null,

      source:
        candles.length
          ? "upstox-v3"
          : "none"
    },

    movement,

    technical,

    exactStrikeSelection: trades[0]?.strikeSelection || null,

    options: {
      expiry,

      summary:
        optionSummary,

      advanced:
        optionAdvanced,

      rows:
        optionRows
    },

    regime:
      marketRegime,

    signal,

    confidence:
      confidenceData.confidence,

    reasons:
      confidenceData.reasons,

    risks:
      confidenceData.risks,

    suggestion:
      decisionEngine.decision,

    decision: decisionEngine,

    noTradeIntelligence,

    trades,

    generatedAt:
      nowISO()
  };
}

// ============================================================
// GENERATED TRADE HISTORY
// ============================================================

function recordGeneratedTrades(trades) {
  if (!Array.isArray(trades) || !trades.length) {
    return;
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let changed = false;

  for (const trade of trades) {
    const key = [
      trade.index,
      trade.optionType,
      trade.strike,
      trade.signal,
      trade.entry
    ].join("|");

    const exists = state.history.some(item =>
      item.type === "trade" &&
      item.historyKey === key &&
      new Date(item.createdAt || 0).getTime() >= cutoff
    );

    if (exists) {
      continue;
    }

    state.history.unshift({
      type: "trade",
      historyKey: key,
      ...trade,
      createdAt: trade.generatedAt || nowISO()
    });
    changed = true;
  }

  if (changed) {
    state.history = state.history.slice(0, 500);
    saveState();
  }
}

// ============================================================
// ALERT FINGERPRINT
// ============================================================

function tradeFingerprint(
  trade
) {
  return [
    trade.index,
    trade.strike,
    trade.optionType,
    trade.signal
  ].join("|");
}

// ============================================================
// PUSH NOTIFICATION
// ============================================================

async function sendPush(
  payload
) {
  if (
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY
  ) {
    return;
  }

  const subscriptions =
    Array.isArray(
      state.pushSubscriptions
    )
      ? state.pushSubscriptions
      : [];

  for (
    const subscription
    of subscriptions
  ) {
    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify(
          payload
        )
      );

    } catch (error) {
      if (
        error.statusCode ===
          404 ||
        error.statusCode ===
          410
      ) {
        state.pushSubscriptions =
          state.pushSubscriptions.filter(
            item =>
              item.endpoint !==
              subscription.endpoint
          );

        saveState();
      }
    }
  }
}

// ============================================================
// STEP 13 — TRADE ALERT + POPUP
// Creates a persistent, actionable alert only after Step 10/11 has
// produced a qualified trade. The UI can consume this through REST or
// the existing realtime SSE stream. No AI or UI action can bypass the
// deterministic trade gate.
// ============================================================

function tradeAlertId() {
  return `TA${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTradeAlertTrade(trade) {
  if (!trade || typeof trade !== "object") return null;
  const required = {
    index: trade.index,
    optionType: trade.optionType,
    strike: Number(trade.strike),
    expiry: trade.expiry || null,
    entry: Number(trade.entry),
    stopLoss: Number(trade.stopLoss),
    targets: Array.isArray(trade.targets) ? trade.targets.map(Number).filter(Number.isFinite).slice(0, 3) : [],
    confidence: Number(trade.confidence),
    signal: trade.signal || null,
    decision: trade.decision || "TRADE",
    decisionScore: Number(trade.decisionScore),
    instrumentKey: trade.instrumentKey || null,
    reason: trade.reason || null,
    decisionReasons: Array.isArray(trade.decisionReasons) ? trade.decisionReasons.slice(0, 8) : [],
    decisionRisks: Array.isArray(trade.decisionRisks) ? trade.decisionRisks.slice(0, 8) : [],
    strikeSelection: trade.strikeSelection || null,
    setupMemory: trade.setupMemory || null
  };

  if (!required.index || !required.optionType || !Number.isFinite(required.strike) || required.strike <= 0) return null;
  if (!required.expiry || !Number.isFinite(required.entry) || required.entry <= 0) return null;
  if (!Number.isFinite(required.stopLoss) || required.stopLoss <= 0 || required.stopLoss >= required.entry) return null;
  if (!required.targets.length || required.targets.some(v => v <= required.entry)) return null;
  if (!required.instrumentKey) return null;
  return required;
}

function buildTradeAlert(trade) {
  const normalized = normalizeTradeAlertTrade(trade);
  if (!normalized) return null;
  const fingerprint = tradeFingerprint(normalized);
  return {
    id: tradeAlertId(),
    type: "TRADE_ALERT",
    status: "NEW",
    action: null,
    fingerprint,
    trade: normalized,
    createdAt: nowISO(),
    actedAt: null,
    actedBy: null,
    actionReason: null
  };
}

async function notifyTrade(trade) {
  if (!state.settings.notifications?.tradeSetup) return;

  const normalized = normalizeTradeAlertTrade(trade);
  if (!normalized) return;

  const fingerprint = tradeFingerprint(normalized);
  const cooldownMs = Number(state.settings.notificationCooldownMs || 900000);
  const lastSent = Number(state.notificationHistory[`trade:${fingerprint}`] || 0);
  if (lastSent && Date.now() - lastSent < cooldownMs) return;

  const activeExisting = state.tradeAlerts.find(item =>
    item.fingerprint === fingerprint &&
    ["NEW", "CONSIDER", "PAPER_TRADE"].includes(item.status)
  );
  if (activeExisting && lastSent) return;

  state.notificationHistory[`trade:${fingerprint}`] = Date.now();

  const alert = buildTradeAlert(normalized);
  if (!alert) return;

  state.tradeAlerts.unshift(alert);
  state.tradeAlerts = state.tradeAlerts.slice(0, 200);

  // Keep the legacy alert store populated for existing UI consumers.
  state.alerts.unshift({
    id: alert.id,
    type: "TRADE",
    fingerprint,
    trade: normalized,
    confidence: normalized.confidence,
    status: alert.status,
    action: alert.action,
    createdAt: alert.createdAt
  });
  state.alerts = state.alerts.slice(0, 200);
  saveState();

  // Existing SSE channel becomes the popup/event transport. No UI rewrite is required.
  realtimeBroadcast("trade-alert", {
    ok: true,
    alert
  });

  await sendPush({
    title: `Era AI — ${normalized.index} Trade Setup`,
    body: `${normalized.optionType} ${normalized.strike} | ${normalized.signal || "TRADE"} | Entry ${normalized.entry} | Confidence ${normalized.confidence}%`,
    data: {
      type: "TRADE_ALERT",
      alertId: alert.id,
      alert
    }
  });
}

function findTradeAlert(alertId) {
  return state.tradeAlerts.find(item => item.id === String(alertId || "")) || null;
}

function applyTradeAlertAction(alert, action, req) {
  const normalizedAction = String(action || "").toUpperCase();
  if (!alert) return { ok: false, status: 404, error: "Trade alert not found." };
  if (!["CONSIDER", "REJECT", "PAPER_TRADE"].includes(normalizedAction)) {
    return { ok: false, status: 400, error: "Action must be CONSIDER, REJECT or PAPER_TRADE." };
  }
  if (["REJECT", "PAPER_TRADE"].includes(normalizedAction) && alert.status === "REJECTED") {
    return { ok: false, status: 409, error: "Trade alert is already rejected." };
  }
  if (alert.status === "PAPER_TRADE") {
    return { ok: false, status: 409, error: "Paper trade has already been created for this alert." };
  }

  const userKey = currentUserKey(req);
  const trade = alert.trade;

  if (normalizedAction === "REJECT") {
    alert.status = "REJECTED";
    alert.action = "REJECT";
    alert.actionReason = String(req.body?.reason || "User rejected the trade setup.").slice(0, 500);
    alert.actedAt = nowISO();
    alert.actedBy = userKey;
    state.history.unshift({
      type: "trade_alert_action",
      alertId: alert.id,
      action: "REJECT",
      index: trade.index,
      trade,
      reason: alert.actionReason,
      createdAt: alert.actedAt,
      user: userKey
    });
    state.history = state.history.slice(0, 500);
    saveState();
    realtimeBroadcast("trade-alert-update", { ok: true, alert });
    return { ok: true, alert, paper: state.paper };
  }

  if (normalizedAction === "CONSIDER") {
    alert.status = "CONSIDER";
    alert.action = "CONSIDER";
    alert.actionReason = String(req.body?.reason || "User is tracking this setup without executing it.").slice(0, 500);
    alert.actedAt = nowISO();
    alert.actedBy = userKey;
    state.history.unshift({
      type: "trade_alert_action",
      alertId: alert.id,
      action: "CONSIDER",
      index: trade.index,
      trade,
      reason: alert.actionReason,
      createdAt: alert.actedAt,
      user: userKey
    });
    state.history = state.history.slice(0, 500);
    saveState();
    realtimeBroadcast("trade-alert-update", { ok: true, alert });
    return { ok: true, alert, paper: state.paper };
  }

  const requestedQuantity = req.body?.quantity !== undefined ? req.body.quantity : null;
  const risk = riskCheck(trade, requestedQuantity);
  if (!risk.ok) return { ok: false, status: 403, error: risk.reason };

  const qty = risk.qty;
  const price = Number(trade.entry);
  const value = price * qty;
  if (state.paper.positions.some(p => p.instrumentKey === trade.instrumentKey && p.quantity > 0)) {
    return { ok: false, status: 409, error: "A paper position for this exact contract is already open." };
  }

  const tradeId = `T${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const position = {
    id: `P${Date.now()}`,
    tradeId,
    alertId: alert.id,
    index: trade.index,
    optionType: trade.optionType,
    strike: trade.strike,
    expiry: trade.expiry,
    instrumentKey: trade.instrumentKey,
    quantity: qty,
    entry: price,
    currentPrice: price,
    stopLoss: trade.stopLoss,
    targets: trade.targets,
    target: trade.targets[0],
    confidence: trade.confidence,
    reasoning: trade.reason || trade.decisionReasons,
    openedAt: nowISO(),
    status: "OPEN",
    source: "STEP13_TRADE_ALERT"
  };

  state.paper.cash -= value;
  state.paper.positions.push(position);
  state.paper.orders.unshift({
    id: `O${Date.now()}`,
    side: "BUY",
    index: trade.index,
    optionType: trade.optionType,
    strike: trade.strike,
    expiry: trade.expiry,
    instrumentKey: trade.instrumentKey,
    quantity: qty,
    price,
    source: "TRADE_ALERT",
    alertId: alert.id,
    createdAt: nowISO()
  });
  state.paper.orders = state.paper.orders.slice(0, 200);
  appendExecutionEvent({
    tradeId, eventType:"OPEN", executionType:"PAPER", side:"BUY", index:trade.index, optionType:trade.optionType,
    strike:trade.strike, expiry:trade.expiry, instrumentKey:trade.instrumentKey, quantity:qty, price, stopLoss:trade.stopLoss,
    targets:trade.targets, confidence:trade.confidence, reasoning:position.reasoning, source:"STEP13_TRADE_ALERT", alertId:alert.id, positionId:position.id
  });

  alert.status = "PAPER_TRADE";
  alert.action = "PAPER_TRADE";
  alert.actionReason = "Paper position created from the qualified ERA trade alert.";
  alert.actedAt = nowISO();
  alert.actedBy = userKey;

  state.history.unshift({
    type: "trade_alert_action",
    alertId: alert.id,
    action: "PAPER_TRADE",
    index: trade.index,
    trade,
    position,
    createdAt: alert.actedAt,
    user: userKey
  });
  state.history = state.history.slice(0, 500);
  saveState();
  realtimeBroadcast("trade-alert-update", { ok: true, alert, position });

  return { ok: true, alert, position, paper: state.paper };
}

// ============================================================
// MARKET MOVE NOTIFICATION
// ============================================================

async function notifyMarketMove(
  index,
  movement,
  market
) {
  if (
    !movement.significant
  ) {
    return;
  }

  const bucket =
    Math.floor(
      Math.abs(
        movement.points
      ) /
        Number(
          state.settings
            .movementThreshold
        )
    );

  const key =
    `${index}|${movement.direction}|${bucket}`;

  if (!state.settings.notifications?.movement) {
    return;
  }

  const moveCooldownKey = `${index}:move:${movement.direction}`;
  const lastMoveAlert = Number(state.notificationHistory[moveCooldownKey] || 0);
  if (Date.now() - lastMoveAlert < Number(state.settings.notificationCooldownMs || 900000)) {
    return;
  }

  if (state.previousSignals[`${index}:move`] === key && lastMoveAlert) {
    return;
  }

  state.previousSignals[`${index}:move`] = key;
  state.notificationHistory[moveCooldownKey] = Date.now();
  saveState();

  await sendPush({
    title:
      `${index} Market Move`,

    body:
      `${movement.direction} ${Math.abs(
        movement.points
      )} points | ${round(
        market.price
      )}`,

    data: {
      index,
      movement,
      market
    }
  });
}

// ============================================================
// MONITOR MARKET
// ============================================================

let scannerBusy = false;

async function monitorMarketState() {
  if (
    scannerBusy
  ) {
    return;
  }

  scannerBusy = true;

  try {
    await refreshMarketData();

    if (
      !isMarketHours()
    ) {
      state.lastScan =
        nowISO();

      return;
    }

    const indices =
      Object.keys(
        INDICES
      );

    for (
      const index of indices
    ) {
      try {
        const analysis =
          await analyzeIndex(
            index
          );

        state.analysis[index] =
          analysis;

        await notifyMarketMove(
          index,
          analysis.movement,
          analysis.market
        );

        if (
          Array.isArray(
            analysis.trades
          )
        ) {
          for (
            const trade
            of analysis.trades
          ) {
            await notifyTrade(
              trade
            );
          }
        }

      } catch (error) {
        console.error(
          `[ERA] Analysis error ${index}:`,
          error.response?.data ||
          error.message
        );
      }
    }

    state.activeTrades =
      Object.values(
        state.analysis
      )
        .flatMap(
          item =>
            item?.trades || []
        );

    state.lastScan =
      nowISO();

    state.lastSuccess =
      nowISO();

    state.lastError =
      null;

  } catch (error) {
    state.lastError = {
      message:
        error.message,

      at:
        nowISO(),

      details:
        error.response?.data ||
        null
    };

    console.error(
      "[ERA] Scanner error:",
      error.response?.data ||
      error.message
    );

  } finally {
    scannerBusy =
      false;
  }
}

// ============================================================
// NEWS
// ============================================================

// ============================================================
// NEWS + GLOBAL INTELLIGENCE — STEP 16
// Multi-topic RSS intelligence, deduplication, event-risk tagging,
// global market context, source health and AI-ready structured context.
// No broker/auth/UI changes are made here.
// ============================================================

const STEP16_NEWS_TOPICS = [
  { key: "india_markets", query: "Nifty Bank Nifty Sensex Indian stock market NSE BSE", weight: 1.2 },
  { key: "rbi_macro", query: "RBI India inflation interest rates economy", weight: 1.0 },
  { key: "us_markets", query: "Federal Reserve US stocks Nasdaq S&P 500 Dow Jones", weight: 0.9 },
  { key: "global_macro", query: "global markets central banks inflation recession", weight: 0.9 },
  { key: "oil_currency", query: "crude oil Brent WTI USD INR dollar India", weight: 1.0 },
  { key: "geopolitics", query: "geopolitics war sanctions Middle East Russia Ukraine global markets", weight: 1.1 }
];

function decodeXml(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function rssField(item, tag) {
  const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function normalizeNewsItem(item, topic) {
  const title = rssField(item, "title");
  const link = rssField(item, "link");
  const pubDate = rssField(item, "pubDate");
  const sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
  const source = sourceMatch ? decodeXml(sourceMatch[1]) : "Google News RSS";
  const publishedAt = pubDate ? new Date(pubDate).toISOString() : null;
  if (!title) return null;
  return {
    id: `NEWS-${Buffer.from(`${title}|${link}`).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}`,
    title,
    link,
    source,
    topic: topic.key,
    publishedAt,
    fetchedAt: nowISO(),
    timestamp: publishedAt || nowISO()
  };
}

function newsDedupe(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = String(item.link || item.title || "").toLowerCase().replace(/\\s+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyNews(item) {
  const text = `${item.title} ${item.topic}`.toLowerCase();
  const positive = /(rally|surge|gains|gain|bullish|record high|eases|cooling inflation|rate cut|stimulus|recovery|strong growth|inflow|falls? in inflation)/i;
  const negative = /(crash|plunge|selloff|sell-off|bearish|war|attack|sanction|tariff|recession|rate hike|inflation|hawkish|default|crisis|geopolitical|escalat|surge in oil|rupee falls|volatility)/i;
  const highRisk = /(war|attack|sanction|tariff|emergency|default|crisis|rate decision|fomc|fed decision|rbi policy|repo rate|election|geopolitical|escalat|oil shock)/i;
  const mediumRisk = /(inflation|cpi|wpi|gdp|jobs|payroll|yield|crude|oil|rupee|currency|central bank|earnings)/i;
  let sentiment = "NEUTRAL";
  if (negative.test(text) && !positive.test(text)) sentiment = "NEGATIVE";
  else if (positive.test(text) && !negative.test(text)) sentiment = "POSITIVE";
  let risk = "LOW";
  if (highRisk.test(text)) risk = "HIGH";
  else if (mediumRisk.test(text)) risk = "MEDIUM";
  return { ...item, sentiment, eventRisk: risk };
}

function buildGlobalIntelligence(items) {
  const classified = items.map(classifyNews);
  let score = 0;
  const themes = new Map();
  const events = [];
  for (const item of classified) {
    const topicWeight = STEP16_NEWS_TOPICS.find(x => x.key === item.topic)?.weight || 1;
    if (item.sentiment === "POSITIVE") score += 1 * topicWeight;
    if (item.sentiment === "NEGATIVE") score -= 1 * topicWeight;
    if (item.eventRisk === "HIGH") events.push({
      id: item.id,
      title: item.title,
      topic: item.topic,
      source: item.source,
      publishedAt: item.publishedAt,
      risk: item.eventRisk,
      link: item.link
    });
    const current = themes.get(item.topic) || { topic: item.topic, positive: 0, negative: 0, neutral: 0 };
    current[item.sentiment.toLowerCase()] += 1;
    themes.set(item.topic, current);
  }
  const riskScore = Math.max(0, Math.min(100, Math.round(
    classified.reduce((sum, x) => sum + (x.eventRisk === "HIGH" ? 5 : x.eventRisk === "MEDIUM" ? 2 : 0), 0)
  )));
  let riskLevel = riskScore >= 35 ? "HIGH" : riskScore >= 15 ? "MEDIUM" : "LOW";
  if (classified.length < 3) riskLevel = "UNKNOWN";
  const marketBias = score > 2 ? "BULLISH_BIAS" : score < -2 ? "BEARISH_BIAS" : "NEUTRAL";

  const gift = state.market?.GIFT_NIFTY || {};
  const vix = state.market?.INDIA_VIX || {};
  return {
    status: classified.length ? "LIVE" : "PARTIAL",
    updatedAt: nowISO(),
    sourceStatus: state.globalIntelligence?.sourceStatus || {},
    riskLevel,
    riskScore,
    marketBias,
    themes: Array.from(themes.values()).sort((a,b) => (b.positive+b.negative+b.neutral) - (a.positive+a.negative+a.neutral)),
    events: events.slice(0, 20),
    sources: Array.from(new Set(classified.map(x => x.source).filter(Boolean))).slice(0, 30),
    failures: state.globalIntelligence?.failures || [],
    marketContext: {
      giftNifty: { price: gift.price ?? null, change: gift.change ?? null, changePercent: gift.changePercent ?? null, timestamp: gift.timestamp ?? null, stale: gift.stale ?? null },
      indiaVix: { price: vix.price ?? null, change: vix.change ?? null, changePercent: vix.changePercent ?? null, timestamp: vix.timestamp ?? null, stale: vix.stale ?? null }
    }
  };
}

async function fetchNews() {
  const all = [];
  const sourceStatus = {};
  const failures = [];
  for (const topic of STEP16_NEWS_TOPICS) {
    try {
      const query = encodeURIComponent(topic.query);
      const url = `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`;
      const response = await axios.get(url, { timeout: 15000, headers: { "User-Agent": "Era-AI/16.0" } });
      const xml = String(response.data || "");
      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      const parsed = items.slice(0, 10).map(x => normalizeNewsItem(x, topic)).filter(Boolean);
      sourceStatus[topic.key] = { ok: true, count: parsed.length, fetchedAt: nowISO() };
      all.push(...parsed);
    } catch (error) {
      sourceStatus[topic.key] = { ok: false, count: 0, fetchedAt: nowISO(), error: apiError(error) };
      failures.push({ source: topic.key, error: apiError(error), at: nowISO() });
    }
  }

  const news = newsDedupe(all)
    .map(classifyNews)
    .sort((a, b) => new Date(b.publishedAt || b.fetchedAt) - new Date(a.publishedAt || a.fetchedAt))
    .slice(0, 60);

  if (news.length) state.news = news;
  state.lastNewsFetch = nowISO();
  state.globalIntelligence = buildGlobalIntelligence(state.news);
  state.globalIntelligence.sourceStatus = sourceStatus;
  state.globalIntelligence.failures = failures;
  if (failures.length && news.length) state.globalIntelligence.status = "PARTIAL";
  if (!news.length && state.news.length) state.globalIntelligence.status = "STALE";
  else if (!news.length) state.globalIntelligence.status = "UNAVAILABLE";
  saveState();
  return state.news;
}

function globalIntelligenceContext() {
  const g = state.globalIntelligence || {};
  return {
    status: g.status,
    updatedAt: g.updatedAt,
    riskLevel: g.riskLevel,
    riskScore: g.riskScore,
    marketBias: g.marketBias,
    themes: Array.isArray(g.themes) ? g.themes.slice(0, 10) : [],
    events: Array.isArray(g.events) ? g.events.slice(0, 10) : [],
    marketContext: g.marketContext || {},
    sourceHealth: g.sourceStatus || {}
  };
}

// ============================================================
// PRE-MARKET WATCHLIST
// ============================================================

let lastPreMarketDate =
  null;

async function preMarketCheck() {
  const {
    weekday,
    hour,
    minute
  } =
    getIndiaTimeParts();

  const weekdays = [
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri"
  ];

  if (
    !weekdays.includes(
      weekday
    )
  ) {
    return;
  }

  const total =
    hour * 60 + minute;

  if (
    total < 540 ||
    total >= 555
  ) {
    return;
  }

  const dateKey =
    new Date()
      .toLocaleDateString(
        "en-CA",
        {
          timeZone:
            "Asia/Kolkata"
        }
      );

  if (
    lastPreMarketDate ===
    dateKey
  ) {
    return;
  }

  lastPreMarketDate =
    dateKey;

  await sendPush({
    title:
      "Era AI — Pre-Market Watchlist",

    body:
      "Market opens at 09:15 IST. Check NIFTY, BANKNIFTY, FINNIFTY and SENSEX setup.",

    data: {
      type:
        "PRE_MARKET"
    }
  });
}

// ============================================================
// ROOT
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,

      app:
        "Era AI",

      version:
        VERSION,

      status:
        "running",

      marketOpen:
        isMarketHours(),

      backend:
        BACKEND_URL,

      updatedAt:
        nowISO()
    });
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      engineRunning:
        state.engineRunning,

      marketOpen:
        isMarketHours(),

      lastSuccess:
        state.lastSuccess,

      lastError:
        state.lastError,

      lastScan:
        state.lastScan,

      lastNewsFetch:
        state.lastNewsFetch,

      timestamp:
        nowISO()
    });
  }
);

// ============================================================
// MARKET
// ============================================================

app.get(
  "/api/market",
  async (req, res) => {
    try {
      await refreshMarketData();

      res.json({
        ok: true,

        version:
          VERSION,

        market:
          state.market,

        markets:
          state.market,

        marketOpen:
          isMarketHours(),

        updatedAt:
          nowISO()
      });

    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message,

        market:
          state.market,

        marketOpen:
          isMarketHours(),

        updatedAt:
          nowISO()
      });
    }
  }
);

// ============================================================
// STEP 12 — NO-TRADE INTELLIGENCE API
// Read-only view of the latest deterministic no-trade explanation.
// It does not trigger a fresh scan and therefore cannot create a
// new Step 11 confirmation by itself.
// ============================================================

app.get(
  "/api/no-trade",
  (req, res) => {
    const index = normalizeIndex(req.query.index) || "NIFTY";
    if (!INDICES[index]) {
      return res.status(400).json({ ok: false, error: "Invalid index" });
    }

    const analysis = state.analysis?.[index] || null;
    const intelligence = analysis?.noTradeIntelligence || {
      available: true,
      status: "NO_TRADE",
      decision: "NO TRADE",
      index,
      primaryReason: "No analysis snapshot is available yet.",
      primaryCode: "NO_ANALYSIS",
      reasons: [{ code: "NO_ANALYSIS", category: "SYSTEM", severity: "INFO", reason: "ERA has not generated an analysis snapshot for this index yet.", action: "Run market analysis before evaluating no-trade conditions." }],
      whatMustChange: ["Run market analysis and wait for a fresh deterministic market snapshot."],
      evaluatedAt: nowISO()
    };

    return res.json({ ok: true, index, noTradeIntelligence: intelligence, updatedAt: nowISO() });
  }
);

// ============================================================
// ANALYSIS
// ============================================================

app.get(
  "/api/analysis",
  async (req, res) => {
    try {
      await refreshMarketData();

      const results = {};

      for (
        const index of Object.keys(
          INDICES
        )
      ) {
        results[index] =
          await analyzeIndex(
            index
          );

        state.analysis[index] =
          results[index];
      }

      state.activeTrades =
        Object.values(
          results
        )
          .flatMap(
            item =>
              item?.trades || []
          );

      state.lastScan =
        nowISO();

      res.json({
        ok: true,

        version:
          VERSION,

        market:
          state.market,

        markets:
          state.market,

        analysis:
          results,

        indexes:
          results,

        selectedIndex:
          normalizeIndex(req.query.index) || "NIFTY",

        selected:
          results[normalizeIndex(req.query.index) || "NIFTY"] || null,

        activeTrades:
          state.activeTrades,

        marketOpen:
          isMarketHours(),

        updatedAt:
          nowISO()
      });

    } catch (error) {
      state.lastError = {
        message:
          error.message,

        at:
          nowISO()
      };

      res.status(500).json({
        ok: false,

        error:
          error.message,

        market:
          state.market,

        analysis:
          state.analysis,

        updatedAt:
          nowISO()
      });
    }
  }
);

// ============================================================
// OPTIONS CONTRACTS
// ============================================================

app.get(
  "/api/options/contracts",
  async (req, res) => {
    try {
      const index =
        normalizeIndex(
          req.query.index ||
          "NIFTY"
        );

      if (!INDICES[index]) {
        return res.status(400)
          .json({
            ok: false,
            error:
              "Invalid index"
          });
      }

      const contracts =
        await fetchOptionContracts(
          index
        );

      const today =
        new Date()
          .toISOString()
          .slice(0, 10);

      const expiries =
        [
          ...new Set(
            contracts
              .map(
                item =>
                  item.expiry
              )
              .filter(Boolean)
          )
        ]
          .filter(
            expiry =>
              expiry >= today
          )
          .sort();

      res.json({
        ok: true,

        index,

        contracts,

        expiries,

        nearestExpiry:
          expiries[0] ||
          null
      });

    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// OPTIONS CHAIN
// ============================================================

app.get(
  "/api/options/chain",
  async (req, res) => {
    try {
      const index =
        normalizeIndex(
          req.query.index ||
          "NIFTY"
        );

      const expiry =
        req.query.expiry ||
        null;

      if (!INDICES[index]) {
        return res.status(400)
          .json({
            ok: false,
            error:
              "Invalid index"
          });
      }

      const chain =
        await fetchOptionChain(
          index,
          expiry
        );

      let rows =
        normalizeOptionChain(
          chain.data
        );

      let spot =
        state.market[index]
          ?.price || 0;

      /*
       * If spot missing, fetch it.
       */
      if (
        !spot
      ) {
        try {
          const quotes =
            await fetchQuotes();

          spot =
            quotes[index]
              ?.price || 0;

        } catch (_) {}
      }

      /*
       * Fetch Greeks only for
       * relevant strikes.
       */
      const relevant =
        [...rows]
          .sort(
            (a, b) =>
              Math.abs(
                a.strike -
                spot
              ) -
              Math.abs(
                b.strike -
                spot
              )
          )
          .slice(0, 25);

      const instrumentKeys =
        [];

      for (
        const row of relevant
      ) {
        if (
          row.call?.instrumentKey
        ) {
          instrumentKeys.push(
            row.call.instrumentKey
          );
        }

        if (
          row.put?.instrumentKey
        ) {
          instrumentKeys.push(
            row.put.instrumentKey
          );
        }
      }

      const greeks =
        await fetchOptionGreeks(
          instrumentKeys
        );

      rows =
        mergeGreeks(
          rows,
          greeks
        );

      const summary =
        calculateOptionSummary(
          rows,
          spot
        );

      const advanced =
        calculateAdvancedOptionAnalytics(
          rows,
          spot,
          chain.expiry
        );

      res.json({
        ok: true,

        index,

        expiry:
          chain.expiry,

        spot:

          spot,

        rows,

        data:
          rows,

        summary,

        advanced,

        updatedAt:
          nowISO()
      });

    } catch (error) {
      console.error(
        "[ERA] Option chain endpoint:",
        error.response?.data ||
        error.message
      );

      res.status(500).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// OPTIONS GREEKS
// ============================================================

app.get(
  "/api/options/greeks",
  async (req, res) => {
    try {
      const keys =
        String(
          req.query.instrument_key ||
          ""
        )
          .split(",")
          .map(
            x => x.trim()
          )
          .filter(Boolean);

      const data =
        await fetchOptionGreeks(
          keys
        );

      res.json({
        ok: true,

        data,

        updatedAt:
          nowISO()
      });

    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// NEWS
// ============================================================

app.get(
  "/api/news",
  async (req, res) => {
    try {
      const news =
        await fetchNews();

      res.json({
        ok: true,

        news,

        updatedAt:
          nowISO()
      });

    } catch (error) {
      res.status(500).json({
        ok: false,

        news:
          state.news,

        error:
          error.message
      });
    }
  }
);

// STEP 16 — GLOBAL INTELLIGENCE API
app.get("/api/global-intelligence", (req, res) => {
  res.json({ ok: true, intelligence: globalIntelligenceContext(), updatedAt: state.globalIntelligence?.updatedAt || null });
});

// ERA AI BRAIN — STEP 5
// Structured market context + AI reasoning + deterministic safety gate.
// This module is additive: existing chat/auth/trading routes remain unchanged.
// ============================================================

function buildAIBrainContext(index) {
  const safeIndex = INDICES[index] ? index : "NIFTY";
  const market = state.market?.[safeIndex] || {};
  const analysis = state.analysis?.[safeIndex] || {};
  const technical = analysis.technical || {};
  const options = analysis.options || {};
  const trades = Array.isArray(analysis.trades)
    ? analysis.trades.slice(0, 3).map(trade => ({
        optionType: trade.optionType,
        strike: trade.strike,
        expiry: trade.expiry,
        entry: trade.entry,
        stopLoss: trade.stopLoss,
        targets: Array.isArray(trade.targets) ? trade.targets.slice(0, 3) : [],
        confidence: trade.confidence,
        status: trade.status,
        strikeSelection: trade.strikeSelection || null
      }))
    : [];

  return {
    index: safeIndex,
    session: {
      marketOpen: isMarketHours(),
      generatedAt: nowISO(),
      engineRunning: Boolean(state.engineRunning)
    },
    market: {
      name: market.name,
      price: market.price,
      previousClose: market.previousClose,
      change: market.change,
      changePercent: market.changePercent,
      open: market.open,
      high: market.high,
      low: market.low,
      volume: market.volume,
      timestamp: market.timestamp,
      source: market.source,
      stale: market.stale,
      available: market.available
    },
    analysis: {
      direction: analysis.direction,
      movement: analysis.movement,
      confidence: analysis.confidence,
      suggestion: analysis.suggestion,
      decision: analysis.decision || null,
      reasons: Array.isArray(analysis.reasons) ? analysis.reasons.slice(0, 8) : [],
      risks: Array.isArray(analysis.risks) ? analysis.risks.slice(0, 8) : [],
      noTradeIntelligence: analysis.noTradeIntelligence || null,
      technical: {
        emaTrend: technical.emaTrend,
        ema9: technical.ema9,
        ema20: technical.ema20,
        ema50: technical.ema50,
        rsi: technical.rsi,
        vwap: technical.vwap,
        vwapSource: technical.vwapSource,
        volume: technical.volume,
        atr: technical.atr,
        momentum: technical.momentum,
        volatility: technical.volatility,
        volumeProfile: technical.volumeProfile,
        priceAction: technical.priceAction || null,
        support: technical.support,
        resistance: technical.resistance,
        levels: technical.levels,
        structure: technical.structure?.label || technical.structure,
        structureDetails: technical.structureDetails,
        bos: technical.bos,
        choch: technical.choch,
        multiTimeframe: technical.multiTimeframe
      },
      regime: analysis.regime || null,
      exactStrikeSelection: analysis.exactStrikeSelection || trades[0]?.strikeSelection || null,
      options: {
        expiry: options.expiry,
        summary: options.summary || null,
        advanced: options.advanced || null
      },
      trades
    },
    safety: {
      minConfidence: Math.max(65, Number(state.settings?.minConfidence || 65)),
      killSwitch: Boolean(state.risk?.killSwitch),
      maxPositions: Number(state.risk?.maxPositions || 0),
      maxTradesPerDay: Number(state.risk?.maxTradesPerDay || 0)
    }
  };
}

function deterministicAIBrainGate(context) {
  const reasons = [];
  const market = context.market || {};
  const analysis = context.analysis || {};
  const safety = context.safety || {};
  const confidence = Number(analysis.confidence);

  if (!context.session?.engineRunning) reasons.push("ERA engine is stopped.");
  if (!context.session?.marketOpen) reasons.push("Market session is closed.");
  if (market.available === false) reasons.push("Live market data is unavailable.");
  if (market.stale === true) reasons.push("Live market data is stale.");
  if (!Number.isFinite(Number(market.price)) || Number(market.price) <= 0) reasons.push("Live price is unavailable.");
  if (Number.isFinite(confidence) && confidence < Number(safety.minConfidence || 60)) {
    reasons.push(`Confidence ${confidence}% is below ERA minimum ${safety.minConfidence}%.`);
  }
  if (safety.killSwitch) reasons.push("ERA risk kill switch is ON.");

  const qualifiedTrades = Array.isArray(analysis.trades)
    ? analysis.trades.filter(t =>
        t &&
        t.optionType &&
        Number(t.strike) > 0 &&
        Number(t.entry) > 0 &&
        Number(t.stopLoss) > 0 &&
        Array.isArray(t.targets) &&
        t.targets.length > 0
      )
    : [];

  if (!qualifiedTrades.length && analysis.suggestion && /BUY|SELL/i.test(String(analysis.suggestion))) {
    reasons.push("A directional suggestion exists, but no complete option contract is available.");
  }

  return {
    allowed: reasons.length === 0,
    decision: reasons.length === 0 ? "ANALYZE" : "WAIT",
    reasons
  };
}

async function callAIBrain(context, userQuestion = "Analyze the current market state.") {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const gate = deterministicAIBrainGate(context);
  const systemPrompt = `
You are ERA AI Brain, the reasoning layer of an Indian market intelligence platform.

Your job is to reason over the supplied structured market state. Do not invent live data.
The backend is the source of truth for prices, indicators, option contracts and risk limits.

Rules:
- If the safety gate says WAIT, do not override it with BUY or SELL. Explain the blocking reasons.
- Treat confidence as a model score, not a probability of profit.
- A trade response may name CE/PE, strike, expiry, entry, stop loss and targets only when those values are present in the supplied data.
- If evidence is incomplete or contradictory, choose WAIT.
- Use noTradeIntelligence as an explanation layer only; never treat it as permission to bypass the deterministic trade gate.
- Never guarantee profit or certainty.
- Separate observed facts from reasoning.
- Keep the answer concise, clear and useful to an Indian trader.
- Respond in simple Roman Hindi/Hinglish unless the user asks for another language.

Return JSON with exactly these keys:
"decision", "summary", "evidence", "risks", "tradePlan", "nextCheck".
tradePlan must be null when there is no qualified trade.
`;

  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            safetyGate: gate,
            marketState: context,
            question: userQuestion
          })
        }
      ],
      temperature: 0.1,
      max_tokens: 1800
    },
    {
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": BACKEND_URL,
        "X-Title": "Era AI Brain"
      }
    }
  );

  const raw = response.data?.choices?.[0]?.message?.content;
  const text = typeof raw === "string"
    ? raw
    : Array.isArray(raw)
      ? raw.map(x => typeof x === "string" ? x : (x?.text || x?.content || "")).filter(Boolean).join("\n")
      : (raw?.text || raw?.content || "");

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim());
  } catch (_) {
    parsed = {
      decision: gate.allowed ? "ANALYZE" : "WAIT",
      summary: text || "ERA Brain returned no readable response.",
      evidence: [],
      risks: gate.reasons,
      tradePlan: null,
      nextCheck: "Recheck fresh market data before acting."
    };
  }

  if (!gate.allowed) {
    parsed.decision = "WAIT";
    parsed.tradePlan = null;
    parsed.risks = [...new Set([...(Array.isArray(parsed.risks) ? parsed.risks : []), ...gate.reasons])];
  }

  return {
    ok: true,
    gate,
    brain: parsed,
    contextGeneratedAt: context.session?.generatedAt || nowISO()
  };
}

app.post("/api/ai/brain", requireAuth, async (req, res) => {
  try {
    if (!OPENROUTER_API_KEY) {
      return res.status(503).json({ ok: false, error: "OPENROUTER_API_KEY is not configured" });
    }

    const requested = String(req.body?.index || "NIFTY").toUpperCase();
    const index = INDICES[requested] ? requested : "NIFTY";
    const question = String(req.body?.question || "Analyze the current market state and tell me whether ERA should WAIT or consider a qualified setup.").trim();

    // Refresh the requested index only; the AI Brain then analyzes that fresh state.
    await refreshMarketData(index);
    state.analysis[index] = await analyzeIndex(index);
    state.lastScan = nowISO();

    const context = buildAIBrainContext(index);
    const result = await callAIBrain(context, question);

    state.history.unshift({
      type: "ai_brain",
      index,
      question,
      decision: result.brain?.decision || result.gate?.decision || "WAIT",
      brain: result.brain,
      gate: result.gate,
      createdAt: nowISO()
    });
    state.history = state.history.slice(0, 500);
    saveState();

    res.json(result);
  } catch (error) {
    console.error("[ERA] AI Brain error:", error.response?.data || error.message);
    res.status(500).json({ ok: false, error: apiError(error.response?.data || error.message) });
  }
});


// ============================================================
// AI CHAT
// ============================================================

app.post(
  "/api/chat",
  requireAuth,
  async (req, res) => {
    try {
      if (
        !OPENROUTER_API_KEY
      ) {
        return res.status(503)
          .json({
            ok: false,

            error:
              "OPENROUTER_API_KEY is not configured"
          });
      }

      const message =
        String(
          req.body?.message ||
          ""
        ).trim();

      if (!message) {
        return res.status(400)
          .json({
            ok: false,

            error:
              "Message is required"
          });
      }

      const systemPrompt = `
You are Era AI, a friendly human-like Indian market assistant.

Reply naturally and conversationally. Use simple Roman Hindi / Hinglish unless the user asks for another language. Do not sound like a code generator or a machine report.

Important style rules:
- Answer the user's actual question first. Do not dump the full market report unless the user asks for a detailed market overview.
- Never return JSON, JavaScript, XML, or code blocks unless the user explicitly asks for code or structured data.
- Do not use a giant markdown report for a simple question. Keep normal answers concise and easy to read.
- If the user asks for a trade/setup, clearly state option type (CE/PE), strike, entry, stop loss, targets, confidence and status when those values are available.
- Always explain WHY Era is giving the setup and WHY it is waiting/no-trade when relevant.
- Never invent live prices, option prices, signals or confirmations.
- If live data is missing or insufficient, say so clearly and prefer WAIT / DATA UNAVAILABLE.
- Do not claim certainty or guaranteed profit.

Use the supplied market and analysis data as the source of truth.`;

      // Keep the OpenRouter prompt small. The full state.analysis object can contain
      // large option/technical arrays; sending it repeatedly caused 44k+ token failures.
      const requestedIndex = String(req.body?.index || "NIFTY").toUpperCase();
      const index = INDICES[requestedIndex] ? requestedIndex : "NIFTY";
      const m = state.market?.[index] || {};
      const a = state.analysis?.[index] || {};
      const t = a.technical || {};
      const o = a.options || {};
      const compactTrades = Array.isArray(a.trades) ? a.trades.slice(0, 3).map(x => ({
        optionType: x.optionType, strike: x.strike, entry: x.entry,
        stopLoss: x.stopLoss, targets: Array.isArray(x.targets) ? x.targets.slice(0, 3) : [],
        confidence: x.confidence, status: x.status, expiry: x.expiry,
        strikeSelection: x.strikeSelection || null
      })) : [];
      const compactContext = {
        index,
        market: {
          name: m.name, price: m.price, previousClose: m.previousClose,
          change: m.change, changePercent: m.changePercent, open: m.open,
          high: m.high, low: m.low, volume: m.volume, timestamp: m.timestamp,
          source: m.source, stale: m.stale
        },
        globalIntelligence: globalIntelligenceContext(),
        analysis: {
          direction: a.direction, movement: a.movement, confidence: a.confidence,
          suggestion: a.suggestion, decision: a.decision || null, reasons: Array.isArray(a.reasons) ? a.reasons.slice(0, 5) : [],
          risks: Array.isArray(a.risks) ? a.risks.slice(0, 5) : [],
          technical: {
            emaTrend: t.emaTrend,
            ema9: t.ema9,
            ema20: t.ema20,
            ema50: t.ema50,
            rsi: t.rsi,
            vwap: t.vwap,
            vwapSource: t.vwapSource,
            atr: t.atr,
            momentum: t.momentum || null,
            volatility: t.volatility || null,
            volumeProfile: t.volumeProfile || null,
            support: t.support,
            resistance: t.resistance,
            levels: t.levels || null,
            priceAction: t.priceAction || null,
            structure: t.structure?.label || t.structure,
            structureDetails: t.structureDetails || null,
            bos: t.bos,
            choch: t.choch,
            multiTimeframe: t.multiTimeframe || null
          },
          regime: a.regime || null,
          exactStrikeSelection: a.exactStrikeSelection || compactTrades[0]?.strikeSelection || null,
          options: {
            expiry: o.expiry || null,
            summary: o.summary || null,
            advanced: o.advanced || null
          },
          trades: compactTrades
        },
        message
      };

      const userContext = compactContext;

      const response =
        await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",

          {
            model:
              OPENROUTER_MODEL,

            messages: [
              {
                role:
                  "system",

                content:
                  systemPrompt
              },

              {
                role:
                  "user",

                content:
                  JSON.stringify(
                    userContext
                  )
              }
            ],

            temperature:
              0.2,

            max_tokens:
              4096
          },

          {
            timeout:
              30000,

            headers: {
              Authorization:
                `Bearer ${OPENROUTER_API_KEY}`,

              "Content-Type":
                "application/json",

              "HTTP-Referer":
                BACKEND_URL,

              "X-Title":
                "Era AI"
            }
          }
        );

      const rawAnswer = response.data?.choices?.[0]?.message?.content;
      const answer = typeof rawAnswer === "string"
        ? rawAnswer
        : Array.isArray(rawAnswer)
          ? rawAnswer.map(x => typeof x === "string" ? x : (x?.text || x?.content || "")).filter(Boolean).join("\n")
          : (rawAnswer?.text || rawAnswer?.content || rawAnswer?.answer || "No response.");

      state.history.unshift({
        type: "chat",
        userMessage: message,
        answer,
        index: req.body?.index || null,
        createdAt: nowISO()
      });

      state.history =
        state.history.slice(0, 500);

      saveState();

      res.json({
        ok: true,

        answer
      });

    } catch (error) {
      console.error(
        "[ERA] Chat error:",
        error.response?.data ||
        error.message
      );

      res.status(500).json({
        ok: false,

        error: apiError(error.response?.data || error.message)
      });
    }
  }
);

// ============================================================
// TTS
// ============================================================

app.post(
  "/api/tts",
  (req, res) => {
    res.status(410).json({
      ok: false,

      error:
        "TTS endpoint is currently disabled"
    });
  }
);

// ============================================================
// SETTINGS GET
// ============================================================

app.get(
  "/api/settings",
  requireAuth,
  (req, res) => {
    res.json({
      ok: true,

      settings:
        state.settings
    });
  }
);

// ============================================================
// SETTINGS POST
// ============================================================

app.post(
  "/api/settings",
  requireAuth,
  (req, res) => {
    try {
      const body =
        req.body || {};

      if (
        body.movementThreshold !==
        undefined
      ) {
        const value =
          Number(
            body.movementThreshold
          );

        if (
          Number.isFinite(value) &&
          value > 0
        ) {
          state.settings
            .movementThreshold =
            value;
        }
      }

      if (body.notificationCooldownMs !== undefined) {
        const value = Number(body.notificationCooldownMs);
        if (Number.isFinite(value) && value >= 60000 && value <= 86400000) {
          state.settings.notificationCooldownMs = value;
        }
      }

      if (body.notifications && typeof body.notifications === "object") {
        for (const key of Object.keys(state.settings.notifications)) {
          if (body.notifications[key] !== undefined) {
            state.settings.notifications[key] = Boolean(body.notifications[key]);
          }
        }
      }

      if (
        body.minConfidence !==
        undefined
      ) {
        const value =
          Number(
            body.minConfidence
          );

        if (
          Number.isFinite(value) &&
          value >= 1 &&
          value <= 100
        ) {
          state.settings
            .minConfidence =
            value;
        }
      }

      saveState();

      res.json({
        ok: true,

        settings:
          state.settings
      });

    } catch (error) {
      res.status(400).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// STEP 17 — PROFESSIONAL BACKTESTING
// Historical strategy testing, deterministic execution simulation,
// slippage/fees, risk-aware sizing, metrics and replay.
// This layer is independent from live/paper execution and never places
// broker orders.
// ============================================================

function parseBacktestDate(value, fallback) {
  const d = value ? new Date(value) : new Date(fallback);
  return Number.isNaN(d.getTime()) ? null : d;
}

function candleObject(candle) {
  return {
    timestamp: candle[0],
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    volume: Number(candle[5] || 0)
  };
}

async function fetchHistoricalInstrumentCandlesRange(instrumentKey, interval, fromDate, toDate) {
  const from = parseBacktestDate(fromDate);
  const to = parseBacktestDate(toDate);
  if (!instrumentKey || !from || !to || from >= to) throw new Error("Invalid instrument or backtest date range.");
  const maxDays = 60;
  if ((to.getTime() - from.getTime()) > maxDays * 86400000) throw new Error(`Backtest range cannot exceed ${maxDays} days.`);
  const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(instrumentKey)}/minutes/${Number(interval)}/${to.toISOString().slice(0,10)}/${from.toISOString().slice(0,10)}`;
  const response = await upstoxRequest(url);
  return (response.data?.candles || []).filter(c => Array.isArray(c) && c.length >= 6).map(candleObject).filter(c => Number.isFinite(c.close) && c.close > 0).sort((a,b) => new Date(a.timestamp)-new Date(b.timestamp));
}

async function fetchHistoricalCandlesRange(index, interval, fromDate, toDate) {
  const config = INDICES[index];
  if (!config) throw new Error(`Unknown index: ${index}`);
  const from = parseBacktestDate(fromDate);
  const to = parseBacktestDate(toDate);
  if (!from || !to || from >= to) throw new Error("Invalid backtest date range.");
  const maxDays = 60;
  if ((to.getTime() - from.getTime()) > maxDays * 86400000) {
    throw new Error(`Backtest range cannot exceed ${maxDays} days.`);
  }
  const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(config.symbol)}/minutes/${Number(interval)}/${to.toISOString().slice(0,10)}/${from.toISOString().slice(0,10)}`;
  const response = await upstoxRequest(url);
  const candles = (response.data?.candles || [])
    .filter(c => Array.isArray(c) && c.length >= 6)
    .map(candleObject)
    .filter(c => Number.isFinite(c.close) && c.close > 0)
    .sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
  return candles;
}

function backtestAtr(candles, period = 14) {
  if (candles.length < 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  if (trs.length < period) return null;
  return trs.slice(-period).reduce((a,b) => a+b, 0) / period;
}

function backtestEma(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s,c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) ema = candles[i].close * k + ema * (1-k);
  return ema;
}

function backtestRsi(candles, period = 14) {
  if (candles.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i-1].close;
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function backtestSignal(window, params) {
  const fast = backtestEma(window, Number(params.fastEma || 20));
  const slow = backtestEma(window, Number(params.slowEma || 50));
  const rsi = backtestRsi(window, Number(params.rsiPeriod || 14));
  const atr = backtestAtr(window, Number(params.atrPeriod || 14));
  if (![fast, slow, rsi, atr].every(Number.isFinite)) return null;
  const last = window[window.length - 1];
  const previous = window.slice(0, -1);
  const prevFast = backtestEma(previous, Number(params.fastEma || 20));
  const prevSlow = backtestEma(previous, Number(params.slowEma || 50));
  const longCross = Number.isFinite(prevFast) && Number.isFinite(prevSlow) && prevFast <= prevSlow && fast > slow;
  const shortCross = Number.isFinite(prevFast) && Number.isFinite(prevSlow) && prevFast >= prevSlow && fast < slow;
  const longOk = rsi >= Number(params.longRsiMin ?? 55) && rsi <= Number(params.longRsiMax ?? 75);
  const shortOk = rsi <= Number(params.shortRsiMax ?? 45) && rsi >= Number(params.shortRsiMin ?? 25);
  if (longCross && longOk) return { side: "LONG", price: last.close, atr, emaFast: fast, emaSlow: slow, rsi };
  if (shortCross && shortOk) return { side: "SHORT", price: last.close, atr, emaFast: fast, emaSlow: slow, rsi };
  return null;
}

function backtestMetrics(trades, initialCapital, equityCurve) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const grossProfit = wins.reduce((s,t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s,t) => s + t.pnl, 0));
  let peak = initialCapital, maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.max(maxDrawdown, peak - point.equity);
  }
  const returns = equityCurve.map(x => x.equity / initialCapital - 1);
  const avgReturn = returns.length ? returns.reduce((a,b)=>a+b,0)/returns.length : 0;
  const variance = returns.length ? returns.reduce((s,r)=>s + Math.pow(r-avgReturn,2),0)/returns.length : 0;
  const sharpe = variance > 0 ? (avgReturn / Math.sqrt(variance)) * Math.sqrt(Math.max(1, returns.length)) : 0;
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? Number((wins.length / trades.length * 100).toFixed(2)) : 0,
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    netPnl: Number(trades.reduce((s,t)=>s+t.pnl,0).toFixed(2)),
    profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : grossProfit > 0 ? null : 0,
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    maxDrawdownPercent: initialCapital ? Number((maxDrawdown / initialCapital * 100).toFixed(2)) : 0,
    finalEquity: Number((equityCurve.length ? equityCurve[equityCurve.length-1].equity : initialCapital).toFixed(2)),
    returnPercent: initialCapital ? Number(((equityCurve.length ? equityCurve[equityCurve.length-1].equity / initialCapital - 1 : 0) * 100).toFixed(2)) : 0,
    sharpeApprox: Number(sharpe.toFixed(3)),
    avgTradePnl: trades.length ? Number((trades.reduce((s,t)=>s+t.pnl,0)/trades.length).toFixed(2)) : 0
  };
}

async function runBacktest(config = {}) {
  const index = String(config.index || "NIFTY").toUpperCase();
  const interval = Math.max(1, Number(config.interval || 5));
  const end = parseBacktestDate(config.to, new Date());
  const start = parseBacktestDate(config.from, new Date(end.getTime() - 30 * 86400000));
  if (!start || !end) throw new Error("Invalid backtest dates.");
  const candles = config.instrumentKey
    ? await fetchHistoricalInstrumentCandlesRange(config.instrumentKey, interval, start, end)
    : await fetchHistoricalCandlesRange(index, interval, start, end);
  if (candles.length < 80) throw new Error(`Not enough historical candles for backtest (${candles.length}).`);

  const p = {
    fastEma: Number(config.fastEma || 20), slowEma: Number(config.slowEma || 50), rsiPeriod: Number(config.rsiPeriod || 14),
    atrPeriod: Number(config.atrPeriod || 14), stopAtr: Number(config.stopAtr || 1.2), targetR: Number(config.targetR || 2),
    slippageBps: Math.max(0, Number(config.slippageBps ?? 5)), feeBps: Math.max(0, Number(config.feeBps ?? 3)),
    riskPerTrade: Math.max(0.1, Number(config.riskPerTrade ?? 1)), maxBarsInTrade: Math.max(1, Number(config.maxBarsInTrade || 48)),
    initialCapital: Math.max(1000, Number(config.initialCapital || 100000)), quantity: config.quantity !== undefined && Number(config.quantity) > 0 ? Math.floor(Number(config.quantity)) : null
  };
  if (p.fastEma >= p.slowEma) throw new Error("fastEma must be lower than slowEma.");

  let equity = p.initialCapital;
  let position = null;
  const trades = [];
  const equityCurve = [];
  const replay = [];
  const warmup = Math.max(p.slowEma + 5, p.atrPeriod + 5, p.rsiPeriod + 5);
  const slip = p.slippageBps / 10000;
  const fee = p.feeBps / 10000;

  for (let i = warmup; i < candles.length; i++) {
    const c = candles[i];
    if (!position) {
      // Signal is evaluated only after candle i closes. Execution is deferred
      // to candle i+1, preventing same-candle look-ahead/execution bias.
      if (i >= candles.length - 1) {
        equityCurve.push({ timestamp:c.timestamp, equity:round(equity,2) });
        continue;
      }
      const signal = backtestSignal(candles.slice(0, i + 1), p);
      if (signal) {
        const next = candles[i + 1];
        const rawEntry = Number(next.open);
        if (!(rawEntry > 0)) {
          equityCurve.push({ timestamp:c.timestamp, equity:round(equity,2) });
          continue;
        }
        const entry = signal.side === "LONG" ? rawEntry * (1 + slip) : rawEntry * (1 - slip);
        const stopDistance = Math.max(signal.atr * p.stopAtr, entry * 0.002);
        const stop = signal.side === "LONG" ? entry - stopDistance : entry + stopDistance;
        const target = signal.side === "LONG" ? entry + stopDistance * p.targetR : entry - stopDistance * p.targetR;
        const riskAmount = equity * p.riskPerTrade / 100;
        const riskPerUnit = Math.abs(entry - stop);
        const riskQty = Math.max(1, Math.floor(riskAmount / riskPerUnit));
        const qty = p.quantity ? Math.min(riskQty, p.quantity) : riskQty;
        position = { side: signal.side, entry, stop, target, quantity: Math.min(qty, p.quantity || qty), entryIndex: i + 1, entryAt: next.timestamp, signalAt: c.timestamp, entryReason: `EMA${p.fastEma}/${p.slowEma} cross + RSI ${signal.rsi.toFixed(1)}`, atr: signal.atr };
        replay.push({ type:"SIGNAL", timestamp:c.timestamp, index, signal });
        replay.push({ type:"ENTRY", timestamp:next.timestamp, index, ...position });
      }
    } else {
      let exitPrice = null, reason = null;
      if (position.side === "LONG") {
        if (c.low <= position.stop) { exitPrice = position.stop; reason = "SL"; }
        else if (c.high >= position.target) { exitPrice = position.target; reason = "TARGET"; }
      } else {
        if (c.high >= position.stop) { exitPrice = position.stop; reason = "SL"; }
        else if (c.low <= position.target) { exitPrice = position.target; reason = "TARGET"; }
      }
      if (!exitPrice && (i - position.entryIndex) >= p.maxBarsInTrade) { exitPrice = c.close; reason = "TIME"; }
      if (!exitPrice && i === candles.length - 1) { exitPrice = c.close; reason = "END"; }
      if (exitPrice) {
        const executedExit = position.side === "LONG" ? exitPrice * (1 - slip) : exitPrice * (1 + slip);
        const gross = position.side === "LONG" ? (executedExit - position.entry) * position.quantity : (position.entry - executedExit) * position.quantity;
        const fees = (position.entry * position.quantity + executedExit * position.quantity) * fee;
        const pnl = gross - fees;
        equity += pnl;
        const trade = { id:`BT-${Date.now()}-${trades.length+1}`, index, side:position.side, quantity:position.quantity, entry:round(position.entry,2), exit:round(executedExit,2), stop:round(position.stop,2), target:round(position.target,2), entryAt:position.entryAt, exitAt:c.timestamp, barsHeld:i-position.entryIndex, reason, pnl:round(pnl,2), pnlPercent:round((pnl/(position.entry*position.quantity))*100,2), fees:round(fees,2), entryReason:position.entryReason };
        trades.push(trade);
        replay.push({ type:"EXIT", timestamp:c.timestamp, ...trade });
        position = null;
      }
    }
    equityCurve.push({ timestamp:c.timestamp, equity:round(equity,2) });
  }

  const result = {
    id:`BT-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
    createdAt:nowISO(), index, instrumentKey:config.instrumentKey || null, interval, from:start.toISOString(), to:end.toISOString(), parameters:p,
    candleCount:candles.length, dataType:config.instrumentKey ? "OPTION_OR_INSTRUMENT" : "INDEX", metrics:backtestMetrics(trades,p.initialCapital,equityCurve), trades,
    replay, equityCurve, dataSource:"Upstox historical candles", status:"COMPLETED"
  };
  state.backtests.unshift(result);
  state.backtests = state.backtests.slice(0, 20);
  saveState();
  return result;
}

function validateBacktestAgainstPaper(backtest, paperTrades) {
  const bt = Array.isArray(backtest?.trades) ? backtest.trades : [];
  const paper = Array.isArray(paperTrades) ? paperTrades : [];
  const btWins = bt.filter(t=>Number(t.pnl)>0).length;
  const pWins = paper.filter(t=>Number(t.pnl)>0).length;
  const btPnl = bt.reduce((s,t)=>s+Number(t.pnl||0),0);
  const pPnl = paper.reduce((s,t)=>s+Number(t.pnl||0),0);
  return {
    backtestTrades:bt.length, paperTrades:paper.length,
    backtestWinRate:bt.length ? Number((btWins/bt.length*100).toFixed(2)) : 0,
    paperWinRate:paper.length ? Number((pWins/paper.length*100).toFixed(2)) : 0,
    backtestPnl:Number(btPnl.toFixed(2)), paperPnl:Number(pPnl.toFixed(2)),
    pnlDifference:Number((pPnl-btPnl).toFixed(2)),
    comparisonNote:"Backtest and paper trades are different samples unless the same dates, setup rules, instrument and execution assumptions are used. This endpoint reports differences; it does not declare strategy validity."
  };
}

app.post("/api/backtest/run", requireAuth, async (req,res) => {
  try {
    const result = await runBacktest(req.body || {});
    res.json({ok:true, result});
  } catch (error) {
    res.status(400).json({ok:false,error:error.message});
  }
});

app.get("/api/backtest", requireAuth, (req,res) => {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit || 10)));
  res.json({ok:true, backtests:state.backtests.slice(0,limit).map(x => ({ id:x.id, createdAt:x.createdAt, index:x.index, interval:x.interval, from:x.from, to:x.to, candleCount:x.candleCount, parameters:x.parameters, metrics:x.metrics, status:x.status }))});
});

app.get("/api/backtest/:id", requireAuth, (req,res) => {
  const result = state.backtests.find(x => x.id === req.params.id);
  if (!result) return res.status(404).json({ok:false,error:"Backtest not found."});
  res.json({ok:true,result});
});

app.get("/api/backtest/:id/replay", requireAuth, (req,res) => {
  const result = state.backtests.find(x => x.id === req.params.id);
  if (!result) return res.status(404).json({ok:false,error:"Backtest not found."});
  const step = Math.max(1, Number(req.query.step || 1));
  const cursor = Math.max(0, Number(req.query.cursor || 0));
  res.json({ok:true,id:result.id,cursor,nextCursor:Math.min(result.replay.length,cursor+step),done:cursor+step>=result.replay.length,events:result.replay.slice(cursor,cursor+step)});
});

app.get("/api/backtest/paper-validation", requireAuth, (req,res) => {
  const id = req.query.id;
  const result = id ? state.backtests.find(x=>x.id===id) : state.backtests[0];
  if (!result) return res.status(404).json({ok:false,error:"No backtest available."});
  const paper = (state.executionLedger || []).filter(x => x.executionType === "PAPER" && x.eventType === "CLOSE");
  res.json({ok:true,resultId:result.id,validation:validateBacktestAgainstPaper(result,paper)});
});

// ============================================================
// HISTORY GET
// ============================================================

app.get(
  "/api/history",
  (req, res) => {
    res.json({
      ok: true,

      history:
        state.history
    });
  }
);

// ============================================================
// HISTORY POST
// ============================================================

app.post(
  "/api/history",
  (req, res) => {
    try {
      const trade =
        req.body || {};

      const record = {
        ...trade,

        id:
          trade.id ||
          `${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,

        createdAt:
          trade.createdAt ||
          nowISO()
      };

      state.history.unshift(
        record
      );

      state.history =
        state.history.slice(
          0,
          500
        );

      saveState();

      res.json({
        ok: true,

        trade:
          record
      });

    } catch (error) {
      res.status(400).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// PUSH PUBLIC KEY
// ============================================================

app.get(
  "/api/push/public-key",
  (req, res) => {
    res.json({
      ok: true,

      publicKey:
        VAPID_PUBLIC_KEY ||
        null
    });
  }
);

// ============================================================
// PUSH SUBSCRIBE
// ============================================================

app.post(
  "/api/subscribe",
  requireAuth,
  (req, res) => {
    try {
      const subscription =
        req.body?.subscription ||
        req.body;

      if (
        !subscription ||
        !subscription.endpoint
      ) {
        return res.status(400)
          .json({
            ok: false,

            error:
              "Invalid subscription"
          });
      }

      const exists =
        state.pushSubscriptions
          .some(
            item =>
              item.endpoint ===
              subscription.endpoint
          );

      if (!exists) {
        state.pushSubscriptions
          .push(subscription);

        saveState();
      }

      res.json({
        ok: true,
        subscribed: true,
        subscriptions: state.pushSubscriptions.length
      });

    } catch (error) {
      res.status(400).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// PUSH TEST
// ============================================================

app.post(
  "/api/push/test",
  requireAuth,
  async (req, res) => {
    try {
      if (
        !VAPID_PUBLIC_KEY ||
        !VAPID_PRIVATE_KEY
      ) {
        return res.status(503).json({
          ok: false,
          error:
            "VAPID keys are not configured"
        });
      }

      if (
        !state.pushSubscriptions.length
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "No push subscriptions are registered"
        });
      }

      await sendPush({
        title:
          "Era AI Test",

        body:
          "Push notifications are working.",

        data: {
          type:
            "TEST"
        }
      });

      res.json({
        ok: true,
        subscriptions:
          state.pushSubscriptions.length
      });

    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

// ============================================================
// ENGINE GET
// ============================================================

app.get(
  "/api/engine",
  (req, res) => {
    res.json({
      ok: true,

      running:
        state.engineRunning,

      lastScan:
        state.lastScan,

      lastSuccess:
        state.lastSuccess,

      lastError:
        state.lastError
    });
  }
);

// ============================================================
// ENGINE START
// ============================================================

app.post(
  "/api/engine/start",
  async (req, res) => {
    state.engineRunning =
      true;

    try {
      await monitorMarketState();
    } catch (_) {}

    res.json({
      ok: true,

      running:
        true
    });
  }
);

// ============================================================
// ENGINE STOP
// ============================================================

app.post(
  "/api/engine/stop",
  (req, res) => {
    state.engineRunning =
      false;

    res.json({
      ok: true,

      running:
        false
    });
  }
);

// ============================================================
// PERIODIC SCANNER
// ============================================================

setInterval(
  async () => {
    if (
      !state.engineRunning
    ) {
      return;
    }

    try {
      await monitorMarketState();
    } catch (error) {
      console.error(
        "[ERA] Periodic scanner:",
        error.message
      );
    }
  },

  state.settings
    .scanIntervalMs
);

// ============================================================
// PERIODIC NEWS
// ============================================================

setInterval(
  async () => {
    try {
      await fetchNews();
    } catch (_) {}
  },

  state.settings
    .newsIntervalMs
);

// ============================================================
// STEP 19 — PROFESSIONAL DETERMINISTIC RISK ENGINE
// Account risk, daily loss, position sizing, exposure, portfolio risk,
// single-index concentration, correlated exposure and kill switch.
// AI cannot override these deterministic controls.
// ============================================================

function apiError(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error.message) return String(error.message);
  if (error.error?.message) return String(error.error.message);
  try { return JSON.stringify(error); } catch (_) { return String(error); }
}

function currentUserKey(req) {
  const authenticated = req?.eraUser?.email || req?.eraUser?.id || "guest";
  const raw = String(authenticated).trim().toLowerCase();
  return raw.slice(0, 180) || "guest";
}

function riskConfig() {
  const r = state.risk || {};
  return {
    riskPerTrade: Math.max(0.1, Number(r.riskPerTrade || 1)),
    maxDailyLoss: Math.max(0.1, Number(r.maxDailyLoss || 2)),
    maxTradeLoss: Math.max(0.1, Number(r.maxTradeLoss || 1)),
    maxPositions: Math.max(1, Math.floor(Number(r.maxPositions || 3))),
    maxTradesPerDay: Math.max(1, Math.floor(Number(r.maxTradesPerDay || 5))),
    maxExposure: Math.max(1, Number(r.maxExposure || 50)),
    maxPortfolioRisk: Math.max(0.1, Number(r.maxPortfolioRisk || 3)),
    maxSingleIndexExposure: Math.max(1, Number(r.maxSingleIndexExposure || 25)),
    maxCorrelationExposure: Math.max(1, Number(r.maxCorrelationExposure || 35)),
    killSwitch: Boolean(r.killSwitch)
  };
}

function paperOpenExposure() {
  return (state.paper?.positions || []).reduce((sum, p) => sum + Number(p.entry || 0) * Number(p.quantity || 0), 0);
}

function paperOpenRisk() {
  return (state.paper?.positions || []).reduce((sum, p) => {
    const entry = Number(p.entry || 0), stop = Number(p.stopLoss || 0), qty = Number(p.quantity || 0);
    return sum + (entry > stop && qty > 0 ? (entry - stop) * qty : 0);
  }, 0);
}

function paperIndexExposure(index) {
  return (state.paper?.positions || []).filter(p => String(p.index || '') === String(index || '')).reduce((sum, p) => sum + Number(p.entry || 0) * Number(p.quantity || 0), 0);
}

function riskSnapshot(trade = null, requestedQuantity = null) {
  const r = riskConfig();
  const capital = Number(state.paper?.startingCapital || 100000);
  const cash = Number(state.paper?.cash || 0);
  const realized = Number(paperRealizedPnlToday() || 0);
  const unrealized = Number(state.paper?.unrealizedPnl || 0);
  const dailyPnl = realized + unrealized;
  const dailyLossLimit = capital * r.maxDailyLoss / 100;
  const exposure = paperOpenExposure();
  const exposureLimit = capital * r.maxExposure / 100;
  const correlatedExposureLimit = capital * r.maxCorrelationExposure / 100;
  const portfolioRisk = paperOpenRisk();
  const portfolioRiskLimit = capital * r.maxPortfolioRisk / 100;
  const positions = (state.paper?.positions || []).length;
  const tradesToday = countTradesToday();
  const snapshot = {
    capital, cash, realizedPnlToday: Number(realized.toFixed(2)), unrealizedPnl: Number(unrealized.toFixed(2)), dailyPnl: Number(dailyPnl.toFixed(2)),
    dailyLossLimit: Number(dailyLossLimit.toFixed(2)), remainingDailyLoss: Number(Math.max(0, dailyLossLimit + dailyPnl).toFixed(2)),
    exposure: Number(exposure.toFixed(2)), exposureLimit: Number(exposureLimit.toFixed(2)), correlatedExposureLimit: Number(correlatedExposureLimit.toFixed(2)), exposurePct: capital ? Number((exposure / capital * 100).toFixed(2)) : 0,
    portfolioRisk: Number(portfolioRisk.toFixed(2)), portfolioRiskLimit: Number(portfolioRiskLimit.toFixed(2)),
    positions, maxPositions: r.maxPositions, tradesToday, maxTradesPerDay: r.maxTradesPerDay,
    killSwitch: r.killSwitch, config:r
  };
  if (trade) {
    const sizing = calculateRiskSizing(trade, requestedQuantity);
    snapshot.proposed = sizing;
    if (sizing.ok) {
      snapshot.proposedExposure = Number((exposure + sizing.entry * sizing.qty).toFixed(2));
      snapshot.proposedPortfolioRisk = Number((portfolioRisk + sizing.totalTradeRisk).toFixed(2));
      snapshot.proposedCorrelatedExposure = Number((exposure + sizing.entry * sizing.qty).toFixed(2));
      snapshot.proposedIndexExposure = Number((paperIndexExposure(trade.index) + sizing.entry * sizing.qty).toFixed(2));
      snapshot.proposedIndexExposureLimit = Number((capital * r.maxSingleIndexExposure / 100).toFixed(2));
      snapshot.proposedRiskAllowed = snapshot.proposedPortfolioRisk <= portfolioRiskLimit &&
        snapshot.proposedExposure <= exposureLimit &&
        snapshot.proposedIndexExposure <= snapshot.proposedIndexExposureLimit &&
        snapshot.proposedCorrelatedExposure <= correlatedExposureLimit;
    }
  }
  return snapshot;
}

function calculateRiskSizing(trade, requestedQuantity = null) {
  const r = state.risk || {};
  const startingCapital = Number(state.paper?.startingCapital || 100000);
  const allowedTradeRiskPct = Math.min(Number(r.maxTradeLoss || 1), Number(r.riskPerTrade || 1));
  const maxRiskAmount = startingCapital * (allowedTradeRiskPct / 100);
  const entry = Number(trade.entry || 0);
  const stop = Number(trade.stopLoss || 0);
  const perUnitRisk = entry - stop;
  const lotSize = Math.max(1, Math.floor(Number(INDICES[trade.index]?.lotSize || 1)));

  if (!(entry > 0) || !(stop > 0) || !(perUnitRisk > 0)) {
    return { ok: false, reason: "Invalid entry/stop values." };
  }

  const maxRiskQtyRaw = Math.floor(maxRiskAmount / perUnitRisk);
  const maxRiskQty = Math.floor(maxRiskQtyRaw / lotSize) * lotSize;
  if (maxRiskQty < lotSize) {
    return { ok: false, reason: `Minimum lot size ${lotSize} exceeds the configured maximum account risk of ₹${maxRiskAmount.toFixed(2)}.` };
  }

  const explicitQty = requestedQuantity !== null && requestedQuantity !== undefined;
  const requestedQty = explicitQty
    ? Math.max(1, Math.floor(Number(requestedQuantity)))
    : lotSize;

  if (explicitQty && requestedQty % lotSize !== 0) {
    return { ok: false, reason: `Quantity must be in lot-size multiples of ${lotSize}.` };
  }

  const qty = explicitQty ? requestedQty : Math.min(lotSize, maxRiskQty);
  if (qty > maxRiskQty) {
    return { ok: false, reason: `Requested quantity ${qty} exceeds the account-risk limit. Maximum allowed is ${maxRiskQty}.` };
  }

  return {
    ok: true,
    qty,
    lotSize,
    entry,
    stop,
    perUnitRisk,
    maxRiskAmount,
    totalTradeRisk: perUnitRisk * qty
  };
}

function riskCheck(trade, requestedQuantity = null) {
  const r = riskConfig();
  if (r.killSwitch) return { ok: false, reason: "ERA risk kill switch is ON.", code:"KILL_SWITCH" };
  if ((state.paper.positions || []).length >= r.maxPositions) return { ok: false, reason: "Maximum open paper positions reached.", code:"MAX_POSITIONS" };
  if (countTradesToday() >= r.maxTradesPerDay) return { ok: false, reason: "Maximum paper trades for today reached.", code:"MAX_TRADES_DAY" };

  const sizing = calculateRiskSizing(trade, requestedQuantity);
  if (!sizing.ok) return { ...sizing, code:"POSITION_RISK" };

  const snapshot = riskSnapshot(trade, requestedQuantity);
  if (snapshot.dailyPnl <= -snapshot.dailyLossLimit) return { ok: false, reason: "Maximum daily paper loss limit reached.", code:"DAILY_LOSS", risk:snapshot };
  if (snapshot.proposedPortfolioRisk > snapshot.portfolioRiskLimit) return { ok: false, reason: "Maximum portfolio risk limit reached.", code:"PORTFOLIO_RISK", risk:snapshot };
  if (snapshot.proposedExposure > snapshot.exposureLimit) return { ok: false, reason: "Maximum paper exposure limit reached.", code:"EXPOSURE", risk:snapshot };
  if (snapshot.proposedCorrelatedExposure > snapshot.correlatedExposureLimit) return { ok: false, reason: "Maximum correlated portfolio exposure limit reached.", code:"CORRELATED_EXPOSURE", risk:snapshot };
  if (snapshot.proposedIndexExposure > snapshot.proposedIndexExposureLimit) return { ok: false, reason: "Maximum single-index exposure limit reached.", code:"INDEX_EXPOSURE", risk:snapshot };

  const cash = Number(state.paper?.cash || 0);
  const orderValue = sizing.entry * sizing.qty;
  if (orderValue > cash) return { ok: false, reason: "Insufficient paper cash for this trade.", code:"CASH", risk:snapshot };
  return { ...sizing, ok: true, reason: "All deterministic risk checks passed.", code:"PASS", risk:snapshot };
}
function validateManualPaperBuy(b) {
  const price = Number(b.price || b.entry || 0);
  if (!(price > 0)) return { ok: false, reason: "Valid order price is required." };
  if (riskConfig().killSwitch) return { ok: false, reason: "ERA risk kill switch is ON." };
  if ((state.paper.positions || []).length >= Number(state.risk.maxPositions || 3)) return { ok: false, reason: "Maximum open paper positions reached." };
  if (countTradesToday() >= Number(state.risk.maxTradesPerDay || 5)) return { ok: false, reason: "Maximum paper trades for today reached." };

  if (!b.index || !b.optionType || !(Number(b.strike) > 0) || !b.instrumentKey) return { ok: false, reason: "Exact index, CE/PE, strike and instrument are required." };

  const stop = Number(b.stopLoss || 0);
  if (!(stop > 0) || price <= stop) return { ok: false, reason: "Valid stop loss below entry price is required." };

  const sizing = calculateRiskSizing({ ...b, entry: price, stopLoss: stop }, b.quantity);
  if (!sizing.ok) return sizing;

  const startingCapital = Number(state.paper.startingCapital || 100000);
  const currentPnl = paperRealizedPnlToday() + Number(state.paper.unrealizedPnl || 0);
  if (currentPnl <= -(startingCapital * Number(state.risk.maxDailyLoss || 2) / 100)) return { ok: false, reason: "Maximum daily paper loss limit reached." };

  const value = price * sizing.qty;
  if (value > Number(state.paper.cash || 0)) return { ok: false, reason: "Insufficient paper cash." };
  const exposure = paperOpenExposure();
  const maxExposureValue = startingCapital * riskConfig().maxExposure / 100;
  if (exposure + value > maxExposureValue) return { ok: false, reason: "Maximum paper exposure limit reached." };
  const correlatedExposureLimit = startingCapital * riskConfig().maxCorrelationExposure / 100;
  if (exposure + value > correlatedExposureLimit) return { ok: false, reason: "Maximum correlated portfolio exposure limit reached." };
  const portfolioRisk = paperOpenRisk() + Number(sizing.totalTradeRisk || 0);
  const portfolioRiskLimit = startingCapital * riskConfig().maxPortfolioRisk / 100;
  if (portfolioRisk > portfolioRiskLimit) return { ok: false, reason: "Maximum portfolio risk limit reached." };
  const indexExposure = paperIndexExposure(b.index) + value;
  const indexExposureLimit = startingCapital * riskConfig().maxSingleIndexExposure / 100;
  if (indexExposure > indexExposureLimit) return { ok: false, reason: "Maximum single-index exposure limit reached." };

  const positionKey = [b.index, b.optionType, b.strike, b.instrumentKey].join("|");
  if ((state.paper.positions || []).some(p => [p.index, p.optionType, p.strike, p.instrumentKey].join("|") === positionKey)) return { ok: false, reason: "A paper position for this exact contract is already open." };

  return { ...sizing, ok: true, qty: sizing.qty, price, value };
}
app.get("/api/candles", async (req, res) => {
  try {
    const index = normalizeIndex(req.query.index || "NIFTY");
    const interval = Math.max(1, Math.min(60, Number(req.query.interval || 5)));
    if (!INDICES[index]) return res.status(400).json({ ok:false, error:"Invalid index" });
    let candles = await fetchIntradayCandles(index, interval);
    if (!candles.length) candles = await fetchHistoricalCandles(index, interval);
    const market = state.market[index];
    candles = syncLatestCandle(candles, market?.price);
    res.json({ ok:true, index, interval, candles, updatedAt:nowISO() });
  } catch (error) {
    res.status(500).json({ ok:false, error:apiError(error) });
  }
});

app.get("/api/opportunities", async (req, res) => {
  try {
    if (!Object.keys(state.market).some(k => state.market[k]?.available)) await refreshMarketData();
    const list = [];
    for (const index of Object.keys(INDICES)) {
      const a = state.analysis[index];
      if (!a?.available) continue;
      for (const trade of (a.trades || [])) list.push({ ...trade, reasons:a.reasons || [], risks:a.risks || [] });
      if (!a.trades?.length) list.push({ index, signal:"NO TRADE", status:"WATCH", confidence:a.confidence || 0, reason:a.suggestion || "No validated setup" });
    }
    list.sort((a,b)=>Number(b.confidence||0)-Number(a.confidence||0));
    res.json({ ok:true, opportunities:list.slice(0,20), updatedAt:nowISO() });
  } catch (error) { res.status(500).json({ok:false,error:apiError(error)}); }
});

app.get("/api/risk", requireAuth, (req,res)=>res.json({ok:true,risk:state.risk,killSwitch:Boolean(state.risk.killSwitch),snapshot:riskSnapshot(),updatedAt:nowISO()}));
app.get("/api/risk/status", requireAuth, (req,res)=>{ try { res.json({ok:true,status:riskSnapshot(),updatedAt:nowISO()}); } catch(error){ res.status(500).json({ok:false,error:apiError(error)}); } });
app.post("/api/risk/check", requireAuth, (req,res)=>{ try { const b=req.body||{}; const trade=b.trade||b; const result=riskCheck(trade,b.quantity!==undefined?b.quantity:null); res.status(result.ok?200:403).json({ok:result.ok,result,updatedAt:nowISO()}); } catch(error){ res.status(400).json({ok:false,error:apiError(error)}); } });
app.post("/api/risk", requireAuth, (req,res)=>{
  try {
    const b=req.body||{};
    for (const k of ["riskPerTrade","maxDailyLoss","maxTradeLoss","maxPositions","maxTradesPerDay","maxExposure","maxPortfolioRisk","maxSingleIndexExposure","maxCorrelationExposure"]) {
      if (b[k] !== undefined && Number.isFinite(Number(b[k])) && Number(b[k]) > 0) state.risk[k]=Number(b[k]);
    }
    if (b.killSwitch !== undefined) state.risk.killSwitch=Boolean(b.killSwitch);
    saveState(); res.json({ok:true,risk:state.risk});
  } catch(error){res.status(400).json({ok:false,error:apiError(error)});}
});

// ============================================================
// STEP 15 — PERMANENT TRADE HISTORY / EXECUTION LEDGER
// Append-only: records are never removed or overwritten.
// Paper and future broker execution events share this ledger.
// ============================================================

function appendExecutionEvent(event = {}) {
  const record = {
    id: event.id || `EX${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    tradeId: event.tradeId || `T${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    eventType: String(event.eventType || "OPEN").toUpperCase(),
    executionType: String(event.executionType || "PAPER").toUpperCase(),
    side: String(event.side || "BUY").toUpperCase(),
    index: event.index || null,
    optionType: event.optionType || null,
    strike: Number.isFinite(Number(event.strike)) ? Number(event.strike) : null,
    expiry: event.expiry || null,
    instrumentKey: event.instrumentKey || null,
    quantity: Number(event.quantity || 0),
    price: Number(event.price || 0),
    stopLoss: Number(event.stopLoss || 0),
    targets: Array.isArray(event.targets) ? event.targets.slice(0, 3).map(Number) : [],
    pnl: Number.isFinite(Number(event.pnl)) ? Number(event.pnl) : null,
    pnlPercent: Number.isFinite(Number(event.pnlPercent)) ? Number(event.pnlPercent) : null,
    reason: event.reason || null,
    result: event.result || null,
    confidence: event.confidence ?? null,
    reasoning: event.reasoning || null,
    source: event.source || "PAPER",
    alertId: event.alertId || null,
    positionId: event.positionId || null,
    executedAt: event.executedAt || nowISO(),
    metadata: event.metadata || null
  };

  state.executionLedger = Array.isArray(state.executionLedger) ? state.executionLedger : [];
  state.executionLedger.push(record);
  saveState();
  return record;
}

function buildPermanentTradeHistory(filters = {}) {
  const ledger = Array.isArray(state.executionLedger) ? state.executionLedger : [];
  const grouped = new Map();

  for (const event of ledger) {
    if (!event?.tradeId) continue;
    let trade = grouped.get(event.tradeId);
    if (!trade) {
      trade = {
        tradeId: event.tradeId, executionType: event.executionType || "PAPER", index: event.index,
        optionType: event.optionType, strike: event.strike, expiry: event.expiry, instrumentKey: event.instrumentKey,
        quantity: 0, entry: null, exit: null, stopLoss: event.stopLoss || null, targets: event.targets || [],
        pnl: 0, pnlPercent: null, result: null, reasoning: event.reasoning || null, confidence: event.confidence ?? null,
        openedAt: null, closedAt: null, status: "OPEN", source: event.source || "PAPER", alertId: event.alertId || null, events: []
      };
      grouped.set(event.tradeId, trade);
    }
    trade.events.push(event);
    if (event.eventType === "OPEN") {
      trade.entry = event.price; trade.openedAt = event.executedAt; trade.quantity = event.quantity;
      trade.stopLoss = event.stopLoss || trade.stopLoss; trade.targets = event.targets?.length ? event.targets : trade.targets;
      trade.reasoning = event.reasoning || trade.reasoning; trade.confidence = event.confidence ?? trade.confidence;
      trade.status = "OPEN";
    } else if (event.eventType === "PARTIAL_EXIT" || event.eventType === "CLOSE") {
      trade.exit = event.price; trade.closedAt = event.executedAt; trade.pnl += Number(event.pnl || 0);
      trade.pnlPercent = event.pnlPercent ?? trade.pnlPercent; trade.result = event.result || event.reason || trade.result;
      if (event.eventType === "CLOSE") trade.status = "CLOSED";
    }
  }

  let list = [...grouped.values()];
  const q = String(filters.search || "").trim().toLowerCase();
  const status = String(filters.status || "ALL").toUpperCase();
  const type = String(filters.executionType || "ALL").toUpperCase();
  if (q) list = list.filter(t => JSON.stringify(t).toLowerCase().includes(q));
  if (status !== "ALL") list = list.filter(t => t.status === status);
  if (type !== "ALL") list = list.filter(t => t.executionType === type);
  list.sort((a,b) => new Date(b.closedAt || b.openedAt || 0) - new Date(a.closedAt || a.openedAt || 0));
  return list;
}

function tradeHistoryStats(list) {
  const trades = Array.isArray(list) ? list : [];
  const closed = trades.filter(t => t.status === "CLOSED");
  const wins = closed.filter(t => Number(t.pnl || 0) > 0);
  const losses = closed.filter(t => Number(t.pnl || 0) < 0);
  const pnl = closed.reduce((s,t) => s + Number(t.pnl || 0), 0);
  return { total: trades.length, open: trades.filter(t => t.status === "OPEN").length, closed: closed.length, wins: wins.length, losses: losses.length, winRate: closed.length ? (wins.length / closed.length) * 100 : 0, realizedPnl: pnl };
}

app.get("/api/trade-history", requireAuth, (req,res)=>{
  try {
    const history = buildPermanentTradeHistory({ search:req.query.search, status:req.query.status, executionType:req.query.executionType });
    res.json({ok:true,history:history.slice(0,1000),stats:tradeHistoryStats(history),ledgerSize:(state.executionLedger||[]).length,updatedAt:nowISO()});
  } catch(error) { res.status(500).json({ok:false,error:apiError(error)}); }
});

app.get("/api/trade-history/:tradeId", requireAuth, (req,res)=>{
  const history = buildPermanentTradeHistory();
  const trade = history.find(t => t.tradeId === String(req.params.tradeId));
  if(!trade) return res.status(404).json({ok:false,error:"Trade history record not found."});
  res.json({ok:true,trade,events:trade.events,updatedAt:nowISO()});
});

app.get("/api/paper", requireAuth, (req,res)=>res.json({ok:true,paper:state.paper,risk:state.risk,updatedAt:nowISO()}));

function paperTodayKey(){
  return new Date().toLocaleDateString("en-CA", {timeZone:"Asia/Kolkata"});
}

function paperTradesToday(){
  const key=paperTodayKey();
  return (state.paper.orders||[]).filter(o=>o.side==="BUY" && String(o.createdAt||"").slice(0,10)===key).length;
}

function paperRealizedPnlToday(){
  const key=paperTodayKey();
  return (state.paper.closedTrades||[]).filter(x=>String(x.closedAt||"").slice(0,10)===key).reduce((sum,x)=>sum+Number(x.pnl||0),0);
}

function settlePaperPosition(position, exitPrice, reason="MANUAL_EXIT"){
  if(!position || !state.paper.positions.some(p=>p.id===position.id)) return null;
  const qty=Math.max(0,Number(position.quantity||0));
  const exit=Number(exitPrice||0);
  if(!qty || !Number.isFinite(exit) || exit<=0) return null;
  const entry=Number(position.entry||0);
  const pnl=(exit-entry)*qty;
  const closedAt=nowISO();
  const closed={
    id:`C${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    positionId:position.id,
    alertId:position.alertId||null,
    index:position.index,
    optionType:position.optionType,
    strike:position.strike,
    expiry:position.expiry||null,
    instrumentKey:position.instrumentKey||null,
    quantity:qty,
    entry,
    exit,
    stopLoss:Number(position.stopLoss||0),
    targets:Array.isArray(position.targets)?position.targets.slice(0,3):[],
    pnl,
    pnlPercent:entry>0?(pnl/(entry*qty))*100:0,
    reason,
    openedAt:position.openedAt||null,
    closedAt,
    confidence:position.confidence??null,
    reasoning:position.reasoning||null
  };
  state.paper.cash += exit*qty;
  state.paper.realizedPnl += pnl;
  state.paper.closedTrades=Array.isArray(state.paper.closedTrades)?state.paper.closedTrades:[];
  state.paper.closedTrades.unshift(closed);
  state.paper.closedTrades=state.paper.closedTrades.slice(0,500);
  state.paper.positions=state.paper.positions.filter(p=>p.id!==position.id);
  state.paper.orders.unshift({id:`O${Date.now()}-${Math.random().toString(36).slice(2,6)}`,side:"SELL",index:closed.index,optionType:closed.optionType,strike:closed.strike,expiry:closed.expiry,instrumentKey:closed.instrumentKey,quantity:qty,price:exit,positionId:closed.positionId,reason,createdAt:closedAt});
  state.paper.orders=state.paper.orders.slice(0,500);
  appendExecutionEvent({
    tradeId:position.tradeId || `T${position.id}`, eventType:"CLOSE", executionType:"PAPER", side:"SELL", index:closed.index,
    optionType:closed.optionType, strike:closed.strike, expiry:closed.expiry, instrumentKey:closed.instrumentKey, quantity:qty,
    price:exit, stopLoss:closed.stopLoss, targets:closed.targets, pnl:closed.pnl, pnlPercent:closed.pnlPercent,
    reason, result:reason, confidence:closed.confidence, reasoning:closed.reasoning, source:"PAPER", alertId:closed.alertId, positionId:closed.positionId
  });
  return closed;
}

async function refreshPaperPositions(priceOverrides={}){
  const positions=Array.isArray(state.paper.positions)?state.paper.positions:[];
  const keys=[...new Set(positions.map(p=>p.instrumentKey).filter(Boolean))];
  let quotes={};
  if(keys.length){
    const data=(await upstoxRequest("https://api.upstox.com/v3/market-quote/quotes",{instrument_key:keys.join(",")})).data||{};
    quotes=data;
  }
  const closed=[];
  for(const p of [...positions]){
    let current=Number(p.currentPrice||p.entry||0);
    const override=Number(priceOverrides[p.instrumentKey]);
    if(Number.isFinite(override) && override>0) current=override;
    else {
      const raw=quotes[p.instrumentKey];
      const ltp=Number(raw?.ltpc?.ltp ?? raw?.last_price ?? raw?.ltp ?? 0);
      if(ltp>0) current=ltp;
    }
    p.currentPrice=current;
    p.unrealizedPnl=(current-Number(p.entry||0))*Number(p.quantity||0);
    p.pnlPercent=Number(p.entry)>0?((current-Number(p.entry))/Number(p.entry))*100:0;
    const expiryMs=p.expiry?new Date(`${String(p.expiry).slice(0,10)}T15:30:00+05:30`).getTime():NaN;
    let trigger=null;
    if(Number.isFinite(expiryMs) && Date.now()>=expiryMs) trigger="EXPIRY";
    else if(Number(p.stopLoss)>0 && current<=Number(p.stopLoss)) trigger="SL_HIT";
    else if(Number(p.target)>0 && current>=Number(p.target)) trigger="TARGET_HIT";
    if(trigger){
      const c=settlePaperPosition(p,current,trigger);
      if(c){
        closed.push(c);
        realtimeBroadcast("paper-position-update", { type:"CLOSED", position:c, paper:state.paper, updatedAt:nowISO() });
        try { await sendPush({ type:"paper-trade", title:`ERA Paper ${trigger.replace(/_/g," ")}`, body:`${c.index} ${c.optionType} ${c.strike} • Exit ₹${Number(c.exit).toFixed(2)} • P&L ₹${Number(c.pnl).toFixed(2)}`, data:c }); } catch(_) {}
      }
    } else {
      realtimeBroadcast("paper-position-update", { type:"MARK", position:p, paper:{unrealizedPnl:state.paper.unrealizedPnl}, updatedAt:nowISO() });
      p.status="RUNNING";
    }
  }
  state.paper.unrealizedPnl=(state.paper.positions||[]).reduce((sum,p)=>sum+Number(p.unrealizedPnl||0),0);
  return closed;
}

app.post("/api/paper/refresh", requireAuth, async (req,res)=>{
  try {
    const closed=await refreshPaperPositions(req.body?.prices||{});
    saveState();
    res.json({ok:true,paper:state.paper,risk:state.risk,closed,updatedAt:nowISO()});
  } catch(error){
    console.error("[ERA] Paper refresh:",error.response?.data||error.message);
    res.status(500).json({ok:false,error:apiError(error)});
  }
});

app.get('/api/paper-trading', requireAuth, (req,res)=>res.json({ok:true,paper:state.paper,risk:state.risk,updatedAt:nowISO()}));

app.post("/api/paper/reset", requireAuth, (req,res)=>{
  state.paper={startingCapital:100000,cash:100000,positions:[],orders:[],realizedPnl:0,unrealizedPnl:0,closedTrades:[]};
  saveState(); res.json({ok:true,paper:state.paper});
});

app.post("/api/paper/order", requireAuth, (req,res)=>{
  try {
    const b=req.body||{};
    const side=String(b.side||"BUY").toUpperCase()==="SELL"?"SELL":"BUY";
    const qty=Math.max(1,Math.floor(Number(b.quantity||1)));
    const price=Number(b.price||b.entry||0);
    if (!price || price<=0) return res.status(400).json({ok:false,error:"Valid order price is required."});
    if (state.risk.killSwitch) return res.status(403).json({ok:false,error:"ERA risk kill switch is ON."});

    if(side==="SELL"){
      let pos=null;
      if(b.positionId) pos=state.paper.positions.find(p=>p.id===String(b.positionId));
      if(!pos){
        const positionKey=[b.index,b.optionType,b.strike,b.instrumentKey].join("|");
        pos=state.paper.positions.find(p=>[p.index,p.optionType,p.strike,p.instrumentKey].join("|")===positionKey);
      }
      if(!pos) return res.status(400).json({ok:false,error:"Matching paper position not found."});
      const closeQty=Math.min(qty,Number(pos.quantity||0));
      if(closeQty<=0) return res.status(400).json({ok:false,error:"Paper position has no open quantity."});
      if(closeQty<Number(pos.quantity||0)){
        const entry=Number(pos.entry||0), pnl=(price-entry)*closeQty;
        const partialAt=nowISO();
        const remainingQuantity=Number(pos.quantity||0)-closeQty;
        state.paper.cash+=price*closeQty; state.paper.realizedPnl+=pnl; pos.quantity=remainingQuantity;
        const partialClosed={id:`C${Date.now()}-${Math.random().toString(36).slice(2,7)}`,positionId:pos.id,alertId:pos.alertId||null,index:pos.index,optionType:pos.optionType,strike:pos.strike,expiry:pos.expiry||null,instrumentKey:pos.instrumentKey||null,quantity:closeQty,entry,exit:price,stopLoss:Number(pos.stopLoss||0),targets:Array.isArray(pos.targets)?pos.targets.slice(0,3):[],pnl,pnlPercent:entry>0?(pnl/(entry*closeQty))*100:0,reason:"PARTIAL_EXIT",openedAt:pos.openedAt||null,closedAt:partialAt,remainingQuantity,confidence:pos.confidence??null,reasoning:pos.reasoning||null};
        state.paper.closedTrades=Array.isArray(state.paper.closedTrades)?state.paper.closedTrades:[];
        state.paper.closedTrades.unshift(partialClosed); state.paper.closedTrades=state.paper.closedTrades.slice(0,500);
        appendExecutionEvent({tradeId:pos.tradeId || `T${pos.id}`,eventType:"PARTIAL_EXIT",executionType:"PAPER",side:"SELL",index:pos.index,optionType:pos.optionType,strike:pos.strike,expiry:pos.expiry,instrumentKey:pos.instrumentKey,quantity:closeQty,price,stopLoss:pos.stopLoss,targets:pos.targets,pnl,pnlPercent:entry>0?(pnl/(entry*closeQty))*100:0,reason:"PARTIAL_EXIT",result:"PARTIAL_EXIT",confidence:pos.confidence,reasoning:pos.reasoning,source:"PAPER",alertId:pos.alertId,positionId:pos.id});
        state.paper.orders.unshift({id:`O${Date.now()}`,side:"SELL",index:pos.index,optionType:pos.optionType,strike:pos.strike,expiry:pos.expiry,instrumentKey:pos.instrumentKey,quantity:closeQty,price,positionId:pos.id,reason:"PARTIAL_EXIT",createdAt:partialAt});
        realtimeBroadcast("paper-position-update", { type:"PARTIAL_EXIT", position:partialClosed, paper:state.paper, updatedAt:partialAt });
      } else {
        const closed=settlePaperPosition(pos,price,String(b.reason||"MANUAL_EXIT"));
        state.paper.unrealizedPnl=(state.paper.positions||[]).reduce((sum,p)=>sum+Number(p.unrealizedPnl||0),0);
        saveState();
        return res.json({ok:true,order:state.paper.orders[0],closed:closed||null,paper:state.paper});
      }
      state.paper.orders=state.paper.orders.slice(0,500); saveState();
      return res.json({ok:true,order:state.paper.orders[0],paper:state.paper});
    }

    const validation=validateManualPaperBuy(b);
    if(!validation.ok) return res.status(403).json({ok:false,error:validation.reason});
    const openedAt=nowISO();
    const tradeId=`T${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const position={id:`P${Date.now()}-${Math.random().toString(36).slice(2,7)}`,tradeId,index:b.index||"NIFTY",optionType:b.optionType||"",strike:Number(b.strike||0),expiry:b.expiry||null,instrumentKey:b.instrumentKey||null,quantity:validation.qty,entry:validation.price,currentPrice:price,unrealizedPnl:0,pnlPercent:0,stopLoss:Number(b.stopLoss||0),targets:Array.isArray(b.targets)?b.targets.map(Number).filter(Number.isFinite).slice(0,3):[],target:Number(b.target||b.targets?.[0]||0),confidence:b.confidence??null,reasoning:b.reasoning||null,openedAt,status:"RUNNING",entryMode:b.entryMode||"market",source:b.source||"MANUAL_PAPER"};
    state.paper.cash-=validation.value; state.paper.positions.push(position);
    const order={id:`O${Date.now()}-${Math.random().toString(36).slice(2,6)}`,side:"BUY",index:position.index,optionType:position.optionType,strike:position.strike,expiry:position.expiry,instrumentKey:position.instrumentKey,quantity:validation.qty,price:validation.price,positionId:position.id,source:position.source,createdAt:openedAt};
    state.paper.orders.unshift(order); state.paper.orders=state.paper.orders.slice(0,500);
    appendExecutionEvent({tradeId,eventType:"OPEN",executionType:"PAPER",side:"BUY",index:position.index,optionType:position.optionType,strike:position.strike,expiry:position.expiry,instrumentKey:position.instrumentKey,quantity:validation.qty,price:validation.price,stopLoss:position.stopLoss,targets:position.targets,confidence:position.confidence,reasoning:position.reasoning,source:position.source,positionId:position.id});
    res.json({ok:true,order,position,paper:state.paper});
  } catch(error){res.status(400).json({ok:false,error:apiError(error)});}
});

app.post("/api/paper/exit", requireAuth, async (req,res)=>{
  try{
    const pos=state.paper.positions.find(p=>p.id===String(req.body?.positionId||""));
    if(!pos) return res.status(404).json({ok:false,error:"Paper position not found."});
    let price=Number(req.body?.price||0);
    if(!(price>0) && pos.instrumentKey){
      const data=(await upstoxRequest("https://api.upstox.com/v3/market-quote/quotes",{instrument_key:pos.instrumentKey})).data||{};
      const raw=data[pos.instrumentKey]; price=Number(raw?.ltpc?.ltp ?? raw?.last_price ?? raw?.ltp ?? 0);
    }
    if(!(price>0)) price=Number(pos.currentPrice||0);
    if(!(price>0)) return res.status(400).json({ok:false,error:"Current paper exit price is unavailable."});
    const closed=settlePaperPosition(pos,price,String(req.body?.reason||"MANUAL_EXIT"));
    state.paper.unrealizedPnl=(state.paper.positions||[]).reduce((sum,p)=>sum+Number(p.unrealizedPnl||0),0);
    saveState(); res.json({ok:true,closed,paper:state.paper,updatedAt:nowISO()});
  }catch(error){res.status(500).json({ok:false,error:apiError(error)});}
});

app.post("/api/paper/mark", requireAuth, async (req,res)=>{
  try {
    const closed=await refreshPaperPositions(req.body?.prices||{});
    saveState(); res.json({ok:true,paper:state.paper,closed});
  } catch(error){res.status(400).json({ok:false,error:apiError(error)});}
});

app.get("/api/journal", requireAuth, (req,res)=>res.json({ok:true,journal:state.journal.slice(0,500)}));
app.post("/api/journal", requireAuth, (req,res)=>{
  try {
    const b=req.body||{}; const record={id:b.id||`J${Date.now()}`,createdAt:b.createdAt||nowISO(),...b};
    state.journal.unshift(record); state.journal=state.journal.slice(0,500); saveState(); res.json({ok:true,record,journal:state.journal});
  } catch(error){res.status(400).json({ok:false,error:apiError(error)});}
});

app.get("/api/events", (req,res)=>res.json({ok:true,events:[],message:"No external economic-calendar provider is configured. ERA will not invent event data.",updatedAt:nowISO()}));

app.post("/api/calculator", (req,res)=>{
  try {
    const b=req.body||{}; const entry=Number(b.entry||0), stop=Number(b.stop||0), target=Number(b.target||0), capital=Number(b.capital||100000), riskPct=Number(b.riskPct||1), qty=Math.max(1,Math.floor(Number(b.qty||1)));
    const riskPerUnit=Math.abs(entry-stop), capitalRisk=capital*(riskPct/100), suggestedQty=riskPerUnit>0?Math.max(1,Math.floor(capitalRisk/riskPerUnit)):0;
    const rr=riskPerUnit>0?Math.abs(target-entry)/riskPerUnit:0;
    const pnl=Number.isFinite(target-entry)?(target-entry)*qty:0;
    res.json({ok:true,entry,stop,target,capital,riskPct,riskPerUnit,capitalRisk,suggestedQty,rr,pnl,updatedAt:nowISO()});
  } catch(error){res.status(400).json({ok:false,error:apiError(error)});}
});

app.post("/api/backtest", requireAuth, async (req,res)=>{
  try {
    const result = await runBacktest(req.body || {});
    res.json({ok:true,result});
  } catch(error) {
    res.status(400).json({ok:false,error:apiError(error)});
  }
});

// ============================================================
// STEP 13 — TRADE ALERT APIs
// ============================================================
app.get("/api/trade-alerts", requireAuth, (req,res)=>{
  const index = req.query.index ? normalizeIndex(req.query.index) : null;
  const alerts = state.tradeAlerts
    .filter(item => !index || item.trade?.index === index)
    .slice(0, 200);
  res.json({ok:true,alerts,updatedAt:nowISO()});
});

app.get("/api/trade-alerts/:id", requireAuth, (req,res)=>{
  const alert=findTradeAlert(req.params.id);
  if(!alert) return res.status(404).json({ok:false,error:"Trade alert not found."});
  res.json({ok:true,alert,updatedAt:nowISO()});
});

app.post("/api/trade-alerts/:id/action", requireAuth, (req,res)=>{
  try {
    const result=applyTradeAlertAction(findTradeAlert(req.params.id), req.body?.action, req);
    return res.status(result.status || (result.ok ? 200 : 400)).json(result);
  } catch(error) {
    console.error("[ERA] Trade alert action:", error.message);
    return res.status(500).json({ok:false,error:apiError(error)});
  }
});

app.get("/api/alerts", requireAuth, (req,res)=>res.json({ok:true,alerts:state.alerts.slice(0,200),updatedAt:nowISO()}));
app.post("/api/alerts", requireAuth, (req,res)=>{
  try { const b=req.body||{}; const alert={id:b.id||`A${Date.now()}`,createdAt:nowISO(),active:true,...b}; state.alerts.unshift(alert); state.alerts=state.alerts.slice(0,200); saveState(); res.json({ok:true,alert}); }
  catch(error){res.status(400).json({ok:false,error:apiError(error)});}
});

// ============================================================
// PRE-MARKET CHECK
// ============================================================

setInterval(
  async () => {
    try {
      await preMarketCheck();
    } catch (error) {
      console.error(
        "[ERA] Pre-market:",
        error.message
      );
    }
  },

  5 * 60 * 1000
);

// ============================================================
// INITIALIZATION
// ============================================================

// Start the real-time market engine without changing the existing scanner.
setTimeout(startRealtimeMarketFeed, 1500);

(async () => {
  try {
    console.log(
      `[ERA] Starting Era AI ${VERSION}`
    );

    console.log(
      `[ERA] Backend: ${BACKEND_URL}`
    );

    console.log(
      `[ERA] Market open: ${isMarketHours()}`
    );

    await fetchNews();

  } catch (error) {
    console.error(
      "[ERA] Initial news error:",
      error.message
    );
  }

  setTimeout(
    async () => {
      try {
        if (
          state.engineRunning
        ) {
          await monitorMarketState();
        }
      } catch (error) {
        console.error(
          "[ERA] Initial scan error:",
          error.message
        );
      }
    },

    3000
  );
})();

// ============================================================
// ============================================================
// STEP 18 — AI SELF-AUDIT / PERFORMANCE INTELLIGENCE
// Deterministic audit first; optional AI narrative second.
// AI observations never override deterministic trading/risk gates.
// ============================================================

function buildAISelfAudit() {
  const ledger = Array.isArray(state.executionLedger) ? state.executionLedger : [];
  const opens = ledger.filter(e => String(e.executionType).toUpperCase() === "PAPER" && String(e.eventType).toUpperCase() === "OPEN" && String(e.side).toUpperCase() === "BUY");
  const closes = ledger.filter(e => String(e.executionType).toUpperCase() === "PAPER" && ["CLOSE","PARTIAL_EXIT"].includes(String(e.eventType).toUpperCase()) && Number.isFinite(Number(e.pnl)));
  const trades = new Map();
  for (const e of opens) if (e.tradeId) trades.set(e.tradeId, { tradeId:e.tradeId, confidence:Number(e.confidence || 0), pnl:0, closed:false, index:e.index, optionType:e.optionType, reasoning:e.reasoning || null, openedAt:e.executedAt });
  for (const e of closes) { const t=trades.get(e.tradeId); if (!t) continue; t.pnl += Number(e.pnl || 0); t.closed=true; t.result=e.result || e.reason || t.result; }
  const completed=[...trades.values()].filter(t=>t.closed);
  const wins=completed.filter(t=>t.pnl>0), losses=completed.filter(t=>t.pnl<0), flat=completed.filter(t=>t.pnl===0);
  const totalPnl=completed.reduce((a,t)=>a+t.pnl,0);
  const buckets={};
  for(const t of completed){ const k=t.confidence>=80?"80+":t.confidence>=70?"70-79":t.confidence>=65?"65-69":"<65"; buckets[k] ||= {trades:0,wins:0,losses:0,pnl:0,winRate:0}; const b=buckets[k]; b.trades++; b.pnl+=t.pnl; if(t.pnl>0)b.wins++; if(t.pnl<0)b.losses++; }
  for(const b of Object.values(buckets)) b.winRate=b.trades?Number((b.wins/b.trades*100).toFixed(2)):0;
  const resultCounts={}; for(const e of closes){const k=String(e.result||e.reason||"UNKNOWN").toUpperCase(); resultCounts[k]=(resultCounts[k]||0)+1;}
  const audit={auditId:`AUDIT-${Date.now()}`,generatedAt:nowISO(),source:"STEP15_EXECUTION_LEDGER",sample:{opened:opens.length,completed:completed.length,pending:opens.length-completed.length},performance:{wins:wins.length,losses:losses.length,flat:flat.length,winRate:completed.length?Number((wins.length/completed.length*100).toFixed(2)):0,totalPnl:Number(totalPnl.toFixed(2)),avgPnl:completed.length?Number((totalPnl/completed.length).toFixed(2)):0,avgConfidence:completed.length?Number((completed.reduce((a,t)=>a+t.confidence,0)/completed.length).toFixed(2)):0},confidenceBuckets:buckets,resultCounts,falseSignals:{highConfidenceLosses:completed.filter(t=>t.confidence>=65&&t.pnl<0).length,lowConfidenceWins:completed.filter(t=>t.confidence<65&&t.pnl>0).length},findings:[],guardrail:{deterministicGateRemainsAuthoritative:true,aiMayNotOverrideRiskOrTradeDecision:true}};
  if(!completed.length) audit.findings.push("Insufficient completed paper trades for outcome-based calibration.");
  if(audit.falseSignals.highConfidenceLosses>0) audit.findings.push("High-confidence losing trades are present; review their technical, price-action, options and regime evidence.");
  if(audit.falseSignals.lowConfidenceWins>0) audit.findings.push("Lower-confidence winners are present; confidence calibration may be conservative for some setups.");
  return audit;
}

app.get("/api/ai-self-audit", requireAuth, (req,res)=>{ try { const audit=buildAISelfAudit(); state.aiSelfAudit=audit; saveState(); res.json({ok:true,audit,updatedAt:nowISO()}); } catch(error){ res.status(500).json({ok:false,error:apiError(error)}); } });

app.post("/api/ai-self-audit/run", requireAuth, async (req,res)=>{
  try {
    const audit=buildAISelfAudit(); let aiReview=null;
    if(OPENROUTER_API_KEY){ try { aiReview=await callAIBrain({mode:"SELF_AUDIT",audit,instruction:"Review this deterministic ERA performance audit. Identify recurring weaknesses, confidence-calibration observations and data gaps. Do not override deterministic risk/trade gates and do not invent evidence."},"Review ERA's trading-system self-audit."); } catch(error){ aiReview={status:"AI_REVIEW_UNAVAILABLE",error:apiError(error)}; } }
    else aiReview={status:"AI_REVIEW_UNAVAILABLE",reason:"OPENROUTER_API_KEY is not configured"};
    state.aiSelfAudit={...audit,aiReview}; saveState(); res.json({ok:true,audit:state.aiSelfAudit,updatedAt:nowISO()});
  } catch(error){ res.status(500).json({ok:false,error:apiError(error)}); }
});

// ============================================================
// STEP 20 — BROKER / ALGO EXECUTION
// Deterministic risk gates remain authoritative. Live broker execution is
// disabled by default and cannot be triggered by an AI response alone.
// ============================================================

function brokerExecutionConfig() {
  return {
    broker: BROKER_NAME,
    enabled: BROKER_EXECUTION_ENABLED,
    product: BROKER_PRODUCT,
    orderBaseUrl: BROKER_ORDER_BASE_URL,
    liveExecutionRequiresExplicitRequest: true,
    deterministicRiskGateRequired: true,
    executionLedger: true
  };
}

function normalizeBrokerOrder(input = {}) {
  const side = String(input.transactionType || input.side || "").toUpperCase();
  const orderType = String(input.orderType || "MARKET").toUpperCase();
  const quantity = Number(input.quantity);
  const instrumentKey = String(input.instrumentKey || input.instrument_token || "").trim();
  const price = Number(input.price || 0);
  const triggerPrice = Number(input.triggerPrice || input.trigger_price || 0);
  if (!instrumentKey) throw new Error("Broker instrument key is required.");
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("Broker quantity must be a positive integer.");
  if (!["BUY","SELL"].includes(side)) throw new Error("Broker transaction type must be BUY or SELL.");
  if (!["MARKET","LIMIT","SL","SL-M"].includes(orderType)) throw new Error("Unsupported broker order type.");
  if (["LIMIT","SL"].includes(orderType) && !(price > 0)) throw new Error("Valid order price is required for this order type.");
  if (["SL","SL-M"].includes(orderType) && !(triggerPrice > 0)) throw new Error("Valid trigger price is required for stop-loss orders.");
  return {
    quantity,
    product: String(input.product || BROKER_PRODUCT || "I").toUpperCase(),
    validity: String(input.validity || "DAY").toUpperCase(),
    price: orderType === "MARKET" || orderType === "SL-M" ? 0 : price,
    tag: String(input.tag || `ERA20-${Date.now().toString(36)}`).slice(0, 40),
    instrument_token: instrumentKey,
    order_type: orderType,
    transaction_type: side,
    disclosed_quantity: Number(input.disclosedQuantity || 0),
    trigger_price: triggerPrice,
    is_amo: Boolean(input.isAmo),
    market_protection: Number.isFinite(Number(input.marketProtection)) ? Number(input.marketProtection) : -1,
    slice: input.slice !== undefined ? Boolean(input.slice) : true
  };
}

function brokerGuard(trade, quantity, liveRequested, transactionType = "BUY") {
  if (!liveRequested) return { ok: true, mode: "DRY_RUN" };
  if (!BROKER_EXECUTION_ENABLED) return { ok:false, code:"BROKER_DISABLED", reason:"Live broker execution is disabled. Set ERA_BROKER_EXECUTION_ENABLED=true only after broker validation." };
  if (BROKER_NAME !== "upstox") return { ok:false, code:"BROKER_UNSUPPORTED", reason:`Unsupported broker: ${BROKER_NAME}` };
  if (!isMarketOpen()) return { ok:false, code:"MARKET_CLOSED", reason:"Live broker execution is blocked outside market hours." };
  // Entry orders must pass every deterministic risk gate. Exit orders are allowed
  // to reduce risk even when the entry gate or kill switch is blocking new trades.
  if (String(transactionType).toUpperCase() === "SELL") return { ok:true, mode:"LIVE_EXIT" };
  if (state.risk?.killSwitch) return { ok:false, code:"KILL_SWITCH", reason:"Risk kill switch is active." };
  const risk = riskCheck(trade, quantity);
  if (!risk.ok) return { ok:false, code:"RISK_BLOCK", reason:risk.reason || "Deterministic risk gate rejected the trade.", risk };
  return { ok:true, mode:"LIVE", risk };
}

async function executeBrokerOrder({ trade = {}, quantity, transactionType = "BUY", orderType = "MARKET", price = 0, triggerPrice = 0, tag, live = false, product, validity = "DAY", isAmo = false } = {}) {
  const guard = brokerGuard(trade, quantity, Boolean(live), transactionType);
  if (!guard.ok) return { ok:false, live:Boolean(live), guard };
  const order = normalizeBrokerOrder({
    instrumentKey: trade.instrumentKey,
    quantity,
    transactionType,
    orderType,
    price,
    triggerPrice,
    tag,
    product,
    validity,
    isAmo
  });
  const clientExecutionId = `ERA20-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  if (!live) {
    const simulated = {
      ok:true,
      live:false,
      mode:"DRY_RUN",
      clientExecutionId,
      broker:brokerExecutionConfig(),
      order,
      message:"Dry-run only. No broker order was sent."
    };
    appendExecutionEvent({
      tradeId: trade.tradeId || clientExecutionId,
      eventType: "BROKER_DRY_RUN",
      executionType: "BROKER",
      side: order.transaction_type,
      index: trade.index || null,
      optionType: trade.optionType || null,
      strike: trade.strike || null,
      expiry: trade.expiry || null,
      instrumentKey: order.instrument_token,
      quantity: order.quantity,
      price: order.price || trade.entry || 0,
      source: "STEP20_DRY_RUN",
      executedAt: nowISO(),
      reasoning: trade.reasoning || null,
      confidence: trade.confidence || null,
      broker: BROKER_NAME,
      brokerOrder: order
    });
    saveState();
    return simulated;
  }
  const response = await upstoxOrderRequest("POST", `${BROKER_ORDER_BASE_URL}/order/place`, order);
  const brokerOrderId = response?.data?.order_id || response?.order_id || response?.data?.orderId || null;
  appendExecutionEvent({
    tradeId: trade.tradeId || brokerOrderId || clientExecutionId,
    eventType: "BROKER_ORDER_PLACED",
    executionType: "BROKER",
    side: order.transaction_type,
    index: trade.index || null,
    optionType: trade.optionType || null,
    strike: trade.strike || null,
    expiry: trade.expiry || null,
    instrumentKey: order.instrument_token,
    quantity: order.quantity,
    price: order.price || trade.entry || 0,
    source: "STEP20_BROKER",
    executedAt: nowISO(),
    reasoning: trade.reasoning || null,
    confidence: trade.confidence || null,
    broker: BROKER_NAME,
    brokerOrderId,
    brokerResponse: response
  });
  saveState();
  return { ok:true, live:true, mode:"LIVE", clientExecutionId, broker:BROKER_NAME, brokerOrderId, order, response };
}

app.get("/api/broker/status", (req,res) => {
  res.json({ ok:true, status:brokerExecutionConfig(), updatedAt:nowISO() });
});

app.post("/api/broker/dry-run", requireAuth, async (req,res) => {
  try {
    const b=req.body||{};
    const result=await executeBrokerOrder({ ...b, live:false });
    res.status(result.ok?200:403).json({ ...result, updatedAt:nowISO() });
  } catch(error) {
    res.status(400).json({ok:false,error:apiError(error),updatedAt:nowISO()});
  }
});

app.post("/api/broker/order", requireAuth, async (req,res) => {
  try {
    const b=req.body||{};
    // Live mode must be explicitly requested; AI-generated payloads cannot opt in implicitly.
    if (b.live !== true) {
      const result=await executeBrokerOrder({ ...b, live:false });
      return res.status(result.ok?200:403).json({ ...result, updatedAt:nowISO() });
    }
    if (b.confirmLiveExecution !== true) {
      return res.status(400).json({ok:false,error:"Live execution requires confirmLiveExecution=true.",code:"LIVE_CONFIRMATION_REQUIRED",updatedAt:nowISO()});
    }
    const result=await executeBrokerOrder({ ...b, live:true });
    res.status(result.ok?200:403).json({ ...result, updatedAt:nowISO() });
  } catch(error) {
    res.status(400).json({ok:false,error:apiError(error),updatedAt:nowISO()});
  }
});

app.get("/api/broker/order/:orderId", requireAuth, async (req,res) => {
  try {
    if (!BROKER_EXECUTION_ENABLED) return res.status(403).json({ok:false,error:"Broker execution is disabled."});
    if (BROKER_NAME !== "upstox") return res.status(400).json({ok:false,error:`Unsupported broker: ${BROKER_NAME}`});
    const result=await upstoxOrderRequest("GET", `${BROKER_STATUS_BASE_URL}/order/details`, { order_id:req.params.orderId });
    res.json({ok:true,broker:BROKER_NAME,orderId:req.params.orderId,data:result,updatedAt:nowISO()});
  } catch(error) { res.status(500).json({ok:false,error:apiError(error),updatedAt:nowISO()}); }
});

app.post("/api/broker/order/:orderId/cancel", requireAuth, async (req,res) => {
  try {
    if (!BROKER_EXECUTION_ENABLED) return res.status(403).json({ok:false,error:"Broker execution is disabled."});
    if (BROKER_NAME !== "upstox") return res.status(400).json({ok:false,error:`Unsupported broker: ${BROKER_NAME}`});
    const result=await upstoxOrderRequest("DELETE", `${BROKER_ORDER_BASE_URL}/order/cancel?order_id=${encodeURIComponent(req.params.orderId)}`);
    appendExecutionEvent({ tradeId:req.params.orderId, eventType:"BROKER_ORDER_CANCEL_REQUESTED", executionType:"BROKER", side:"SYSTEM", source:"STEP20_BROKER", executedAt:nowISO(), broker:BROKER_NAME, brokerOrderId:req.params.orderId, brokerResponse:result });
    saveState();
    res.json({ok:true,broker:BROKER_NAME,orderId:req.params.orderId,data:result,updatedAt:nowISO()});
  } catch(error) { res.status(500).json({ok:false,error:apiError(error),updatedAt:nowISO()}); }
});

// ============================================================
// STEP 21 — PORTFOLIO ANALYTICS
// Portfolio analytics are read-only intelligence. They do not place,
// modify, or override trades and never bypass Step 19 risk controls.
// ============================================================

function portfolioDateKey(value = Date.now()) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function portfolioClosedTrades() {
  return Array.isArray(state.paper?.closedTrades) ? state.paper.closedTrades : [];
}

function portfolioOpenPositions() {
  return Array.isArray(state.paper?.positions) ? state.paper.positions.filter(p => Number(p.quantity || 0) > 0) : [];
}

function buildPortfolioAnalytics() {
  const paper = state.paper || {};
  const startingCapital = Number(paper.startingCapital || 0);
  const cash = Number(paper.cash || 0);
  const positions = portfolioOpenPositions();
  const closed = portfolioClosedTrades();

  let marketValue = 0;
  let unrealizedPnl = 0;
  const byIndex = {};
  const byOptionType = {};

  for (const p of positions) {
    const qty = Number(p.quantity || 0);
    const entry = Number(p.entry || 0);
    const current = Number(p.currentPrice ?? p.entry ?? 0);
    const value = current * qty;
    const pnl = (current - entry) * qty;
    marketValue += value;
    unrealizedPnl += pnl;
    const index = String(p.index || "UNKNOWN");
    const type = String(p.optionType || "UNKNOWN").toUpperCase();
    if (!byIndex[index]) byIndex[index] = { positions: 0, quantity: 0, marketValue: 0, unrealizedPnl: 0 };
    byIndex[index].positions += 1;
    byIndex[index].quantity += qty;
    byIndex[index].marketValue += value;
    byIndex[index].unrealizedPnl += pnl;
    if (!byOptionType[type]) byOptionType[type] = { positions: 0, marketValue: 0, unrealizedPnl: 0 };
    byOptionType[type].positions += 1;
    byOptionType[type].marketValue += value;
    byOptionType[type].unrealizedPnl += pnl;
  }

  const realizedPnl = closed.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
  const totalPnl = realizedPnl + unrealizedPnl;
  const equity = cash + marketValue;
  const returnPct = startingCapital > 0 ? (totalPnl / startingCapital) * 100 : 0;
  const exposure = equity > 0 ? (marketValue / equity) * 100 : 0;
  const wins = closed.filter(t => Number(t.pnl || 0) > 0);
  const losses = closed.filter(t => Number(t.pnl || 0) < 0);
  const grossProfit = wins.reduce((s,t) => s + Number(t.pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((s,t) => s + Number(t.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  const daily = {};
  for (const t of closed) {
    const key = portfolioDateKey(t.closedAt);
    if (!key) continue;
    daily[key] = Number(((daily[key] || 0) + Number(t.pnl || 0)).toFixed(2));
  }
  const dailySeries = Object.entries(daily).sort((a,b) => a[0].localeCompare(b[0])).map(([date,pnl]) => ({ date, pnl }));

  let running = startingCapital;
  let peak = startingCapital;
  let maxDrawdown = 0;
  const equityCurve = dailySeries.map(item => {
    running += item.pnl;
    peak = Math.max(peak, running);
    const dd = peak > 0 ? ((peak - running) / peak) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, dd);
    return { date:item.date, equity:Number(running.toFixed(2)), drawdownPct:Number(dd.toFixed(2)) };
  });

  const today = portfolioDateKey();
  const todayRealized = daily[today] || 0;
  const todayPnl = todayRealized + unrealizedPnl;

  return {
    generatedAt: nowISO(),
    source: "STEP15_EXECUTION_LEDGER_AND_PAPER_PORTFOLIO",
    account: {
      startingCapital: Number(startingCapital.toFixed(2)),
      cash: Number(cash.toFixed(2)),
      marketValue: Number(marketValue.toFixed(2)),
      equity: Number(equity.toFixed(2)),
      realizedPnl: Number(realizedPnl.toFixed(2)),
      unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
      totalPnl: Number(totalPnl.toFixed(2)),
      returnPct: Number(returnPct.toFixed(2)),
      exposurePct: Number(exposure.toFixed(2))
    },
    performance: {
      completedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: closed.length ? Number((wins.length / closed.length * 100).toFixed(2)) : 0,
      grossProfit: Number(grossProfit.toFixed(2)),
      grossLoss: Number(grossLoss.toFixed(2)),
      profitFactor: profitFactor === null ? null : Number(profitFactor.toFixed(2)),
      averageWin: Number(avgWin.toFixed(2)),
      averageLoss: Number(avgLoss.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdown.toFixed(2))
    },
    today: {
      date: today,
      realizedPnl: Number(todayRealized.toFixed(2)),
      unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
      totalPnl: Number(todayPnl.toFixed(2))
    },
    openPositions: positions.map(p => ({
      tradeId:p.tradeId || null, positionId:p.id || null, index:p.index || null,
      optionType:p.optionType || null, strike:p.strike || null, expiry:p.expiry || null,
      quantity:Number(p.quantity || 0), entry:Number(p.entry || 0), currentPrice:Number(p.currentPrice ?? p.entry ?? 0),
      marketValue:Number((Number(p.currentPrice ?? p.entry ?? 0) * Number(p.quantity || 0)).toFixed(2)),
      unrealizedPnl:Number(((Number(p.currentPrice ?? p.entry ?? 0) - Number(p.entry || 0)) * Number(p.quantity || 0)).toFixed(2)),
      stopLoss:p.stopLoss || null, targets:p.targets || [], openedAt:p.openedAt || null
    })),
    allocation: { byIndex, byOptionType },
    dailyPnl: dailySeries,
    equityCurve,
    risk: {
      maxDailyLossPct:Number(state.risk?.maxDailyLoss || 0),
      maxExposurePct:Number(state.risk?.maxExposure || 0),
      killSwitch:Boolean(state.risk?.killSwitch)
    }
  };
}

app.get("/api/portfolio", requireAuth, (req,res) => {
  try { res.json({ ok:true, portfolio:buildPortfolioAnalytics(), updatedAt:nowISO() }); }
  catch(error) { res.status(500).json({ ok:false, error:apiError(error) }); }
});

app.get("/api/portfolio/summary", requireAuth, (req,res) => {
  try {
    const p = buildPortfolioAnalytics();
    res.json({ ok:true, summary:{account:p.account,performance:p.performance,today:p.today,openPositions:p.openPositions.length,risk:p.risk}, updatedAt:nowISO() });
  } catch(error) { res.status(500).json({ ok:false, error:apiError(error) }); }
});

app.get("/api/portfolio/equity", requireAuth, (req,res) => {
  try {
    const p = buildPortfolioAnalytics();
    res.json({ ok:true, equityCurve:p.equityCurve,dailyPnl:p.dailyPnl,updatedAt:nowISO() });
  } catch(error) { res.status(500).json({ ok:false,error:apiError(error) }); }
});

app.get("/api/portfolio/allocation", requireAuth, (req,res) => {
  try {
    const p = buildPortfolioAnalytics();
    res.json({ ok:true, allocation:p.allocation,openPositions:p.openPositions,updatedAt:nowISO() });
  } catch(error) { res.status(500).json({ ok:false,error:apiError(error) }); }
});

// STEP 22 security/deployment status. This reports hardening gaps without exposing secret values.
app.get("/api/security/status", eraRateLimit({windowMs:60_000,max:30,keyPrefix:"security"}), (req,res) => {
  const brokerLive = String(process.env.ERA_BROKER_EXECUTION_ENABLED || "false").toLowerCase() === "true";
  const checks = {
    https: Boolean(req.secure || req.headers["x-forwarded-proto"] === "https"),
    brokerDisabledByDefault: !brokerLive,
    upstoxTokenConfigured: Boolean(String(process.env.UPSTOX_ACCESS_TOKEN || "").trim()),
    openRouterKeyConfigured: Boolean(String(process.env.OPENROUTER_API_KEY || "").trim()),
    vapidConfigured: Boolean(String(process.env.VAPID_PUBLIC_KEY || "").trim() && String(process.env.VAPID_PRIVATE_KEY || "").trim()),
    allowedOriginConfigured: ALLOWED_ORIGIN !== "*",
    serverSideAuthSessions: typeof requireAuth === "function" && typeof createAuthSession === "function",
    multiUserDatabase: Boolean(dbReady && dbPool)
  };
  const warnings = [];
  if (!checks.allowedOriginConfigured) warnings.push("Configure ERA_ALLOWED_ORIGIN for production instead of wildcard CORS.");
  if (!checks.serverSideAuthSessions) warnings.push("Server-side authentication sessions are not configured.");
  if (!checks.multiUserDatabase) warnings.push("Persistent user-scoped database is unavailable.");
  if (checks.multiUserDatabase) warnings.push("Authenticated user state is persisted per user; in-process request serialization is used until the engine is fully dependency-injected for concurrent multi-user execution.");
  if (!checks.https) warnings.push("HTTPS was not detected on this request; public production traffic should use HTTPS.");
  res.json({ok:true,step:22,checks,warnings,updatedAt:nowISO()});
});

// STEP 23 — FINAL ERA TRADING OS
// ============================================================
function buildEraTradingOSStatus(req) {
  const brokerLive = String(process.env.ERA_BROKER_EXECUTION_ENABLED || "false").toLowerCase() === "true";
  const ledgerSize = Array.isArray(state.executionLedger) ? state.executionLedger.length : 0;
  const paperPositions = Array.isArray(state.paper?.positions) ? state.paper.positions.length : 0;
  const engineRunning = Boolean(state.engineRunning);
  const riskKillSwitch = Boolean(state.risk?.killSwitch);
  const readiness = {
    engine: engineRunning,
    riskEngine: typeof riskCheck === "function",
    executionLedger: ledgerSize >= 0,
    paperTrading: Boolean(state.paper),
    portfolioAnalytics: typeof buildPortfolioAnalytics === "function",
    aiSelfAudit: typeof buildAISelfAudit === "function",
    backtesting: typeof runBacktest === "function",
    globalIntelligence: typeof getGlobalIntelligence === "function" || typeof buildGlobalIntelligence === "function",
    realtime: typeof realtimeState === "object",
    securityHardening: Boolean(typeof requireAuth === "function" && typeof createAuthSession === "function"),
    brokerExecution: !brokerLive || (BROKER_NAME === "upstox" && Boolean(process.env.UPSTOX_ACCESS_TOKEN)),
    liveBrokerDisabledByDefault: !brokerLive,
    userScopedPersistence: Boolean(dbReady)
  };
  const blockers = [];
  if (!readiness.engine) blockers.push("Market engine is not running.");
  if (riskKillSwitch) blockers.push("Risk kill switch is enabled.");
  if (!readiness.brokerExecution) blockers.push("Live broker execution is enabled but broker credentials/configuration are incomplete.");
  if (!readiness.globalIntelligence) blockers.push("Global intelligence module is unavailable.");
  if (!readiness.realtime) blockers.push("Realtime market module is unavailable.");
  if (!readiness.securityHardening) blockers.push("Server-side authentication hardening is incomplete.");
  if (!readiness.userScopedPersistence) blockers.push("Production multi-user persistence is not complete; current state remains file-based/global. Enable a user-scoped database before multi-user production.");
  const runtimeMode = brokerLive ? "LIVE_BROKER_ENABLED" : "PAPER_SAFE_MODE";
  readiness.persistentDatabase = Boolean(dbReady);
  if (!dbReady) blockers.push("Persistent PostgreSQL database is not connected/configured.");
  readiness.userScopedPersistence = Boolean(dbReady);
  const productionReady = readiness.engine && readiness.riskEngine && readiness.executionLedger && readiness.paperTrading && readiness.portfolioAnalytics && readiness.aiSelfAudit && readiness.backtesting && readiness.globalIntelligence && readiness.realtime && readiness.securityHardening && readiness.brokerExecution && readiness.userScopedPersistence && readiness.persistentDatabase && blockers.length === 0;
  return {
    ok: true,
    step: 23,
    product: "ERA AI — Autonomous Indian Market Intelligence and Options Analysis Platform",
    version: VERSION,
    runtimeMode,
    productionReady,
    readiness,
    blockers,
    liveBroker: { enabled: brokerLive, broker: BROKER_NAME },
    counts: { executionLedger: ledgerSize, openPaperPositions: paperPositions },
    policy: {
      deterministicRiskGate: true,
      aiCannotOverrideRisk: true,
      existingAuthPreserved: true,
      existingUiPreserved: true
    },
    checkedAt: nowISO()
  };
}

app.get("/api/era-os", eraRateLimit({windowMs:60_000,max:30,keyPrefix:"era-os"}), (req,res) => {
  try { res.json(buildEraTradingOSStatus(req)); }
  catch(error) { res.status(500).json({ok:false,error:apiError(error)}); }
});

app.get("/api/system/status", eraRateLimit({windowMs:60_000,max:30,keyPrefix:"system-status"}), (req,res) => {
  try {
    const status = buildEraTradingOSStatus(req);
    res.json({ ok:true, status:{version:status.version,runtimeMode:status.runtimeMode,productionReady:status.productionReady,blockers:status.blockers}, updatedAt:nowISO() });
  } catch(error) { res.status(500).json({ok:false,error:apiError(error)}); }
});

app.get("/api/health", (req,res) => {
  res.json({ ok:true, service:"era-ai", version:VERSION, engineRunning:Boolean(state.engineRunning), checkedAt:nowISO() });
});

// SERVER
// ============================================================

ensurePersistentDatabase().finally(() => {
app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Era AI ${VERSION} running on port ${PORT}`
    );
  }
);
});
