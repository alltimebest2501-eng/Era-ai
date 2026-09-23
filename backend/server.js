"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;
const VERSION = "8.2.5";

app.use(cors());
app.use(express.json({ limit: "2mb" }));

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

// ============================================================
// TEST AUTH / EMAIL OTP
// ============================================================
const authOtps = new Map();
const AUTH_OTP_TTL_MS = 5 * 60 * 1000;
const AUTH_RESEND_MS = 10 * 1000;

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

app.post("/api/auth/send-otp", async (req, res) => {
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
    authOtps.set(key, { otp, sentAt: Date.now(), expiresAt: Date.now() + AUTH_OTP_TTL_MS });

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

app.post("/api/auth/verify-otp", (req, res) => {
  const mode = req.body?.mode === "mobile" ? "mobile" : "email";
  const value = String(req.body?.value || "").trim();
  const otp = String(req.body?.otp || "").trim();
  const normalized = mode === "email" ? normalizeAuthEmail(value) : value.replace(/\D/g, "");
  const key = `${mode}:${normalized}`;
  const record = authOtps.get(key);

  if (!/^\d{6}$/.test(otp)) return res.status(400).json({ ok: false, error: "Enter the 6-digit OTP." });
  if (!record) return res.status(400).json({ ok: false, error: "OTP not found. Please request a new OTP." });
  if (Date.now() > record.expiresAt) { authOtps.delete(key); return res.status(400).json({ ok: false, error: "OTP expired. Please request a new OTP." }); }
  if (record.otp !== otp) return res.status(400).json({ ok: false, error: "Incorrect OTP. Please try again." });

  authOtps.delete(key);
  const user = mode === "email" ? { email: normalized, verified: true, loginMethod: "email" } : { mobile: normalized, verified: true, loginMethod: "mobile" };
  return res.json({ ok: true, user });
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

  history: [],

  pushSubscriptions: [],

  previousPrices: {},

  previousSignals: {},

  notificationHistory: {},

  settings: {
    movementThreshold: 20,
    minConfidence: 60,
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
    realizedPnl: 0
  },

  journal: [],

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

    if (saved.notificationHistory && typeof saved.notificationHistory === "object") {
      state.notificationHistory = saved.notificationHistory;
    }

    if (saved.paper && typeof saved.paper === "object") {
      state.paper = { ...state.paper, ...saved.paper, positions: Array.isArray(saved.paper.positions) ? saved.paper.positions : [], orders: Array.isArray(saved.paper.orders) ? saved.paper.orders : [] };
    }

    if (Array.isArray(saved.journal)) state.journal = saved.journal;
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
          pushSubscriptions:
            state.pushSubscriptions,

          history:
            state.history,

          alerts:
            state.alerts,

          settings:
            state.settings,

          notificationHistory:
            state.notificationHistory,

          paper:
            state.paper,

          journal:
            state.journal,

          risk:
            state.risk
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

loadState();

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

async function refreshMarketData() {
  const quotes =
    await fetchQuotes();

  state.market = {
    ...state.market,
    ...quotes
  };

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
      round(support),

    resistance:
      round(resistance),

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

function createOptionTrades(
  index,
  market,
  movement,
  confidenceData,
  rows
) {
  if (
    !market ||
    !market.available
  ) {
    return [];
  }

  if (
    !movement.significant
  ) {
    return [];
  }

  if (
    confidenceData.confidence <
    61
  ) {
    return [];
  }

  const direction =
    movement.direction;

  const optionType =
    direction === "UP"
      ? "CE"
      : direction === "DOWN"
        ? "PE"
        : null;

  if (!optionType) {
    return [];
  }

  const spot =
    Number(
      market.price
    );

  const sorted =
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
      .slice(0, 9);

  const trades = [];

  for (
    const row of sorted
  ) {
    const side =
      optionType === "CE"
        ? row.call
        : row.put;

    if (
      !side ||
      !side.instrumentKey
    ) {
      continue;
    }

    const entry =
      Number(
        side.ltp
      );

    if (
      !Number.isFinite(
        entry
      ) ||
      entry <= 0
    ) {
      continue;
    }

    const stopLoss =
      entry *
      (
        confidenceData.confidence >=
        75
          ? 0.83
          : 0.80
      );

    const risk =
      entry -
      stopLoss;

    if (
      risk <= 0
    ) {
      continue;
    }

    const target1 =
      entry +
      risk * 1.5;

    const target2 =
      entry +
      risk * 2.5;

    const target3 =
      entry +
      risk * 3.5;

    trades.push({
      index,

      instrumentKey:
        side.instrumentKey,

      optionType,

      strike:
        row.strike,

      signal:
        "BUY",

      direction,

      entry:
        round(entry),

      stopLoss:
        round(stopLoss),

      targets: [
        round(target1),
        round(target2),
        round(target3)
      ],

      rr: 3.5,

      confidence:
        confidenceData.confidence,

      status:
        confidenceData.confidence >=
        75
          ? "CONFIRMED"
          : "SETUP",

      invalidation:
        `Option price below ${round(
          stopLoss
        )}`,

      generatedAt:
        nowISO()
    });
  }

  return trades
    .filter(t => Number(t?.confidence || 0) > 60)
    .slice(0, 3);
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
      market.price
    );

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

  const trades =
    createOptionTrades(
      index,
      market,
      movement,
      confidenceData,
      optionRows
    );

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

    options: {
      expiry,

      summary:
        optionSummary,

      rows:
        optionRows
    },

    signal,

    confidence:
      confidenceData.confidence,

    reasons:
      confidenceData.reasons,

    risks:
      confidenceData.risks,

    suggestion:
      confidenceData.suggestion,

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
// TRADE ALERT
// ============================================================

async function notifyTrade(
  trade
) {
  if (!state.settings.notifications?.tradeSetup) {
    return;
  }

  const fingerprint =
    tradeFingerprint(
      trade
    );

  const existing =
    state.alerts.find(
      alert =>
        alert.fingerprint ===
        fingerprint
    );

  const cooldownMs = Number(state.settings.notificationCooldownMs || 900000);
  const lastSent = Number(state.notificationHistory[`trade:${fingerprint}`] || 0);
  if (lastSent && Date.now() - lastSent < cooldownMs) {
    return;
  }

  if (existing && existing.confidence === trade.confidence && lastSent) {
    return;
  }

  state.notificationHistory[`trade:${fingerprint}`] = Date.now();

  const alert = {
    id:
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,

    type:
      "TRADE",

    fingerprint,

    trade,

    confidence:
      trade.confidence,

    createdAt:
      nowISO()
  };

  state.alerts.unshift(
    alert
  );

  state.alerts =
    state.alerts.slice(
      0,
      100
    );

  saveState();

  await sendPush({
    title:
      `Era AI — ${trade.index}`,

    body:
      `${trade.optionType} ${trade.strike} | ${trade.signal} | Confidence ${trade.confidence}%`,

    data:
      trade
  });
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

async function fetchNews() {
  try {
    const query =
      encodeURIComponent(
        "Nifty BankNifty Sensex stock market India"
      );

    const url =
      `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`;

    const response =
      await axios.get(
        url,
        {
          timeout: 20000
        }
      );

    const xml =
      response.data || "";

    const items =
      xml.match(
        /<item>[\s\S]*?<\/item>/g
      ) || [];

    const news =
      items
        .slice(0, 20)
        .map(
          item => {
            const title =
              (
                item.match(
                  /<title>([\s\S]*?)<\/title>/
                ) || []
              )[1];

            const link =
              (
                item.match(
                  /<link>([\s\S]*?)<\/link>/
                ) || []
              )[1];

            const pubDate =
              (
                item.match(
                  /<pubDate>([\s\S]*?)<\/pubDate>/
                ) || []
              )[1];

            return {
              title:
                title
                  ? title
                      .replace(
                        /<!\[CDATA\[/g,
                        ""
                      )
                      .replace(
                        /\]\]>/g,
                        ""
                      )
                      .trim()
                  : "",

              link:
                link
                  ? link.trim()
                  : "",

              pubDate:
                pubDate
                  ? pubDate.trim()
                  : ""
            };
          }
        )
        .filter(
          item =>
            item.title
        );

    state.news =
      news;

    state.lastNewsFetch =
      nowISO();

    return news;

  } catch (error) {
    console.error(
      "[ERA] News error:",
      error.message
    );

    return state.news;
  }
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

// ============================================================
// AI CHAT
// ============================================================

app.post(
  "/api/chat",
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
        confidence: x.confidence, status: x.status
      })) : [];
      const compactContext = {
        index,
        market: {
          name: m.name, price: m.price, previousClose: m.previousClose,
          change: m.change, changePercent: m.changePercent, open: m.open,
          high: m.high, low: m.low, volume: m.volume, timestamp: m.timestamp,
          source: m.source, stale: m.stale
        },
        analysis: {
          direction: a.direction, movement: a.movement, confidence: a.confidence,
          suggestion: a.suggestion, reasons: Array.isArray(a.reasons) ? a.reasons.slice(0, 5) : [],
          risks: Array.isArray(a.risks) ? a.risks.slice(0, 5) : [],
          technical: {
            emaTrend: t.emaTrend, rsi: t.rsi, vwap: t.vwap,
            structure: t.structure?.label || t.structure,
            bos: t.bos, choch: t.choch
          },
          options: {
            pcr: o.pcr, sentiment: o.sentiment,
            callOI: o.callOI, putOI: o.putOI
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
// ERA V8.2 FEATURE APIs
// ============================================================

function apiError(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error.message) return String(error.message);
  if (error.error?.message) return String(error.error.message);
  try { return JSON.stringify(error); } catch (_) { return String(error); }
}

function currentUserKey(req) {
  const raw = String(req.headers["x-era-user"] || "guest").trim().toLowerCase();
  return raw.slice(0, 180) || "guest";
}

function riskCheck(trade) {
  const r = state.risk;
  if (r.killSwitch) return { ok: false, reason: "ERA risk kill switch is ON." };
  if ((state.paper.positions || []).length >= Number(r.maxPositions || 3)) return { ok: false, reason: "Maximum open paper positions reached." };
  const entry = Number(trade.entry || 0), stop = Number(trade.stopLoss || 0);
  if (!entry || !stop || entry <= stop) return { ok: false, reason: "Invalid entry/stop values." };
  const lossPct = ((entry - stop) / entry) * 100;
  if (lossPct > Number(r.maxTradeLoss || 1) * 2) return { ok: false, reason: "Trade risk exceeds configured limit." };
  return { ok: true, reason: "Risk checks passed." };
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

app.get("/api/risk", (req,res)=>res.json({ok:true,risk:state.risk,killSwitch:Boolean(state.risk.killSwitch),updatedAt:nowISO()}));
app.post("/api/risk", (req,res)=>{
  try {
    const b=req.body||{};
    for (const k of ["riskPerTrade","maxDailyLoss","maxTradeLoss","maxPositions","maxTradesPerDay","maxExposure"]) {
      if (b[k] !== undefined && Number.isFinite(Number(b[k])) && Number(b[k]) > 0) state.risk[k]=Number(b[k]);
    }
    if (b.killSwitch !== undefined) state.risk.killSwitch=Boolean(b.killSwitch);
    saveState(); res.json({ok:true,risk:state.risk});
  } catch(error){res.status(400).json({ok:false,error:apiError(error)});}
});

app.get("/api/paper", (req,res)=>res.json({ok:true,paper:state.paper,risk:state.risk,updatedAt:nowISO()}));
app.post("/api/paper/refresh", async (req,res)=>{
  try {
    const positions=Array.isArray(state.paper.positions)?state.paper.positions:[];
    const keys=[...new Set(positions.map(p=>p.instrumentKey).filter(Boolean))];
    let quotes={};
    if(keys.length){
      const data=(await upstoxRequest("https://api.upstox.com/v3/market-quote/quotes",{instrument_key:keys.join(",")})).data||{};
      quotes=data;
    }
    let unrealized=0;
    for(const p of positions){
      let current=Number(p.currentPrice||p.entry||0);
      const raw=quotes[p.instrumentKey];
      const ltp=Number(raw?.ltpc?.ltp ?? raw?.last_price ?? raw?.ltp ?? 0);
      if(ltp>0) current=ltp;
      p.currentPrice=current;
      p.unrealizedPnl=(current-Number(p.entry||0))*Number(p.quantity||0);
      unrealized+=p.unrealizedPnl;
      if(p.stopLoss && current<=Number(p.stopLoss)) p.status="STOP_RISK";
      else if(p.target && current>=Number(p.target)) p.status="TARGET_REACHED";
      else p.status="OPEN";
    }
    state.paper.unrealizedPnl=unrealized;
    saveState();
    res.json({ok:true,paper:state.paper,risk:state.risk,updatedAt:nowISO()});
  } catch(error){
    console.error("[ERA] Paper refresh:",error.response?.data||error.message);
    res.status(500).json({ok:false,error:apiError(error)});
  }
});

app.get('/api/paper-trading', (req,res)=>res.json({ok:true,paper:state.paper,risk:state.risk,updatedAt:nowISO()}));

app.post("/api/paper/reset", (req,res)=>{
  state.paper={startingCapital:100000,cash:100000,positions:[],orders:[],realizedPnl:0};
  saveState(); res.json({ok:true,paper:state.paper});
});
app.post("/api/paper/order", (req,res)=>{
  try {
    const b=req.body||{};
    const side=String(b.side||"BUY").toUpperCase()==="SELL"?"SELL":"BUY";
    const qty=Math.max(1,Math.floor(Number(b.quantity||1)));
    const price=Number(b.price||b.entry||0);
    if (!price || price<=0) return res.status(400).json({ok:false,error:"Valid order price is required."});
    if (state.risk.killSwitch) return res.status(403).json({ok:false,error:"ERA risk kill switch is ON."});
    const value=price*qty;
    if (side==="BUY" && value>state.paper.cash) return res.status(400).json({ok:false,error:"Insufficient paper cash."});
    const positionKey=[b.index,b.optionType,b.strike,b.instrumentKey].join("|");
    if (side==="BUY") {
      state.paper.cash-=value;
      state.paper.positions.push({id:`P${Date.now()}`,index:b.index||"NIFTY",optionType:b.optionType||"",strike:Number(b.strike||0),instrumentKey:b.instrumentKey||null,quantity:qty,entry:price,currentPrice:price,stopLoss:Number(b.stopLoss||0),target:Number(b.target||0),openedAt:nowISO()});
    } else {
      const pos=state.paper.positions.find(p=>[p.index,p.optionType,p.strike,p.instrumentKey].join("|")===positionKey);
      if (!pos) return res.status(400).json({ok:false,error:"Matching paper position not found."});
      const closeQty=Math.min(qty,pos.quantity); const pnl=(price-pos.entry)*closeQty; state.paper.cash+=price*closeQty; state.paper.realizedPnl+=pnl; pos.quantity-=closeQty; if(pos.quantity<=0) state.paper.positions=state.paper.positions.filter(x=>x.id!==pos.id);
    }
    const order={id:`O${Date.now()}`,side,index:b.index||"NIFTY",optionType:b.optionType||"",strike:Number(b.strike||0),quantity:qty,price,createdAt:nowISO()};
    state.paper.orders.unshift(order); state.paper.orders=state.paper.orders.slice(0,200); saveState();
    res.json({ok:true,order,paper:state.paper});
  } catch(error){res.status(400).json({ok:false,error:apiError(error)});}
});

app.post("/api/paper/mark", (req,res)=>{
  try {
    for (const p of state.paper.positions) {
      const m=state.market[p.index];
      if (p.instrumentKey && Number.isFinite(Number(req.body?.prices?.[p.instrumentKey]))) p.currentPrice=Number(req.body.prices[p.instrumentKey]);
      else if (p.optionLtp !== undefined) p.currentPrice=Number(p.optionLtp);
      if (p.stopLoss && p.currentPrice<=p.stopLoss) p.status="STOP_RISK";
      else if (p.target && p.currentPrice>=p.target) p.status="TARGET_REACHED";
      else p.status="OPEN";
    }
    saveState(); res.json({ok:true,paper:state.paper});
  } catch(error){res.status(400).json({ok:false,error:apiError(error)});}
});

app.get("/api/journal", (req,res)=>res.json({ok:true,journal:state.journal.slice(0,500)}));
app.post("/api/journal", (req,res)=>{
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

app.post("/api/backtest", async (req,res)=>{
  try {
    const index=normalizeIndex(req.body?.index||"NIFTY"); const interval=Math.max(1,Math.min(60,Number(req.body?.interval||5)));
    if(!INDICES[index]) return res.status(400).json({ok:false,error:"Invalid index"});
    let candles=await fetchHistoricalCandles(index,interval); if(candles.length<30) candles=await fetchIntradayCandles(index,interval);
    if(candles.length<30) return res.status(400).json({ok:false,error:"Not enough candle data for backtest."});
    const closes=candles.map(c=>Number(c[4])); const trades=[]; let equity=Number(req.body?.capital||100000), peak=equity, maxDD=0;
    for(let i=25;i<candles.length-1;i++){
      const ema9=ema(closes.slice(0,i+1),9), ema20=ema(closes.slice(0,i+1),20), r=rsi(closes.slice(0,i+1),14); if(ema9===null||ema20===null||r===null) continue;
      const up=ema9>ema20 && r>=52, down=ema9<ema20 && r<=48; if(!up&&!down) continue;
      const entry=closes[i], exit=closes[i+1], pnl=up?exit-entry:entry-exit; equity+=pnl; peak=Math.max(peak,equity); maxDD=Math.max(maxDD,peak-equity); trades.push({time:candles[i][0],side:up?"BUY":"SELL",entry,exit,pnl});
    }
    const wins=trades.filter(t=>t.pnl>0), losses=trades.filter(t=>t.pnl<=0); const grossWin=wins.reduce((s,t)=>s+t.pnl,0), grossLoss=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
    res.json({ok:true,index,interval,capital:Number(req.body?.capital||100000),endingCapital:round(equity),netPnl:round(equity-Number(req.body?.capital||100000)),trades:trades.length,winRate:trades.length?round(wins.length/trades.length*100):0,maxDrawdown:round(maxDD),profitFactor:grossLoss?round(grossWin/grossLoss):null,history:trades.slice(-100),dataWindow:trades.length?{from:trades[0].time,to:trades[trades.length-1].time}:null,updatedAt:nowISO()});
  } catch(error){res.status(500).json({ok:false,error:apiError(error)});}
});

app.get("/api/alerts", (req,res)=>res.json({ok:true,alerts:state.alerts.slice(0,200),updatedAt:nowISO()}));
app.post("/api/alerts", (req,res)=>{
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
// SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Era AI ${VERSION} running on port ${PORT}`
    );
  }
);
