require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const webpush = require("web-push");
const UpstoxClient = require("upstox-js-sdk");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const UPSTOX_BASE = "https://api.upstox.com/v2";
const UPSTOX_V3 = "https://api.upstox.com/v3";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/* =========================================================
   INSTRUMENT KEYS
========================================================= */

const NIFTY_KEY = "NSE_INDEX|Nifty 50";
const BANKNIFTY_KEY = "NSE_INDEX|Nifty Bank";
const FINNIFTY_KEY = "NSE_INDEX|Nifty Fin Service";
const SENSEX_KEY = "BSE_INDEX|SENSEX";

const VIX_KEY = "NSE_INDEX|India VIX";
const GIFT_KEY = "GLOBAL_INDEX|SGX NIFTY";

const OPTION_UNDERLYINGS = [
  { name: "NIFTY", key: NIFTY_KEY, strikeStep: 50 },
  { name: "BANKNIFTY", key: BANKNIFTY_KEY, strikeStep: 100 },
  { name: "FINNIFTY", key: FINNIFTY_KEY, strikeStep: 50 },
  { name: "SENSEX", key: SENSEX_KEY, strikeStep: 100 }
];

/* =========================================================
   CONFIG
========================================================= */

const CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD || 50);
const MOVEMENT_TRIGGER = Number(process.env.OPTION_MOVEMENT_TRIGGER || 20);
const MONITOR_INTERVAL = Number(process.env.MONITOR_INTERVAL_MS || 20000);
const ALERT_COOLDOWN = Number(process.env.ALERT_COOLDOWN_MS || 180000);
const MAX_RELEVANT_STRIKES = Number(process.env.MAX_RELEVANT_STRIKES || 10);

/* =========================================================
   STATE
========================================================= */

const optionContracts = new Map();
const liveOptionData = new Map();
const optionSnapshots = new Map();

const alerts = [];
const activeTrades = new Map();
const pushSubscriptions = new Map();

let latestTomorrowPlan = null;
let monitorTimer = null;
let monitorRunning = false;
let monitorBusy = false;

let lastMonitorAt = null;
let lastMarketOpenNotification = null;
let lastMarketCloseAnalysis = null;
let lastMarketDate = null;

/* =========================================================
   PUSH / VAPID
========================================================= */

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:era-ai@example.com";

const PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log("Era AI Push: ENABLED");
} else {
  console.log("Era AI Push: DISABLED - VAPID keys missing");
}

/* =========================================================
   UPSTOX AUTH & HEADERS
========================================================= */

function authHeaders() {
  if (!process.env.UPSTOX_ACCESS_TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is missing");
  }

  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`
  };
}

/* =========================================================
   TIME HELPERS (INDIA)
========================================================= */

function indiaParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date());

  const result = {};
  for (const p of parts) {
    result[p.type] = p.value;
  }
  return result;
}

function getIndiaDate() {
  const p = indiaParts();
  return `${p.year}-${p.month}-${p.day}`;
}

function indiaMinutes() {
  const p = indiaParts();
  return Number(p.hour) * 60 + Number(p.minute);
}

function isWeekday() {
  const day = indiaParts().weekday;
  return day !== "Sat" && day !== "Sun";
}

function isMarketOpen() {
  if (!isWeekday()) return false;
  const m = indiaMinutes();
  return m >= 555 && m <= 930;
}

/* =========================================================
   PUSH NOTIFICATION LOGIC
========================================================= */

async function sendPushNotification({ title, body, type = "ERA", data = {} }) {
  if (!PUSH_ENABLED) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  const payload = JSON.stringify({
    title,
    body,
    type,
    data,
    timestamp: new Date().toISOString()
  });

  for (const [id, subscription] of pushSubscriptions.entries()) {
    try {
      await webpush.sendNotification(subscription, payload);
      sent++;
    } catch (error) {
      failed++;
      if (error.statusCode === 404 || error.statusCode === 410) {
        pushSubscriptions.delete(id);
      }
      console.error("Push error:", error.message);
    }
  }

  return { sent, failed };
}

app.get("/api/push/public-key", (req, res) => {
  res.json({
    success: true,
    enabled: PUSH_ENABLED,
    publicKey: VAPID_PUBLIC_KEY || null
  });
});

app.post("/api/push/subscribe", (req, res) => {
  try {
    const subscription = req.body?.subscription || req.body;
    if (!subscription?.endpoint) {
      return res.status(400).json({ success: false, error: "Invalid subscription" });
    }
    const id = Buffer.from(subscription.endpoint).toString("base64url");
    pushSubscriptions.set(id, subscription);
    res.json({ success: true, subscribed: true, total: pushSubscriptions.size });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/* =========================================================
   MARKET QUOTE API
========================================================= */

function findQuote(data, key) {
  if (!data) return {};
  if (data[key]) return data[key];
  const short = key.split("|")[1];
  for (const k of Object.keys(data)) {
    if (k.includes(short)) return data[k];
  }
  return {};
}

function normalizeQuote(q) {
  const ohlc = q?.ohlc || {};
  return {
    lastPrice: q?.last_price ?? null,
    netChange: q?.net_change ?? null,
    previousClose: q?.prev_close_price ?? ohlc.close ?? null,
    open: q?.open ?? ohlc.open ?? null,
    high: q?.high ?? ohlc.high ?? null,
    low: q?.low ?? ohlc.low ?? null,
    close: q?.close ?? ohlc.close ?? null,
    volume: q?.volume ?? ohlc.volume ?? null
  };
}

async function getLiveMarketData() {
  try {
    const instruments = [
      NIFTY_KEY,
      BANKNIFTY_KEY,
      FINNIFTY_KEY,
      SENSEX_KEY,
      VIX_KEY,
      GIFT_KEY
    ].join(",");

    const response = await axios.get(`${UPSTOX_BASE}/market-quote/quotes`, {
      params: { instrument_key: instruments },
      headers: authHeaders(),
      timeout: 15000
    });

    const data = response.data?.data || {};

    return {
      success: true,
      timestamp: new Date().toISOString(),
      nifty: normalizeQuote(findQuote(data, NIFTY_KEY)),
      banknifty: normalizeQuote(findQuote(data, BANKNIFTY_KEY)),
      finnifty: normalizeQuote(findQuote(data, FINNIFTY_KEY)),
      sensex: normalizeQuote(findQuote(data, SENSEX_KEY)),
      indiaVix: normalizeQuote(findQuote(data, VIX_KEY)),
      giftNifty: normalizeQuote(findQuote(data, GIFT_KEY))
    };
  } catch (error) {
    console.error("Market data error:", error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

app.get("/api/market", async (req, res) => {
  const data = await getLiveMarketData();
  if (!data.success) return res.status(500).json(data);
  res.json(data);
});

/* =========================================================
   CANDLES & INDICATORS
========================================================= */

function parseCandles(candles) {
  return candles
    .map(c => ({
      timestamp: c[0],
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5] || 0),
      oi: Number(c[6] || 0)
    }))
    .filter(c => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close))
    .reverse();
}

async function getIntradayCandles(instrumentKey, interval = 5) {
  try {
    const encoded = encodeURIComponent(instrumentKey);
    const response = await axios.get(
      `${UPSTOX_V3}/historical-candle/intraday/${encoded}/minutes/${interval}`,
      { headers: authHeaders(), timeout: 15000 }
    );
    return parseCandles(response.data?.data?.candles || []);
  } catch (error) {
    console.error("Intraday candle error:", error.message);
    return [];
  }
}

function calculateEMA(values, period) {
  if (!values || values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }
  return Number(ema.toFixed(2));
}

function calculateRSI(values, period = 14) {
  if (!values || values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

async function getTechnicalAnalysis(instrumentKey) {
  try {
    const candles = await getIntradayCandles(instrumentKey, 5);
    if (candles.length < 20) {
      return { success: false, status: "INSUFFICIENT_DATA" };
    }
    const closes = candles.map(c => c.close);
    const current = closes[closes.length - 1];
    const ema9 = calculateEMA(closes, 9);
    const ema20 = calculateEMA(closes, 20);
    const rsi = calculateRSI(closes, 14);

    let trend = "SIDEWAYS";
    if (ema9 && ema20) {
      if (current > ema9 && ema9 > ema20) trend = "BULLISH";
      else if (current < ema9 && ema9 < ema20) trend = "BEARISH";
    }

    return {
      success: true,
      instrumentKey,
      current,
      ema9,
      ema20,
      rsi,
      trend
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/* =========================================================
   OPENROUTER AI INTEGRATION
========================================================= */

async function generateAIAnalysis(promptText) {
  if (!process.env.OPENROUTER_API_KEY) {
    return "AI Key is missing in .env configuration.";
  }

  try {
    const res = await axios.post(
      OPENROUTER_URL,
      {
        model: process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
        messages: [{ role: "user", content: promptText }]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    return res.data?.choices?.[0]?.message?.content || "No analysis generated.";
  } catch (error) {
    console.error("OpenRouter Error:", error.response?.data || error.message);
    return "Error executing AI Analysis.";
  }
}

app.post("/api/ai/analyze", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ success: false, error: "Prompt is required" });

  const aiResult = await generateAIAnalysis(prompt);
  res.json({ success: true, analysis: aiResult });
});

/* =========================================================
   OPTIONS CONTRACTS API
========================================================= */

app.get("/api/options/contracts", async (req, res) => {
  try {
    const instrumentKey = req.query.instrument_key || NIFTY_KEY;
    const response = await axios.get(`${UPSTOX_BASE}/option/contract`, {
      params: { instrument_key: instrumentKey },
      headers: authHeaders(),
      timeout: 20000
    });

    res.json({
      success: true,
      data: response.data?.data || []
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

/* =========================================================
   MONITORING ENGINE & SERVER SETUP
========================================================= */

async function runMonitoringTask() {
  if (monitorBusy) return;
  monitorBusy = true;

  try {
    lastMonitorAt = new Date().toISOString();
    if (isMarketOpen()) {
      // Execute live monitoring steps
    }
  } catch (err) {
    console.error("Monitor execution error:", err.message);
  } finally {
    monitorBusy = false;
  }
}

function startMonitorLoop() {
  if (monitorRunning) return;
  monitorRunning = true;
  monitorTimer = setInterval(runMonitoringTask, MONITOR_INTERVAL);
  console.log(`Era AI Background Monitor Started (${MONITOR_INTERVAL}ms loop)`);
}

// Default Health Route
app.get("/", (req, res) => {
  res.json({
    status: "Era AI Engine Online",
    marketOpen: isMarketOpen(),
    time: new Date().toISOString()
  });
});

// Server Initialization
app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`Era AI Server running on port ${PORT}`);
  console.log(`=================================`);
  startMonitorLoop();
});
