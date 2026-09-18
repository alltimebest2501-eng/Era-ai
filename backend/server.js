require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const UPSTOX_ACCESS_TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const UPSTOX_V2 = "https://api.upstox.com/v2";
const UPSTOX_V3 = "https://api.upstox.com/v3";

const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://era-ai.onrender.com";

/* =========================================================
   BASIC APP CONFIG
========================================================= */

app.set("trust proxy", 1);

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

/* =========================================================
   DATA DIRECTORIES
========================================================= */

const DATA_DIR = path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "subscriptions.json");

/* =========================================================
   SAFE JSON HELPERS
========================================================= */

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch (error) {
    console.error("JSON READ ERROR:", file, error.message);
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error("JSON WRITE ERROR:", file, error.message);
    return false;
  }
}

/* =========================================================
   DEFAULT SETTINGS
========================================================= */

const DEFAULT_SETTINGS = {
  movementTrigger: 0.35,
  minConfidence: 60,
  autoAlerts: true,
  notifications: true,
  analysisInterval: 60,
};

let settings = {
  ...DEFAULT_SETTINGS,
  ...readJson(SETTINGS_FILE, {}),
};

writeJson(SETTINGS_FILE, settings);

/* =========================================================
   SUPPORTED INDICES
========================================================= */

const INDICES = {
  NIFTY: {
    name: "NIFTY",
    instrumentKey: "NSE_INDEX|Nifty 50",
    optionInstrumentKey: "NSE_INDEX|Nifty 50",
  },

  BANKNIFTY: {
    name: "BANKNIFTY",
    instrumentKey: "NSE_INDEX|Nifty Bank",
    optionInstrumentKey: "NSE_INDEX|Nifty Bank",
  },

  FINNIFTY: {
    name: "FINNIFTY",
    instrumentKey: "NSE_INDEX|Nifty Fin Service",
    optionInstrumentKey: "NSE_INDEX|Nifty Fin Service",
  },

  SENSEX: {
    name: "SENSEX",
    instrumentKey: "BSE_INDEX|SENSEX",
    optionInstrumentKey: "BSE_INDEX|SENSEX",
  },
};

const GLOBAL_INSTRUMENTS = {
  GIFT_NIFTY: "GLOBAL_INDEX|SGX NIFTY",
  INDIA_VIX: "NSE_INDEX|India VIX",
};

/* =========================================================
   RUNTIME STATE
========================================================= */

let upstoxConfigured = Boolean(UPSTOX_ACCESS_TOKEN);

let engineState = {
  running: false,
  lastRun: null,
  lastSuccess: null,
  lastError: null,
};

let analysisCache = new Map();

let alertState = {
  active: null,
  lastSignal: null,
};

/* =========================================================
   UPSTOX HELPERS
========================================================= */

function getUpstoxHeaders() {
  if (!UPSTOX_ACCESS_TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is missing");
  }

  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}`,
  };
}

async function upstoxGet(url, params = {}) {
  const response = await axios.get(url, {
    params,
    headers: getUpstoxHeaders(),
    timeout: 15000,
  });

  return response.data;
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function round(value, decimals = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/* =========================================================
   INDEX HELPERS
========================================================= */

function normalizeIndex(index) {
  if (!index) {
    return "NIFTY";
  }

  const key = String(index).trim().toUpperCase();

  return INDICES[key] ? key : "NIFTY";
}

function getIndexConfig(index) {
  return INDICES[normalizeIndex(index)];
}

/* =========================================================
   MARKET QUOTE V3
========================================================= */

function extractQuoteObject(data, instrumentKey) {
  if (!data || !data.data) {
    return null;
  }

  const root = data.data;

  if (root[instrumentKey]) {
    return root[instrumentKey];
  }

  const encodedKey = instrumentKey.replace(/\|/g, "%7C");

  if (root[encodedKey]) {
    return root[encodedKey];
  }

  const values = Object.values(root);

  return values.length ? values[0] : null;
}

function normalizeMarketQuote(raw, instrumentKey, name) {
  if (!raw) {
    return {
      name,
      instrumentKey,
      available: false,
      price: null,
      previousClose: null,
      change: null,
      changePercent: null,
      volume: null,
      oi: null,
      timestamp: null,
    };
  }

  const price = normalizeNumber(
    raw.last_price ??
      raw.last_traded_price ??
      raw.ltp ??
      raw.lastPrice
  );

  const previousClose = normalizeNumber(
    raw.prev_close_price ??
      raw.cp ??
      raw.previous_close ??
      raw.prevClosePrice
  );

  let change = normalizeNumber(
    raw.net_change ??
      raw.netChange ??
      raw.change,
    NaN
  );

  if (!Number.isFinite(change) && Number.isFinite(price) && previousClose) {
    change = price - previousClose;
  }

  let changePercent = normalizeNumber(
    raw.change_percent ??
      raw.changePercent,
    NaN
  );

  if (
    !Number.isFinite(changePercent) &&
    Number.isFinite(change) &&
    previousClose
  ) {
    changePercent = (change / previousClose) * 100;
  }

  const ohlc = raw.ohlc || {};

  return {
    name,
    instrumentKey,
    available: true,

    price: round(price),
    previousClose: round(previousClose),

    change: round(change),
    changePercent: round(changePercent),

    open: round(ohlc.open ?? raw.open),
    high: round(ohlc.high ?? raw.high),
    low: round(ohlc.low ?? raw.low),
    close: round(ohlc.close ?? raw.close),

    volume: normalizeNumber(raw.volume),

    oi: raw.oi != null ? normalizeNumber(raw.oi) : null,
    previousOI:
      raw.previous_oi != null ? normalizeNumber(raw.previous_oi) : null,

    timestamp: raw.timestamp || raw.ts || null,

    raw,
  };
}

/* =========================================================
   GET ONE MARKET QUOTE
========================================================= */

async function getMarketQuote(index) {
  const key = normalizeIndex(index);
  const config = getIndexConfig(key);

  const response = await upstoxGet(
    `${UPSTOX_V3}/market-quote/quotes`,
    {
      instrument_key: config.instrumentKey,
    }
  );

  const raw = extractQuoteObject(
    response,
    config.instrumentKey
  );

  return normalizeMarketQuote(
    raw,
    config.instrumentKey,
    key
  );
}

/* =========================================================
   GET ALL SUPPORTED INDEX QUOTES
========================================================= */

async function getAllMarketQuotes() {
  const entries = Object.entries(INDICES);

  const result = {};

  await Promise.all(
    entries.map(async ([name, config]) => {
      try {
        const response = await upstoxGet(
          `${UPSTOX_V3}/market-quote/quotes`,
          {
            instrument_key: config.instrumentKey,
          }
        );

        const raw = extractQuoteObject(
          response,
          config.instrumentKey
        );

        result[name] = normalizeMarketQuote(
          raw,
          config.instrumentKey,
          name
        );
      } catch (error) {
        console.error(
          `MARKET ERROR ${name}:`,
          error.response?.data || error.message
        );

        result[name] = {
          name,
          instrumentKey: config.instrumentKey,
          available: false,
          error: true,
          price: null,
          change: null,
          changePercent: null,
        };
      }
    })
  );

  return result;
}

/* =========================================================
   GLOBAL MARKET DATA
========================================================= */

async function getGlobalMarketData() {
  const result = {
    giftNifty: null,
    indiaVix: null,
  };

  try {
    const response = await upstoxGet(
      `${UPSTOX_V3}/market-quote/quotes`,
      {
        instrument_key: GLOBAL_INSTRUMENTS.GIFT_NIFTY,
      }
    );

    result.giftNifty = normalizeMarketQuote(
      extractQuoteObject(
        response,
        GLOBAL_INSTRUMENTS.GIFT_NIFTY
      ),
      GLOBAL_INSTRUMENTS.GIFT_NIFTY,
      "GIFT NIFTY"
    );
  } catch (error) {
    console.error(
      "GIFT NIFTY ERROR:",
      error.response?.data || error.message
    );
  }

  try {
    const response = await upstoxGet(
      `${UPSTOX_V3}/market-quote/quotes`,
      {
        instrument_key: GLOBAL_INSTRUMENTS.INDIA_VIX,
      }
    );

    result.indiaVix = normalizeMarketQuote(
      extractQuoteObject(
        response,
        GLOBAL_INSTRUMENTS.INDIA_VIX
      ),
      GLOBAL_INSTRUMENTS.INDIA_VIX,
      "INDIA VIX"
    );
  } catch (error) {
    console.error(
      "INDIA VIX ERROR:",
      error.response?.data || error.message
    );
  }

  return result;
}

/* =========================================================
   CANDLE HELPERS
========================================================= */

function parseCandle(candle) {
  if (!Array.isArray(candle)) {
    return null;
  }

  return {
    timestamp: candle[0],
    open: normalizeNumber(candle[1]),
    high: normalizeNumber(candle[2]),
    low: normalizeNumber(candle[3]),
    close: normalizeNumber(candle[4]),
    volume: normalizeNumber(candle[5]),
    oi: normalizeNumber(candle[6]),
  };
}

async function getIntradayCandles(
  index,
  interval = 5
) {
  const config = getIndexConfig(index);

  const encoded = encodeURIComponent(
    config.instrumentKey
  );

  const response = await upstoxGet(
    `${UPSTOX_V3}/historical-candle/intraday/${encoded}/minutes/${interval}`
  );

  const candles = response?.data?.candles || [];

  return candles
    .map(parseCandle)
    .filter(Boolean)
    .reverse();
}

/* =========================================================
   TECHNICAL INDICATORS
========================================================= */

function calculateEMA(values, period) {
  if (!values.length) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let ema = values[0];

  for (let i = 1; i < values.length; i++) {
    ema =
      (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

function calculateRSI(values, period = 14) {
  if (values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change = values[i] - values[i - 1];

    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    averageGain =
      (averageGain * (period - 1) + gain) /
      period;

    averageLoss =
      (averageLoss * (period - 1) + loss) /
      period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

function calculateVWAP(candles) {
  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (const candle of candles) {
    const typical =
      (candle.high +
        candle.low +
        candle.close) /
      3;

    cumulativePV +=
      typical * candle.volume;

    cumulativeVolume += candle.volume;
  }

  if (!cumulativeVolume) {
    return null;
  }

  return cumulativePV / cumulativeVolume;
}

function calculateSupportResistance(candles) {
  const recent = candles.slice(-20);

  if (!recent.length) {
    return {
      support: null,
      resistance: null,
    };
  }

  const lows = recent.map((x) => x.low);
  const highs = recent.map((x) => x.high);

  return {
    support: Math.min(...lows),
    resistance: Math.max(...highs),
  };
}

/* =========================================================
   TECHNICAL ANALYSIS
========================================================= */

async function getTechnicalAnalysis(index) {
  const candles = await getIntradayCandles(index, 5);

  if (candles.length < 20) {
    throw new Error(
      `Not enough candles for ${normalizeIndex(index)}`
    );
  }

  const closes = candles.map((x) => x.close);

  const ema9 = calculateEMA(closes, 9);
  const ema20 = calculateEMA(closes, 20);
  const ema50 =
    closes.length >= 50
      ? calculateEMA(closes, 50)
      : null;

  const rsi = calculateRSI(closes, 14);
  const vwap = calculateVWAP(candles);

  const sr =
    calculateSupportResistance(candles);

  const currentPrice =
    closes[closes.length - 1];

  let bullishScore = 0;
  let bearishScore = 0;

  const reasons = [];

  if (ema9 > ema20) {
    bullishScore += 20;
    reasons.push("EMA 9 is above EMA 20");
  } else {
    bearishScore += 20;
    reasons.push("EMA 9 is below EMA 20");
  }

  if (ema50 != null) {
    if (currentPrice > ema50) {
      bullishScore += 15;
      reasons.push("Price is above EMA 50");
    } else {
      bearishScore += 15;
      reasons.push("Price is below EMA 50");
    }
  }

  if (rsi != null) {
    if (rsi >= 55 && rsi <= 70) {
      bullishScore += 15;
      reasons.push("RSI supports bullish momentum");
    } else if (rsi <= 45 && rsi >= 30) {
      bearishScore += 15;
      reasons.push("RSI supports bearish momentum");
    }
  }

  if (vwap != null) {
    if (currentPrice > vwap) {
      bullishScore += 10;
      reasons.push("Price is above VWAP");
    } else {
      bearishScore += 10;
      reasons.push("Price is below VWAP");
    }
  }

  let trend = "NEUTRAL";

  if (bullishScore > bearishScore) {
    trend = "BULLISH";
  } else if (bearishScore > bullishScore) {
    trend = "BEARISH";
  }

  return {
    index: normalizeIndex(index),

    currentPrice: round(currentPrice),

    ema9: round(ema9),
    ema20: round(ema20),
    ema50: ema50 != null ? round(ema50) : null,

    rsi: rsi != null ? round(rsi) : null,

    vwap: vwap != null ? round(vwap) : null,

    support:
      sr.support != null
        ? round(sr.support)
        : null,

    resistance:
      sr.resistance != null
        ? round(sr.resistance)
        : null,

    bullishScore,
    bearishScore,
    trend,

    reasons,

    candleCount: candles.length,

    lastCandle:
      candles[candles.length - 1] || null,
  };
}

/* =========================================================
   OPTION CONTRACTS
========================================================= */

const contractCache = new Map();

async function getOptionContracts(index) {
  const key = normalizeIndex(index);
  const config = getIndexConfig(key);

  if (contractCache.has(key)) {
    const cached = contractCache.get(key);

    if (
      Date.now() - cached.timestamp <
      30 * 60 * 1000
    ) {
      return cached.contracts;
    }
  }

  const response = await upstoxGet(
    `${UPSTOX_V2}/option/contract`,
    {
      instrument_key:
        config.optionInstrumentKey,
    }
  );

  const contracts =
    Array.isArray(response?.data)
      ? response.data
      : [];

  contractCache.set(key, {
    timestamp: Date.now(),
    contracts,
  });

  return contracts;
}

/* =========================================================
   EXPIRY EXTRACTION
========================================================= */

function getExpiriesFromContracts(contracts) {
  return [
    ...new Set(
      contracts
        .map(
          (contract) =>
            contract.expiry ||
            contract.expiry_date ||
            contract.expiryDate
        )
        .filter(Boolean)
    ),
  ].sort();
}

/* =========================================================
   OPTION CHAIN
========================================================= */

async function getOptionChain(
  index,
  expiryDate
) {
  const key = normalizeIndex(index);
  const config = getIndexConfig(key);

  if (!expiryDate) {
    throw new Error(
      "expiry_date is required"
    );
  }

  const response = await upstoxGet(
    `${UPSTOX_V2}/option/chain`,
    {
      instrument_key:
        config.optionInstrumentKey,
      expiry_date: expiryDate,
    }
  );

  return response?.data || [];
}

/* =========================================================
   OPTION SUMMARY
========================================================= */

function buildOptionSummary(chain) {
  if (!Array.isArray(chain) || !chain.length) {
    return {
      available: false,
      pcr: null,
      callOI: 0,
      putOI: 0,
      callVolume: 0,
      putVolume: 0,
      sentiment: "NEUTRAL",
    };
  }

  let callOI = 0;
  let putOI = 0;

  let callVolume = 0;
  let putVolume = 0;

  for (const row of chain) {
    const call =
      row.call_options ||
      row.callOptions ||
      {};

    const put =
      row.put_options ||
      row.putOptions ||
      {};

    const callMarket =
      call.market_data || {};

    const putMarket =
      put.market_data || {};

    callOI += normalizeNumber(callMarket.oi);
    putOI += normalizeNumber(putMarket.oi);

    callVolume +=
      normalizeNumber(callMarket.volume);

    putVolume +=
      normalizeNumber(putMarket.volume);
  }

  const pcr =
    callOI > 0 ? putOI / callOI : null;

  let sentiment = "NEUTRAL";

  if (pcr != null) {
    if (pcr >= 1.1) {
      sentiment = "BULLISH";
    } else if (pcr <= 0.8) {
      sentiment = "BEARISH";
    }
  }

  return {
    available: true,

    pcr: pcr != null ? round(pcr, 3) : null,

    callOI,
    putOI,

    callVolume,
    putVolume,

    sentiment,
  };
}

/* =========================================================
   GET NEAREST EXPIRY
========================================================= */

async function getNearestExpiry(index) {
  const contracts =
    await getOptionContracts(index);

  const expiries =
    getExpiriesFromContracts(contracts);

  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  const future =
    expiries.filter(
      (expiry) => expiry >= today
    );

  return future[0] || expiries[0] || null;
}

/* =========================================================
   ERA SIGNAL ENGINE
========================================================= */

function buildTradeSignal(
  index,
  market,
  technical,
  optionSummary
) {
  if (!market || !market.available) {
    return {
      direction: "WAIT",
      status: "DATA UNAVAILABLE",
      confidence: 0,
      entry: null,
      stopLoss: null,
      target1: null,
      target2: null,
      target3: null,
      riskReward: null,
      confirmations: [],
      invalidation:
        "Live market data unavailable.",
    };
  }

  let bullish = 0;
  let bearish = 0;

  const confirmations = [];

  if (technical.trend === "BULLISH") {
    bullish += 40;
    confirmations.push(
      "Technical trend is bullish."
    );
  }

  if (technical.trend === "BEARISH") {
    bearish += 40;
    confirmations.push(
      "Technical trend is bearish."
    );
  }

  if (
    optionSummary &&
    optionSummary.sentiment === "BULLISH"
  ) {
    bullish += 30;
    confirmations.push(
      "Option-chain sentiment is bullish."
    );
  }

  if (
    optionSummary &&
    optionSummary.sentiment === "BEARISH"
  ) {
    bearish += 30;
    confirmations.push(
      "Option-chain sentiment is bearish."
    );
  }

  const price = market.price;

  if (!price) {
    return {
      direction: "WAIT",
      status: "DATA UNAVAILABLE",
      confidence: 0,
      entry: null,
      stopLoss: null,
      target1: null,
      target2: null,
      target3: null,
      riskReward: null,
      confirmations,
      invalidation:
        "Current price unavailable.",
    };
  }

  let direction = "WAIT";

  if (
    bullish >= 70 &&
    bullish > bearish
  ) {
    direction = "BUY";
  } else if (
    bearish >= 70 &&
    bearish > bullish
  ) {
    direction = "SELL";
  }

  const confidence =
    direction === "BUY"
      ? bullish
      : direction === "SELL"
      ? bearish
      : Math.max(
          bullish,
          bearish
        );

  if (direction === "WAIT") {
    return {
      direction,
      status: "WAIT",
      confidence,
      entry: null,
      stopLoss: null,
      target1: null,
      target2: null,
      target3: null,
      riskReward: null,
      confirmations,
      invalidation:
        "Technical and option confirmations are not sufficiently aligned.",
    };
  }

  const support =
    technical.support || price * 0.995;

  const resistance =
    technical.resistance || price * 1.005;

  let stopLoss;
  let target1;
  let target2;
  let target3;

  if (direction === "BUY") {
    stopLoss = Math.min(
      support,
      price * 0.995
    );

    const risk = price - stopLoss;

    target1 = price + risk * 1;
    target2 = price + risk * 2;
    target3 = price + risk * 3;
  } else {
    stopLoss = Math.max(
      resistance,
      price * 1.005
    );

    const risk = stopLoss - price;

    target1 = price - risk * 1;
    target2 = price - risk * 2;
    target3 = price - risk * 3;
  }

  const risk = Math.abs(
    price - stopLoss
  );

  const riskReward =
    risk > 0
      ? Math.abs(target2 - price) / risk
      : null;

  return {
    direction,
    status: "CONFIRMED",
    confidence,

    entry: round(price),
    stopLoss: round(stopLoss),

    target1: round(target1),
    target2: round(target2),
    target3: round(target3),

    riskReward:
      riskReward != null
        ? round(riskReward, 2)
        : null,

    confirmations,

    invalidation:
      direction === "BUY"
        ? `Invalidation below ${round(stopLoss)}.`
        : `Invalidation above ${round(stopLoss)}.`,
  };
}

/* =========================================================
   COMPLETE INDEX ANALYSIS
========================================================= */

async function getIndexAnalysis(index) {
  const key = normalizeIndex(index);

  const cached =
    analysisCache.get(key);

  if (
    cached &&
    Date.now() - cached.timestamp <
      30 * 1000
  ) {
    return cached.data;
  }

  const market =
    await getMarketQuote(key);

  const technical =
    await getTechnicalAnalysis(key);

  let optionSummary = {
    available: false,
    sentiment: "NEUTRAL",
    pcr: null,
  };

  let optionExpiry = null;

  try {
    optionExpiry =
      await getNearestExpiry(key);

    if (optionExpiry) {
      const chain =
        await getOptionChain(
          key,
          optionExpiry
        );

      optionSummary =
        buildOptionSummary(chain);
    }
  } catch (error) {
    console.error(
      `OPTION ANALYSIS ${key}:`,
      error.response?.data ||
        error.message
    );
  }

  const signal =
    buildTradeSignal(
      key,
      market,
      technical,
      optionSummary
    );

  const result = {
    index: key,
    market,
    technical,

    options: {
      ...optionSummary,
      expiry: optionExpiry,
    },

    signal,

    generatedAt:
      new Date().toISOString(),
  };

  analysisCache.set(key, {
    timestamp: Date.now(),
    data: result,
  });

  return result;
}

/* =========================================================
   COMPLETE ERA ANALYSIS
========================================================= */

async function getEraAnalysis(
  selectedIndex = "NIFTY"
) {
  const selected =
    normalizeIndex(selectedIndex);

  const indices = {};

  for (const key of Object.keys(INDICES)) {
    try {
      indices[key] =
        await getIndexAnalysis(key);
    } catch (error) {
      console.error(
        `INDEX ANALYSIS ERROR ${key}:`,
        error.response?.data ||
          error.message
      );

      indices[key] = {
        index: key,
        market: {
          available: false,
          price: null,
          change: null,
          changePercent: null,
        },
        technical: {
          trend: "UNKNOWN",
          rsi: null,
          ema9: null,
          ema20: null,
          ema50: null,
          vwap: null,
        },
        options: {
          available: false,
          sentiment: "UNKNOWN",
        },
        signal: {
          direction: "WAIT",
          status: "DATA UNAVAILABLE",
          confidence: 0,
          entry: null,
          stopLoss: null,
          target1: null,
          target2: null,
          target3: null,
          riskReward: null,
          confirmations: [],
          invalidation:
            "Live data unavailable.",
        },
      };
    }
  }

  const global =
    await getGlobalMarketData();

  const selectedData =
    indices[selected] || indices.NIFTY;

  return {
    selectedIndex: selected,

    market: {
      indices,

      selected:
        selectedData?.market || null,

      nifty:
        indices.NIFTY?.market || null,

      banknifty:
        indices.BANKNIFTY?.market || null,

      finnifty:
        indices.FINNIFTY?.market || null,

      sensex:
        indices.SENSEX?.market || null,

      giftNifty:
        global.giftNifty,

      indiaVix:
        global.indiaVix,
    },

    technical:
      selectedData?.technical || {},

    options:
      selectedData?.options || {},

    signal:
      selectedData?.signal || {},

    indicesAnalysis: indices,

    generatedAt:
      new Date().toISOString(),
  };
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Era AI",
    version: "2.0.0",
    upstoxConfigured,
    engine: engineState,
    timestamp:
      new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Era AI backend is running.",
    version: "2.0.0",
  });
});

/* =========================================================
   ANALYSIS API
========================================================= */

app.get("/api/analysis", async (req, res) => {
  try {
    if (!upstoxConfigured) {
      return res.status(503).json({
        ok: false,
        error:
          "UPSTOX_ACCESS_TOKEN is not configured.",
        status: "DATA UNAVAILABLE",
      });
    }

    const selected =
      normalizeIndex(
        req.query.index ||
          req.query.instrument ||
          "NIFTY"
      );

    const analysis =
      await getEraAnalysis(selected);

    res.json({
      ok: true,
      ...analysis,
    });
  } catch (error) {
    console.error(
      "ANALYSIS ERROR:",
      error.response?.data ||
        error.message
    );

    res.status(503).json({
      ok: false,
      error: "Market analysis unavailable.",
      status: "DATA UNAVAILABLE",
      details:
        process.env.NODE_ENV === "production"
          ? undefined
          : error.message,
    });
  }
});

/* =========================================================
   MARKET API
========================================================= */

app.get(
  "/api/market",
  async (req, res) => {
    try {
      const index =
        normalizeIndex(
          req.query.index || "NIFTY"
        );

      const market =
        await getMarketQuote(index);

      res.json({
        ok: true,
        index,
        market,
      });
    } catch (error) {
      console.error(
        "MARKET API ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(503).json({
        ok: false,
        error:
          "Market data unavailable.",
      });
    }
  }
);

/* =========================================================
   OPTION CONTRACTS API
========================================================= */

app.get(
  "/api/options/contracts",
  async (req, res) => {
    try {
      const index =
        normalizeIndexFromInstrumentKey(
          req.query.instrument_key
        );

      const contracts =
        await getOptionContracts(index);

      const expiries =
        getExpiriesFromContracts(
          contracts
        );

      res.json({
        ok: true,
        index,
        expiries,
        contracts,
      });
    } catch (error) {
      console.error(
        "CONTRACT ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(503).json({
        ok: false,
        error:
          "Option contracts unavailable.",
        contracts: [],
        expiries: [],
      });
    }
  }
);

/* =========================================================
   OPTION CHAIN API
========================================================= */

app.get(
  "/api/options/chain",
  async (req, res) => {
    try {
      const index =
        normalizeIndexFromInstrumentKey(
          req.query.instrument_key
        );

      const expiry =
        req.query.expiry_date;

      if (!expiry) {
        return res.status(400).json({
          ok: false,
          error:
            "expiry_date is required.",
        });
      }

      const chain =
        await getOptionChain(
          index,
          expiry
        );

      res.json({
        ok: true,
        index,
        expiry,
        data: chain,
      });
    } catch (error) {
      console.error(
        "OPTION CHAIN ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(503).json({
        ok: false,
        error:
          "Option chain unavailable.",
        data: [],
      });
    }
  }
);

/* =========================================================
   OPTION GREEKS API
========================================================= */

app.get(
  "/api/options/greeks",
  async (req, res) => {
    try {
      const instrumentKeys =
        String(
          req.query.instrument_key || ""
        )
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);

      if (!instrumentKeys.length) {
        return res.status(400).json({
          ok: false,
          error:
            "instrument_key is required.",
        });
      }

      if (instrumentKeys.length > 50) {
        return res.status(400).json({
          ok: false,
          error:
            "Maximum 50 instrument keys per request.",
        });
      }

      const response =
        await upstoxGet(
          `${UPSTOX_V3}/market-quote/option-greek`,
          {
            instrument_key:
              instrumentKeys.join(","),
          }
        );

      res.json({
        ok: true,
        data: response?.data || {},
      });
    } catch (error) {
      console.error(
        "GREEKS ERROR:",
        error.response?.data ||
          error.message
      );

      res.status(503).json({
        ok: false,
        error:
          "Option Greeks unavailable.",
      });
    }
  }
);

/* =========================================================
   INSTRUMENT KEY -> INDEX
========================================================= */

function normalizeIndexFromInstrumentKey(
  instrumentKey
) {
  if (!instrumentKey) {
    return "NIFTY";
  }

  const value =
    String(instrumentKey);

  for (const [
    index,
    config,
  ] of Object.entries(INDICES)) {
    if (
      value === config.instrumentKey ||
      value === config.optionInstrumentKey
    ) {
      return index;
    }
  }

  return "NIFTY";
}

/* =========================================================
   NEWS API
========================================================= */

app.get("/api/news", async (req, res) => {
  try {
    const url =
      process.env.NEWS_API_URL;

    const key =
      process.env.NEWS_API_KEY;

    if (!url || !key) {
      return res.json({
        ok: true,
        news: [],
        message:
          "News provider is not configured.",
      });
    }

    const response =
      await axios.get(url, {
        params: {
          apiKey: key,
        },
        timeout: 10000,
      });

    const articles =
      response?.data?.articles || [];

    res.json({
      ok: true,
      news: articles.slice(0, 30),
    });
  } catch (error) {
    console.error(
      "NEWS ERROR:",
      error.message
    );

    res.json({
      ok: false,
      news: [],
    });
  }
});

/* =========================================================
   CHAT API
========================================================= */

app.post("/api/chat", async (req, res) => {
  try {
    const message =
      String(req.body?.message || "")
        .trim();

    const language =
      String(
        req.body?.language || "hinglish"
      );

    const history =
      Array.isArray(req.body?.history)
        ? req.body.history.slice(-10)
        : [];

    if (!message) {
      return res.status(400).json({
        ok: false,
        error: "Message is required.",
      });
    }

    const apiKey =
      process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        error:
          "OPENROUTER_API_KEY is not configured.",
      });
    }

    let liveContext = null;

    try {
      if (upstoxConfigured) {
        liveContext =
          await getEraAnalysis(
            "NIFTY"
          );
      }
    } catch (error) {
      console.error(
        "CHAT LIVE CONTEXT ERROR:",
        error.message
      );
    }

    const systemPrompt = `
You are Era AI, a market-analysis assistant.

Rules:
1. Never invent live market prices.
2. Use supplied live market context when available.
3. If live data is unavailable, clearly say DATA UNAVAILABLE.
4. Do not guarantee profit.
5. Do not claim certainty about future prices.
6. For trading setups use:
   Direction
   Entry
   Stop Loss
   Target 1
   Target 2
   Target 3
   Risk/Reward
   Status
   Confirmations
   Invalidation
7. If confirmations are insufficient, say WAIT / NO TRADE.
8. Answer in ${language}.
`;

    const response =
      await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model:
            process.env.OPENROUTER_MODEL ||
            "openai/gpt-4o-mini",

          messages: [
            {
              role: "system",
              content: systemPrompt,
            },

            {
              role: "system",
              content:
                "LIVE MARKET CONTEXT:\n" +
                JSON.stringify(
                  liveContext || {},
                  null,
                  2
                ),
            },

            ...history,

            {
              role: "user",
              content: message,
            },
          ],

          temperature: 0.2,
          max_tokens: 1200,
        },
        {
          headers: {
            Authorization:
              `Bearer ${apiKey}`,

            "Content-Type":
              "application/json",

            "HTTP-Referer":
              FRONTEND_URL,

            "X-Title":
              "Era AI",
          },

          timeout: 30000,
        }
      );

    const answer =
      response?.data?.choices?.[0]
        ?.message?.content ||
      "Sorry, Era could not generate a response.";

    res.json({
      ok: true,
      answer,
    });
  } catch (error) {
    console.error(
      "CHAT ERROR:",
      error.response?.data ||
        error.message
    );

    res.status(500).json({
      ok: false,
      error:
        "Era chat is temporarily unavailable.",
    });
  }
});

/* =========================================================
   TTS API
========================================================= */

app.post("/api/tts", async (req, res) => {
  try {
    const text =
      String(req.body?.text || "")
        .trim();

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "Text is required.",
      });
    }

    const apiKey =
      process.env.ELEVENLABS_API_KEY;

    const voiceId =
      process.env.ELEVENLABS_VOICE_ID;

    if (!apiKey || !voiceId) {
      return res.status(503).json({
        ok: false,
        error:
          "TTS is not configured.",
      });
    }

    const response =
      await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          text,
          model_id:
            process.env.ELEVENLABS_MODEL ||
            "eleven_multilingual_v2",
        },
        {
          headers: {
            "xi-api-key": apiKey,
            Accept:
              "audio/mpeg",
            "Content-Type":
              "application/json",
          },

          responseType: "arraybuffer",
          timeout: 30000,
        }
      );

    res.setHeader(
      "Content-Type",
      "audio/mpeg"
    );

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    res.send(response.data);
  } catch (error) {
    console.error(
      "TTS ERROR:",
      error.response?.data ||
        error.message
    );

    res.status(500).json({
      ok: false,
      error:
        "Text-to-speech unavailable.",
    });
  }
});

/* =========================================================
   SETTINGS
========================================================= */

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
    try {
      const allowed = [
        "movementTrigger",
        "minConfidence",
        "autoAlerts",
        "notifications",
        "analysisInterval",
      ];

      for (const key of allowed) {
        if (
          Object.prototype.hasOwnProperty.call(
            req.body || {},
            key
          )
        ) {
          settings[key] =
            req.body[key];
        }
      }

      writeJson(
        SETTINGS_FILE,
        settings
      );

      res.json({
        ok: true,
        settings,
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error:
          "Could not update settings.",
      });
    }
  }
);

/* =========================================================
   HISTORY
========================================================= */

app.get(
  "/api/history",
  (req, res) => {
    const history =
      readJson(
        HISTORY_FILE,
        []
      );

    res.json({
      ok: true,
      history,
    });
  }
);

app.post(
  "/api/history",
  (req, res) => {
    try {
      const body =
        req.body || {};

      const trade = {
        id:
          body.id ||
          `${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,

        market:
          String(
            body.market || "NIFTY"
          ).slice(0, 30),

        direction:
          String(
            body.direction || "WAIT"
          ).slice(0, 10),

        entry:
          normalizeNumber(
            body.entry,
            null
          ),

        stopLoss:
          normalizeNumber(
            body.stopLoss,
            null
          ),

        target1:
          normalizeNumber(
            body.target1,
            null
          ),

        target2:
          normalizeNumber(
            body.target2,
            null
          ),

        target3:
          normalizeNumber(
            body.target3,
            null
          ),

        confidence:
          normalizeNumber(
            body.confidence,
            null
          ),

        status:
          String(
            body.status || "OPEN"
          ).slice(0, 30),

        timestamp:
          body.timestamp ||
          new Date().toISOString(),
      };

      const history =
        readJson(
          HISTORY_FILE,
          []
        );

      history.unshift(trade);

      writeJson(
        HISTORY_FILE,
        history.slice(0, 1000)
      );

      res.json({
        ok: true,
        trade,
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error:
          "Could not save history.",
      });
    }
  }
);

/* =========================================================
   WEB PUSH CONFIG
========================================================= */

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || "";

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || "";

const VAPID_EMAIL =
  process.env.VAPID_EMAIL ||
  "mailto:admin@example.com";

let pushConfigured =
  Boolean(
    VAPID_PUBLIC_KEY &&
      VAPID_PRIVATE_KEY
  );

if (pushConfigured) {
  try {
    webpush.setVapidDetails(
      VAPID_EMAIL,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
  } catch (error) {
    pushConfigured = false;

    console.error(
      "WEB PUSH CONFIG ERROR:",
      error.message
    );
  }
}

/* =========================================================
   PUSH PUBLIC KEY
========================================================= */

app.get(
  "/api/push/public-key",
  (req, res) => {
    res.json({
      ok: true,
      configured: pushConfigured,
      publicKey:
        pushConfigured
          ? VAPID_PUBLIC_KEY
          : null,
    });
  }
);

/* =========================================================
   PUSH SUBSCRIPTION
========================================================= */

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
        return res.status(400).json({
          ok: false,
          error:
            "Valid PushSubscription is required.",
        });
      }

      const subscriptions =
        readJson(
          SUBSCRIPTIONS_FILE,
          []
        );

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
      }

      writeJson(
        SUBSCRIPTIONS_FILE,
        subscriptions
      );

      res.json({
        ok: true,
        subscribed: true,
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error:
          "Could not save push subscription.",
      });
    }
  }
);

/* =========================================================
   SEND PUSH
========================================================= */

async function sendPushNotification(
  title,
  body,
  url = "/"
) {
  if (!pushConfigured) {
    return {
      sent: 0,
      skipped: true,
      reason:
        "VAPID is not configured.",
    };
  }

  const subscriptions =
    readJson(
      SUBSCRIPTIONS_FILE,
      []
    );

  const payload =
    JSON.stringify({
      title,
      body,
      url,
    });

  let sent = 0;

  const validSubscriptions = [];

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        subscription,
        payload
      );

      sent++;
      validSubscriptions.push(
        subscription
      );
    } catch (error) {
      const statusCode =
        error.statusCode;

      if (
        statusCode !== 404 &&
        statusCode !== 410
      ) {
        validSubscriptions.push(
          subscription
        );
      }
    }
  }

  writeJson(
    SUBSCRIPTIONS_FILE,
    validSubscriptions
  );

  return {
    sent,
    skipped: false,
  };
}

/* =========================================================
   TEST PUSH
========================================================= */

app.post(
  "/api/push/test",
  async (req, res) => {
    try {
      const result =
        await sendPushNotification(
          "Era AI",
          "Test notification received.",
          "/?from=notification"
        );

      res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          "Push notification failed.",
      });
    }
  }
);

/* =========================================================
   ENGINE
========================================================= */

let engineTimer = null;

async function runEngineCycle() {
  if (!upstoxConfigured) {
    engineState.lastError =
      "UPSTOX_ACCESS_TOKEN is missing.";

    return;
  }

  engineState.lastRun =
    new Date().toISOString();

  try {
    const analysis =
      await getEraAnalysis(
        "NIFTY"
      );

    const signal =
      analysis.signal || {};

    if (
      signal.direction === "BUY" ||
      signal.direction === "SELL"
    ) {
      const previous =
        alertState.lastSignal;

      const changed =
        !previous ||
        previous.direction !==
          signal.direction ||
        previous.entry !==
          signal.entry;

      if (
        changed &&
        settings.autoAlerts &&
        signal.confidence >=
          Number(
            settings.minConfidence || 60
          )
      ) {
        alertState.lastSignal =
          signal;

        alertState.active = {
          market: "NIFTY",
          ...signal,
          createdAt:
            new Date().toISOString(),
        };

        await sendPushNotification(
          `Era AI ${signal.direction}`,
          `NIFTY ${signal.direction} setup. Entry ${signal.entry}, SL ${signal.stopLoss}, Target 1 ${signal.target1}.`,
          "/?from=notification"
        );
      }
    }

    engineState.lastSuccess =
      new Date().toISOString();

    engineState.lastError = null;
  } catch (error) {
    engineState.lastError =
      error.message;

    console.error(
      "ENGINE ERROR:",
      error.response?.data ||
        error.message
    );
  }
}

function startEngine() {
  if (engineTimer) {
    clearInterval(engineTimer);
  }

  if (!upstoxConfigured) {
    engineState.running = false;

    console.log(
      "Era engine NOT started: UPSTOX_ACCESS_TOKEN missing."
    );

    return;
  }

  engineState.running = true;

  const interval =
    Math.max(
      30,
      Number(
        settings.analysisInterval || 60
      )
    ) * 1000;

  runEngineCycle();

  engineTimer =
    setInterval(
      runEngineCycle,
      interval
    );

  console.log(
    `Era engine started. Interval: ${interval / 1000}s`
  );
}

app.get(
  "/api/engine",
  (req, res) => {
    res.json({
      ok: true,
      engine: engineState,
      activeAlert:
        alertState.active,
    });
  }
);

app.post(
  "/api/engine/start",
  (req, res) => {
    startEngine();

    res.json({
      ok: true,
      engine: engineState,
    });
  }
);

app.post(
  "/api/engine/stop",
  (req, res) => {
    if (engineTimer) {
      clearInterval(engineTimer);
      engineTimer = null;
    }

    engineState.running = false;

    res.json({
      ok: true,
      engine: engineState,
    });
  }
);

/* =========================================================
   ERROR HANDLING
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error: "Endpoint not found.",
      path: req.path,
    });
  }
);

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "EXPRESS ERROR:",
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      ok: false,
      error:
        "Internal server error.",
    });
  }
);

/* =========================================================
   PROCESS ERROR HANDLING
========================================================= */

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "UNHANDLED REJECTION:",
      reason
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      "===================================="
    );

    console.log(
      `Era AI backend running on port ${PORT}`
    );

    console.log(
      `Upstox configured: ${upstoxConfigured}`
    );

    console.log(
      `Push configured: ${pushConfigured}`
    );

    console.log(
      "Supported indices: NIFTY, BANKNIFTY, FINNIFTY, SENSEX"
    );

    console.log(
      "===================================="
    );

    startEngine();
  }
);
