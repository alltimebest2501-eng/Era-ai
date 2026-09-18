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
const VERSION = "6.0.0";

app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* =========================================================
   ERA AI V6
   Autonomous Indian Market + Options Intelligence Backend
   ========================================================= */

const BACKEND_URL =
  process.env.BACKEND_URL || "https://era-ai.onrender.com";

const UPSTOX_ACCESS_TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || "mailto:admin@era-ai.app";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

/* =========================================================
   INDEX CONFIGURATION
   ========================================================= */

const INDICES = {
  NIFTY: {
    symbol: "NSE_INDEX|Nifty 50",
    name: "NIFTY",
    exchange: "NSE",
    lotSize: 65
  },

  BANKNIFTY: {
    symbol: "NSE_INDEX|Nifty Bank",
    name: "BANKNIFTY",
    exchange: "NSE",
    lotSize: 30
  },

  FINNIFTY: {
    symbol: "NSE_INDEX|Nifty Fin Service",
    name: "FINNIFTY",
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

/* =========================================================
   RUNTIME STATE
   ========================================================= */

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

  settings: {
    movementThreshold: 20,
    minConfidence: 55,
    scanIntervalMs: 60000,
    newsIntervalMs: 300000
  }
};

/* =========================================================
   FILE STORAGE
   ========================================================= */

const DATA_DIR = path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DATA_FILE = path.join(DATA_DIR, "era-state.json");

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;

    const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    if (Array.isArray(saved.pushSubscriptions)) {
      state.pushSubscriptions = saved.pushSubscriptions;
    }

    if (Array.isArray(saved.history)) {
      state.history = saved.history.slice(-500);
    }

    if (Array.isArray(saved.alerts)) {
      state.alerts = saved.alerts.slice(-300);
    }
  } catch (error) {
    console.error("State load error:", error.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        {
          pushSubscriptions: state.pushSubscriptions,
          history: state.history,
          alerts: state.alerts
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error("State save error:", error.message);
  }
}

loadState();

/* =========================================================
   UPSTOX REQUEST
   ========================================================= */

async function upstoxRequest(url, params = {}) {
  if (!UPSTOX_ACCESS_TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is not configured");
  }

  const response = await axios.get(url, {
    params,
    timeout: 15000,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}`
    }
  });

  return response.data;
}

/* =========================================================
   HELPERS
   ========================================================= */

function round(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }

  const multiplier = 10 ** decimals;
  return Math.round(Number(value) * multiplier) / multiplier;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nowISO() {
  return new Date().toISOString();
}

function isMarketHours() {
  const now = new Date();

  const india = new Date(
    now.toLocaleString("en-US", {
      timeZone: "Asia/Kolkata"
    })
  );

  const day = india.getDay();

  if (day === 0 || day === 6) return false;

  const minutes = india.getHours() * 60 + india.getMinutes();

  return minutes >= 555 && minutes <= 930;
}

function normalizeIndex(index) {
  const key = String(index || "NIFTY")
    .trim()
    .toUpperCase();

  return INDICES[key] ? key : "NIFTY";
}

/* =========================================================
   MARKET QUOTE NORMALIZATION
   ========================================================= */

function normalizeQuote(index, raw) {
  if (!raw) {
    return {
      index,
      available: false,
      error: "No quote data"
    };
  }

  const ltp =
    raw.last_price ??
    raw.ltp ??
    raw.last_traded_price ??
    raw.close_price ??
    0;

  const netChange =
    raw.net_change ??
    raw.netChange ??
    raw.change ??
    0;

  let previousClose =
    raw.prev_close_price ??
    raw.previous_close ??
    raw.previousClose ??
    null;

  if (
    (previousClose === null ||
      previousClose === undefined ||
      safeNumber(previousClose) === 0) &&
    safeNumber(netChange) !== 0
  ) {
    previousClose = safeNumber(ltp) - safeNumber(netChange);
  }

  const change = safeNumber(netChange);

  const changePercent =
    previousClose && safeNumber(previousClose) !== 0
      ? (change / safeNumber(previousClose)) * 100
      : 0;

  return {
    index,
    available: true,
    price: round(ltp),
    previousClose: round(previousClose),
    change: round(change),
    changePercent: round(changePercent),
    open: round(
      raw.open ??
        raw.open_price ??
        raw.ohlc?.open
    ),
    high: round(
      raw.high ??
        raw.high_price ??
        raw.ohlc?.high
    ),
    low: round(
      raw.low ??
        raw.low_price ??
        raw.ohlc?.low
    ),
    close: round(
      raw.close ??
        raw.close_price ??
        raw.ohlc?.close ??
        ltp
    ),
    timestamp:
      raw.timestamp ||
      raw.last_trade_time ||
      nowISO()
  };
}

/* =========================================================
   LIVE MARKET DATA
   ========================================================= */

async function fetchQuotes() {
  const symbols = Object.entries(INDICES)
    .map(([key, config]) => `${key}:${config.symbol}`)
    .join(",");

  const url = "https://api.upstox.com/v2/market-quote/ltp";

  const response = await upstoxRequest(url, {
    instrument_key: Object.values(INDICES)
      .map((item) => item.symbol)
      .join(",")
  });

  const rawData = response.data || {};

  const result = {};

  for (const [index, config] of Object.entries(INDICES)) {
    let raw = null;

    const possibleKeys = [
      config.symbol,
      config.symbol.replace("|", ":"),
      index
    ];

    for (const key of possibleKeys) {
      if (rawData[key]) {
        raw = rawData[key];
        break;
      }
    }

    if (!raw) {
      const matching = Object.entries(rawData).find(
        ([key]) =>
          key.toUpperCase().includes(index) ||
          key === config.symbol
      );

      if (matching) {
        raw = matching[1];
      }
    }

    result[index] = normalizeQuote(index, raw);
  }

  return result;
}

/* =========================================================
   EXTRA MARKET DATA
   ========================================================= */

async function fetchExtraMarketData() {
  const result = {
    GIFT_NIFTY: null,
    INDIA_VIX: null
  };

  try {
    const response = await upstoxRequest(
      "https://api.upstox.com/v2/market-quote/ltp",
      {
        instrument_key: [
          EXTRA_SYMBOLS.GIFT_NIFTY,
          EXTRA_SYMBOLS.INDIA_VIX
        ].join(",")
      }
    );

    const data = response.data || {};

    const giftRaw =
      data[EXTRA_SYMBOLS.GIFT_NIFTY] ||
      data["GIFT_NIFTY"] ||
      null;

    const vixRaw =
      data[EXTRA_SYMBOLS.INDIA_VIX] ||
      data["INDIA_VIX"] ||
      null;

    if (giftRaw) {
      result.GIFT_NIFTY = normalizeQuote("GIFT_NIFTY", giftRaw);
    }

    if (vixRaw) {
      result.INDIA_VIX = normalizeQuote("INDIA_VIX", vixRaw);
    }
  } catch (error) {
    console.warn("Extra market data unavailable:", error.message);
  }

  return result;
}

/* =========================================================
   HISTORICAL CANDLES
   ========================================================= */

async function fetchCandles(index, interval = "5minute") {
  const config = INDICES[index];

  if (!config) {
    throw new Error(`Unsupported index: ${index}`);
  }

  const endDate = new Date();

  const startDate = new Date(
    endDate.getTime() - 3 * 24 * 60 * 60 * 1000
  );

  const from = startDate.toISOString().slice(0, 10);
  const to = endDate.toISOString().slice(0, 10);

  const url =
    `https://api.upstox.com/v3/historical-candle/` +
    `${encodeURIComponent(config.symbol)}/` +
    `${encodeURIComponent(interval)}/` +
    `${to}/` +
    `${from}`;

  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}`
      }
    });

    return response.data?.data?.candles || [];
  } catch (error) {
    console.error(
      `Candle error ${index}:`,
      error.response?.data || error.message
    );

    return [];
  }
}

/* =========================================================
   TECHNICAL INDICATORS
   ========================================================= */

function ema(values, period) {
  if (!values || values.length === 0) return null;

  const k = 2 / (period + 1);

  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (!values || values.length < period + 1) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    if (diff > 0) gains += diff;
    if (diff < 0) losses += Math.abs(diff);
  }

  if (losses === 0) return 100;

  const rs = gains / losses;

  return 100 - 100 / (1 + rs);
}

function calculateVWAP(candles) {
  if (!candles || !candles.length) return null;

  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (const candle of candles) {
    const high = safeNumber(candle[2]);
    const low = safeNumber(candle[3]);
    const close = safeNumber(candle[4]);
    const volume = safeNumber(candle[5]);

    const typical = (high + low + close) / 3;

    cumulativePV += typical * volume;
    cumulativeVolume += volume;
  }

  if (!cumulativeVolume) return null;

  return cumulativePV / cumulativeVolume;
}

function technicalAnalysis(candles, price) {
  if (!candles || candles.length < 10) {
    return {
      ema9: null,
      ema20: null,
      ema50: null,
      rsi: 50,
      vwap: null,
      support: null,
      resistance: null,
      trend: "NEUTRAL",
      structure: "INSUFFICIENT_DATA"
    };
  }

  const closes = candles.map((c) => safeNumber(c[4]));
  const highs = candles.map((c) => safeNumber(c[2]));
  const lows = candles.map((c) => safeNumber(c[3]));

  const ema9 = ema(closes, 9);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, Math.min(50, closes.length));

  const currentRSI = rsi(closes, 14);
  const vwap = calculateVWAP(candles);

  const recent = Math.min(20, candles.length);

  const support = Math.min(...lows.slice(-recent));
  const resistance = Math.max(...highs.slice(-recent));

  let trend = "NEUTRAL";

  if (
    ema9 &&
    ema20 &&
    ema50 &&
    price > ema9 &&
    ema9 > ema20 &&
    ema20 > ema50
  ) {
    trend = "BULLISH";
  } else if (
    ema9 &&
    ema20 &&
    ema50 &&
    price < ema9 &&
    ema9 < ema20 &&
    ema20 < ema50
  ) {
    trend = "BEARISH";
  }

  let structure = "RANGE";

  if (closes.length >= 6) {
    const last = closes.slice(-3);
    const previous = closes.slice(-6, -3);

    if (
      Math.min(...last) > Math.min(...previous) &&
      Math.max(...last) > Math.max(...previous)
    ) {
      structure = "HH_HL";
    } else if (
      Math.max(...last) < Math.max(...previous) &&
      Math.min(...last) < Math.min(...previous)
    ) {
      structure = "LH_LL";
    }
  }

  return {
    ema9: round(ema9),
    ema20: round(ema20),
    ema50: round(ema50),
    rsi: round(currentRSI),
    vwap: round(vwap),
    support: round(support),
    resistance: round(resistance),
    trend,
    structure
  };
}

/* =========================================================
   OPTION CONTRACTS
   ========================================================= */

async function fetchOptionContracts(index) {
  const config = INDICES[index];

  if (!config) {
    throw new Error("Unsupported index");
  }

  const url =
    "https://api.upstox.com/v2/option/contract";

  const response = await upstoxRequest(url, {
    instrument_key: config.symbol
  });

  return response.data || [];
}

/* =========================================================
   OPTION CHAIN
   ========================================================= */

async function fetchOptionChain(index, expiryDate = null) {
  const config = INDICES[index];

  if (!config) {
    throw new Error(`Unsupported index ${index}`);
  }

  const url =
    "https://api.upstox.com/v2/option/chain";

  const params = {
    instrument_key: config.symbol
  };

  if (expiryDate) {
    params.expiry_date = expiryDate;
  }

  const response = await upstoxRequest(url, params);

  return response.data || [];
}

/* =========================================================
   OPTION NORMALIZATION
   ========================================================= */

function normalizeOptionChain(rawChain, index) {
  const rows = [];

  for (const item of rawChain || []) {
    const strike =
      item.strike_price ??
      item.strikePrice ??
      item.strike;

    const call =
      item.call_options ??
      item.CE ??
      item.call ??
      {};

    const put =
      item.put_options ??
      item.PE ??
      item.put ??
      {};

    const ceMarket = call.market_data || call.marketData || call;
    const peMarket = put.market_data || put.marketData || put;

    rows.push({
      index,

      strikePrice: safeNumber(strike),

      CE: {
        instrumentKey:
          call.instrument_key ||
          call.instrumentKey ||
          null,

        ltp: round(
          ceMarket.ltp ??
          ceMarket.last_price ??
          0
        ),

        oi: safeNumber(
          ceMarket.oi ??
          ceMarket.open_interest ??
          0
        ),

        changeOi: safeNumber(
          ceMarket.change_in_oi ??
          ceMarket.changeOi ??
          0
        ),

        volume: safeNumber(
          ceMarket.volume ??
          0
        ),

        iv: round(
          ceMarket.iv ??
          ceMarket.implied_volatility ??
          0
        )
      },

      PE: {
        instrumentKey:
          put.instrument_key ||
          put.instrumentKey ||
          null,

        ltp: round(
          peMarket.ltp ??
          peMarket.last_price ??
          0
        ),

        oi: safeNumber(
          peMarket.oi ??
          peMarket.open_interest ??
          0
        ),

        changeOi: safeNumber(
          peMarket.change_in_oi ??
          peMarket.changeOi ??
          0
        ),

        volume: safeNumber(
          peMarket.volume ??
          0
        ),

        iv: round(
          peMarket.iv ??
          peMarket.implied_volatility ??
          0
        )
      }
    });
  }

  return rows
    .filter((row) => row.strikePrice > 0)
    .sort((a, b) => a.strikePrice - b.strikePrice);
}

/* =========================================================
   OPTION SUMMARY
   ========================================================= */

function optionSummary(rows, spot) {
  if (!rows.length) {
    return {
      pcr: null,
      atmStrike: null,
      maxCallOI: null,
      maxPutOI: null
    };
  }

  const callsOI = rows.reduce(
    (sum, row) => sum + safeNumber(row.CE.oi),
    0
  );

  const putsOI = rows.reduce(
    (sum, row) => sum + safeNumber(row.PE.oi),
    0
  );

  const pcr =
    callsOI > 0 ? putsOI / callsOI : null;

  const atm = rows.reduce((closest, row) => {
    if (!closest) return row;

    return Math.abs(row.strikePrice - spot) <
      Math.abs(closest.strikePrice - spot)
      ? row
      : closest;
  }, null);

  const maxCall = rows.reduce(
    (best, row) =>
      !best || row.CE.oi > best.CE.oi ? row : best,
    null
  );

  const maxPut = rows.reduce(
    (best, row) =>
      !best || row.PE.oi > best.PE.oi ? row : best,
    null
  );

  let sentiment = "NEUTRAL";

  if (pcr >= 1.05) sentiment = "BULLISH";
  if (pcr <= 0.80) sentiment = "BEARISH";

  return {
    pcr: round(pcr, 3),
    sentiment,
    atmStrike: atm?.strikePrice || null,

    maxCallOI: maxCall
      ? {
          strike: maxCall.strikePrice,
          oi: maxCall.CE.oi
        }
      : null,

    maxPutOI: maxPut
      ? {
          strike: maxPut.strikePrice,
          oi: maxPut.PE.oi
        }
      : null
  };
}

/* =========================================================
   MOVEMENT ENGINE
   ========================================================= */

function movementFromPrevious(index, currentPrice) {
  const previous = state.previousPrices[index];

  if (!previous) {
    state.previousPrices[index] = currentPrice;

    return {
      points: 0,
      percent: 0,
      significant: false,
      direction: "NONE"
    };
  }

  const points = currentPrice - previous;
  const absPoints = Math.abs(points);

  const percent =
    previous !== 0
      ? (points / previous) * 100
      : 0;

  state.previousPrices[index] = currentPrice;

  return {
    points: round(points),
    percent: round(percent, 3),
    significant:
      absPoints >= state.settings.movementThreshold,
    direction:
      points > 0
        ? "UP"
        : points < 0
        ? "DOWN"
        : "FLAT"
  };
}

/* =========================================================
   CONFIDENCE ENGINE
   ========================================================= */

function calculateConfidence({
  direction,
  movement,
  technical,
  optionSummaryData
}) {
  let score = 50;

  const reasons = [];
  const risks = [];

  /* Movement */
  if (
    Math.abs(movement.points) >=
    state.settings.movementThreshold
  ) {
    score += 8;

    reasons.push(
      `${state.settings.movementThreshold}+ point movement detected`
    );
  } else {
    risks.push("20+ point movement not confirmed");
  }

  /* Trend */
  if (
    direction === "BUY" &&
    technical.trend === "BULLISH"
  ) {
    score += 10;
    reasons.push("Bullish EMA trend");
  }

  if (
    direction === "SELL" &&
    technical.trend === "BEARISH"
  ) {
    score += 10;
    reasons.push("Bearish EMA trend");
  }

  if (
    direction === "BUY" &&
    technical.trend === "BEARISH"
  ) {
    score -= 10;
    risks.push("Trend conflict");
  }

  if (
    direction === "SELL" &&
    technical.trend === "BULLISH"
  ) {
    score -= 10;
    risks.push("Trend conflict");
  }

  /* Structure */
  if (
    direction === "BUY" &&
    technical.structure === "HH_HL"
  ) {
    score += 8;
    reasons.push("Higher-high / higher-low structure");
  }

  if (
    direction === "SELL" &&
    technical.structure === "LH_LL"
  ) {
    score += 8;
    reasons.push("Lower-high / lower-low structure");
  }

  /* VWAP */
  if (technical.vwap) {
    if (
      direction === "BUY" &&
      state.market &&
      movement
    ) {
      reasons.push("VWAP available for confirmation");
      score += 3;
    }

    if (
      direction === "SELL"
    ) {
      reasons.push("VWAP available for confirmation");
      score += 3;
    }
  }

  /* RSI */
  if (direction === "BUY") {
    if (technical.rsi >= 50 && technical.rsi <= 70) {
      score += 6;
      reasons.push("RSI supports bullish momentum");
    }

    if (technical.rsi > 75) {
      score -= 4;
      risks.push("RSI overheated");
    }
  }

  if (direction === "SELL") {
    if (technical.rsi >= 30 && technical.rsi < 50) {
      score += 6;
      reasons.push("RSI supports bearish momentum");
    }

    if (technical.rsi < 25) {
      score -= 4;
      risks.push("RSI oversold");
    }
  }

  /* Options */
  if (optionSummaryData) {
    if (
      direction === "BUY" &&
      optionSummaryData.sentiment === "BULLISH"
    ) {
      score += 8;
      reasons.push("Options sentiment supportive");
    }

    if (
      direction === "SELL" &&
      optionSummaryData.sentiment === "BEARISH"
    ) {
      score += 8;
      reasons.push("Options sentiment supportive");
    }

    if (
      direction === "BUY" &&
      optionSummaryData.sentiment === "BEARISH"
    ) {
      score -= 6;
      risks.push("Options sentiment conflicts");
    }

    if (
      direction === "SELL" &&
      optionSummaryData.sentiment === "BULLISH"
    ) {
      score -= 6;
      risks.push("Options sentiment conflicts");
    }
  }

  score = Math.round(clamp(score, 20, 95));

  let suggestion = "WAIT";

  if (score >= 75) {
    suggestion = "TRADE CONSIDER";
  } else if (score >= 60) {
    suggestion = "WAIT FOR CONFIRMATION";
  } else {
    suggestion = "AVOID / NO TRADE";
  }

  return {
    score,
    reasons,
    risks,
    suggestion
  };
}

/* =========================================================
   STRIKE SELECTION
   ========================================================= */

function selectRelevantStrikes(rows, spot, count = 7) {
  if (!rows.length) return [];

  const sorted = [...rows].sort(
    (a, b) =>
      Math.abs(a.strikePrice - spot) -
      Math.abs(b.strikePrice - spot)
  );

  return sorted.slice(0, count);
}

/* =========================================================
   OPTION TRADE CREATION
   ========================================================= */

function buildOptionTrades(
  index,
  market,
  technical,
  rows,
  optionSummaryData,
  movement
) {
  if (!market?.available || !market.price) {
    return [];
  }

  const spot = market.price;

  const direction =
    movement.direction === "UP"
      ? "BUY"
      : movement.direction === "DOWN"
      ? "SELL"
      : null;

  if (!direction) return [];

  const strikes = selectRelevantStrikes(
    rows,
    spot,
    9
  );

  const trades = [];

  for (const row of strikes) {
    const optionType =
      direction === "BUY" ? "CE" : "PE";

    const option = row[optionType];

    if (!option || !option.ltp) {
      continue;
    }

    const confidence = calculateConfidence({
      direction,
      movement,
      technical,
      optionSummaryData
    });

    const entry = safeNumber(option.ltp);

    if (!entry) continue;

    const stopPercent =
      confidence.score >= 75
        ? 0.17
        : 0.20;

    const stopLoss = entry * (1 - stopPercent);

    const risk = entry - stopLoss;

    const t1 = entry + risk * 1.5;
    const t2 = entry + risk * 2.5;
    const t3 = entry + risk * 3.5;

    const trade = {
      id:
        `${index}-${row.strikePrice}-${optionType}-` +
        `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 7)}`,

      createdAt: nowISO(),

      index,

      strikePrice: row.strikePrice,

      optionType,

      signal: "BUY",

      underlyingDirection: direction,

      movement: {
        points: movement.points,
        percent: movement.percent,
        direction: movement.direction
      },

      entry: round(entry),
      stopLoss: round(stopLoss),

      targets: {
        T1: round(t1),
        T2: round(t2),
        T3: round(t3)
      },

      rr: 3.5,

      confidence: confidence.score,

      confidenceReasons: confidence.reasons,

      risks: confidence.risks,

      suggestion: confidence.suggestion,

      status:
        confidence.score >= 75
          ? "CONFIRMED"
          : "SETUP",

      invalidation:
        `Option price below ₹${round(stopLoss)}`,

      source: "ERA_AUTONOMOUS_SCANNER"
    };

    trades.push(trade);
  }

  /*
   * Keep all qualifying setups.
   * Do not return dozens of duplicate strikes.
   */
  return trades.filter(
    (trade) =>
      trade.confidence >=
      state.settings.minConfidence
  );
}

/* =========================================================
   ANALYSIS BUILDER
   ========================================================= */

async function analyzeIndex(index) {
  const market = state.market[index];

  if (!market?.available) {
    return {
      index,
      available: false,
      signal: "WAIT"
    };
  }

  const candles = await fetchCandles(index, "5minute");

  const technical = technicalAnalysis(
    candles,
    market.price
  );

  let optionRows = [];
  let optionSummaryData = null;

  try {
    const chain = await fetchOptionChain(index);

    optionRows = normalizeOptionChain(
      chain,
      index
    );

    optionSummaryData = optionSummary(
      optionRows,
      market.price
    );
  } catch (error) {
    console.warn(
      `Option chain unavailable ${index}:`,
      error.message
    );
  }

  const movement = movementFromPrevious(
    index,
    market.price
  );

  let signal = "WAIT";
  let direction = null;

  if (movement.significant) {
    if (movement.direction === "UP") {
      signal = "BUY";
      direction = "BUY";
    } else if (movement.direction === "DOWN") {
      signal = "SELL";
      direction = "SELL";
    }
  }

  const confidence = direction
    ? calculateConfidence({
        direction,
        movement,
        technical,
        optionSummaryData
      })
    : {
        score: 50,
        reasons: [
          "No 20+ point directional movement yet"
        ],
        risks: [],
        suggestion: "WAIT"
      };

  const trades =
    direction && optionRows.length
      ? buildOptionTrades(
          index,
          market,
          technical,
          optionRows,
          optionSummaryData,
          movement
        )
      : [];

  return {
    index,
    available: true,

    market,

    movement,

    technical,

    options: {
      summary: optionSummaryData,
      relevantStrikes: selectRelevantStrikes(
        optionRows,
        market.price,
        9
      )
    },

    signal,

    confidence: confidence.score,

    confidenceReasons: confidence.reasons,

    risks: confidence.risks,

    suggestion: confidence.suggestion,

    trades,

    generatedAt: nowISO()
  };
}

/* =========================================================
   ALERT DEDUPLICATION
   ========================================================= */

function tradeFingerprint(trade) {
  return [
    trade.index,
    trade.strikePrice,
    trade.optionType,
    trade.signal
  ].join("|");
}

function shouldAlertTrade(trade) {
  const fingerprint = tradeFingerprint(trade);

  const previous =
    state.previousSignals[fingerprint];

  const currentState = [
    trade.status,
    trade.confidence >= 75 ? "HIGH" : "NORMAL",
    trade.suggestion
  ].join("|");

  if (previous === currentState) {
    return false;
  }

  state.previousSignals[fingerprint] =
    currentState;

  return true;
}

/* =========================================================
   PUSH NOTIFICATIONS
   ========================================================= */

async function sendPushNotification(payload) {
  if (
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY
  ) {
    console.warn(
      "Push notification skipped: VAPID keys not configured"
    );

    return;
  }

  if (!state.pushSubscriptions.length) {
    return;
  }

  const message = JSON.stringify(payload);

  const expired = [];

  for (let i = 0; i < state.pushSubscriptions.length; i++) {
    const subscription =
      state.pushSubscriptions[i];

    try {
      await webpush.sendNotification(
        subscription,
        message
      );
    } catch (error) {
      if (
        error.statusCode === 404 ||
        error.statusCode === 410
      ) {
        expired.push(i);
      } else {
        console.error(
          "Push error:",
          error.message
        );
      }
    }
  }

  for (
    let i = expired.length - 1;
    i >= 0;
    i--
  ) {
    state.pushSubscriptions.splice(
      expired[i],
      1
    );
  }

  saveState();
}

async function notifyTrade(trade) {
  const title =
    `Era AI — ${trade.index} ${trade.strikePrice} ${trade.optionType}`;

  const body =
    `${trade.signal} | Entry ₹${trade.entry} | ` +
    `SL ₹${trade.stopLoss} | ` +
    `Confidence ${trade.confidence}% | ` +
    `${trade.suggestion}`;

  const payload = {
    type: "TRADE_ALERT",
    title,
    body,
    trade
  };

  state.alerts.push({
    id: trade.id,
    type: "TRADE_ALERT",
    createdAt: nowISO(),
    trade
  });

  state.alerts =
    state.alerts.slice(-300);

  saveState();

  await sendPushNotification(payload);
}

/* =========================================================
   MARKET MOVE ALERT
   ========================================================= */

async function notifyMarketMove(
  index,
  market,
  movement
) {
  if (!movement.significant) return;

  const fingerprint =
    `MOVE|${index}|${movement.direction}`;

  const previous =
    state.previousSignals[fingerprint];

  const bucket =
    Math.floor(
      Math.abs(movement.points) /
        state.settings.movementThreshold
    );

  const stateKey =
    `${movement.direction}|${bucket}`;

  if (previous === stateKey) return;

  state.previousSignals[fingerprint] =
    stateKey;

  await sendPushNotification({
    type: "MARKET_MOVE",
    title: `Era AI — ${index} Major Move`,
    body:
      `${movement.direction} ${Math.abs(
        movement.points
      )} points | Price ₹${market.price}`,
    index,
    market,
    movement,
    createdAt: nowISO()
  });
}

/* =========================================================
   MARKET OPEN/CLOSE DETECTION
   ========================================================= */

let previousMarketOpenState = null;

async function monitorMarketState() {
  const open = isMarketHours();

  if (
    previousMarketOpenState === null
  ) {
    previousMarketOpenState = open;
    return;
  }

  if (
    open &&
    !previousMarketOpenState
  ) {
    await sendPushNotification({
      type: "MARKET_OPEN",
      title: "Era AI — Market Open",
      body:
        "Indian market monitoring has started. Era Radar is scanning NIFTY, BANKNIFTY, FINNIFTY and SENSEX.",
      createdAt: nowISO()
    });
  }

  if (
    !open &&
    previousMarketOpenState
  ) {
    await sendPushNotification({
      type: "MARKET_CLOSE",
      title: "Era AI — Market Closed",
      body:
        "Market monitoring session completed. Era is preparing the next-day watchlist.",
      createdAt: nowISO()
    });
  }

  previousMarketOpenState = open;
}

/* =========================================================
   AUTONOMOUS SCANNER
   ========================================================= */

let scannerBusy = false;

async function runAutonomousScan() {
  if (scannerBusy) return;

  scannerBusy = true;

  try {
    await monitorMarketState();

    if (!isMarketHours()) {
      state.lastScan = nowISO();
      return;
    }

    console.log(
      `[ERA V6] Autonomous scan ${nowISO()}`
    );

    const quotes =
      await fetchQuotes();

    state.market = {
      ...state.market,
      ...quotes
    };

    try {
      const extra =
        await fetchExtraMarketData();

      state.market = {
        ...state.market,
        ...extra
      };
    } catch (_) {}

    const analyses = {};

    for (const index of Object.keys(INDICES)) {
      try {
        const analysis =
          await analyzeIndex(index);

        analyses[index] =
          analysis;

        state.analysis[index] =
          analysis;

        const market =
          state.market[index];

        if (market?.available) {
          await notifyMarketMove(
            index,
            market,
            analysis.movement
          );
        }

        for (
          const trade of analysis.trades || []
        ) {
          if (shouldAlertTrade(trade)) {
            state.activeTrades.push(
              trade
            );

            state.activeTrades =
              state.activeTrades.slice(-200);

            await notifyTrade(trade);
          }
        }
      } catch (error) {
        console.error(
          `Analysis error ${index}:`,
          error.message
        );
      }
    }

    state.lastScan = nowISO();
    state.lastSuccess = nowISO();
    state.lastError = null;

    return analyses;
  } catch (error) {
    state.lastError =
      error.response?.data ||
      error.message;

    console.error(
      "[ERA V6] Scanner error:",
      error.response?.data ||
        error.message
    );
  } finally {
    scannerBusy = false;
  }
}

/* =========================================================
   NEWS
   ========================================================= */

function decodeXml(value = "") {
  return value
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function fetchNews() {
  try {
    const url =
      "https://news.google.com/rss/search";

    const response =
      await axios.get(url, {
        params: {
          q:
            "Nifty OR BankNifty OR Sensex OR Indian stock market",
          hl: "en-IN",
          gl: "IN",
          ceid: "IN:en"
        },
        timeout: 15000
      });

    const xml = response.data || "";

    const items = [];

    const blocks =
      xml.match(/<item>[\s\S]*?<\/item>/g) ||
      [];

    for (const block of blocks.slice(0, 20)) {
      const title =
        block.match(
          /<title>([\s\S]*?)<\/title>/
        )?.[1] || "";

      const link =
        block.match(
          /<link>([\s\S]*?)<\/link>/
        )?.[1] || "";

      const pubDate =
        block.match(
          /<pubDate>([\s\S]*?)<\/pubDate>/
        )?.[1] || "";

      const source =
        block.match(
          /<source[^>]*>([\s\S]*?)<\/source>/
        )?.[1] || "";

      if (!title) continue;

      items.push({
        title: decodeXml(title),
        link: decodeXml(link),
        publishedAt: pubDate,
        source: decodeXml(source)
      });
    }

    state.news = items;
    state.lastNewsFetch = nowISO();

    return items;
  } catch (error) {
    console.error(
      "News error:",
      error.message
    );

    return state.news;
  }
}

/* =========================================================
   EXPRESS ROUTES
   ========================================================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Era AI",
    version: VERSION,
    upstoxConfigured:
      Boolean(UPSTOX_ACCESS_TOKEN),
    pushConfigured:
      Boolean(
        VAPID_PUBLIC_KEY &&
        VAPID_PRIVATE_KEY
      ),
    engineRunning:
      state.engineRunning,
    lastSuccess:
      state.lastSuccess,
    lastError:
      state.lastError,
    lastScan:
      state.lastScan,
    timestamp:
      nowISO()
  });
});

app.get("/", (req, res) => {
  res.json({
    service: "Era AI",
    version: VERSION,
    status: "online",
    engine:
      state.engineRunning
        ? "RUNNING"
        : "STOPPED"
  });
});

/* =========================================================
   MARKET
   ========================================================= */

app.get("/api/market", async (req, res) => {
  try {
    const quotes =
      await fetchQuotes();

    state.market = {
      ...state.market,
      ...quotes
    };

    res.json({
      success: true,
      market: state.market,
      timestamp: nowISO()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error.response?.data ||
        error.message,
      market: state.market
    });
  }
});

/* =========================================================
   ANALYSIS
   ========================================================= */

app.get("/api/analysis", async (req, res) => {
  const selectedIndex =
    normalizeIndex(req.query.index);

  try {
    const quotes =
      await fetchQuotes();

    state.market = {
      ...state.market,
      ...quotes
    };

    const analyses = {};

    for (const index of Object.keys(INDICES)) {
      try {
        analyses[index] =
          await analyzeIndex(index);
      } catch (error) {
        analyses[index] = {
          index,
          available: false,
          error: error.message
        };
      }
    }

    res.json({
      success: true,

      selectedIndex,

      market: {
        indices: state.market,

        giftNifty:
          state.market.GIFT_NIFTY,

        indiaVix:
          state.market.INDIA_VIX
      },

      analyses,

      selectedAnalysis:
        analyses[selectedIndex] || null,

      generatedAt: nowISO()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error.response?.data ||
        error.message
    });
  }
});

/* =========================================================
   OPTIONS — CONTRACTS
   ========================================================= */

app.get(
  "/api/options/contracts",
  async (req, res) => {
    const index =
      normalizeIndex(req.query.index);

    try {
      const contracts =
        await fetchOptionContracts(
          index
        );

      res.json({
        success: true,
        index,
        contracts,
        generatedAt: nowISO()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        index,
        error:
          error.response?.data ||
          error.message
      });
    }
  }
);

/* =========================================================
   OPTIONS — CHAIN
   ========================================================= */

app.get(
  "/api/options/chain",
  async (req, res) => {
    const index =
      normalizeIndex(req.query.index);

    const expiry =
      req.query.expiry || null;

    try {
      const chain =
        await fetchOptionChain(
          index,
          expiry
        );

      const market =
        state.market[index];

      const rows =
        normalizeOptionChain(
          chain,
          index
        );

      const summary =
        optionSummary(
          rows,
          market?.price || 0
        );

      res.json({
        success: true,
        index,
        expiry,
        spot:
          market?.price || null,
        summary,
        chain: rows,
        generatedAt: nowISO()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        index,
        error:
          error.response?.data ||
          error.message
      });
    }
  }
);

/* =========================================================
   OPTIONS — GREEKS
   ========================================================= */

app.get(
  "/api/options/greeks",
  async (req, res) => {
    const instrumentKey =
      req.query.instrument_key;

    if (!instrumentKey) {
      return res.status(400).json({
        success: false,
        error:
          "instrument_key is required"
      });
    }

    try {
      const data =
        await upstoxRequest(
          "https://api.upstox.com/v2/option/greeks",
          {
            instrument_key:
              instrumentKey
          }
        );

      res.json({
        success: true,
        data: data.data || []
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.response?.data ||
          error.message
      });
    }
  }
);

/* =========================================================
   NEWS
   ========================================================= */

app.get("/api/news", async (req, res) => {
  try {
    const news =
      await fetchNews();

    res.json({
      success: true,
      news,
      updatedAt:
        state.lastNewsFetch
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      news: state.news,
      error: error.message
    });
  }
});

/* =========================================================
   CHAT
   ========================================================= */

app.post("/api/chat", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({
      success: false,
      error:
        "OPENROUTER_API_KEY is not configured"
    });
  }

  const message =
    String(
      req.body?.message || ""
    ).trim();

  if (!message) {
    return res.status(400).json({
      success: false,
      error: "Message is required"
    });
  }

  try {
    const response =
      await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: OPENROUTER_MODEL,
          messages: [
            {
              role: "system",
              content:
                "You are Era AI, a professional Indian market analysis assistant. " +
                "Use the supplied market context. " +
                "Do not claim certainty or guaranteed profit. " +
                "Explain technical and options reasoning clearly."
            },
            {
              role: "user",
              content:
                JSON.stringify({
                  question: message,
                  market: state.market,
                  analysis: state.analysis
                })
            }
          ],
          temperature: 0.2
        },
        {
          timeout: 30000,
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

    const answer =
      response.data?.choices?.[0]
        ?.message?.content ||
      "Era could not generate a response.";

    res.json({
      success: true,
      answer
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error.response?.data ||
        error.message
    });
  }
});

/* =========================================================
   TTS — COMPATIBILITY ENDPOINT
   V6 UI DOES NOT USE VOICE OUTPUT
   ========================================================= */

app.post("/api/tts", async (req, res) => {
  res.status(410).json({
    success: false,
    disabled: true,
    message:
      "Voice output is disabled in Era AI V6."
  });
});

/* =========================================================
   SETTINGS
   ========================================================= */

app.get("/api/settings", (req, res) => {
  res.json({
    success: true,
    settings: state.settings
  });
});

app.post("/api/settings", (req, res) => {
  const body = req.body || {};

  if (body.movementThreshold !== undefined) {
    state.settings.movementThreshold =
      clamp(
        safeNumber(
          body.movementThreshold,
          20
        ),
        1,
        1000
      );
  }

  if (body.minConfidence !== undefined) {
    state.settings.minConfidence =
      clamp(
        safeNumber(
          body.minConfidence,
          55
        ),
        20,
        95
      );
  }

  res.json({
    success: true,
    settings: state.settings
  });
});

/* =========================================================
   HISTORY / JOURNAL
   ========================================================= */

app.get("/api/history", (req, res) => {
  res.json({
    success: true,
    history: state.history,
    activeTrades:
      state.activeTrades,
    alerts:
      state.alerts.slice(-100)
  });
});

app.post(
  "/api/history",
  (req, res) => {
    const trade =
      req.body?.trade;

    if (!trade) {
      return res.status(400).json({
        success: false,
        error: "trade is required"
      });
    }

    state.history.push({
      ...trade,
      recordedAt: nowISO()
    });

    state.history =
      state.history.slice(-500);

    saveState();

    res.json({
      success: true
    });
  }
);

/* =========================================================
   PUSH — PUBLIC KEY
   ========================================================= */

app.get(
  "/api/push/public-key",
  (req, res) => {
    res.json({
      success: true,
      publicKey:
        VAPID_PUBLIC_KEY || null
    });
  }
);

/* =========================================================
   PUSH — SUBSCRIBE
   ========================================================= */

app.post(
  "/api/subscribe",
  (req, res) => {
    const subscription =
      req.body?.subscription;

    if (
      !subscription ||
      !subscription.endpoint
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Valid push subscription is required"
      });
    }

    const exists =
      state.pushSubscriptions.some(
        (item) =>
          item.endpoint ===
          subscription.endpoint
      );

    if (!exists) {
      state.pushSubscriptions.push(
        subscription
      );

      state.pushSubscriptions =
        state.pushSubscriptions.slice(
          -1000
        );

      saveState();
    }

    res.json({
      success: true,
      subscribed: true
    });
  }
);

/* =========================================================
   PUSH — TEST
   ========================================================= */

app.post(
  "/api/push/test",
  async (req, res) => {
    try {
      await sendPushNotification({
        type: "TEST",
        title: "Era AI — Test Notification",
        body:
          "Push notifications are working.",
        createdAt: nowISO()
      });

      res.json({
        success: true,
        message:
          "Test notification sent"
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   ENGINE
   ========================================================= */

app.get("/api/engine", (req, res) => {
  res.json({
    success: true,
    running:
      state.engineRunning,
    lastScan:
      state.lastScan,
    lastSuccess:
      state.lastSuccess,
    lastError:
      state.lastError,
    activeTrades:
      state.activeTrades.length
  });
});

app.post(
  "/api/engine/start",
  (req, res) => {
    state.engineRunning = true;

    res.json({
      success: true,
      running: true
    });
  }
);

app.post(
  "/api/engine/stop",
  (req, res) => {
    state.engineRunning = false;

    res.json({
      success: true,
      running: false
    });
  }
);

/* =========================================================
   PRE-MARKET NEXT-DAY WATCHLIST
   ========================================================= */

async function sendPreMarketNotification() {
  const dateKey =
    new Date()
      .toLocaleDateString(
        "en-IN",
        {
          timeZone: "Asia/Kolkata"
        }
      );

  const fingerprint =
    `PREMARKET|${dateKey}`;

  if (
    state.previousSignals[
      fingerprint
    ]
  ) {
    return;
  }

  state.previousSignals[
    fingerprint
  ] = "SENT";

  const summary =
    Object.values(
      state.analysis
    )
      .slice(0, 4)
      .map(
        (item) =>
          `${item.index}: ${item.signal || "WAIT"}`
      )
      .join(" | ");

  await sendPushNotification({
    type: "PRE_MARKET",
    title:
      "Era AI — Next Day Watchlist",
    body:
      summary ||
      "Era is preparing the next market setup.",
    createdAt: nowISO()
  });
}

/* =========================================================
   PERIODIC WORKERS
   ========================================================= */

setInterval(
  async () => {
    if (!state.engineRunning) {
      return;
    }

    await runAutonomousScan();
  },
  state.settings.scanIntervalMs
);

setInterval(
  async () => {
    await fetchNews();
  },
  state.settings.newsIntervalMs
);

/*
 * Pre-market check.
 * This worker runs every 5 minutes.
 */
setInterval(
  async () => {
    const now = new Date();

    const india =
      new Date(
        now.toLocaleString(
          "en-US",
          {
            timeZone:
              "Asia/Kolkata"
          }
        )
      );

    const day =
      india.getDay();

    if (
      day === 0 ||
      day === 6
    ) {
      return;
    }

    const minutes =
      india.getHours() * 60 +
      india.getMinutes();

    /*
     * Around 09:00–09:15 IST
     */
    if (
      minutes >= 540 &&
      minutes < 555
    ) {
      await sendPreMarketNotification();
    }
  },
  5 * 60 * 1000
);

/* =========================================================
   INITIALIZATION
   ========================================================= */

async function initializeEra() {
  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    `       ERA AI V${VERSION}`
  );
  console.log(
    "  Autonomous Market Intelligence Engine"
  );
  console.log(
    "=========================================="
  );
  console.log("");

  console.log(
    "Supported indices:",
    Object.keys(INDICES).join(", ")
  );

  console.log(
    "20+ movement filter:",
    state.settings.movementThreshold
  );

  console.log(
    "Minimum confidence:",
    state.settings.minConfidence
  );

  console.log(
    "Upstox:",
    UPSTOX_ACCESS_TOKEN
      ? "CONFIGURED"
      : "NOT CONFIGURED"
  );

  console.log(
    "Push:",
    VAPID_PUBLIC_KEY &&
      VAPID_PRIVATE_KEY
      ? "CONFIGURED"
      : "NOT CONFIGURED"
  );

  console.log("");

  try {
    await fetchNews();
  } catch (_) {}

  /*
   * First scan is delayed slightly so the server
   * can finish starting before external APIs are hit.
   */
  setTimeout(
    () => {
      runAutonomousScan().catch(
        (error) =>
          console.error(
            "Initial scan:",
            error.message
          )
      );
    },
    3000
  );
}

app.listen(
  PORT,
  "0.0.0.0",
  async () => {
    console.log(
      `Era AI V${VERSION} running on port ${PORT}`
    );

    await initializeEra();
  }
);
