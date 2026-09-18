// ============================================================
// ERA AI - SERVER.JS
// Step 7A - Live Market Data + Normalization Fix
// ============================================================

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const app = express();

const PORT = process.env.PORT || 10000;

// ============================================================
// CONFIG
// ============================================================

const UPSTOX_BASE = "https://api.upstox.com";
const UPSTOX_ACCESS_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || "mailto:admin@era-ai.app";

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// DATA DIRECTORIES
// ============================================================

const DATA_DIR = path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SUBSCRIPTIONS_FILE = path.join(
  DATA_DIR,
  "push-subscriptions.json"
);

const HISTORY_FILE = path.join(
  DATA_DIR,
  "history.json"
);

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch (error) {
    console.error("JSON READ ERROR:", error.message);
    return fallback;
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2),
      "utf8"
    );
    return true;
  } catch (error) {
    console.error("JSON WRITE ERROR:", error.message);
    return false;
  }
}

// ============================================================
// UPSTOX HELPERS
// ============================================================

function upstoxHeaders() {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}`,
  };
}

function requireUpstox() {
  if (!UPSTOX_ACCESS_TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is missing");
  }
}

// ============================================================
// SUPPORTED INDICES
// ============================================================

const INDICES = {
  NIFTY: {
    name: "NIFTY",
    instrumentKey: "NSE_INDEX|Nifty 50",
  },

  BANKNIFTY: {
    name: "BANKNIFTY",
    instrumentKey: "NSE_INDEX|Nifty Bank",
  },

  FINNIFTY: {
    name: "FINNIFTY",
    instrumentKey: "NSE_INDEX|Nifty Fin Service",
  },

  SENSEX: {
    name: "SENSEX",
    instrumentKey: "BSE_INDEX|SENSEX",
  },
};

const EXTRA_MARKET_DATA = {
  giftNifty: {
    name: "GIFT NIFTY",
    instrumentKey: "GLOBAL_INDEX|SGX NIFTY",
  },

  indiaVix: {
    name: "INDIA VIX",
    instrumentKey: "NSE_INDEX|India VIX",
  },
};

// ============================================================
// NUMBER HELPERS
// ============================================================

function number(value, fallback = null) {
  const n = Number(value);

  if (Number.isFinite(n)) {
    return n;
  }

  return fallback;
}

function round(value, decimals = 2) {
  const n = number(value);

  if (n === null) {
    return null;
  }

  const factor = Math.pow(10, decimals);

  return Math.round(n * factor) / factor;
}

// ============================================================
// MARKET DATA NORMALIZATION
// ============================================================

function extractQuote(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const ohlc =
    raw.ohlc ||
    raw.OHLC ||
    {};

  const price = number(
    raw.last_price ??
      raw.lastPrice ??
      raw.ltp ??
      raw.close ??
      ohlc.close
  );

  if (price === null) {
    return null;
  }

  const open = number(
    raw.open ??
      ohlc.open
  );

  const high = number(
    raw.high ??
      ohlc.high
  );

  const low = number(
    raw.low ??
      ohlc.low
  );

  const close = number(
    raw.close ??
      ohlc.close ??
      price
  );

  // Upstox sometimes provides this directly.
  let previousClose = number(
    raw.prev_close_price ??
      raw.previous_close ??
      raw.previousClose ??
      raw.prevClosePrice
  );

  const netChange = number(
    raw.net_change ??
      raw.netChange ??
      raw.change
  );

  // ----------------------------------------------------------
  // IMPORTANT:
  // If Upstox does not return previous close but gives
  // net_change, derive previous close:
  //
  // previousClose = currentPrice - netChange
  // ----------------------------------------------------------

  if (
    (previousClose === null || previousClose === 0) &&
    netChange !== null
  ) {
    previousClose = price - netChange;
  }

  // Last fallback.
  if (
    (previousClose === null || previousClose === 0) &&
    close !== null &&
    netChange !== null
  ) {
    previousClose = close - netChange;
  }

  let change = netChange;

  if (change === null && previousClose !== null) {
    change = price - previousClose;
  }

  let changePercent = null;

  if (
    previousClose !== null &&
    previousClose !== 0 &&
    change !== null
  ) {
    changePercent = (change / previousClose) * 100;
  }

  const volume = number(
    raw.volume ??
      ohlc.volume,
    0
  );

  const oi = number(
    raw.oi
  );

  const previousOI = number(
    raw.previous_oi ??
      raw.previousOI
  );

  const timestamp =
    raw.timestamp ||
    new Date().toISOString();

  return {
    price: round(price, 2),

    previousClose: round(previousClose, 2),

    change: round(change, 2),

    changePercent: round(changePercent, 2),

    open: round(open, 2),
    high: round(high, 2),
    low: round(low, 2),
    close: round(close, 2),

    volume,
    oi,
    previousOI,

    timestamp,

    raw,
  };
}

// ============================================================
// GET SINGLE MARKET QUOTE
// ============================================================

async function getMarketQuote(
  indexName,
  instrumentKey
) {
  requireUpstox();

  const url =
    `${UPSTOX_BASE}/v2/market-quote/quotes`;

  const response = await axios.get(url, {
    params: {
      instrument_key: instrumentKey,
    },

    headers: upstoxHeaders(),

    timeout: 15000,
  });

  const data = response.data?.data || {};

  const keys = Object.keys(data);

  let rawQuote = null;

  if (keys.length > 0) {
    rawQuote = data[keys[0]];
  }

  if (!rawQuote) {
    return {
      name: indexName,
      instrumentKey,
      available: false,
      price: null,
      previousClose: null,
      change: null,
      changePercent: null,
      open: null,
      high: null,
      low: null,
      close: null,
      volume: 0,
      oi: null,
      previousOI: null,
      timestamp: new Date().toISOString(),
      raw: null,
    };
  }

  const normalized = extractQuote(rawQuote);

  if (!normalized) {
    return {
      name: indexName,
      instrumentKey,
      available: false,
      price: null,
      previousClose: null,
      change: null,
      changePercent: null,
      open: null,
      high: null,
      low: null,
      close: null,
      volume: 0,
      oi: null,
      previousOI: null,
      timestamp: new Date().toISOString(),
      raw: rawQuote,
    };
  }

  return {
    name: indexName,
    instrumentKey,
    available: true,

    ...normalized,
  };
}

// ============================================================
// GET ALL MARKET DATA
// ============================================================

async function getAllMarkets() {
  const result = {};

  for (const [key, config] of Object.entries(INDICES)) {
    try {
      result[key] = await getMarketQuote(
        config.name,
        config.instrumentKey
      );
    } catch (error) {
      console.error(
        `${config.name} MARKET ERROR:`,
        error.response?.data || error.message
      );

      result[key] = {
        name: config.name,
        instrumentKey: config.instrumentKey,
        available: false,
        price: null,
        previousClose: null,
        change: null,
        changePercent: null,
        open: null,
        high: null,
        low: null,
        close: null,
        volume: 0,
        oi: null,
        previousOI: null,
        timestamp: new Date().toISOString(),
        raw: null,
        error: error.message,
      };
    }
  }

  return result;
}

// ============================================================
// EXTRA MARKET DATA
// ============================================================

async function getExtraMarketData() {
  const result = {};

  for (const [key, config] of Object.entries(
    EXTRA_MARKET_DATA
  )) {
    try {
      result[key] = await getMarketQuote(
        config.name,
        config.instrumentKey
      );
    } catch (error) {
      console.error(
        `${config.name} ERROR:`,
        error.response?.data || error.message
      );

      result[key] = {
        name: config.name,
        instrumentKey: config.instrumentKey,
        available: false,
        price: null,
        previousClose: null,
        change: null,
        changePercent: null,
        open: null,
        high: null,
        low: null,
        close: null,
        volume: 0,
        oi: null,
        previousOI: null,
        timestamp: new Date().toISOString(),
        raw: null,
        error: error.message,
      };
    }
  }

  return result;
}

// ============================================================
// HISTORICAL CANDLES
// ============================================================

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

async function getHistoricalCandles(
  instrumentKey,
  days = 5
) {
  requireUpstox();

  const to = new Date();

  const from = new Date();

  from.setDate(
    from.getDate() - days
  );

  const url =
    `${UPSTOX_BASE}/v3/historical-candle/` +
    `${encodeURIComponent(instrumentKey)}/1minute/` +
    `${formatDate(to)}/${formatDate(from)}`;

  const response = await axios.get(url, {
    headers: upstoxHeaders(),
    timeout: 20000,
  });

  const candles =
    response.data?.data?.candles || [];

  return candles
    .map((candle) => ({
      timestamp: candle[0],
      open: number(candle[1]),
      high: number(candle[2]),
      low: number(candle[3]),
      close: number(candle[4]),
      volume: number(candle[5], 0),
      oi: number(candle[6], 0),
    }))
    .filter(
      (c) =>
        c.open !== null &&
        c.high !== null &&
        c.low !== null &&
        c.close !== null
    )
    .reverse();
}

// ============================================================
// EMA
// ============================================================

function calculateEMA(values, period) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce(
      (sum, value) => sum + value,
      0
    ) / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    ema =
      (values[i] - ema) *
        multiplier +
      ema;
  }

  return ema;
}

// ============================================================
// RSI
// ============================================================

function calculateRSI(values, period = 14) {
  if (
    !Array.isArray(values) ||
    values.length <= period
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff =
      values[i] - values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  let averageGain =
    gains / period;

  let averageLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const diff =
      values[i] - values[i - 1];

    const gain =
      diff > 0 ? diff : 0;

    const loss =
      diff < 0 ? Math.abs(diff) : 0;

    averageGain =
      (averageGain * (period - 1) +
        gain) /
      period;

    averageLoss =
      (averageLoss * (period - 1) +
        loss) /
      period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs =
    averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

// ============================================================
// VWAP
// ============================================================

function calculateVWAP(candles) {
  if (!candles?.length) {
    return null;
  }

  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (const candle of candles) {
    const volume =
      number(candle.volume, 0);

    const typicalPrice =
      (candle.high +
        candle.low +
        candle.close) /
      3;

    cumulativePV +=
      typicalPrice * volume;

    cumulativeVolume += volume;
  }

  if (cumulativeVolume === 0) {
    return null;
  }

  return cumulativePV / cumulativeVolume;
}

// ============================================================
// TECHNICAL ANALYSIS
// ============================================================

function getTechnicalAnalysis(
  index,
  market,
  candles
) {
  if (!candles?.length) {
    return {
      index,
      currentPrice: market.price,
      ema9: null,
      ema20: null,
      ema50: null,
      rsi: null,
      vwap: null,
      support: null,
      resistance: null,
      bullishScore: 0,
      bearishScore: 0,
      trend: "WAIT",
      reasons: [],
      candleCount: 0,
      lastCandle: null,
    };
  }

  const closes = candles.map(
    (c) => c.close
  );

  const ema9 =
    calculateEMA(closes, 9);

  const ema20 =
    calculateEMA(closes, 20);

  const ema50 =
    calculateEMA(closes, 50);

  const rsi =
    calculateRSI(closes, 14);

  const vwap =
    calculateVWAP(candles);

  const recent =
    candles.slice(-20);

  const support =
    Math.min(
      ...recent.map((c) => c.low)
    );

  const resistance =
    Math.max(
      ...recent.map((c) => c.high)
    );

  let bullishScore = 0;
  let bearishScore = 0;

  const reasons = [];

  if (
    ema9 !== null &&
    ema20 !== null
  ) {
    if (ema9 > ema20) {
      bullishScore += 20;
      reasons.push(
        "EMA 9 is above EMA 20"
      );
    } else {
      bearishScore += 20;
      reasons.push(
        "EMA 9 is below EMA 20"
      );
    }
  }

  if (
    ema50 !== null &&
    market.price !== null
  ) {
    if (market.price > ema50) {
      bullishScore += 15;
      reasons.push(
        "Price is above EMA 50"
      );
    } else {
      bearishScore += 15;
      reasons.push(
        "Price is below EMA 50"
      );
    }
  }

  if (rsi !== null) {
    if (rsi >= 55) {
      bullishScore += 10;
      reasons.push(
        "RSI shows bullish momentum"
      );
    } else if (rsi <= 45) {
      bearishScore += 10;
      reasons.push(
        "RSI shows bearish momentum"
      );
    }
  }

  let trend = "NEUTRAL";

  if (
    bullishScore >
      bearishScore
  ) {
    trend = "BULLISH";
  } else if (
    bearishScore >
      bullishScore
  ) {
    trend = "BEARISH";
  }

  return {
    index,

    currentPrice:
      round(market.price),

    ema9:
      round(ema9),

    ema20:
      round(ema20),

    ema50:
      round(ema50),

    rsi:
      round(rsi),

    vwap:
      round(vwap),

    support:
      round(support),

    resistance:
      round(resistance),

    bullishScore,
    bearishScore,

    trend,

    reasons,

    candleCount:
      candles.length,

    lastCandle:
      candles[candles.length - 1],
  };
}

// ============================================================
// OPTION CONTRACTS
// ============================================================

async function getOptionContracts(
  instrumentKey
) {
  requireUpstox();

  const response =
    await axios.get(
      `${UPSTOX_BASE}/v2/option/contract`,
      {
        params: {
          instrument_key:
            instrumentKey,
        },

        headers: upstoxHeaders(),

        timeout: 20000,
      }
    );

  return response.data?.data || [];
}

// ============================================================
// OPTION CHAIN
// ============================================================

async function getOptionChain(
  instrumentKey,
  expiryDate
) {
  requireUpstox();

  const params = {
    instrument_key:
      instrumentKey,
  };

  if (expiryDate) {
    params.expiry_date =
      expiryDate;
  }

  const response =
    await axios.get(
      `${UPSTOX_BASE}/v2/option/chain`,
      {
        params,
        headers: upstoxHeaders(),
        timeout: 20000,
      }
    );

  return response.data?.data || [];
}

// ============================================================
// OPTION SUMMARY
// ============================================================

function getOptionSummary(chain) {
  if (!Array.isArray(chain)) {
    return {
      available: false,
      pcr: null,
      callOI: 0,
      putOI: 0,
      callVolume: 0,
      putVolume: 0,
      sentiment: "UNKNOWN",
    };
  }

  let callOI = 0;
  let putOI = 0;
  let callVolume = 0;
  let putVolume = 0;

  for (const item of chain) {
    const call =
      item.call_options ||
      item.call ||
      {};

    const put =
      item.put_options ||
      item.put ||
      {};

    const callMarket =
      call.market_data ||
      {};

    const putMarket =
      put.market_data ||
      {};

    callOI +=
      number(callMarket.oi, 0);

    putOI +=
      number(putMarket.oi, 0);

    callVolume +=
      number(callMarket.volume, 0);

    putVolume +=
      number(putMarket.volume, 0);
  }

  const pcr =
    callOI > 0
      ? putOI / callOI
      : null;

  let sentiment = "NEUTRAL";

  if (pcr !== null) {
    if (pcr >= 1.05) {
      sentiment = "BULLISH";
    } else if (pcr <= 0.85) {
      sentiment = "BEARISH";
    }
  }

  return {
    available: true,

    pcr: round(pcr, 3),

    callOI,
    putOI,

    callVolume,
    putVolume,

    sentiment,
  };
}

// ============================================================
// SIGNAL
// ============================================================

function generateSignal(
  index,
  market,
  technical,
  options
) {
  const bullish =
    technical.bullishScore +
    (options.sentiment === "BULLISH"
      ? 35
      : 0);

  const bearish =
    technical.bearishScore +
    (options.sentiment === "BEARISH"
      ? 35
      : 0);

  const confirmations = [];

  if (
    technical.trend ===
    "BULLISH"
  ) {
    confirmations.push(
      "Technical trend is bullish."
    );
  }

  if (
    technical.trend ===
    "BEARISH"
  ) {
    confirmations.push(
      "Technical trend is bearish."
    );
  }

  if (
    options.sentiment ===
    "BULLISH"
  ) {
    confirmations.push(
      "Option-chain sentiment is bullish."
    );
  }

  if (
    options.sentiment ===
    "BEARISH"
  ) {
    confirmations.push(
      "Option-chain sentiment is bearish."
    );
  }

  let direction = "WAIT";
  let status = "WAIT";

  let confidence = 40;

  if (
    bullish >= 60 &&
    bullish > bearish
  ) {
    direction = "BUY";
    status = "CONFIRMED";
    confidence = Math.min(
      95,
      50 + bullish
    );
  } else if (
    bearish >= 60 &&
    bearish > bullish
  ) {
    direction = "SELL";
    status = "CONFIRMED";
    confidence = Math.min(
      95,
      50 + bearish
    );
  }

  let entry = null;
  let stopLoss = null;
  let target1 = null;
  let target2 = null;
  let target3 = null;

  const price =
    market.price;

  if (
    direction === "BUY" &&
    price !== null
  ) {
    entry = price;

    const risk =
      Math.max(
        price * 0.005,
        Math.abs(
          price -
            (technical.support ||
              price * 0.995)
        )
      );

    stopLoss =
      price - risk;

    target1 =
      price + risk;

    target2 =
      price + risk * 2;

    target3 =
      price + risk * 3;
  }

  if (
    direction === "SELL" &&
    price !== null
  ) {
    entry = price;

    const risk =
      Math.max(
        price * 0.005,
        Math.abs(
          (technical.resistance ||
            price * 1.005) -
            price
        )
      );

    stopLoss =
      price + risk;

    target1 =
      price - risk;

    target2 =
      price - risk * 2;

    target3 =
      price - risk * 3;
  }

  return {
    direction,
    status,

    confidence,

    entry:
      round(entry),

    stopLoss:
      round(stopLoss),

    target1:
      round(target1),

    target2:
      round(target2),

    target3:
      round(target3),

    riskReward:
      direction === "WAIT"
        ? null
        : 2,

    confirmations,

    invalidation:
      direction === "BUY"
        ? `Invalidation below ${round(
            stopLoss
          )}.`
        : direction === "SELL"
        ? `Invalidation above ${round(
            stopLoss
          )}.`
        : "Technical and option confirmations are not sufficiently aligned.",
  };
}

// ============================================================
// COMPLETE INDEX ANALYSIS
// ============================================================

async function getIndexAnalysis(
  index
) {
  const config =
    INDICES[index];

  if (!config) {
    throw new Error(
      `Unsupported index: ${index}`
    );
  }

  const market =
    await getMarketQuote(
      config.name,
      config.instrumentKey
    );

  let candles = [];

  try {
    candles =
      await getHistoricalCandles(
        config.instrumentKey,
        5
      );
  } catch (error) {
    console.error(
      `${index} CANDLE ERROR:`,
      error.response?.data ||
        error.message
    );
  }

  const technical =
    getTechnicalAnalysis(
      index,
      market,
      candles
    );

  let options = {
    available: false,
    pcr: null,
    callOI: 0,
    putOI: 0,
    callVolume: 0,
    putVolume: 0,
    sentiment: "UNKNOWN",
    expiry: null,
  };

  try {
    const contracts =
      await getOptionContracts(
        config.instrumentKey
      );

    const expiries = [
      ...new Set(
        contracts
          .map(
            (c) =>
              c.expiry ||
              c.expiry_date
          )
          .filter(Boolean)
      ),
    ].sort();

    const expiry =
      expiries[0] || null;

    if (expiry) {
      const chain =
        await getOptionChain(
          config.instrumentKey,
          expiry
        );

      options =
        getOptionSummary(chain);

      options.expiry =
        expiry;
    }
  } catch (error) {
    console.error(
      `${index} OPTION ERROR:`,
      error.response?.data ||
        error.message
    );
  }

  const signal =
    generateSignal(
      index,
      market,
      technical,
      options
    );

  return {
    index,

    market,

    technical,

    options,

    signal,

    generatedAt:
      new Date().toISOString(),
  };
}

// ============================================================
// ENGINE STATE
// ============================================================

const engine = {
  running: true,
  lastRun: null,
  lastSuccess: null,
  lastError: null,
  latest: null,
};

let engineTimer = null;

// ============================================================
// ENGINE RUN
// ============================================================

async function runEngine() {
  engine.lastRun =
    new Date().toISOString();

  try {
    const results = {};

    for (const index of Object.keys(
      INDICES
    )) {
      try {
        results[index] =
          await getIndexAnalysis(
            index
          );
      } catch (error) {
        console.error(
          `ENGINE ${index} ERROR:`,
          error.message
        );
      }
    }

    engine.latest = results;

    engine.lastSuccess =
      new Date().toISOString();

    engine.lastError = null;

    console.log(
      "ERA ENGINE SUCCESS:",
      engine.lastSuccess
    );

    return results;
  } catch (error) {
    engine.lastError =
      error.message;

    console.error(
      "ENGINE ERROR:",
      error.message
    );

    return null;
  }
}

function startEngine() {
  if (engineTimer) {
    return;
  }

  engine.running = true;

  runEngine();

  engineTimer = setInterval(
    () => {
      if (engine.running) {
        runEngine();
      }
    },
    60000
  );
}

function stopEngine() {
  engine.running = false;

  if (engineTimer) {
    clearInterval(engineTimer);
    engineTimer = null;
  }
}

// ============================================================
// PUSH NOTIFICATIONS
// ============================================================

if (
  VAPID_PUBLIC_KEY &&
  VAPID_PRIVATE_KEY
) {
  try {
    webpush.setVapidDetails(
      VAPID_SUBJECT,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );

    console.log(
      "Push notifications configured."
    );
  } catch (error) {
    console.error(
      "VAPID ERROR:",
      error.message
    );
  }
}

function getSubscriptions() {
  return readJSON(
    SUBSCRIPTIONS_FILE,
    []
  );
}

function saveSubscriptions(
  subscriptions
) {
  return writeJSON(
    SUBSCRIPTIONS_FILE,
    subscriptions
  );
}

async function sendPush(
  payload
) {
  if (
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY
  ) {
    return {
      sent: 0,
      skipped: true,
      reason:
        "VAPID keys are not configured",
    };
  }

  const subscriptions =
    getSubscriptions();

  let sent = 0;

  const remaining = [];

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify(payload)
      );

      sent++;

      remaining.push(
        subscription
      );
    } catch (error) {
      if (
        error.statusCode === 404 ||
        error.statusCode === 410
      ) {
        continue;
      }

      remaining.push(
        subscription
      );
    }
  }

  saveSubscriptions(
    remaining
  );

  return {
    sent,
    total: subscriptions.length,
  };
}

// ============================================================
// NEWS
// ============================================================

async function getNews() {
  try {
    const url =
      "https://news.google.com/rss/search";

    const response =
      await axios.get(url, {
        params: {
          q:
            "Indian stock market NIFTY BANKNIFTY Sensex",
          hl: "en-IN",
          gl: "IN",
          ceid: "IN:en",
        },
        timeout: 15000,
      });

    const xml =
      response.data || "";

    const items = [];

    const matches =
      xml.match(
        /<item>([\s\S]*?)<\/item>/g
      ) || [];

    for (
      const item of matches.slice(
        0,
        20
      )
    ) {
      const title =
        item.match(
          /<title>([\s\S]*?)<\/title>/
        )?.[1] || "";

      const link =
        item.match(
          /<link>([\s\S]*?)<\/link>/
        )?.[1] || "";

      const pubDate =
        item.match(
          /<pubDate>([\s\S]*?)<\/pubDate>/
        )?.[1] || "";

      if (title) {
        items.push({
          title:
            title
              .replace(
                /<!\[CDATA\[|\]\]>/g,
                ""
              )
              .trim(),

          url:
            link.trim(),

          publishedAt:
            pubDate.trim(),
        });
      }
    }

    return items;
  } catch (error) {
    console.error(
      "NEWS ERROR:",
      error.message
    );

    return [];
  }
}

// ============================================================
// ROUTES
// ============================================================

// HEALTH
app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service: "Era AI",
      version: "2.1.0",
      upstoxConfigured:
        Boolean(
          UPSTOX_ACCESS_TOKEN
        ),

      engine: {
        running:
          engine.running,

        lastRun:
          engine.lastRun,

        lastSuccess:
          engine.lastSuccess,

        lastError:
          engine.lastError,
      },

      timestamp:
        new Date().toISOString(),
    });
  }
);

// ROOT
app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,
      service: "Era AI",
      message:
        "Era AI backend is running.",
      version: "2.1.0",
    });
  }
);

// ============================================================
// /api/market
// ============================================================

app.get(
  "/api/market",
  async (req, res) => {
    try {
      const index =
        String(
          req.query.index ||
            "NIFTY"
        ).toUpperCase();

      const config =
        INDICES[index] ||
        INDICES.NIFTY;

      const market =
        await getMarketQuote(
          config.name,
          config.instrumentKey
        );

      res.json({
        ok: true,

        index:
          config.name,

        market,
      });
    } catch (error) {
      console.error(
        "/api/market ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(500).json({
        ok: false,
        error:
          error.response?.data ||
          error.message,
      });
    }
  }
);

// ============================================================
// /api/analysis
// ============================================================

app.get(
  "/api/analysis",
  async (req, res) => {
    const selectedIndex =
      String(
        req.query.index ||
          "NIFTY"
      ).toUpperCase();

    if (!INDICES[selectedIndex]) {
      return res.status(400).json({
        ok: false,
        error:
          "Unsupported index",
        supportedIndices:
          Object.keys(INDICES),
      });
    }

    try {
      const indices = {};

      for (const index of Object.keys(
        INDICES
      )) {
        try {
          indices[index] =
            await getIndexAnalysis(
              index
            );
        } catch (error) {
          console.error(
            `${index} ANALYSIS ERROR:`,
            error.message
          );
        }
      }

      const extra =
        await getExtraMarketData();

      const selected =
        indices[
          selectedIndex
        ];

      if (!selected) {
        return res.status(500).json({
          ok: false,
          error:
            "Selected index analysis unavailable",
        });
      }

      res.json({
        ok: true,

        selectedIndex,

        market: {
          indices,

          selected:
            selected.market,

          nifty:
            indices.NIFTY?.market ||
            null,

          banknifty:
            indices.BANKNIFTY?.market ||
            null,

          finnifty:
            indices.FINNIFTY?.market ||
            null,

          sensex:
            indices.SENSEX?.market ||
            null,

          giftNifty:
            extra.giftNifty,

          indiaVix:
            extra.indiaVix,
        },

        technical:
          selected.technical,

        options:
          selected.options,

        signal:
          selected.signal,

        indicesAnalysis:
          indices,

        generatedAt:
          new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        "/api/analysis ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(500).json({
        ok: false,
        error:
          error.response?.data ||
          error.message,
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
      const instrumentKey =
        req.query.instrument_key;

      if (!instrumentKey) {
        return res.status(400).json({
          ok: false,
          error:
            "instrument_key is required",
        });
      }

      const data =
        await getOptionContracts(
          instrumentKey
        );

      res.json({
        ok: true,
        data,
      });
    } catch (error) {
      console.error(
        "/api/options/contracts ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(500).json({
        ok: false,
        error:
          error.response?.data ||
          error.message,
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
      const instrumentKey =
        req.query.instrument_key;

      const expiryDate =
        req.query.expiry_date;

      if (!instrumentKey) {
        return res.status(400).json({
          ok: false,
          error:
            "instrument_key is required",
        });
      }

      const data =
        await getOptionChain(
          instrumentKey,
          expiryDate
        );

      res.json({
        ok: true,
        data,
      });
    } catch (error) {
      console.error(
        "/api/options/chain ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(500).json({
        ok: false,
        error:
          error.response?.data ||
          error.message,
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
      requireUpstox();

      const instrumentKeys =
        String(
          req.query.instrument_key ||
            ""
        )
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);

      if (!instrumentKeys.length) {
        return res.status(400).json({
          ok: false,
          error:
            "instrument_key is required",
        });
      }

      const response =
        await axios.get(
          `${UPSTOX_BASE}/v2/option/greeks`,
          {
            params: {
              instrument_key:
                instrumentKeys.join(
                  ","
                ),
            },

            headers:
              upstoxHeaders(),

            timeout: 20000,
          }
        );

      res.json({
        ok: true,
        data:
          response.data?.data ||
          [],
      });
    } catch (error) {
      console.error(
        "/api/options/greeks ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(500).json({
        ok: false,
        error:
          error.response?.data ||
          error.message,
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
      const data =
        await getNews();

      res.json({
        ok: true,
        data,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// CHAT
// ============================================================

app.post(
  "/api/chat",
  async (req, res) => {
    try {
      const message =
        String(
          req.body?.message ||
            ""
        ).trim();

      const language =
        req.body?.language ||
        "en";

      const history =
        Array.isArray(
          req.body?.history
        )
          ? req.body.history
          : [];

      if (!message) {
        return res.status(400).json({
          ok: false,
          error:
            "message is required",
        });
      }

      if (!OPENROUTER_API_KEY) {
        return res.json({
          ok: true,
          reply:
            "AI chat is not configured yet.",
        });
      }

      let marketContext = null;

      try {
        marketContext =
          await getIndexAnalysis(
            "NIFTY"
          );
      } catch (error) {
        console.error(
          "CHAT MARKET CONTEXT ERROR:",
          error.message
        );
      }

      const systemPrompt = `
You are Era AI, a professional Indian stock-market analysis assistant.

You communicate through text only.

Never claim guaranteed profits.
Never fabricate live prices.
Use the supplied market context when available.

Explain:
- market structure
- trend
- technical indicators
- option-chain information
- risk
- invalidation
- WAIT when confirmation is insufficient.

User language: ${language}

Current market context:
${JSON.stringify(
  marketContext
)}
`;

      const messages = [
        {
          role: "system",
          content:
            systemPrompt,
        },

        ...history
          .slice(-10)
          .map((item) => ({
            role:
              item.role ===
              "assistant"
                ? "assistant"
                : "user",
            content:
              String(
                item.content ||
                  ""
              ),
          })),

        {
          role: "user",
          content: message,
        },
      ];

      const response =
        await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            model:
              OPENROUTER_MODEL,

            messages,

            temperature: 0.2,
          },
          {
            headers: {
              Authorization:
                `Bearer ${OPENROUTER_API_KEY}`,

              "Content-Type":
                "application/json",

              "HTTP-Referer":
                "https://era-ai.onrender.com",

              "X-Title":
                "Era AI",
            },

            timeout: 30000,
          }
        );

      const reply =
        response.data
          ?.choices?.[0]
          ?.message?.content ||
        "Era could not generate a response.";

      res.json({
        ok: true,
        reply,
      });
    } catch (error) {
      console.error(
        "/api/chat ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(500).json({
        ok: false,
        error:
          error.response?.data ||
          error.message,
      });
    }
  }
);

// ============================================================
// TTS
// ============================================================

app.post(
  "/api/tts",
  async (req, res) => {
    try {
      const text =
        String(
          req.body?.text ||
            ""
        ).trim();

      if (!text) {
        return res.status(400).json({
          ok: false,
          error:
            "text is required",
        });
      }

      if (
        !ELEVENLABS_API_KEY ||
        !ELEVENLABS_VOICE_ID
      ) {
        return res.status(503).json({
          ok: false,
          error:
            "TTS is not configured",
        });
      }

      const response =
        await axios.post(
          `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
          {
            text,

            model_id:
              "eleven_multilingual_v2",

            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
            },
          },
          {
            headers: {
              "xi-api-key":
                ELEVENLABS_API_KEY,

              Accept:
                "audio/mpeg",

              "Content-Type":
                "application/json",
            },

            responseType:
              "arraybuffer",

            timeout: 30000,
          }
        );

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.send(
        Buffer.from(
          response.data
        )
      );
    } catch (error) {
      console.error(
        "/api/tts ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(500).json({
        ok: false,
        error:
          "TTS request failed",
      });
    }
  }
);

// ============================================================
// SETTINGS
// ============================================================

const settings = {
  selectedIndex: "NIFTY",
  notifications: true,
  theme: "dark",
};

app.get(
  "/api/settings",
  (req, res) => {
    res.json({
      ok: true,
      settings,
    });
  }
);

app.post(
  "/api/settings",
  (req, res) => {
    Object.assign(
      settings,
      req.body || {}
    );

    res.json({
      ok: true,
      settings,
    });
  }
);

// ============================================================
// HISTORY
// ============================================================

app.get(
  "/api/history",
  (req, res) => {
    res.json({
      ok: true,
      data: readJSON(
        HISTORY_FILE,
        []
      ),
    });
  }
);

app.post(
  "/api/history",
  (req, res) => {
    const history =
      readJSON(
        HISTORY_FILE,
        []
      );

    history.push({
      ...req.body,

      createdAt:
        new Date().toISOString(),
    });

    // Keep latest 1000 entries.
    const trimmed =
      history.slice(-1000);

    writeJSON(
      HISTORY_FILE,
      trimmed
    );

    res.json({
      ok: true,
      data:
        trimmed[
          trimmed.length - 1
        ],
    });
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
        null,
    });
  }
);

// ============================================================
// SUBSCRIBE
// ============================================================

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
        ok: false,
        error:
          "Valid push subscription is required",
      });
    }

    const subscriptions =
      getSubscriptions();

    const exists =
      subscriptions.some(
        (item) =>
          item.endpoint ===
          subscription.endpoint
      );

    if (!exists) {
      subscriptions.push(
        subscription
      );

      saveSubscriptions(
        subscriptions
      );
    }

    res.json({
      ok: true,
      subscribed: true,
    });
  }
);

// ============================================================
// PUSH TEST
// ============================================================

app.post(
  "/api/push/test",
  async (req, res) => {
    try {
      const result =
        await sendPush({
          title:
            req.body?.title ||
            "Era AI",

          body:
            req.body?.body ||
            "Era notification test.",

          icon:
            req.body?.icon ||
            "/icon-192.png",

          data: {
            url:
              req.body?.url ||
              "/?from=notification",
          },
        });

      res.json({
        ok: true,
        result,
      });
    } catch (error) {
      console.error(
        "/api/push/test ERROR:",
        error.message
      );

      res.status(500).json({
        ok: false,
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// ENGINE STATUS
// ============================================================

app.get(
  "/api/engine",
  (req, res) => {
    res.json({
      ok: true,
      engine,
    });
  }
);

// ============================================================
// ENGINE START
// ============================================================

app.post(
  "/api/engine/start",
  (req, res) => {
    startEngine();

    res.json({
      ok: true,
      engine,
    });
  }
);

// ============================================================
// ENGINE STOP
// ============================================================

app.post(
  "/api/engine/stop",
  (req, res) => {
    stopEngine();

    res.json({
      ok: true,
      engine,
    });
  }
);

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (error, req, res, next) => {
    console.error(
      "GLOBAL ERROR:",
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Internal server error",
    });
  }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "========================================"
    );

    console.log(
      "        ERA AI BACKEND STARTED"
    );

    console.log(
      "========================================"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `UPSTOX: ${
        UPSTOX_ACCESS_TOKEN
          ? "CONFIGURED"
          : "MISSING"
      }`
    );

    console.log(
      `OPENROUTER: ${
        OPENROUTER_API_KEY
          ? "CONFIGURED"
          : "MISSING"
      }`
    );

    console.log(
      `ELEVENLABS: ${
        ELEVENLABS_API_KEY
          ? "CONFIGURED"
          : "MISSING"
      }`
    );

    console.log(
      `VAPID: ${
        VAPID_PUBLIC_KEY &&
        VAPID_PRIVATE_KEY
          ? "CONFIGURED"
          : "MISSING"
      }`
    );

    console.log(
      "Supported indices:",
      Object.keys(
        INDICES
      ).join(", ")
    );

    console.log(
      "========================================"
    );

    startEngine();
  }
);
