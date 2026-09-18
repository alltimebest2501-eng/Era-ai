/*
=========================================================
 ERA AI — V7.2.0
 AI STOCK / OPTIONS ANALYSIS BACKEND
=========================================================

Main fixes:
- Upstox V3 Full Market Quotes
- Previous close / change / OHLC
- Intraday 5 minute candles
- Current-session VWAP
- Change OI = OI - Previous OI
- Option Greeks canonical-key matching
- NIFTY / BANKNIFTY / FINNIFTY / SENSEX
- BUY / SELL / WAIT analysis
- Entry / SL / T1 / T2 / T3 / RR
- Signals API
- Trades API
- Scanner API
- Push notifications
- News
- Chat
- Settings
- History
=========================================================
*/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/* =====================================================
   VERSION
===================================================== */

const VERSION = "7.2.0";

/* =====================================================
   ENV
===================================================== */

const PORT = process.env.PORT || 10000;

const UPSTOX_ACCESS_TOKEN =
  process.env.UPSTOX_ACCESS_TOKEN ||
  process.env.UPSTOX_TOKEN ||
  "";

const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY || "";

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || "";

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || "";

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT ||
  "mailto:admin@era-ai.app";

/* =====================================================
   UPSTOX
===================================================== */

const UPSTOX_V2 = "https://api.upstox.com/v2";
const UPSTOX_V3 = "https://api.upstox.com/v3";

const upstoxHeaders = () => ({
  Accept: "application/json",
  Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}`,
});

/* =====================================================
   INDEX CONFIG
===================================================== */

const INDEXES = {
  NIFTY: {
    name: "NIFTY 50",
    instrumentKey: "NSE_INDEX|Nifty 50",
    exchange: "NSE_INDEX",
    symbol: "NIFTY",
    lotSize: 75,
    strikeStep: 50,
  },

  BANKNIFTY: {
    name: "BANK NIFTY",
    instrumentKey: "NSE_INDEX|Nifty Bank",
    exchange: "NSE_INDEX",
    symbol: "BANKNIFTY",
    lotSize: 30,
    strikeStep: 100,
  },

  FINNIFTY: {
    name: "FIN NIFTY",
    instrumentKey: "NSE_INDEX|Nifty Fin Service",
    exchange: "NSE_INDEX",
    symbol: "FINNIFTY",
    lotSize: 65,
    strikeStep: 50,
  },

  SENSEX: {
    name: "SENSEX",
    instrumentKey: "BSE_INDEX|SENSEX",
    exchange: "BSE_INDEX",
    symbol: "SENSEX",
    lotSize: 20,
    strikeStep: 100,
  },
};

/*
  GIFT key can change depending on Upstox instrument master.
  We keep it optional instead of breaking the whole API.
*/
const EXTRA_INSTRUMENTS = {
  GIFT_NIFTY: "GLOBAL_INDEX|SGX NIFTY",
  INDIA_VIX: "NSE_INDEX|India VIX",
};

/* =====================================================
   DATA STORAGE
===================================================== */

const DATA_DIR = path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const STATE_FILE = path.join(DATA_DIR, "era-state.json");
const HISTORY_FILE = path.join(DATA_DIR, "era-history.json");
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "push-subscriptions.json");

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) return fallback;

    return JSON.parse(raw);
  } catch (error) {
    console.error("JSON READ ERROR:", file, error.message);
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
  } catch (error) {
    console.error("JSON WRITE ERROR:", file, error.message);
  }
}

/* =====================================================
   DEFAULT STATE
===================================================== */

const defaultState = {
  version: VERSION,

  selectedIndex: "NIFTY",

  market: {},

  analysis: {},

  activeTrades: [],

  previousPrices: {},

  lastScanAt: null,

  lastScanSuccessAt: null,

  lastScanError: null,

  scannerRunning: false,

  settings: {
    scanIntervalMs: 60000,
    newsIntervalMs: 300000,
    notifications: true,
    minConfidence: 65,
    autoScanner: true,
  },

  engine: {
    running: false,
    startedAt: null,
    stoppedAt: null,
  },
};

const savedState = readJSON(
  STATE_FILE,
  {}
);

const state = {
  ...defaultState,
  ...savedState,

  settings: {
    ...defaultState.settings,
    ...(savedState.settings || {}),
  },

  engine: {
    ...defaultState.engine,
    ...(savedState.engine || {}),
  },

  market: savedState.market || {},
  analysis: savedState.analysis || {},
  activeTrades: savedState.activeTrades || [],
  previousPrices: savedState.previousPrices || {},
};

/* =====================================================
   HISTORY
===================================================== */

let history = readJSON(
  HISTORY_FILE,
  []
);

if (!Array.isArray(history)) {
  history = [];
}

/* =====================================================
   PUSH
===================================================== */

let pushSubscriptions = readJSON(
  SUBSCRIPTIONS_FILE,
  []
);

if (!Array.isArray(pushSubscriptions)) {
  pushSubscriptions = [];
}

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
  } catch (error) {
    console.error(
      "VAPID CONFIG ERROR:",
      error.message
    );
  }
}

/* =====================================================
   HELPERS
===================================================== */

function saveState() {
  writeJSON(
    STATE_FILE,
    {
      ...state,
      version: VERSION,
    }
  );
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function nowISO() {
  return new Date().toISOString();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;

  const p = Math.pow(10, digits);

  return Math.round(n * p) / p;
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function canonicalKey(key) {
  if (!key) return "";

  return String(key)
    .replace(/\|/g, ":")
    .trim();
}

function sleepSafe(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function getIndexConfig(index) {
  const key = String(index || "")
    .toUpperCase();

  return INDEXES[key] || INDEXES.NIFTY;
}

function getIndexName(index) {
  return getIndexConfig(index).name;
}

/* =====================================================
   MARKET HOURS
===================================================== */

function indiaTimeParts() {
  const formatter =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone: "Asia/Kolkata",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }
    );

  const parts =
    formatter.formatToParts(
      new Date()
    );

  const map = {};

  for (const part of parts) {
    map[part.type] = part.value;
  }

  return {
    weekday: map.weekday,
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function isWeekday() {
  const parts = indiaTimeParts();

  return (
    parts.weekday !== "Sat" &&
    parts.weekday !== "Sun"
  );
}

function isMarketHours() {
  if (!isWeekday()) return false;

  const parts = indiaTimeParts();

  const minutes =
    parts.hour * 60 +
    parts.minute;

  return (
    minutes >= 9 * 60 + 15 &&
    minutes <= 15 * 60 + 30
  );
}

/* =====================================================
   UPSTOX REQUEST
===================================================== */

async function upstoxGet(
  url,
  params = {},
  timeout = 15000
) {
  if (!UPSTOX_ACCESS_TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is missing"
    );
  }

  const response = await axios.get(
    url,
    {
      params,
      headers: upstoxHeaders(),
      timeout,
    }
  );

  return response.data;
}

/* =====================================================
   RESPONSE KEY FINDER
===================================================== */

function findResponseInstrument(
  data,
  instrumentKey
) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const keys = Object.keys(data);

  const targetPipe =
    String(instrumentKey);

  const targetColon =
    canonicalKey(instrumentKey);

  const direct =
    data[targetPipe] ||
    data[targetColon];

  if (direct) {
    return direct;
  }

  for (const key of keys) {
    if (
      canonicalKey(key) ===
      targetColon
    ) {
      return data[key];
    }
  }

  return null;
}

/* =====================================================
   MARKET QUOTES V3
===================================================== */

function normalizeQuote(
  index,
  raw
) {
  const config =
    getIndexConfig(index);

  if (!raw) {
    return {
      index,
      name: config.name,
      instrumentKey:
        config.instrumentKey,

      available: false,

      price: null,
      previousClose: null,

      change: null,
      changePercent: null,

      open: null,
      high: null,
      low: null,
      close: null,

      volume: null,

      timestamp: null,
      lastTradeTime: null,

      stale: true,
      error: "Quote unavailable",
    };
  }

  const price =
    safeNumber(
      raw.last_price,
      NaN
    );

  const previousClose =
    safeNumber(
      raw.prev_close_price,
      NaN
    );

  let change =
    safeNumber(
      raw.net_change,
      NaN
    );

  if (
    !Number.isFinite(change) &&
    Number.isFinite(price) &&
    Number.isFinite(previousClose)
  ) {
    change =
      price - previousClose;
  }

  let changePercent = null;

  if (
    Number.isFinite(change) &&
    Number.isFinite(previousClose) &&
    previousClose !== 0
  ) {
    changePercent =
      (change / previousClose) * 100;
  }

  const ohlc =
    raw.ohlc || {};

  const open =
    safeNumber(
      ohlc.open,
      null
    );

  const high =
    safeNumber(
      ohlc.high,
      null
    );

  const low =
    safeNumber(
      ohlc.low,
      null
    );

  const close =
    safeNumber(
      ohlc.close,
      null
    );

  return {
    index,

    name: config.name,

    instrumentKey:
      config.instrumentKey,

    available:
      Number.isFinite(price),

    price:
      Number.isFinite(price)
        ? round(price, 2)
        : null,

    previousClose:
      Number.isFinite(previousClose)
        ? round(previousClose, 2)
        : null,

    change:
      Number.isFinite(change)
        ? round(change, 2)
        : null,

    changePercent:
      Number.isFinite(changePercent)
        ? round(changePercent, 2)
        : null,

    open:
      Number.isFinite(open)
        ? round(open, 2)
        : null,

    high:
      Number.isFinite(high)
        ? round(high, 2)
        : null,

    low:
      Number.isFinite(low)
        ? round(low, 2)
        : null,

    /*
      This is current/session OHLC close.
      previousClose is yesterday's close.
    */
    close:
      Number.isFinite(close)
        ? round(close, 2)
        : null,

    sessionClose:
      Number.isFinite(close)
        ? round(close, 2)
        : null,

    volume:
      safeNumber(
        raw.volume,
        null
      ),

    averagePrice:
      safeNumber(
        raw.average_price,
        null
      ),

    oi:
      safeNumber(
        raw.oi,
        null
      ),

    lowerCircuit:
      safeNumber(
        raw.lower_circuit_limit,
        null
      ),

    upperCircuit:
      safeNumber(
        raw.upper_circuit_limit,
        null
      ),

    timestamp:
      raw.timestamp ||
      raw.ts ||
      null,

    lastTradeTime:
      raw.last_trade_time ||
      raw.last_trade_time ||
      null,

    stale: false,

    source: "upstox-v3",
  };
}

async function fetchQuotes() {
  const entries =
    Object.entries(INDEXES);

  const instrumentKeys =
    entries.map(
      ([, config]) =>
        config.instrumentKey
    );

  const response =
    await upstoxGet(
      `${UPSTOX_V3}/market-quote/quotes`,
      {
        instrument_key:
          instrumentKeys.join(","),
      }
    );

  const data =
    response &&
    response.data
      ? response.data
      : {};

  const result = {};

  for (
    const [index, config]
    of entries
  ) {
    const raw =
      findResponseInstrument(
        data,
        config.instrumentKey
      );

    result[index] =
      normalizeQuote(
        index,
        raw
      );
  }

  return result;
}

/* =====================================================
   EXTRA MARKET DATA
===================================================== */

async function fetchExtraMarketData() {
  const result = {
    GIFT_NIFTY: {
      available: false,
      price: null,
      change: null,
      changePercent: null,
    },

    INDIA_VIX: {
      available: false,
      price: null,
      change: null,
      changePercent: null,
    },
  };

  try {
    const keys = [
      EXTRA_INSTRUMENTS.GIFT_NIFTY,
      EXTRA_INSTRUMENTS.INDIA_VIX,
    ];

    const response =
      await upstoxGet(
        `${UPSTOX_V3}/market-quote/quotes`,
        {
          instrument_key:
            keys.join(","),
        }
      );

    const data =
      response &&
      response.data
        ? response.data
        : {};

    for (
      const [name, instrumentKey]
      of Object.entries(
        EXTRA_INSTRUMENTS
      )
    ) {
      const raw =
        findResponseInstrument(
          data,
          instrumentKey
        );

      if (!raw) continue;

      const price =
        safeNumber(
          raw.last_price,
          null
        );

      const previousClose =
        safeNumber(
          raw.prev_close_price,
          null
        );

      let change =
        safeNumber(
          raw.net_change,
          null
        );

      if (
        change === null &&
        price !== null &&
        previousClose !== null
      ) {
        change =
          price - previousClose;
      }

      const changePercent =
        previousClose &&
        change !== null
          ? (change /
              previousClose) *
            100
          : null;

      result[name] = {
        available:
          price !== null,

        price:
          price !== null
            ? round(price, 2)
            : null,

        previousClose:
          previousClose !== null
            ? round(previousClose, 2)
            : null,

        change:
          change !== null
            ? round(change, 2)
            : null,

        changePercent:
          changePercent !== null
            ? round(
                changePercent,
                2
              )
            : null,

        source: "upstox-v3",
      };
    }
  } catch (error) {
    console.log(
      "Extra market data unavailable:",
      error.message
    );
  }

  return result;
}

/* =====================================================
   CANDLE HELPERS
===================================================== */

function parseCandle(candle) {
  if (!Array.isArray(candle)) {
    return null;
  }

  const timestamp =
    candle[0];

  const open =
    Number(candle[1]);

  const high =
    Number(candle[2]);

  const low =
    Number(candle[3]);

  const close =
    Number(candle[4]);

  const volume =
    Number(candle[5] || 0);

  const oi =
    Number(candle[6] || 0);

  if (
    !timestamp ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  ) {
    return null;
  }

  return {
    timestamp,
    time: timestamp,

    open,
    high,
    low,
    close,

    volume:
      Number.isFinite(volume)
        ? volume
        : 0,

    oi:
      Number.isFinite(oi)
        ? oi
        : 0,
  };
}

function candleTimeMs(candle) {
  if (!candle) return 0;

  const t =
    new Date(
      candle.timestamp
    ).getTime();

  return Number.isFinite(t)
    ? t
    : 0;
}

function removeFutureCandles(
  candles
) {
  const now =
    Date.now();

  return candles.filter(
    candle =>
      candleTimeMs(candle) <=
      now + 30000
  );
}

function getCompletedCandles(
  candles,
  intervalMinutes = 5
) {
  if (!candles.length) {
    return [];
  }

  const now =
    Date.now();

  const intervalMs =
    intervalMinutes *
    60 *
    1000;

  const completed =
    candles.filter(
      candle => {
        const start =
          candleTimeMs(
            candle
          );

        if (!start) return false;

        return (
          start +
            intervalMs <=
          now
        );
      }
    );

  /*
    If API timestamps don't perfectly
    represent candle start time, don't
    destroy the entire dataset.
  */
  if (
    completed.length <
    Math.min(
      2,
      candles.length
    )
  ) {
    return candles;
  }

  return completed;
}

/* =====================================================
   CANDLES
===================================================== */

async function fetchCandles(
  index
) {
  const config =
    getIndexConfig(index);

  const encodedKey =
    encodeURIComponent(
      config.instrumentKey
    );

  let response;

  let source;

  if (isMarketHours()) {
    /*
      Current-session intraday candles.
    */
    response =
      await upstoxGet(
        `${UPSTOX_V3}/historical-candle/intraday/${encodedKey}/minutes/5`
      );

    source = "intraday";
  } else {
    /*
      Historical fallback when market
      is closed.
    */

    const end =
      new Date();

    const start =
      new Date(
        end.getTime() -
          7 *
            24 *
            60 *
            60 *
            1000
      );

    const toDate =
      end.toISOString()
        .slice(0, 10);

    const fromDate =
      start.toISOString()
        .slice(0, 10);

    response =
      await upstoxGet(
        `${UPSTOX_V3}/historical-candle/${encodedKey}/minutes/5/${toDate}/${fromDate}`
      );

    source = "historical";
  }

  const rawCandles =
    response &&
    response.data &&
    Array.isArray(
      response.data.candles
    )
      ? response.data.candles
      : [];

  let candles =
    rawCandles
      .map(parseCandle)
      .filter(Boolean);

  candles =
    removeFutureCandles(
      candles
    );

  candles.sort(
    (a, b) =>
      candleTimeMs(a) -
      candleTimeMs(b)
  );

  return {
    candles,
    completedCandles:
      getCompletedCandles(
        candles,
        5
      ),

    source,

    latest:
      candles.length
        ? candles[
            candles.length - 1
          ]
        : null,

    fetchedAt:
      nowISO(),
  };
}

/* =====================================================
   TECHNICAL INDICATORS
===================================================== */

function calculateEMA(
  values,
  period
) {
  if (
    !Array.isArray(values) ||
    values.length === 0
  ) {
    return null;
  }

  if (
    values.length <
    period
  ) {
    return null;
  }

  const multiplier =
    2 /
    (period + 1);

  let ema = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    ema +=
      Number(values[i]) || 0;
  }

  ema /= period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    ema =
      (values[i] -
        ema) *
        multiplier +
      ema;
  }

  return ema;
}

function calculateRSI(
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
    let i = 1;
    i <= period;
    i++
  ) {
    const diff =
      values[i] -
      values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses +=
        Math.abs(diff);
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const diff =
      values[i] -
      values[i - 1];

    const gain =
      diff > 0
        ? diff
        : 0;

    const loss =
      diff < 0
        ? Math.abs(diff)
        : 0;

    avgGain =
      ((avgGain *
        (period - 1)) +
        gain) /
      period;

    avgLoss =
      ((avgLoss *
        (period - 1)) +
        loss) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return (
    100 -
    100 /
      (1 + rs)
  );
}

function calculateATR(
  candles,
  period = 14
) {
  if (
    !candles ||
    candles.length <
      period + 1
  ) {
    return null;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const tr =
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
            previous.close
        ),

        Math.abs(
          current.low -
            previous.close
        )
      );

    trs.push(tr);
  }

  if (
    trs.length < period
  ) {
    return null;
  }

  let atr = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    atr += trs[i];
  }

  atr /= period;

  for (
    let i = period;
    i < trs.length;
    i++
  ) {
    atr =
      ((atr *
        (period - 1)) +
        trs[i]) /
      period;
  }

  return atr;
}

function calculateVWAP(
  candles
) {
  if (
    !Array.isArray(candles) ||
    !candles.length
  ) {
    return null;
  }

  /*
    VWAP should be session based.
    Since intraday candles are used
    during market hours, this naturally
    represents the current session.
  */

  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (
    const candle of candles
  ) {
    const typicalPrice =
      (candle.high +
        candle.low +
        candle.close) /
      3;

    const volume =
      Number(candle.volume);

    if (
      !Number.isFinite(
        typicalPrice
      )
    ) {
      continue;
    }

    /*
      If volume is unavailable,
      don't manufacture fake volume.
    */
    if (
      !Number.isFinite(volume) ||
      volume <= 0
    ) {
      continue;
    }

    cumulativePV +=
      typicalPrice *
      volume;

    cumulativeVolume +=
      volume;
  }

  if (
    cumulativeVolume <= 0
  ) {
    return null;
  }

  return (
    cumulativePV /
    cumulativeVolume
  );
}

function calculateSupportResistance(
  candles
) {
  if (
    !candles ||
    !candles.length
  ) {
    return {
      support: null,
      resistance: null,
    };
  }

  const recent =
    candles.slice(-20);

  const lows =
    recent.map(
      c => c.low
    );

  const highs =
    recent.map(
      c => c.high
    );

  return {
    support:
      Math.min(...lows),

    resistance:
      Math.max(...highs),
  };
}

function detectStructure(
  candles
) {
  if (
    !candles ||
    candles.length < 6
  ) {
    return "NEUTRAL";
  }

  const last =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  const old =
    candles[
      candles.length - 5
    ];

  if (
    last.high >
      previous.high &&
    previous.high >
      old.high &&
    last.low >
      previous.low &&
    previous.low >
      old.low
  ) {
    return "HH_HL";
  }

  if (
    last.high <
      previous.high &&
    previous.high <
      old.high &&
    last.low <
      previous.low &&
    previous.low <
      old.low
  ) {
    return "LH_LL";
  }

  return "NEUTRAL";
}

/* =====================================================
   TECHNICAL ANALYSIS
===================================================== */

function calculateTechnical(
  candles,
  livePrice
) {
  if (
    !candles ||
    !candles.length
  ) {
    return {
      available: false,
      trend: "UNKNOWN",
      structure: "UNKNOWN",
      ema9: null,
      ema20: null,
      ema50: null,
      rsi: null,
      atr: null,
      vwap: null,
      support: null,
      resistance: null,
      priceVsVWAP: "UNKNOWN",
      momentum: 0,
    };
  }

  const closes =
    candles.map(
      c => c.close
    );

  const ema9 =
    calculateEMA(
      closes,
      9
    );

  const ema20 =
    calculateEMA(
      closes,
      20
    );

  const ema50 =
    calculateEMA(
      closes,
      50
    );

  const rsi =
    calculateRSI(
      closes,
      14
    );

  const atr =
    calculateATR(
      candles,
      14
    );

  const vwap =
    calculateVWAP(
      candles
    );

  const sr =
    calculateSupportResistance(
      candles
    );

  const structure =
    detectStructure(
      candles
    );

  const price =
    Number.isFinite(
      Number(livePrice)
    )
      ? Number(livePrice)
      : closes[
          closes.length - 1
        ];

  let trend =
    "NEUTRAL";

  if (
    ema9 !== null &&
    ema20 !== null &&
    ema50 !== null
  ) {
    if (
      ema9 > ema20 &&
      ema20 > ema50
    ) {
      trend = "BULLISH";
    } else if (
      ema9 < ema20 &&
      ema20 < ema50
    ) {
      trend = "BEARISH";
    }
  }

  let priceVsVWAP =
    "UNKNOWN";

  if (vwap !== null) {
    if (price > vwap) {
      priceVsVWAP =
        "ABOVE";
    } else if (
      price < vwap
    ) {
      priceVsVWAP =
        "BELOW";
    } else {
      priceVsVWAP =
        "AT";
    }
  }

  const lookback =
    Math.min(
      5,
      closes.length - 1
    );

  let momentum = 0;

  if (lookback > 0) {
    momentum =
      price -
      closes[
        closes.length -
          1 -
          lookback
      ];
  }

  return {
    available: true,

    trend,

    structure,

    ema9:
      ema9 !== null
        ? round(ema9, 2)
        : null,

    ema20:
      ema20 !== null
        ? round(ema20, 2)
        : null,

    ema50:
      ema50 !== null
        ? round(ema50, 2)
        : null,

    rsi:
      rsi !== null
        ? round(rsi, 2)
        : null,

    atr:
      atr !== null
        ? round(atr, 2)
        : null,

    vwap:
      vwap !== null
        ? round(vwap, 2)
        : null,

    support:
      sr.support !== null
        ? round(
            sr.support,
            2
          )
        : null,

    resistance:
      sr.resistance !== null
        ? round(
            sr.resistance,
            2
          )
        : null,

    priceVsVWAP,

    momentum:
      round(
        momentum,
        2
      ),
  };
}

/* =====================================================
   OPTION CONTRACTS
===================================================== */

async function fetchOptionContracts(
  index
) {
  const config =
    getIndexConfig(index);

  const response =
    await upstoxGet(
      `${UPSTOX_V2}/option/contract`,
      {
        instrument_key:
          config.instrumentKey,
      }
    );

  const data =
    Array.isArray(
      response.data
    )
      ? response.data
      : [];

  return data;
}

/* =====================================================
   EXPIRY
===================================================== */

function expiryTimestamp(
  expiry
) {
  const t =
    new Date(
      `${expiry}T00:00:00+05:30`
    ).getTime();

  return Number.isFinite(t)
    ? t
    : Infinity;
}

function findNearestExpiry(
  contracts
) {
  const today =
    new Date(
      new Date()
        .toLocaleString(
          "en-US",
          {
            timeZone:
              "Asia/Kolkata",
          }
        )
    );

  today.setHours(
    0,
    0,
    0,
    0
  );

  const todayTime =
    today.getTime();

  const expiries =
    [
      ...new Set(
        contracts
          .map(
            c =>
              c.expiry
          )
          .filter(Boolean)
      ),
    ]
      .sort(
        (a, b) =>
          expiryTimestamp(a) -
          expiryTimestamp(b)
      );

  for (
    const expiry of expiries
  ) {
    if (
      expiryTimestamp(expiry) >=
      todayTime
    ) {
      return expiry;
    }
  }

  return expiries[0] || null;
}

/* =====================================================
   OPTION CHAIN
===================================================== */

function normalizeOptionChain(
  responseData
) {
  if (
    !Array.isArray(
      responseData
    )
  ) {
    return [];
  }

  const rows = [];

  for (
    const item of responseData
  ) {
    if (!item) continue;

    const strike =
      safeNumber(
        item.strike_price ??
          item.strikePrice,
        null
      );

    const call =
      item.call_options ||
      item.call ||
      null;

    const put =
      item.put_options ||
      item.put ||
      null;

    const callMarket =
      call &&
      call.market_data
        ? call.market_data
        : {};

    const putMarket =
      put &&
      put.market_data
        ? put.market_data
        : {};

    const callGreeks =
      call &&
      call.option_greeks
        ? call.option_greeks
        : {};

    const putGreeks =
      put &&
      put.option_greeks
        ? put.option_greeks
        : {};

    const callOi =
      safeNumber(
        callMarket.oi,
        null
      );

    const callPrevOi =
      safeNumber(
        callMarket.prev_oi,
        null
      );

    const putOi =
      safeNumber(
        putMarket.oi,
        null
      );

    const putPrevOi =
      safeNumber(
        putMarket.prev_oi,
        null
      );

    const callChangeOi =
      callOi !== null &&
      callPrevOi !== null
        ? callOi -
          callPrevOi
        : safeNumber(
            callMarket.change_in_oi ??
              callMarket.changeOi,
            null
          );

    const putChangeOi =
      putOi !== null &&
      putPrevOi !== null
        ? putOi -
          putPrevOi
        : safeNumber(
            putMarket.change_in_oi ??
              putMarket.changeOi,
            null
          );

    rows.push({
      strike,

      CE: {
        instrumentKey:
          call?.instrument_key ||
          call?.instrumentKey ||
          null,

        ltp:
          safeNumber(
            callMarket.ltp,
            null
          ),

        closePrice:
          safeNumber(
            callMarket.close_price,
            null
          ),

        volume:
          safeNumber(
            callMarket.volume,
            null
          ),

        oi: callOi,

        prevOi:
          callPrevOi,

        changeOi:
          callChangeOi,

        bid:
          safeNumber(
            callMarket.bid_price,
            null
          ),

        ask:
          safeNumber(
            callMarket.ask_price,
            null
          ),

        delta:
          safeNumber(
            callGreeks.delta,
            null
          ),

        gamma:
          safeNumber(
            callGreeks.gamma,
            null
          ),

        theta:
          safeNumber(
            callGreeks.theta,
            null
          ),

        vega:
          safeNumber(
            callGreeks.vega,
            null
          ),

        iv:
          safeNumber(
            callGreeks.iv,
            null
          ),

        pop:
          safeNumber(
            callGreeks.pop,
            null
          ),
      },

      PE: {
        instrumentKey:
          put?.instrument_key ||
          put?.instrumentKey ||
          null,

        ltp:
          safeNumber(
            putMarket.ltp,
            null
          ),

        closePrice:
          safeNumber(
            putMarket.close_price,
            null
          ),

        volume:
          safeNumber(
            putMarket.volume,
            null
          ),

        oi: putOi,

        prevOi:
          putPrevOi,

        changeOi:
          putChangeOi,

        bid:
          safeNumber(
            putMarket.bid_price,
            null
          ),

        ask:
          safeNumber(
            putMarket.ask_price,
            null
          ),

        delta:
          safeNumber(
            putGreeks.delta,
            null
          ),

        gamma:
          safeNumber(
            putGreeks.gamma,
            null
          ),

        theta:
          safeNumber(
            putGreeks.theta,
            null
          ),

        vega:
          safeNumber(
            putGreeks.vega,
            null
          ),

        iv:
          safeNumber(
            putGreeks.iv,
            null
          ),

        pop:
          safeNumber(
            putGreeks.pop,
            null
          ),
      },
    });
  }

  return rows;
}

/* =====================================================
   OPTION GREEKS
===================================================== */

async function fetchOptionGreeks(
  instrumentKeys
) {
  const uniqueKeys =
    [
      ...new Set(
        instrumentKeys
          .filter(Boolean)
      ),
    ];

  const result = {};

  /*
    Upstox allows a maximum of
    50 instrument keys per request.
  */

  for (
    let i = 0;
    i < uniqueKeys.length;
    i += 50
  ) {
    const batch =
      uniqueKeys.slice(
        i,
        i + 50
      );

    try {
      const response =
        await upstoxGet(
          `${UPSTOX_V3}/market-quote/option-greek`,
          {
            instrument_key:
              batch.join(","),
          }
        );

      const data =
        response &&
        response.data
          ? response.data
          : {};

      for (
        const [key, value]
        of Object.entries(
          data
        )
      ) {
        result[key] =
          value;

        result[
          canonicalKey(key)
        ] = value;
      }
    } catch (error) {
      console.error(
        "OPTION GREEKS ERROR:",
        error.message
      );
    }

    if (
      i + 50 <
      uniqueKeys.length
    ) {
      await sleepSafe(100);
    }
  }

  return result;
}

/* =====================================================
   MERGE GREEKS
===================================================== */

function mergeGreek(
  option,
  greekData
) {
  if (!option) {
    return option;
  }

  const key =
    option.instrumentKey;

  if (!key) {
    return option;
  }

  const exact =
    greekData[key];

  const canonical =
    greekData[
      canonicalKey(key)
    ];

  const greek =
    exact ||
    canonical;

  if (!greek) {
    /*
      Keep option-chain embedded
      Greeks if available.
    */
    return option;
  }

  return {
    ...option,

    ltp:
      greek.last_price ??
      option.ltp,

    delta:
      greek.delta ??
      option.delta,

    gamma:
      greek.gamma ??
      option.gamma,

    theta:
      greek.theta ??
      option.theta,

    vega:
      greek.vega ??
      option.vega,

    iv:
      greek.iv ??
      option.iv,

    oi:
      greek.oi ??
      option.oi,

    volume:
      greek.volume ??
      option.volume,
  };
}

function mergeGreeksIntoRows(
  rows,
  greekData
) {
  return rows.map(row => ({
    ...row,

    CE:
      mergeGreek(
        row.CE,
        greekData
      ),

    PE:
      mergeGreek(
        row.PE,
        greekData
      ),
  }));
}

/* =====================================================
   OPTION CHAIN FETCH
===================================================== */

async function fetchOptionChain(
  index,
  expiry = null
) {
  const config =
    getIndexConfig(index);

  const response =
    await upstoxGet(
      `${UPSTOX_V2}/option/chain`,
      {
        instrument_key:
          config.instrumentKey,

        ...(expiry
          ? {
              expiry_date:
                expiry,
            }
          : {}),
      }
    );

  const rawData =
    Array.isArray(
      response.data
    )
      ? response.data
      : [];

  const selectedExpiry =
    expiry ||
    findNearestExpiry(
      rawData
    );

  let filtered =
    rawData;

  if (selectedExpiry) {
    filtered =
      rawData.filter(
        item =>
          !item.expiry ||
          item.expiry ===
            selectedExpiry
      );
  }

  let rows =
    normalizeOptionChain(
      filtered
    );

  /*
    If the API response itself
    didn't include rows, try raw data.
  */

  if (!rows.length) {
    rows =
      normalizeOptionChain(
        rawData
      );
  }

  /*
    Get Greeks for nearest rows.
  */
  const instrumentKeys = [];

  for (
    const row of rows
  ) {
    if (
      row.CE &&
      row.CE.instrumentKey
    ) {
      instrumentKeys.push(
        row.CE.instrumentKey
      );
    }

    if (
      row.PE &&
      row.PE.instrumentKey
    ) {
      instrumentKeys.push(
        row.PE.instrumentKey
      );
    }
  }

  /*
    Limit to nearest 25 strikes
    around ATM later in analysis.
    For API response we can still
    fetch up to 50.
  */
  const greekKeys =
    instrumentKeys.slice(
      0,
      50
    );

  const greekData =
    greekKeys.length
      ? await fetchOptionGreeks(
          greekKeys
        )
      : {};

  rows =
    mergeGreeksIntoRows(
      rows,
      greekData
    );

  rows.sort(
    (a, b) =>
      safeNumber(a.strike, 0) -
      safeNumber(b.strike, 0)
  );

  return {
    index,

    expiry:
      selectedExpiry,

    rows,

    fetchedAt:
      nowISO(),
  };
}

/* =====================================================
   OPTION SUMMARY
===================================================== */

function optionSummary(
  rows,
  spot,
  strikeStep
) {
  if (
    !Array.isArray(rows) ||
    !rows.length
  ) {
    return {
      available: false,

      pcr: null,

      callOI: 0,
      putOI: 0,

      callChangeOI: 0,
      putChangeOI: 0,

      sentiment: "NEUTRAL",

      atmStrike: null,

      selectedRows: [],
    };
  }

  let callOI = 0;
  let putOI = 0;

  let callChangeOI = 0;
  let putChangeOI = 0;

  for (
    const row of rows
  ) {
    callOI +=
      safeNumber(
        row.CE?.oi,
        0
      );

    putOI +=
      safeNumber(
        row.PE?.oi,
        0
      );

    callChangeOI +=
      safeNumber(
        row.CE?.changeOi,
        0
      );

    putChangeOI +=
      safeNumber(
        row.PE?.changeOi,
        0
      );
  }

  const pcr =
    callOI > 0
      ? putOI / callOI
      : null;

  let sentiment =
    "NEUTRAL";

  if (pcr !== null) {
    if (pcr >= 1.15) {
      sentiment =
        "BULLISH";
    } else if (
      pcr <= 0.85
    ) {
      sentiment =
        "BEARISH";
    }
  }

  const atmStrike =
    strikeStep
      ? Math.round(
          spot / strikeStep
        ) * strikeStep
      : null;

  const selectedRows =
    rows
      .slice()
      .sort(
        (a, b) =>
          Math.abs(
            a.strike -
              atmStrike
          ) -
          Math.abs(
            b.strike -
              atmStrike
          )
      )
      .slice(0, 9)
      .sort(
        (a, b) =>
          a.strike -
          b.strike
      );

  return {
    available: true,

    pcr:
      pcr !== null
        ? round(pcr, 2)
        : null,

    callOI,
    putOI,

    callChangeOI,
    putChangeOI,

    sentiment,

    atmStrike,

    selectedRows,
  };
}

/* =====================================================
   MOVEMENT
===================================================== */

function movementFromPrevious(
  index,
  currentPrice,
  market
) {
  const previous =
    state.previousPrices[
      index
    ];

  const scanPoints =
    previous !== undefined
      ? currentPrice -
        previous
      : 0;

  const sessionPoints =
    safeNumber(
      market?.change,
      0
    );

  const sessionPercent =
    safeNumber(
      market?.changePercent,
      0
    );

  let direction =
    "FLAT";

  const reference =
    Math.abs(
      scanPoints
    ) >=
    Math.abs(
      sessionPoints
    )
      ? scanPoints
      : sessionPoints;

  if (reference > 0) {
    direction =
      "UP";
  } else if (
    reference < 0
  ) {
    direction =
      "DOWN";
  }

  /*
    20 points alone should NOT
    automatically mean a trade.

    It is only movement confirmation.
  */
  const threshold =
    index === "SENSEX"
      ? 60
      : index === "BANKNIFTY"
      ? 40
      : 20;

  const significant =
    Math.abs(
      scanPoints
    ) >= threshold ||
    Math.abs(
      sessionPoints
    ) >= threshold;

  state.previousPrices[
    index
  ] = currentPrice;

  return {
    scanPoints:
      round(
        scanPoints,
        2
      ),

    sessionPoints:
      round(
        sessionPoints,
        2
      ),

    sessionPercent:
      round(
        sessionPercent,
        2
      ),

    direction,

    threshold,

    significant,
  };
}

/* =====================================================
   DIRECTIONAL ENGINE
===================================================== */

function buildDirectionalBias(
  technical,
  options,
  movement
) {
  let bullish = 0;
  let bearish = 0;

  const reasonsBull = [];
  const reasonsBear = [];

  /*
    TREND
  */

  if (
    technical.trend ===
    "BULLISH"
  ) {
    bullish += 2;

    reasonsBull.push(
      "EMA trend bullish"
    );
  }

  if (
    technical.trend ===
    "BEARISH"
  ) {
    bearish += 2;

    reasonsBear.push(
      "EMA trend bearish"
    );
  }

  /*
    STRUCTURE
  */

  if (
    technical.structure ===
    "HH_HL"
  ) {
    bullish += 2;

    reasonsBull.push(
      "Higher-high / higher-low structure"
    );
  }

  if (
    technical.structure ===
    "LH_LL"
  ) {
    bearish += 2;

    reasonsBear.push(
      "Lower-high / lower-low structure"
    );
  }

  /*
    VWAP
  */

  if (
    technical.priceVsVWAP ===
    "ABOVE"
  ) {
    bullish += 1;

    reasonsBull.push(
      "Price above VWAP"
    );
  }

  if (
    technical.priceVsVWAP ===
    "BELOW"
  ) {
    bearish += 1;

    reasonsBear.push(
      "Price below VWAP"
    );
  }

  /*
    RSI
  */

  if (
    technical.rsi !== null
  ) {
    if (
      technical.rsi >= 52 &&
      technical.rsi <= 72
    ) {
      bullish += 1;

      reasonsBull.push(
        "RSI supports bullish momentum"
      );
    }

    if (
      technical.rsi <= 48 &&
      technical.rsi >= 28
    ) {
      bearish += 1;

      reasonsBear.push(
        "RSI supports bearish momentum"
      );
    }
  }

  /*
    MOMENTUM
  */

  if (
    technical.momentum > 0
  ) {
    bullish += 1;

    reasonsBull.push(
      "Short-term momentum positive"
    );
  }

  if (
    technical.momentum < 0
  ) {
    bearish += 1;

    reasonsBear.push(
      "Short-term momentum negative"
    );
  }

  /*
    OPTIONS
  */

  if (
    options.sentiment ===
    "BULLISH"
  ) {
    bullish += 2;

    reasonsBull.push(
      "Option-chain sentiment bullish"
    );
  }

  if (
    options.sentiment ===
    "BEARISH"
  ) {
    bearish += 2;

    reasonsBear.push(
      "Option-chain sentiment bearish"
    );
  }

  /*
    MOVEMENT
  */

  if (
    movement.significant
  ) {
    if (
      movement.direction ===
      "UP"
    ) {
      bullish += 1;

      reasonsBull.push(
        "Price movement confirms upside"
      );
    }

    if (
      movement.direction ===
      "DOWN"
    ) {
      bearish += 1;

      reasonsBear.push(
        "Price movement confirms downside"
      );
    }
  }

  const total =
    bullish +
    bearish;

  let direction =
    "WAIT";

  if (
    bullish >= 6 &&
    bullish > bearish + 1
  ) {
    direction =
      "BUY";
  } else if (
    bearish >= 6 &&
    bearish > bullish + 1
  ) {
    direction =
      "SELL";
  }

  const dominant =
    Math.max(
      bullish,
      bearish
    );

  const confidence =
    clamp(
      Math.round(
        (dominant / 12) *
          100
      ),
      0,
      100
    );

  return {
    direction,

    bullishScore:
      bullish,

    bearishScore:
      bearish,

    confidence,

    bullishReasons:
      reasonsBull,

    bearishReasons:
      reasonsBear,

    confirmations:
      direction === "BUY"
        ? reasonsBull
        : direction === "SELL"
        ? reasonsBear
        : [
            ...new Set([
              ...reasonsBull,
              ...reasonsBear,
            ]),
          ].slice(0, 6),
  };
}

/* =====================================================
   TRADE BUILDER
===================================================== */

function makeTrade(
  index,
  optionType,
  option,
  direction,
  technical,
  confidence
) {
  if (
    !option ||
    option.ltp === null ||
    option.ltp <= 0
  ) {
    return null;
  }

  const entry =
    Number(option.ltp);

  /*
    Option premium risk model.
    This is a predefined algorithmic
    risk model, not a guarantee.
  */

  const stopPercent =
    0.20;

  const sl =
    direction === "BUY"
      ? entry *
        (1 -
          stopPercent)
      : entry *
        (1 +
          stopPercent);

  let t1;
  let t2;
  let t3;

  if (
    direction === "BUY"
  ) {
    t1 =
      entry +
      (entry - sl) *
        1.5;

    t2 =
      entry +
      (entry - sl) *
        2.5;

    t3 =
      entry +
      (entry - sl) *
        3.5;
  } else {
    t1 =
      entry -
      (sl - entry) *
        1.5;

    t2 =
      entry -
      (sl - entry) *
        2.5;

    t3 =
      entry -
      (sl - entry) *
        3.5;
  }

  const risk =
    Math.abs(
      entry - sl
    );

  const reward =
    Math.abs(
      t3 - entry
    );

  const rr =
    risk > 0
      ? reward / risk
      : null;

  return {
    id:
      `${index}-${optionType}-${option.instrumentKey}-${Date.now()}`,

    index,

    type:
      optionType,

    optionType,

    instrumentKey:
      option.instrumentKey,

    strike:
      option.strike ||
      null,

    direction,

    status:
      confidence >= 75
        ? "CONFIRMED"
        : "SETUP",

    entry:
      round(entry, 2),

    sl:
      round(sl, 2),

    stopLoss:
      round(sl, 2),

    target1:
      round(t1, 2),

    target2:
      round(t2, 2),

    target3:
      round(t3, 2),

    t1:
      round(t1, 2),

    t2:
      round(t2, 2),

    t3:
      round(t3, 2),

    rr:
      rr !== null
        ? round(rr, 2)
        : null,

    risk:
      round(risk, 2),

    confidence,

    rsi:
      technical.rsi,

    vwap:
      technical.vwap,

    createdAt:
      nowISO(),

    invalidation:
      direction === "BUY"
        ? `Option premium below SL ${round(
            sl,
            2
          )}`
        : `Option premium above SL ${round(
            sl,
            2
          )}`,
  };
}

/* =====================================================
   BUILD OPTION TRADES
===================================================== */

function buildOptionTrades(
  index,
  optionSummaryData,
  direction,
  technical,
  confidence
) {
  if (
    !optionSummaryData ||
    !optionSummaryData.available
  ) {
    return [];
  }

  if (
    direction !== "BUY" &&
    direction !== "SELL"
  ) {
    return [];
  }

  const rows =
    optionSummaryData.selectedRows ||
    [];

  const optionType =
    direction === "BUY"
      ? "CE"
      : "PE";

  const candidates =
    rows
      .map(row => ({
        row,
        option:
          row[
            optionType
          ],
      }))
      .filter(
        item =>
          item.option &&
          item.option.ltp !==
            null &&
          item.option.ltp > 0
      )
      .sort(
        (a, b) =>
          Math.abs(
            a.row.strike -
              optionSummaryData.atmStrike
          ) -
          Math.abs(
            b.row.strike -
              optionSummaryData.atmStrike
          )
      )
      .slice(0, 3);

  const trades = [];

  for (
    const candidate
    of candidates
  ) {
    const option = {
      ...candidate.option,
      strike:
        candidate.row.strike,
    };

    const trade =
      makeTrade(
        index,
        optionType,
        option,
        "BUY",
        technical,
        confidence
      );

    if (trade) {
      trades.push(trade);
    }
  }

  return trades;
}

/* =====================================================
   FINGERPRINT
===================================================== */

function tradeFingerprint(
  trade
) {
  return [
    trade.index,
    trade.type,
    trade.strike,
    trade.direction,
  ].join("|");
}

function addActiveTrades(
  trades
) {
  for (
    const trade of trades
  ) {
    const fingerprint =
      tradeFingerprint(
        trade
      );

    const exists =
      state.activeTrades.some(
        existing =>
          tradeFingerprint(
            existing
          ) ===
          fingerprint
      );

    if (!exists) {
      state.activeTrades.push(
        trade
      );
    }
  }

  /*
    Keep recent active trades
    manageable.
  */
  if (
    state.activeTrades.length >
    30
  ) {
    state.activeTrades =
      state.activeTrades.slice(
        -30
      );
  }
}

/* =====================================================
   ANALYZE INDEX
===================================================== */

async function analyzeIndex(
  index
) {
  const config =
    getIndexConfig(index);

  const market =
    state.market[index];

  if (
    !market ||
    !market.available ||
    market.price === null
  ) {
    return {
      index,

      name:
        config.name,

      status:
        "NO_DATA",

      signal:
        "WAIT",

      direction:
        "WAIT",

      confidence: 0,

      reason:
        "Live market data unavailable",

      updatedAt:
        nowISO(),
    };
  }

  let candleResult;

  try {
    candleResult =
      await fetchCandles(
        index
      );
  } catch (error) {
    console.error(
      `CANDLE ERROR ${index}:`,
      error.message
    );

    candleResult = {
      candles: [],
      completedCandles: [],
      source: "unavailable",
      latest: null,
    };
  }

  const candles =
    candleResult.completedCandles
      .length
      ? candleResult.completedCandles
      : candleResult.candles;

  const technical =
    calculateTechnical(
      candles,
      market.price
    );

  let optionData;

  try {
    optionData =
      await fetchOptionChain(
        index
      );
  } catch (error) {
    console.error(
      `OPTION CHAIN ERROR ${index}:`,
      error.message
    );

    optionData = {
      expiry: null,
      rows: [],
      fetchedAt: nowISO(),
    };
  }

  const options =
    optionSummary(
      optionData.rows,
      market.price,
      config.strikeStep
    );

  const movement =
    movementFromPrevious(
      index,
      market.price,
      market
    );

  const bias =
    buildDirectionalBias(
      technical,
      options,
      movement
    );

  let status =
    "WAIT";

  if (
    bias.direction !==
    "WAIT"
  ) {
    if (
      bias.confidence >=
      state.settings
        .minConfidence
    ) {
      status =
        "CONFIRMED";
    } else {
      status =
        "SETUP";
    }
  }

  let trades = [];

  if (
    status !== "WAIT" &&
    bias.confidence >=
      state.settings.minConfidence
  ) {
    trades =
      buildOptionTrades(
        index,
        options,
        bias.direction,
        technical,
        bias.confidence
      );
  }

  /*
    All option trades are long
    premium positions:
    BUY CE for bullish
    BUY PE for bearish.
  */

  addActiveTrades(
    trades
  );

  const result = {
    index,

    name:
      config.name,

    status,

    signal:
      bias.direction,

    direction:
      bias.direction,

    confidence:
      bias.confidence,

    bullishScore:
      bias.bullishScore,

    bearishScore:
      bias.bearishScore,

    market: {
      price:
        market.price,

      previousClose:
        market.previousClose,

      change:
        market.change,

      changePercent:
        market.changePercent,

      open:
        market.open,

      high:
        market.high,

      low:
        market.low,

      close:
        market.close,
    },

    technical,

    movement,

    options: {
      expiry:
        optionData.expiry,

      pcr:
        options.pcr,

      sentiment:
        options.sentiment,

      callOI:
        options.callOI,

      putOI:
        options.putOI,

      callChangeOI:
        options.callChangeOI,

      putChangeOI:
        options.putChangeOI,

      atmStrike:
        options.atmStrike,

      chain:
        options.selectedRows,
    },

    confirmations:
      bias.confirmations,

    bullishReasons:
      bias.bullishReasons,

    bearishReasons:
      bias.bearishReasons,

    reasons:
      bias.confirmations,

    entry:
      trades[0]?.entry ||
      null,

    sl:
      trades[0]?.sl ||
      null,

    stopLoss:
      trades[0]?.sl ||
      null,

    target1:
      trades[0]?.t1 ||
      null,

    target2:
      trades[0]?.t2 ||
      null,

    target3:
      trades[0]?.t3 ||
      null,

    t1:
      trades[0]?.t1 ||
      null,

    t2:
      trades[0]?.t2 ||
      null,

    t3:
      trades[0]?.t3 ||
      null,

    rr:
      trades[0]?.rr ||
      null,

    trades,

    invalidation:
      trades[0]?.invalidation ||
      "Wait for confirmation before entry",

    candleSource:
      candleResult.source,

    candleCount:
      candleResult.candles.length,

    completedCandleCount:
      candles.length,

    latestCandle:
      candleResult.latest,

    updatedAt:
      nowISO(),
  };

  state.analysis[
    index
  ] = result;

  return result;
}

/* =====================================================
   NOTIFICATIONS
===================================================== */

async function sendPushNotification(
  payload
) {
  if (
    !state.settings.notifications
  ) {
    return;
  }

  if (
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY
  ) {
    return;
  }

  if (
    !pushSubscriptions.length
  ) {
    return;
  }

  const message =
    JSON.stringify(
      payload
    );

  const dead = [];

  for (
    const subscription
    of pushSubscriptions
  ) {
    try {
      await webpush.sendNotification(
        subscription,
        message
      );
    } catch (error) {
      if (
        error.statusCode ===
          404 ||
        error.statusCode ===
          410
      ) {
        dead.push(
          subscription
        );
      }
    }
  }

  if (dead.length) {
    pushSubscriptions =
      pushSubscriptions.filter(
        sub =>
          !dead.includes(
            sub
          )
      );

    writeJSON(
      SUBSCRIPTIONS_FILE,
      pushSubscriptions
    );
  }
}

const notifiedTrades =
  new Map();

async function notifyTrades(
  trades
) {
  for (
    const trade of trades
  ) {
    const fingerprint =
      tradeFingerprint(
        trade
      );

    const last =
      notifiedTrades.get(
        fingerprint
      );

    const now =
      Date.now();

    if (
      last &&
      now - last <
        15 * 60 * 1000
    ) {
      continue;
    }

    notifiedTrades.set(
      fingerprint,
      now
    );

    await sendPushNotification({
      type:
        "TRADE_SIGNAL",

      title:
        `Era AI — ${trade.index}`,

      body:
        `${trade.type} ${trade.strike} ${trade.direction} | Entry ${trade.entry} | SL ${trade.sl} | T1 ${trade.t1}`,

      trade,
    });
  }
}

const notifiedMoves =
  new Map();

async function notifyMarketMove(
  index,
  market,
  movement
) {
  if (
    !movement.significant
  ) {
    return;
  }

  const bucket =
    Math.floor(
      Date.now() /
        (10 * 60 * 1000)
    );

  const key =
    `${index}-${movement.direction}-${bucket}`;

  if (
    notifiedMoves.has(key)
  ) {
    return;
  }

  notifiedMoves.set(
    key,
    true
  );

  await sendPushNotification({
    type:
      "MARKET_MOVE",

    title:
      `Era AI — ${getIndexName(
        index
      )}`,

    body:
      `${movement.direction} movement detected: ${market.price} (${market.changePercent ?? 0}%)`,

    index,

    market,

    movement,
  });
}

/* =====================================================
   SCANNER
===================================================== */

let scannerTimer = null;
let scannerRunning = false;

async function runAutonomousScan() {
  if (scannerRunning) {
    return;
  }

  scannerRunning = true;

  state.scannerRunning =
    true;

  state.lastScanAt =
    nowISO();

  state.lastScanError =
    null;

  try {
    /*
      Fetch all quotes in one request.
    */
    const quotes =
      await fetchQuotes();

    state.market = {
      ...state.market,
      ...quotes,
    };

    /*
      Extra market data is non-blocking.
    */
    state.extraMarket =
      await fetchExtraMarketData();

    const allResults = [];

    /*
      Sequential processing helps
      avoid Upstox request bursts.
    */

    for (
      const index
      of Object.keys(
        INDEXES
      )
    ) {
      try {
        const result =
          await analyzeIndex(
            index
          );

        allResults.push(
          result
        );

        await notifyMarketMove(
          index,
          state.market[
            index
          ],
          result.movement ||
            {}
        );

        if (
          result.trades &&
          result.trades.length
        ) {
          await notifyTrades(
            result.trades
          );
        }
      } catch (error) {
        console.error(
          `ANALYSIS ERROR ${index}:`,
          error.message
        );

        state.analysis[
          index
        ] = {
          index,

          status:
            "ERROR",

          signal:
            "WAIT",

          direction:
            "WAIT",

          confidence: 0,

          error:
            error.message,

          updatedAt:
            nowISO(),
        };
      }
    }

    state.lastScanSuccessAt =
      nowISO();

    state.lastScanError =
      null;

    saveState();

    /*
      Store compact history.
    */

    history.push({
      timestamp:
        nowISO(),

      market:
        state.market,

      analysis:
        Object.fromEntries(
          allResults.map(
            item => [
              item.index,
              {
                signal:
                  item.signal,

                confidence:
                  item.confidence,

                price:
                  item.market?.price,

                change:
                  item.market?.change,

                changePercent:
                  item.market
                    ?.changePercent,
              },
            ]
          )
        ),
    });

    if (
      history.length >
      500
    ) {
      history =
        history.slice(
          -500
        );
    }

    writeJSON(
      HISTORY_FILE,
      history
    );
  } catch (error) {
    state.lastScanError =
      error.message;

    console.error(
      "SCANNER ERROR:",
      error.message
    );

    saveState();
  } finally {
    scannerRunning =
      false;

    state.scannerRunning =
      false;
  }
}

function startScanner() {
  if (scannerTimer) {
    clearInterval(
      scannerTimer
    );
  }

  if (
    !state.settings.autoScanner
  ) {
    state.engine.running =
      false;

    saveState();

    return;
  }

  state.engine.running =
    true;

  state.engine.startedAt =
    nowISO();

  scannerTimer =
    setInterval(
      () => {
        runAutonomousScan()
          .catch(error =>
            console.error(
              "Scanner loop:",
              error.message
            )
          );
      },
      Math.max(
        30000,
        Number(
          state.settings
            .scanIntervalMs
        ) || 60000
      )
    );

  saveState();

  /*
    Run immediately.
  */
  runAutonomousScan()
    .catch(error =>
      console.error(
        "Initial scanner:",
        error.message
      )
    );
}

function stopScanner() {
  if (scannerTimer) {
    clearInterval(
      scannerTimer
    );

    scannerTimer =
      null;
  }

  state.engine.running =
    false;

  state.engine.stoppedAt =
    nowISO();

  saveState();
}

/* =====================================================
   HEALTH
===================================================== */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      status:
        "healthy",

      service:
        "Era AI",

      version:
        VERSION,

      uptime:
        process.uptime(),

      marketOpen:
        isMarketHours(),

      scannerRunning:
        state.scannerRunning,

      engineRunning:
        state.engine.running,

      timestamp:
        nowISO(),
    });
  }
);

/* =====================================================
   ROOT
===================================================== */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,

      name:
        "Era AI",

      version:
        VERSION,

      status:
        "running",

      endpoints: [
        "/health",
        "/api/market",
        "/api/analysis",
        "/api/signals",
        "/api/trades",
        "/api/scanner",
        "/api/options/contracts",
        "/api/options/chain",
        "/api/options/greeks",
        "/api/history",
        "/api/settings",
        "/api/engine",
        "/api/news",
      ],

      timestamp:
        nowISO(),
    });
  }
);

/* =====================================================
   MARKET
===================================================== */

app.get(
  "/api/market",
  async (req, res) => {
    try {
      const quotes =
        await fetchQuotes();

      state.market = {
        ...state.market,
        ...quotes,
      };

      saveState();

      res.json({
        ok: true,

        version:
          VERSION,

        market:
          state.market,

        extraMarket:
          state.extraMarket ||
          {},

        marketOpen:
          isMarketHours(),

        updatedAt:
          nowISO(),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message,

        market:
          state.market,
      });
    }
  }
);

/* =====================================================
   MARKET REFRESH
===================================================== */

app.post(
  "/api/market/refresh",
  async (req, res) => {
    try {
      const quotes =
        await fetchQuotes();

      state.market = {
        ...state.market,
        ...quotes,
      };

      saveState();

      res.json({
        ok: true,

        market:
          state.market,

        updatedAt:
          nowISO(),
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

/* =====================================================
   ANALYSIS
===================================================== */

app.get(
  "/api/analysis",
  async (req, res) => {
    const requested =
      String(
        req.query.index ||
          ""
      ).toUpperCase();

    /*
      If index supplied, return
      selected analysis.
    */

    if (
      requested &&
      INDEXES[requested]
    ) {
      try {
        /*
          Refresh quote first.
        */
        const quotes =
          await fetchQuotes();

        state.market = {
          ...state.market,
          ...quotes,
        };

        const result =
          await analyzeIndex(
            requested
          );

        saveState();

        return res.json({
          ok: true,

          index:
            requested,

          analysis:
            result,

          market:
            state.market[
              requested
            ],

          updatedAt:
            nowISO(),
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,

          error:
            error.message,

          analysis:
            state.analysis[
              requested
            ] || null,
        });
      }
    }

    /*
      Otherwise return all.
    */

    try {
      const quotes =
        await fetchQuotes();

      state.market = {
        ...state.market,
        ...quotes,
      };

      for (
        const index
        of Object.keys(
          INDEXES
        )
      ) {
        try {
          await analyzeIndex(
            index
          );
        } catch (error) {
          console.error(
            `Analysis ${index}:`,
            error.message
          );
        }
      }

      saveState();

      res.json({
        ok: true,

        analysis:
          state.analysis,

        market:
          state.market,

        updatedAt:
          nowISO(),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message,

        analysis:
          state.analysis,
      });
    }
  }
);

/* =====================================================
   SIGNALS
===================================================== */

app.get(
  "/api/signals",
  (req, res) => {
    const requested =
      String(
        req.query.index ||
          ""
      ).toUpperCase();

    if (
      requested &&
      INDEXES[requested]
    ) {
      const analysis =
        state.analysis[
          requested
        ];

      return res.json({
        ok: true,

        index:
          requested,

        signal:
          analysis?.signal ||
          "WAIT",

        direction:
          analysis?.direction ||
          "WAIT",

        status:
          analysis?.status ||
          "WAIT",

        confidence:
          analysis?.confidence ||
          0,

        entry:
          analysis?.entry ||
          null,

        sl:
          analysis?.sl ||
          null,

        t1:
          analysis?.t1 ||
          null,

        t2:
          analysis?.t2 ||
          null,

        t3:
          analysis?.t3 ||
          null,

        rr:
          analysis?.rr ||
          null,

        confirmations:
          analysis?.confirmations ||
          [],

        invalidation:
          analysis?.invalidation ||
          null,

        updatedAt:
          analysis?.updatedAt ||
          null,
      });
    }

    const signals = {};

    for (
      const index
      of Object.keys(
        INDEXES
      )
    ) {
      const analysis =
        state.analysis[
          index
        ];

      signals[index] = {
        signal:
          analysis?.signal ||
          "WAIT",

        direction:
          analysis?.direction ||
          "WAIT",

        status:
          analysis?.status ||
          "WAIT",

        confidence:
          analysis?.confidence ||
          0,

        entry:
          analysis?.entry ||
          null,

        sl:
          analysis?.sl ||
          null,

        t1:
          analysis?.t1 ||
          null,

        t2:
          analysis?.t2 ||
          null,

        t3:
          analysis?.t3 ||
          null,

        rr:
          analysis?.rr ||
          null,

        updatedAt:
          analysis?.updatedAt ||
          null,
      };
    }

    res.json({
      ok: true,

      signals,
    });
  }
);

/* =====================================================
   TRADES
===================================================== */

app.get(
  "/api/trades",
  (req, res) => {
    const index =
      String(
        req.query.index ||
          ""
      ).toUpperCase();

    let trades =
      state.activeTrades ||
      [];

    if (
      index &&
      INDEXES[index]
    ) {
      trades =
        trades.filter(
          trade =>
            trade.index ===
            index
        );
    }

    res.json({
      ok: true,

      count:
        trades.length,

      trades,

      updatedAt:
        nowISO(),
    });
  }
);

/* =====================================================
   OPTIONS CONTRACTS
===================================================== */

app.get(
  "/api/options/contracts",
  async (req, res) => {
    const index =
      String(
        req.query.index ||
          "NIFTY"
      ).toUpperCase();

    if (!INDEXES[index]) {
      return res.status(400).json({
        ok: false,

        error:
          "Unsupported index",

        supported:
          Object.keys(
            INDEXES
          ),
      });
    }

    try {
      const contracts =
        await fetchOptionContracts(
          index
        );

      res.json({
        ok: true,

        index,

        count:
          contracts.length,

        contracts,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message,

        index,
      });
    }
  }
);

/* =====================================================
   OPTIONS CHAIN
===================================================== */

app.get(
  "/api/options/chain",
  async (req, res) => {
    const index =
      String(
        req.query.index ||
          "NIFTY"
      ).toUpperCase();

    const expiry =
      req.query.expiry ||
      null;

    if (!INDEXES[index]) {
      return res.status(400).json({
        ok: false,

        error:
          "Unsupported index",
      });
    }

    try {
      /*
        Refresh market first.
      */
      if (
        !state.market[index]
      ) {
        const quotes =
          await fetchQuotes();

        state.market = {
          ...state.market,
          ...quotes,
        };
      }

      const result =
        await fetchOptionChain(
          index,
          expiry
        );

      const summary =
        optionSummary(
          result.rows,
          state.market[
            index
          ]?.price || 0,
          INDEXES[index]
            .strikeStep
        );

      res.json({
        ok: true,

        index,

        expiry:
          result.expiry,

        atmStrike:
          summary.atmStrike,

        pcr:
          summary.pcr,

        sentiment:
          summary.sentiment,

        callOI:
          summary.callOI,

        putOI:
          summary.putOI,

        callChangeOI:
          summary.callChangeOI,

        putChangeOI:
          summary.putChangeOI,

        count:
          result.rows.length,

        chain:
          result.rows,

        rows:
          result.rows,

        fetchedAt:
          result.fetchedAt,
      });
    } catch (error) {
      console.error(
        "OPTION CHAIN ROUTE:",
        error.message
      );

      res.status(500).json({
        ok: false,

        index,

        error:
          error.message,

        chain: [],
        rows: [],
      });
    }
  }
);

/* =====================================================
   OPTION GREEKS DIRECT
===================================================== */

app.get(
  "/api/options/greeks",
  async (req, res) => {
    try {
      let keys =
        req.query.instrument_key ||
        req.query.instrumentKey ||
        "";

      if (
        Array.isArray(keys)
      ) {
        keys =
          keys.join(",");
      }

      const instrumentKeys =
        String(keys)
          .split(",")
          .map(
            key =>
              key.trim()
          )
          .filter(Boolean);

      if (
        !instrumentKeys.length
      ) {
        return res.status(400).json({
          ok: false,

          error:
            "instrument_key is required",
        });
      }

      const data =
        await fetchOptionGreeks(
          instrumentKeys
        );

      res.json({
        ok: true,

        count:
          Object.keys(data)
            .length,

        data,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message,

        data: {},
      });
    }
  }
);

/* =====================================================
   CANDLES
===================================================== */

app.get(
  "/api/candles",
  async (req, res) => {
    const index =
      String(
        req.query.index ||
          "NIFTY"
      ).toUpperCase();

    if (!INDEXES[index]) {
      return res.status(400).json({
        ok: false,

        error:
          "Unsupported index",
      });
    }

    try {
      const result =
        await fetchCandles(
          index
        );

      res.json({
        ok: true,

        index,

        source:
          result.source,

        candles:
          result.candles,

        completedCandles:
          result.completedCandles,

        latest:
          result.latest,

        count:
          result.candles.length,

        fetchedAt:
          result.fetchedAt,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message,

        candles: [],
      });
    }
  }
);

/* =====================================================
   SCANNER
===================================================== */

app.get(
  "/api/scanner",
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      running:
        state.scannerRunning,

      engine:
        state.engine,

      lastScanAt:
        state.lastScanAt,

      lastScanSuccessAt:
        state.lastScanSuccessAt,

      lastScanError:
        state.lastScanError,

      intervalMs:
        state.settings
          .scanIntervalMs,

      autoScanner:
        state.settings
          .autoScanner,

      marketOpen:
        isMarketHours(),

      analysis:
        state.analysis,

      updatedAt:
        nowISO(),
    });
  }
);

/* =====================================================
   SCANNER START
===================================================== */

app.post(
  "/api/scanner/start",
  (req, res) => {
    state.settings.autoScanner =
      true;

    startScanner();

    res.json({
      ok: true,

      running:
        state.engine.running,

      message:
        "Era AI scanner started",
    });
  }
);

/* =====================================================
   SCANNER STOP
===================================================== */

app.post(
  "/api/scanner/stop",
  (req, res) => {
    state.settings.autoScanner =
      false;

    stopScanner();

    res.json({
      ok: true,

      running:
        state.engine.running,

      message:
        "Era AI scanner stopped",
    });
  }
);

/* =====================================================
   ENGINE
===================================================== */

app.get(
  "/api/engine",
  (req, res) => {
    res.json({
      ok: true,

      version:
        VERSION,

      engine:
        state.engine,

      running:
        state.engine.running,

      scannerRunning:
        state.scannerRunning,

      lastScanAt:
        state.lastScanAt,

      lastScanSuccessAt:
        state.lastScanSuccessAt,

      lastScanError:
        state.lastScanError,

      updatedAt:
        nowISO(),
    });
  }
);

/* =====================================================
   ENGINE POST
===================================================== */

app.post(
  "/api/engine",
  (req, res) => {
    const action =
      String(
        req.body?.action ||
          ""
      ).toLowerCase();

    if (
      action === "start" ||
      action === "run"
    ) {
      state.settings.autoScanner =
        true;

      startScanner();

      return res.json({
        ok: true,

        running:
          state.engine.running,
      });
    }

    if (
      action === "stop"
    ) {
      state.settings.autoScanner =
        false;

      stopScanner();

      return res.json({
        ok: true,

        running:
          state.engine.running,
      });
    }

    if (
      action === "scan" ||
      action === "refresh"
    ) {
      runAutonomousScan()
        .catch(error =>
          console.error(
            "Manual scan:",
            error.message
          )
        );

      return res.json({
        ok: true,

        message:
          "Scan started",
      });
    }

    res.status(400).json({
      ok: false,

      error:
        "Use action: start, stop or scan",
    });
  }
);

/* =====================================================
   SETTINGS GET
===================================================== */

app.get(
  "/api/settings",
  (req, res) => {
    res.json({
      ok: true,

      settings:
        state.settings,

      version:
        VERSION,
    });
  }
);

/* =====================================================
   SETTINGS POST
===================================================== */

app.post(
  "/api/settings",
  (req, res) => {
    const body =
      req.body || {};

    if (
      body.notifications !==
      undefined
    ) {
      state.settings.notifications =
        Boolean(
          body.notifications
        );
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
        Number.isFinite(value)
      ) {
        state.settings.minConfidence =
          clamp(
            value,
            50,
            95
          );
      }
    }

    if (
      body.scanIntervalMs !==
      undefined
    ) {
      const value =
        Number(
          body.scanIntervalMs
        );

      if (
        Number.isFinite(value)
      ) {
        state.settings.scanIntervalMs =
          clamp(
            value,
            30000,
            300000
          );

        /*
          Restart timer with
          new interval.
        */
        if (
          state.engine.running
        ) {
          startScanner();
        }
      }
    }

    if (
      body.autoScanner !==
      undefined
    ) {
      state.settings.autoScanner =
        Boolean(
          body.autoScanner
        );

      if (
        state.settings.autoScanner
      ) {
        startScanner();
      } else {
        stopScanner();
      }
    }

    saveState();

    res.json({
      ok: true,

      settings:
        state.settings,
    });
  }
);

/* =====================================================
   SELECTED INDEX
===================================================== */

app.get(
  "/api/index",
  (req, res) => {
    res.json({
      ok: true,

      selectedIndex:
        state.selectedIndex,

      supported:
        Object.keys(
          INDEXES
        ),
    });
  }
);

app.post(
  "/api/index",
  (req, res) => {
    const index =
      String(
        req.body?.index ||
          ""
      ).toUpperCase();

    if (!INDEXES[index]) {
      return res.status(400).json({
        ok: false,

        error:
          "Unsupported index",

        supported:
          Object.keys(
            INDEXES
          ),
      });
    }

    state.selectedIndex =
      index;

    saveState();

    res.json({
      ok: true,

      selectedIndex:
        index,
    });
  }
);

/* =====================================================
   HISTORY
===================================================== */

app.get(
  "/api/history",
  (req, res) => {
    const limit =
      clamp(
        Number(
          req.query.limit ||
            100
        ),
        1,
        500
      );

    res.json({
      ok: true,

      history:
        history.slice(
          -limit
        ),

      count:
        Math.min(
          history.length,
          limit
        ),
    });
  }
);

/* =====================================================
   PUSH PUBLIC KEY
===================================================== */

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

/* =====================================================
   PUSH SUBSCRIBE
===================================================== */

app.post(
  "/api/push/subscribe",
  (req, res) => {
    const subscription =
      req.body;

    if (
      !subscription ||
      !subscription.endpoint
    ) {
      return res.status(400).json({
        ok: false,

        error:
          "Invalid subscription",
      });
    }

    const exists =
      pushSubscriptions.some(
        item =>
          item.endpoint ===
          subscription.endpoint
      );

    if (!exists) {
      pushSubscriptions.push(
        subscription
      );

      writeJSON(
        SUBSCRIPTIONS_FILE,
        pushSubscriptions
      );
    }

    res.json({
      ok: true,

      subscribed: true,

      count:
        pushSubscriptions.length,
    });
  }
);

/* =====================================================
   PUSH TEST
===================================================== */

app.post(
  "/api/push/test",
  async (req, res) => {
    try {
      await sendPushNotification({
        type:
          "TEST",

        title:
          "Era AI",

        body:
          "Era AI notification test successful",

        timestamp:
          nowISO(),
      });

      res.json({
        ok: true,

        sent: true,
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

/* =====================================================
   NEWS
===================================================== */

let newsCache = {
  items: [],
  updatedAt: null,
};

async function fetchNews() {
  try {
    const rssUrl =
      "https://news.google.com/rss/search?q=NIFTY%20BANKNIFTY%20Indian%20stock%20market&hl=en-IN&gl=IN&ceid=IN:en";

    const response =
      await axios.get(
        rssUrl,
        {
          timeout: 15000,
          responseType:
            "text",
        }
      );

    const xml =
      response.data || "";

    const items = [];

    const matches =
      xml.match(
        /<item>[\s\S]*?<\/item>/g
      ) || [];

    for (
      const item
      of matches.slice(0, 20)
    ) {
      const title =
        item.match(
          /<title><!\[CDATA\[(.*?)\]\]><\/title>/
        ) ||
        item.match(
          /<title>(.*?)<\/title>/
        );

      const link =
        item.match(
          /<link>(.*?)<\/link>/
        );

      const pubDate =
        item.match(
          /<pubDate>(.*?)<\/pubDate>/
        );

      items.push({
        title:
          title
            ? title[1]
            : "",

        link:
          link
            ? link[1]
            : "",

        publishedAt:
          pubDate
            ? pubDate[1]
            : null,
      });
    }

    newsCache = {
      items,

      updatedAt:
        nowISO(),
    };

    return newsCache;
  } catch (error) {
    console.error(
      "NEWS ERROR:",
      error.message
    );

    return newsCache;
  }
}

app.get(
  "/api/news",
  async (req, res) => {
    try {
      const age =
        newsCache.updatedAt
          ? Date.now() -
            new Date(
              newsCache.updatedAt
            ).getTime()
          : Infinity;

      if (
        age >
        state.settings.newsIntervalMs
      ) {
        await fetchNews();
      }

      res.json({
        ok: true,

        ...newsCache,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,

        error:
          error.message,

        ...newsCache,
      });
    }
  }
);

/* =====================================================
   CHAT / AI
===================================================== */

app.post(
  "/api/chat",
  async (req, res) => {
    const message =
      String(
        req.body?.message ||
          req.body?.prompt ||
          ""
      ).trim();

    if (!message) {
      return res.status(400).json({
        ok: false,

        error:
          "Message is required",
      });
    }

    if (!OPENROUTER_API_KEY) {
      return res.status(503).json({
        ok: false,

        error:
          "OPENROUTER_API_KEY is not configured",
      });
    }

    try {
      const selected =
        state.selectedIndex;

      const market =
        state.market[
          selected
        ];

      const analysis =
        state.analysis[
          selected
        ];

      const systemPrompt = `
You are Era AI, an Indian stock-market analysis assistant.

Current selected index:
${selected}

Market:
${JSON.stringify(
  market || {},
  null,
  2
)}

Current analysis:
${JSON.stringify(
  analysis || {},
  null,
  2
)}

Rules:
- Be concise and clear.
- Do not guarantee profit.
- If confirmation is insufficient, say WAIT.
- Explain entry, SL and targets only when available.
- Never present uncertainty as certainty.
- This is market analysis, not guaranteed financial advice.
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
                role:
                  "system",

                content:
                  systemPrompt,
              },

              {
                role:
                  "user",

                content:
                  message,
              },
            ],

            temperature:
              0.2,
          },
          {
            headers: {
              Authorization:
                `Bearer ${OPENROUTER_API_KEY}`,

              "Content-Type":
                "application/json",
            },

            timeout:
              30000,
          }
        );

      const reply =
        response.data
          ?.choices?.[0]
          ?.message
          ?.content ||
        "No response received.";

      res.json({
        ok: true,

        reply,

        index:
          selected,

        timestamp:
          nowISO(),
      });
    } catch (error) {
      console.error(
        "CHAT ERROR:",
        error.response
          ?.data ||
          error.message
      );

      res.status(500).json({
        ok: false,

        error:
          error.response
            ?.data?.error
            ?.message ||
          error.message,
      });
    }
  }
);

/* =====================================================
   TTS
===================================================== */

app.post(
  "/api/tts",
  (req, res) => {
    /*
      TTS remains frontend/browser
      controlled for now.

      This endpoint intentionally returns
      disabled instead of pretending that
      server-side TTS is configured.
    */

    res.json({
      ok: true,

      enabled: false,

      message:
        "Use browser/client voice engine for Era AI voice output.",
    });
  }
);

/* =====================================================
   PRE-MARKET STATUS
===================================================== */

app.get(
  "/api/premarket",
  (req, res) => {
    const parts =
      indiaTimeParts();

    const currentMinutes =
      parts.hour * 60 +
      parts.minute;

    const premarket =
      isWeekday() &&
      currentMinutes >=
        9 * 60 &&
      currentMinutes <
        9 * 60 + 15;

    res.json({
      ok: true,

      premarket,

      marketOpen:
        isMarketHours(),

      time: parts,

      timestamp:
        nowISO(),
    });
  }
);

/* =====================================================
   DEBUG MARKET
===================================================== */

app.get(
  "/api/debug/market",
  async (req, res) => {
    try {
      const quotes =
        await fetchQuotes();

      res.json({
        ok: true,

        version:
          VERSION,

        marketOpen:
          isMarketHours(),

        quotes,

        timestamp:
          nowISO(),
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

/* =====================================================
   404
===================================================== */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,

      error:
        "Endpoint not found",

      path:
        req.originalUrl,

      version:
        VERSION,
    });
  }
);

/* =====================================================
   GLOBAL ERROR
===================================================== */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "GLOBAL ERROR:",
      error
    );

    if (
      res.headersSent
    ) {
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

/* =====================================================
   START SERVER
===================================================== */

const server =
  app.listen(
    PORT,
    () => {
      console.log(
        "================================================="
      );

      console.log(
        ` ERA AI V${VERSION}`
      );

      console.log(
        ` Server running on port ${PORT}`
      );

      console.log(
        ` Market hours: ${isMarketHours()}`
      );

      console.log(
        ` Upstox token: ${
          UPSTOX_ACCESS_TOKEN
            ? "CONFIGURED"
            : "MISSING"
        }`
      );

      console.log(
        ` OpenRouter: ${
          OPENROUTER_API_KEY
            ? "CONFIGURED"
            : "MISSING"
        }`
      );

      console.log(
        ` Push: ${
          VAPID_PUBLIC_KEY &&
          VAPID_PRIVATE_KEY
            ? "CONFIGURED"
            : "NOT CONFIGURED"
        }`
      );

      console.log(
        "================================================="
      );

      /*
        Start scanner only when
        enabled in settings.
      */
      if (
        state.settings.autoScanner
      ) {
        startScanner();
      }
    }
  );

/* =====================================================
   GRACEFUL SHUTDOWN
===================================================== */

function shutdown(
  signal
) {
  console.log(
    `${signal} received. Shutting down...`
  );

  if (scannerTimer) {
    clearInterval(
      scannerTimer
    );

    scannerTimer =
      null;
  }

  saveState();

  server.close(
    () => {
      process.exit(0);
    }
  );
}

process.on(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);

/* =====================================================
   UNHANDLED ERRORS
===================================================== */

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "UNHANDLED REJECTION:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);
