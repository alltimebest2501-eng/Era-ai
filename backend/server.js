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

const DATA_DIR =
  path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });
}

const DATA_FILE =
  path.join(
    DATA_DIR,
    "era-state.json"
  );

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return;
    }

    const saved =
      JSON.parse(
        fs.readFileSync(
          DATA_FILE,
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
        saved.history.slice(-500);
    }

    if (
      Array.isArray(saved.alerts)
    ) {
      state.alerts =
        saved.alerts.slice(-300);
    }
  } catch (error) {
    console.error(
      "State load error:",
      error.message
    );
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        {
          pushSubscriptions:
            state.pushSubscriptions,

          history:
            state.history,

          alerts:
            state.alerts
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      "State save error:",
      error.message
    );
  }
}

loadState();

/* =========================================================
   UPSTOX REQUEST
   ========================================================= */

async function upstoxRequest(
  url,
  params = {}
) {
  if (!UPSTOX_ACCESS_TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is not configured"
    );
  }

  const response =
    await axios.get(url, {
      params,
      timeout: 20000,

      headers: {
        Accept:
          "application/json",

        Authorization:
          `Bearer ${UPSTOX_ACCESS_TOKEN}`
      }
    });

  return response.data;
}

/* =========================================================
   HELPERS
   ========================================================= */

function round(
  value,
  decimals = 2
) {
  if (
    value === null ||
    value === undefined ||
    Number.isNaN(Number(value))
  ) {
    return null;
  }

  const multiplier =
    10 ** decimals;

  return (
    Math.round(
      Number(value) *
        multiplier
    ) /
    multiplier
  );
}

function safeNumber(
  value,
  fallback = 0
) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
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
  const key =
    String(index || "NIFTY")
      .trim()
      .toUpperCase();

  return INDICES[key]
    ? key
    : "NIFTY";
}

/* =========================================================
   MARKET HOURS
   ========================================================= */

function isMarketHours() {
  const now =
    new Date();

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
    return false;
  }

  const minutes =
    india.getHours() *
      60 +
    india.getMinutes();

  return (
    minutes >= 555 &&
    minutes <= 930
  );
}

/* =========================================================
   MARKET QUOTE NORMALIZATION
   ========================================================= */

function normalizeQuote(
  index,
  raw
) {
  if (!raw) {
    return {
      index,
      available: false,
      error:
        "No quote data"
    };
  }

  const ltp =
    raw.last_price ??
    raw.ltp ??
    raw.last_traded_price ??
    raw.close_price ??
    raw.close ??
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
    (
      previousClose === null ||
      previousClose === undefined ||
      safeNumber(
        previousClose
      ) === 0
    ) &&
    safeNumber(
      netChange
    ) !== 0
  ) {
    previousClose =
      safeNumber(ltp) -
      safeNumber(netChange);
  }

  const change =
    safeNumber(netChange);

  const changePercent =
    previousClose &&
    safeNumber(
      previousClose
    ) !== 0
      ? (
          change /
          safeNumber(
            previousClose
          )
        ) * 100
      : 0;

  return {
    index,

    available: true,

    price: round(ltp),

    previousClose:
      round(previousClose),

    change:
      round(change),

    changePercent:
      round(
        changePercent,
        3
      ),

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
      raw.timestamp ??
      raw.last_trade_time ??
      nowISO()
  };
}

/* =========================================================
   LIVE MARKET DATA
   ========================================================= */

async function fetchQuotes() {
  const response =
    await upstoxRequest(
      "https://api.upstox.com/v2/market-quote/ltp",
      {
        instrument_key:
          Object.values(
            INDICES
          )
            .map(
              item =>
                item.symbol
            )
            .join(",")
      }
    );

  const rawData =
    response.data || {};

  const result = {};

  for (
    const [
      index,
      config
    ] of Object.entries(
      INDICES
    )
  ) {
    let raw = null;

    const possibleKeys = [
      config.symbol,

      config.symbol.replace(
        "|",
        ":"
      ),

      index
    ];

    for (
      const key of possibleKeys
    ) {
      if (rawData[key]) {
        raw =
          rawData[key];
        break;
      }
    }

    if (!raw) {
      const matching =
        Object.entries(
          rawData
        ).find(
          ([key]) =>
            key
              .toUpperCase()
              .includes(index) ||
            key ===
              config.symbol
        );

      if (matching) {
        raw =
          matching[1];
      }
    }

    result[index] =
      normalizeQuote(
        index,
        raw
      );
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
    const response =
      await upstoxRequest(
        "https://api.upstox.com/v2/market-quote/ltp",
        {
          instrument_key: [
            EXTRA_SYMBOLS.GIFT_NIFTY,
            EXTRA_SYMBOLS.INDIA_VIX
          ].join(",")
        }
      );

    const data =
      response.data || {};

    const giftRaw =
      data[
        EXTRA_SYMBOLS
          .GIFT_NIFTY
      ] ||
      data.GIFT_NIFTY ||
      null;

    const vixRaw =
      data[
        EXTRA_SYMBOLS
          .INDIA_VIX
      ] ||
      data.INDIA_VIX ||
      null;

    if (giftRaw) {
      result.GIFT_NIFTY =
        normalizeQuote(
          "GIFT_NIFTY",
          giftRaw
        );
    }

    if (vixRaw) {
      result.INDIA_VIX =
        normalizeQuote(
          "INDIA_VIX",
          vixRaw
        );
    }
  } catch (error) {
    console.warn(
      "Extra market data unavailable:",
      error.message
    );
  }

  return result;
}

/* =========================================================
   HISTORICAL CANDLES — FIXED V3
   ========================================================= */

async function fetchCandles(
  index,
  interval = 5
) {
  const config =
    INDICES[index];

  if (!config) {
    throw new Error(
      `Unsupported index: ${index}`
    );
  }

  if (!UPSTOX_ACCESS_TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is not configured"
    );
  }

  const endDate =
    new Date();

  /*
   * Seven days gives enough
   * 5-minute candles for EMA50,
   * RSI, VWAP and structure.
   */
  const startDate =
    new Date(
      endDate.getTime() -
        7 *
          24 *
          60 *
          60 *
          1000
    );

  const from =
    startDate
      .toISOString()
      .slice(0, 10);

  const to =
    endDate
      .toISOString()
      .slice(0, 10);

  const unit =
    "minutes";

  const candleInterval =
    String(interval);

  const url =
    `https://api.upstox.com/v3/historical-candle/` +
    `${encodeURIComponent(
      config.symbol
    )}/` +
    `${unit}/` +
    `${candleInterval}/` +
    `${to}/` +
    `${from}`;

  try {
    const response =
      await axios.get(
        url,
        {
          timeout: 20000,

          headers: {
            Accept:
              "application/json",

            Authorization:
              `Bearer ${UPSTOX_ACCESS_TOKEN}`
          }
        }
      );

    let candles =
      response.data?.data
        ?.candles || [];

    candles =
      candles.filter(
        candle =>
          Array.isArray(
            candle
          ) &&
          candle.length >= 6 &&
          Number.isFinite(
            Number(
              candle[4]
            )
          )
      );

    /*
     * Oldest -> newest
     */
    candles.sort(
      (a, b) =>
        new Date(
          a[0]
        ).getTime() -
        new Date(
          b[0]
        ).getTime()
    );

    console.log(
      `[ERA] ${index} candles: ${candles.length}`
    );

    if (!candles.length) {
      console.warn(
        `[ERA] No historical candles returned for ${index}`
      );
    }

    return candles;
  } catch (error) {
    console.error(
      `[ERA] Candle error ${index}:`,
      error.response?.data ||
      error.message
    );

    return [];
  }
}

/* =========================================================
   TECHNICAL INDICATORS
   ========================================================= */

function ema(
  values,
  period
) {
  if (
    !values ||
    values.length === 0
  ) {
    return null;
  }

  if (
    values.length < period
  ) {
    return null;
  }

  let result =
    values
      .slice(0, period)
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / period;

  const k =
    2 /
    (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      values[i] * k +
      result * (1 - k);
  }

  return result;
}

function rsi(
  values,
  period = 14
) {
  if (
    !values ||
    values.length <
      period + 1
  ) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  const start =
    values.length -
    period;

  for (
    let i = start;
    i < values.length;
    i++
  ) {
    const diff =
      values[i] -
      values[i - 1];

    if (diff > 0) {
      gains += diff;
    }

    if (diff < 0) {
      losses +=
        Math.abs(diff);
    }
  }

  if (losses === 0) {
    return gains > 0
      ? 100
      : 50;
  }

  const rs =
    gains / losses;

  return (
    100 -
    100 /
      (1 + rs)
  );
}

function calculateVWAP(
  candles
) {
  if (
    !candles ||
    !candles.length
  ) {
    return null;
  }

  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (
    const candle of candles
  ) {
    const high =
      safeNumber(
        candle[2]
      );

    const low =
      safeNumber(
        candle[3]
      );

    const close =
      safeNumber(
        candle[4]
      );

    const volume =
      safeNumber(
        candle[5]
      );

    const typical =
      (
        high +
        low +
        close
      ) / 3;

    cumulativePV +=
      typical * volume;

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

/* =========================================================
   MARKET STRUCTURE
   ========================================================= */

function detectStructure(
  candles
) {
  if (
    !candles ||
    candles.length < 12
  ) {
    return {
      label:
        "INSUFFICIENT_DATA",
      swingHigh: null,
      swingLow: null,
      bos: "NONE",
      choch: "NONE"
    };
  }

  const highs =
    candles.map(
      candle =>
        safeNumber(
          candle[2]
        )
    );

  const lows =
    candles.map(
      candle =>
        safeNumber(
          candle[3]
        )
    );

  const closes =
    candles.map(
      candle =>
        safeNumber(
          candle[4]
        )
    );

  const recentCount =
    Math.min(
      6,
      candles.length
    );

  const previousStart =
    Math.max(
      0,
      candles.length -
        recentCount * 2
    );

  const previousEnd =
    Math.max(
      0,
      candles.length -
        recentCount
    );

  const recentHigh =
    Math.max(
      ...highs.slice(
        -recentCount
      )
    );

  const recentLow =
    Math.min(
      ...lows.slice(
        -recentCount
      )
    );

  const previousHigh =
    Math.max(
      ...highs.slice(
        previousStart,
        previousEnd
      )
    );

  const previousLow =
    Math.min(
      ...lows.slice(
        previousStart,
        previousEnd
      )
    );

  const lastClose =
    closes[
      closes.length - 1
    ];

  let label =
    "RANGE";

  if (
    recentHigh >
      previousHigh &&
    recentLow >
      previousLow
  ) {
    label =
      "HH_HL";
  } else if (
    recentHigh <
      previousHigh &&
    recentLow <
      previousLow
  ) {
    label =
      "LH_LL";
  }

  let bos =
    "NONE";

  if (
    lastClose >
    previousHigh
  ) {
    bos =
      "BULLISH_BOS";
  } else if (
    lastClose <
    previousLow
  ) {
    bos =
      "BEARISH_BOS";
  }

  let choch =
    "NONE";

  if (
    label === "HH_HL" &&
    lastClose <
      previousLow
  ) {
    choch =
      "BEARISH_CHOCH";
  }

  if (
    label === "LH_LL" &&
    lastClose >
      previousHigh
  ) {
    choch =
      "BULLISH_CHOCH";
  }

  return {
    label,

    swingHigh:
      round(recentHigh),

    swingLow:
      round(recentLow),

    bos,

    choch
  };
}

/* =========================================================
   TECHNICAL ANALYSIS
   ========================================================= */

function technicalAnalysis(
  candles,
  price
) {
  if (
    !candles ||
    candles.length < 10
  ) {
    return {
      candleCount:
        candles?.length || 0,

      ema9: null,
      ema20: null,
      ema50: null,

      rsi: 50,

      vwap: null,

      support: null,
      resistance: null,

      trend:
        "NEUTRAL",

      structure:
        "INSUFFICIENT_DATA",

      structureDetails: {
        label:
          "INSUFFICIENT_DATA",
        swingHigh: null,
        swingLow: null,
        bos: "NONE",
        choch: "NONE"
      }
    };
  }

  const closes =
    candles.map(
      c =>
        safeNumber(c[4])
    );

  const highs =
    candles.map(
      c =>
        safeNumber(c[2])
    );

  const lows =
    candles.map(
      c =>
        safeNumber(c[3])
    );

  const ema9 =
    ema(
      closes,
      9
    );

  const ema20 =
    ema(
      closes,
      20
    );

  const ema50 =
    ema(
      closes,
      50
    );

  const currentRSI =
    rsi(
      closes,
      14
    );

  const vwap =
    calculateVWAP(
      candles
    );

  const recent =
    Math.min(
      30,
      candles.length
    );

  const support =
    Math.min(
      ...lows.slice(
        -recent
      )
    );

  const resistance =
    Math.max(
      ...highs.slice(
        -recent
      )
    );

  let trend =
    "NEUTRAL";

  if (
    ema9 !== null &&
    ema20 !== null &&
    ema50 !== null
  ) {
    if (
      price > ema9 &&
      ema9 > ema20 &&
      ema20 > ema50
    ) {
      trend =
        "BULLISH";
    } else if (
      price < ema9 &&
      ema9 < ema20 &&
      ema20 < ema50
    ) {
      trend =
        "BEARISH";
    }
  }

  const structureDetails =
    detectStructure(
      candles
    );

  return {
    candleCount:
      candles.length,

    ema9:
      round(ema9),

    ema20:
      round(ema20),

    ema50:
      round(ema50),

    rsi:
      round(currentRSI),

    vwap:
      round(vwap),

    support:
      round(support),

    resistance:
      round(resistance),

    trend,

    structure:
      structureDetails.label,

    structureDetails
  };
}

/* =========================================================
   OPTION CONTRACTS
   ========================================================= */

async function fetchOptionContracts(
  index
) {
  const config =
    INDICES[index];

  if (!config) {
    throw new Error(
      "Unsupported index"
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

  return response.data || [];
}

/* =========================================================
   EXPIRY FINDER
   ========================================================= */

async function findNearestExpiry(
  index
) {
  const contracts =
    await fetchOptionContracts(
      index
    );

  const today =
    new Date();

  today.setHours(
    0,
    0,
    0,
    0
  );

  const expiries = [
    ...new Set(
      contracts
        .map(
          item =>
            item.expiry
        )
        .filter(Boolean)
    )
  ];

  const valid =
    expiries
      .filter(
        date =>
          new Date(
            date
          ).getTime() >=
          today.getTime()
      )
      .sort(
        (a, b) =>
          new Date(a).getTime() -
          new Date(b).getTime()
      );

  return valid[0] || null;
}

/* =========================================================
   OPTION CHAIN
   ========================================================= */

async function fetchOptionChain(
  index,
  expiryDate = null
) {
  const config =
    INDICES[index];

  if (!config) {
    throw new Error(
      `Unsupported index ${index}`
    );
  }

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
      `No valid option expiry found for ${index}`
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

/* =========================================================
   OPTION GREEKS — V3
   ========================================================= */

async function fetchOptionGreeks(
  instrumentKeys
) {
  if (
    !instrumentKeys ||
    !instrumentKeys.length
  ) {
    return {};
  }

  const uniqueKeys =
    [
      ...new Set(
        instrumentKeys
          .filter(Boolean)
      )
    ].slice(0, 50);

  if (!uniqueKeys.length) {
    return {};
  }

  try {
    const response =
      await upstoxRequest(
        "https://api.upstox.com/v3/market-quote/option-greek",
        {
          instrument_key:
            uniqueKeys.join(",")
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

/* =========================================================
   OPTION NORMALIZATION
   ========================================================= */

function normalizeOptionChain(
  rawChain,
  index
) {
  const rows = [];

  for (
    const item of rawChain || []
  ) {
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

    const ceMarket =
      call.market_data ||
      call.marketData ||
      call;

    const peMarket =
      put.market_data ||
      put.marketData ||
      put;

    const ceGreeks =
      call.option_greeks ||
      call.optionGreeks ||
      ceMarket.option_greeks ||
      ceMarket.optionGreeks ||
      {};

    const peGreeks =
      put.option_greeks ||
      put.optionGreeks ||
      peMarket.option_greeks ||
      peMarket.optionGreeks ||
      {};

    rows.push({
      index,

      strikePrice:
        safeNumber(strike),

      CE: {
        instrumentKey:
          call.instrument_key ||
          call.instrumentKey ||
          null,

        ltp:
          round(
            ceMarket.ltp ??
            ceMarket.last_price ??
            0
          ),

        oi:
          safeNumber(
            ceMarket.oi ??
            ceMarket.open_interest ??
            0
          ),

        changeOi:
          safeNumber(
            ceMarket.change_in_oi ??
            ceMarket.changeOi ??
            0
          ),

        volume:
          safeNumber(
            ceMarket.volume ??
            0
          ),

        iv:
          round(
            ceMarket.iv ??
            ceMarket.implied_volatility ??
            ceGreeks.iv ??
            ceGreeks.implied_volatility ??
            0
          ),

        delta:
          round(
            ceGreeks.delta ??
            ceMarket.delta ??
            0,
            4
          ),

        gamma:
          round(
            ceGreeks.gamma ??
            ceMarket.gamma ??
            0,
            6
          ),

        theta:
          round(
            ceGreeks.theta ??
            ceMarket.theta ??
            0,
            4
          ),

        vega:
          round(
            ceGreeks.vega ??
            ceMarket.vega ??
            0,
            4
          ),

        rho:
          round(
            ceGreeks.rho ??
            ceMarket.rho ??
            0,
            4
          )
      },

      PE: {
        instrumentKey:
          put.instrument_key ||
          put.instrumentKey ||
          null,

        ltp:
          round(
            peMarket.ltp ??
            peMarket.last_price ??
            0
          ),

        oi:
          safeNumber(
            peMarket.oi ??
            peMarket.open_interest ??
            0
          ),

        changeOi:
          safeNumber(
            peMarket.change_in_oi ??
            peMarket.changeOi ??
            0
          ),

        volume:
          safeNumber(
            peMarket.volume ??
            0
          ),

        iv:
          round(
            peMarket.iv ??
            peMarket.implied_volatility ??
            peGreeks.iv ??
            peGreeks.implied_volatility ??
            0
          ),

        delta:
          round(
            peGreeks.delta ??
            peMarket.delta ??
            0,
            4
          ),

        gamma:
          round(
            peGreeks.gamma ??
            peMarket.gamma ??
            0,
            6
          ),

        theta:
          round(
            peGreeks.theta ??
            peMarket.theta ??
            0,
            4
          ),

        vega:
          round(
            peGreeks.vega ??
            peMarket.vega ??
            0,
            4
          ),

        rho:
          round(
            peGreeks.rho ??
            peMarket.rho ??
            0,
            4
          )
      }
    });
  }

  return rows
    .filter(
      row =>
        row.strikePrice > 0
    )
    .sort(
      (a, b) =>
        a.strikePrice -
        b.strikePrice
    );
}

/* =========================================================
   OPTION SUMMARY
   ========================================================= */

function optionSummary(
  rows,
  spot
) {
  if (!rows.length) {
    return {
      pcr: null,
      sentiment:
        "NEUTRAL",
      atmStrike: null,
      maxCallOI: null,
      maxPutOI: null
    };
  }

  const callsOI =
    rows.reduce(
      (sum, row) =>
        sum +
        safeNumber(
          row.CE.oi
        ),
      0
    );

  const putsOI =
    rows.reduce(
      (sum, row) =>
        sum +
        safeNumber(
          row.PE.oi
        ),
      0
    );

  const pcr =
    callsOI > 0
      ? putsOI / callsOI
      : null;

  const atm =
    rows.reduce(
      (closest, row) => {
        if (!closest) {
          return row;
        }

        return (
          Math.abs(
            row.strikePrice -
              spot
          ) <
          Math.abs(
            closest.strikePrice -
              spot
          )
            ? row
            : closest
        );
      },
      null
    );

  const maxCall =
    rows.reduce(
      (best, row) =>
        !best ||
        row.CE.oi >
          best.CE.oi
          ? row
          : best,
      null
    );

  const maxPut =
    rows.reduce(
      (best, row) =>
        !best ||
        row.PE.oi >
          best.PE.oi
          ? row
          : best,
      null
    );

  let sentiment =
    "NEUTRAL";

  if (
    pcr !== null &&
    pcr >= 1.05
  ) {
    sentiment =
      "BULLISH";
  }

  if (
    pcr !== null &&
    pcr <= 0.80
  ) {
    sentiment =
      "BEARISH";
  }

  return {
    pcr:
      round(
        pcr,
        3
      ),

    sentiment,

    atmStrike:
      atm?.strikePrice ||
      null,

    maxCallOI:
      maxCall
        ? {
            strike:
              maxCall.strikePrice,

            oi:
              maxCall.CE.oi
          }
        : null,

    maxPutOI:
      maxPut
        ? {
            strike:
              maxPut.strikePrice,

            oi:
              maxPut.PE.oi
          }
        : null
  };
}

/* =========================================================
   MOVEMENT ENGINE
   ========================================================= */

function movementFromPrevious(
  index,
  currentPrice
) {
  const previous =
    state.previousPrices[
      index
    ];

  if (!previous) {
    state.previousPrices[
      index
    ] = currentPrice;

    return {
      points: 0,
      percent: 0,
      significant: false,
      direction:
        "NONE"
    };
  }

  const points =
    currentPrice -
    previous;

  const absPoints =
    Math.abs(points);

  const percent =
    previous !== 0
      ? (
          points /
          previous
        ) * 100
      : 0;

  state.previousPrices[
    index
  ] = currentPrice;

  return {
    points:
      round(points),

    percent:
      round(
        percent,
        3
      ),

    significant:
      absPoints >=
      state.settings
        .movementThreshold,

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

  if (
    Math.abs(
      movement.points
    ) >=
    state.settings
      .movementThreshold
  ) {
    score += 8;

    reasons.push(
      `${state.settings.movementThreshold}+ point movement detected`
    );
  } else {
    risks.push(
      "20+ point movement not confirmed"
    );
  }

  if (
    direction === "BUY" &&
    technical.trend ===
      "BULLISH"
  ) {
    score += 10;

    reasons.push(
      "Bullish EMA trend"
    );
  }

  if (
    direction === "SELL" &&
    technical.trend ===
      "BEARISH"
  ) {
    score += 10;

    reasons.push(
      "Bearish EMA trend"
    );
  }

  if (
    direction === "BUY" &&
    technical.trend ===
      "BEARISH"
  ) {
    score -= 10;

    risks.push(
      "Trend conflict"
    );
  }

  if (
    direction === "SELL" &&
    technical.trend ===
      "BULLISH"
  ) {
    score -= 10;

    risks.push(
      "Trend conflict"
    );
  }

  if (
    direction === "BUY" &&
    technical.structure ===
      "HH_HL"
  ) {
    score += 8;

    reasons.push(
      "Higher-high / higher-low structure"
    );
  }

  if (
    direction === "SELL" &&
    technical.structure ===
      "LH_LL"
  ) {
    score += 8;

    reasons.push(
      "Lower-high / lower-low structure"
    );
  }

  if (technical.vwap) {
    score += 3;

    reasons.push(
      "VWAP available for confirmation"
    );
  }

  if (
    direction === "BUY"
  ) {
    if (
      technical.rsi >= 50 &&
      technical.rsi <= 70
    ) {
      score += 6;

      reasons.push(
        "RSI supports bullish momentum"
      );
    }

    if (
      technical.rsi > 75
    ) {
      score -= 4;

      risks.push(
        "RSI overheated"
      );
    }
  }

  if (
    direction === "SELL"
  ) {
    if (
      technical.rsi >= 30 &&
      technical.rsi < 50
    ) {
      score += 6;

      reasons.push(
        "RSI supports bearish momentum"
      );
    }

    if (
      technical.rsi < 25
    ) {
      score -= 4;

      risks.push(
        "RSI oversold"
      );
    }
  }

  if (optionSummaryData) {
    if (
      direction === "BUY" &&
      optionSummaryData.sentiment ===
        "BULLISH"
    ) {
      score += 8;

      reasons.push(
        "Options sentiment supportive"
      );
    }

    if (
      direction === "SELL" &&
      optionSummaryData.sentiment ===
        "BEARISH"
    ) {
      score += 8;

      reasons.push(
        "Options sentiment supportive"
      );
    }

    if (
      direction === "BUY" &&
      optionSummaryData.sentiment ===
        "BEARISH"
    ) {
      score -= 6;

      risks.push(
        "Options sentiment conflicts"
      );
    }

    if (
      direction === "SELL" &&
      optionSummaryData.sentiment ===
        "BULLISH"
    ) {
      score -= 6;

      risks.push(
        "Options sentiment conflicts"
      );
    }
  }

  score =
    Math.round(
      clamp(
        score,
        20,
        95
      )
    );

  let suggestion =
    "WAIT";

  if (
    score >= 75
  ) {
    suggestion =
      "TRADE CONSIDER";
  } else if (
    score >= 60
  ) {
    suggestion =
      "WAIT FOR CONFIRMATION";
  } else {
    suggestion =
      "AVOID / NO TRADE";
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

function selectRelevantStrikes(
  rows,
  spot,
  count = 9
) {
  if (!rows.length) {
    return [];
  }

  return [...rows]
    .sort(
      (a, b) =>
        Math.abs(
          a.strikePrice -
            spot
        ) -
        Math.abs(
          b.strikePrice -
            spot
        )
    )
    .slice(
      0,
      count
    );
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
  if (
    !market?.available ||
    !market.price
  ) {
    return [];
  }

  if (
    !movement.significant
  ) {
    return [];
  }

  const spot =
    market.price;

  const underlyingDirection =
    movement.direction;

  const optionType =
    underlyingDirection ===
    "UP"
      ? "CE"
      : underlyingDirection ===
        "DOWN"
      ? "PE"
      : null;

  if (!optionType) {
    return [];
  }

  const strikes =
    selectRelevantStrikes(
      rows,
      spot,
      9
    );

  const trades = [];

  for (
    const row of strikes
  ) {
    const option =
      row[optionType];

    if (
      !option ||
      !option.ltp ||
      option.ltp <= 0
    ) {
      continue;
    }

    const confidence =
      calculateConfidence({
        direction:
          underlyingDirection ===
          "UP"
            ? "BUY"
            : "SELL",

        movement,

        technical,

        optionSummaryData
      });

    const entry =
      safeNumber(
        option.ltp
      );

    if (!entry) {
      continue;
    }

    const stopPercent =
      confidence.score >=
      75
        ? 0.17
        : 0.20;

    const stopLoss =
      entry *
      (1 - stopPercent);

    const risk =
      entry -
      stopLoss;

    const t1 =
      entry +
      risk * 1.5;

    const t2 =
      entry +
      risk * 2.5;

    const t3 =
      entry +
      risk * 3.5;

    trades.push({
      id:
        `${index}-` +
        `${row.strikePrice}-` +
        `${optionType}-` +
        `${Date.now()}-` +
        `${Math.random()
          .toString(36)
          .slice(2, 7)}`,

      createdAt:
        nowISO(),

      index,

      strikePrice:
        row.strikePrice,

      optionType,

      signal:
        "BUY",

      underlyingDirection,

      movement: {
        points:
          movement.points,

        percent:
          movement.percent,

        direction:
          movement.direction
      },

      entry:
        round(entry),

      stopLoss:
        round(stopLoss),

      targets: {
        T1:
          round(t1),

        T2:
          round(t2),

        T3:
          round(t3)
      },

      rr: 3.5,

      confidence:
        confidence.score,

      confidenceReasons:
        confidence.reasons,

      risks:
        confidence.risks,

      suggestion:
        confidence.suggestion,

      status:
        confidence.score >=
        75
          ? "CONFIRMED"
          : "SETUP",

      invalidation:
        `Option price below ₹${round(
          stopLoss
        )}`,

      source:
        "ERA_AUTONOMOUS_SCANNER"
    });
  }

  return trades.filter(
    trade =>
      trade.confidence >=
      state.settings
        .minConfidence
  );
}

/* =========================================================
   ANALYSIS BUILDER
   ========================================================= */

async function analyzeIndex(
  index
) {
  const market =
    state.market[index];

  if (
    !market?.available
  ) {
    return {
      index,
      available: false,
      signal: "WAIT"
    };
  }

  /*
   * FIX:
   * Upstox V3 uses:
   * minutes / 5
   */
  const candles =
    await fetchCandles(
      index,
      5
    );

  const technical =
    technicalAnalysis(
      candles,
      market.price
    );

  let optionRows = [];

  let optionSummaryData =
    null;

  let selectedExpiry =
    null;

  try {
    const chainResult =
      await fetchOptionChain(
        index
      );

    selectedExpiry =
      chainResult.expiry;

    optionRows =
      normalizeOptionChain(
        chainResult.data,
        index
      );

    /*
     * Fetch Greeks separately
     * for relevant instruments.
     */
    const greekKeys = [];

    for (
      const row of optionRows
    ) {
      if (
        row.CE?.instrumentKey
      ) {
        greekKeys.push(
          row.CE.instrumentKey
        );
      }

      if (
        row.PE?.instrumentKey
      ) {
        greekKeys.push(
          row.PE.instrumentKey
        );
      }
    }

    const greekData =
      await fetchOptionGreeks(
        greekKeys
      );

    /*
     * Merge V3 Greeks.
     */
    for (
      const row of optionRows
    ) {
      const ceKey =
        row.CE
          ?.instrumentKey;

      const peKey =
        row.PE
          ?.instrumentKey;

      const ce =
        ceKey
          ? greekData[
              ceKey
            ]
          : null;

      const pe =
        peKey
          ? greekData[
              peKey
            ]
          : null;

      if (ce) {
        row.CE.delta =
          round(
            ce.delta ??
              row.CE.delta,
            4
          );

        row.CE.gamma =
          round(
            ce.gamma ??
              row.CE.gamma,
            6
          );

        row.CE.theta =
          round(
            ce.theta ??
              row.CE.theta,
            4
          );

        row.CE.vega =
          round(
            ce.vega ??
              row.CE.vega,
            4
          );

        row.CE.iv =
          round(
            ce.iv ??
              row.CE.iv,
            4
          );
      }

      if (pe) {
        row.PE.delta =
          round(
            pe.delta ??
              row.PE.delta,
            4
          );

        row.PE.gamma =
          round(
            pe.gamma ??
              row.PE.gamma,
            6
          );

        row.PE.theta =
          round(
            pe.theta ??
              row.PE.theta,
            4
          );

        row.PE.vega =
          round(
            pe.vega ??
              row.PE.vega,
            4
          );

        row.PE.iv =
          round(
            pe.iv ??
              row.PE.iv,
            4
          );
      }
    }

    optionSummaryData =
      optionSummary(
        optionRows,
        market.price
      );
  } catch (error) {
    console.warn(
      `Option chain unavailable ${index}:`,
      error.message
    );
  }

  const movement =
    movementFromPrevious(
      index,
      market.price
    );

  let signal =
    "WAIT";

  let direction =
    null;

  if (
    movement.significant
  ) {
    if (
      movement.direction ===
      "UP"
    ) {
      signal =
        "BUY";

      direction =
        "BUY";
    } else if (
      movement.direction ===
      "DOWN"
    ) {
      signal =
        "SELL";

      direction =
        "SELL";
    }
  }

  const confidence =
    direction
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

          suggestion:
            "WAIT"
        };

  const trades =
    direction &&
    optionRows.length
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

    candles: {
      interval:
        "5minute",

      count:
        candles.length,

      latest:
        candles.length
          ? candles[
              candles.length -
                1
            ][0]
          : null
    },

    movement,

    technical,

    options: {
      expiry:
        selectedExpiry,

      summary:
        optionSummaryData,

      relevantStrikes:
        selectRelevantStrikes(
          optionRows,
          market.price,
          9
        )
    },

    signal,

    confidence:
      confidence.score,

    confidenceReasons:
      confidence.reasons,

    risks:
      confidence.risks,

    suggestion:
      confidence.suggestion,

    trades,

    generatedAt:
      nowISO()
  };
}

/* =========================================================
   ALERT DEDUPLICATION
   ========================================================= */

function tradeFingerprint(
  trade
) {
  return [
    trade.index,

    trade.strikePrice,

    trade.optionType,

    trade.signal
  ].join("|");
}

function shouldAlertTrade(
  trade
) {
  const fingerprint =
    tradeFingerprint(
      trade
    );

  const previous =
    state.previousSignals[
      fingerprint
    ];

  const currentState =
    [
      trade.status,

      trade.confidence >=
      75
        ? "HIGH"
        : "NORMAL",

      trade.suggestion
    ].join("|");

  if (
    previous ===
    currentState
  ) {
    return false;
  }

  state.previousSignals[
    fingerprint
  ] = currentState;

  return true;
}

/* =========================================================
   PUSH NOTIFICATIONS
   ========================================================= */

async function sendPushNotification(
  payload
) {
  if (
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY
  ) {
    console.warn(
      "Push notification skipped: VAPID keys not configured"
    );

    return;
  }

  if (
    !state.pushSubscriptions
      .length
  ) {
    return;
  }

  const message =
    JSON.stringify(
      payload
    );

  const expired = [];

  for (
    let i = 0;
    i <
    state
      .pushSubscriptions
      .length;
    i++
  ) {
    const subscription =
      state.pushSubscriptions[
        i
      ];

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
    let i =
      expired.length - 1;
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

async function notifyTrade(
  trade
) {
  const title =
    `Era AI — ${trade.index} ${trade.strikePrice} ${trade.optionType}`;

  const body =
    `${trade.signal} | ` +
    `Entry ₹${trade.entry} | ` +
    `SL ₹${trade.stopLoss} | ` +
    `T1 ₹${trade.targets.T1} | ` +
    `T2 ₹${trade.targets.T2} | ` +
    `T3 ₹${trade.targets.T3} | ` +
    `Confidence ${trade.confidence}% | ` +
    `${trade.suggestion}`;

  const payload = {
    type:
      "TRADE_ALERT",

    title,

    body,

    trade
  };

  state.alerts.push({
    id:
      trade.id,

    type:
      "TRADE_ALERT",

    createdAt:
      nowISO(),

    trade
  });

  state.alerts =
    state.alerts.slice(
      -300
    );

  saveState();

  await sendPushNotification(
    payload
  );
}

/* =========================================================
   MARKET MOVE ALERT
   ========================================================= */

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

  const fingerprint =
    `MOVE|${index}|${movement.direction}`;

  const previous =
    state.previousSignals[
      fingerprint
    ];

  const bucket =
    Math.floor(
      Math.abs(
        movement.points
      ) /
        state.settings
          .movementThreshold
    );

  const stateKey =
    `${movement.direction}|${bucket}`;

  if (
    previous ===
    stateKey
  ) {
    return;
  }

  state.previousSignals[
    fingerprint
  ] = stateKey;

  await sendPushNotification({
    type:
      "MARKET_MOVE",

    title:
      `Era AI — ${index} Major Move`,

    body:
      `${movement.direction} ${Math.abs(
        movement.points
      )} points | Price ₹${market.price}`,

    index,

    market,

    movement,

    createdAt:
      nowISO()
  });
}

/* =========================================================
   MARKET OPEN/CLOSE
   ========================================================= */

let previousMarketOpenState =
  null;

async function monitorMarketState() {
  const open =
    isMarketHours();

  if (
    previousMarketOpenState ===
    null
  ) {
    previousMarketOpenState =
      open;

    return;
  }

  if (
    open &&
    !previousMarketOpenState
  ) {
    await sendPushNotification({
      type:
        "MARKET_OPEN",

      title:
        "Era AI — Market Open",

      body:
        "Indian market monitoring has started. Era Radar is scanning NIFTY, BANKNIFTY, FINNIFTY and SENSEX.",

      createdAt:
        nowISO()
    });
  }

  if (
    !open &&
    previousMarketOpenState
  ) {
    await sendPushNotification({
      type:
        "MARKET_CLOSE",

      title:
        "Era AI — Market Closed",

      body:
        "Market monitoring session completed. Era is preparing the next-day watchlist.",

      createdAt:
        nowISO()
    });
  }

  previousMarketOpenState =
    open;
}

/* =========================================================
   AUTONOMOUS SCANNER
   ========================================================= */

let scannerBusy =
  false;

async function runAutonomousScan() {
  if (scannerBusy) {
    return;
  }

  scannerBusy =
    true;

  try {
    await monitorMarketState();

    if (
      !isMarketHours()
    ) {
      state.lastScan =
        nowISO();

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

    for (
      const index of
        Object.keys(
          INDICES
        )
    ) {
      try {
        const analysis =
          await analyzeIndex(
            index
          );

        analyses[index] =
          analysis;

        state.analysis[index] =
          analysis;

        const market =
          state.market[index];

        if (
          market?.available
        ) {
          await notifyMarketMove(
            index,

            market,

            analysis.movement
          );
        }

        for (
          const trade of
            analysis.trades ||
            []
        ) {
          if (
            shouldAlertTrade(
              trade
            )
          ) {
            state.activeTrades.push(
              trade
            );

            state.activeTrades =
              state.activeTrades.slice(
                -200
              );

            await notifyTrade(
              trade
            );
          }
        }
      } catch (error) {
        console.error(
          `Analysis error ${index}:`,
          error.message
        );
      }
    }

    state.lastScan =
      nowISO();

    state.lastSuccess =
      nowISO();

    state.lastError =
      null;

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
    scannerBusy =
      false;
  }
}

/* =========================================================
   NEWS
   ========================================================= */

function decodeXml(
  value = ""
) {
  return value
    .replace(
      /<!\[CDATA\[/g,
      ""
    )
    .replace(
      /\]\]>/g,
      ""
    )
    .replace(
      /&amp;/g,
      "&"
    )
    .replace(
      /&quot;/g,
      '"'
    )
    .replace(
      /&#39;/g,
      "'"
    )
    .replace(
      /&lt;/g,
      "<"
    )
    .replace(
      /&gt;/g,
      ">"
    );
}

async function fetchNews() {
  try {
    const response =
      await axios.get(
        "https://news.google.com/rss/search",
        {
          params: {
            q:
              "Nifty OR BankNifty OR Sensex OR Indian stock market",

            hl:
              "en-IN",

            gl:
              "IN",

            ceid:
              "IN:en"
          },

          timeout:
            15000
        }
      );

    const xml =
      response.data || "";

    const items = [];

    const blocks =
      xml.match(
        /<item>[\s\S]*?<\/item>/g
      ) || [];

    for (
      const block of
        blocks.slice(
          0,
          20
        )
    ) {
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

      if (!title) {
        continue;
      }

      items.push({
        title:
          decodeXml(
            title
          ),

        link:
          decodeXml(
            link
          ),

        publishedAt:
          pubDate,

        source:
          decodeXml(
            source
          )
      });
    }

    state.news =
      items;

    state.lastNewsFetch =
      nowISO();

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
   HEALTH
   ========================================================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "Era AI",

      version:
        VERSION,

      upstoxConfigured:
        Boolean(
          UPSTOX_ACCESS_TOKEN
        ),

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
  }
);

/* =========================================================
   ROOT
   ========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      service:
        "Era AI",

      version:
        VERSION,

      status:
        "online",

      engine:
        state.engineRunning
          ? "RUNNING"
          : "STOPPED"
    });
  }
);

/* =========================================================
   MARKET
   ========================================================= */

app.get(
  "/api/market",
  async (req, res) => {
    try {
      const quotes =
        await fetchQuotes();

      state.market = {
        ...state.market,
        ...quotes
      };

      res.json({
        success:
          true,

        market:
          state.market,

        timestamp:
          nowISO()
      });
    } catch (error) {
      res.status(500).json({
        success:
          false,

        error:
          error.response?.data ||
          error.message,

        market:
          state.market
      });
    }
  }
);

/* =========================================================
   ANALYSIS
   ========================================================= */

app.get(
  "/api/analysis",
  async (req, res) => {
    const selectedIndex =
      normalizeIndex(
        req.query.index
      );

    try {
      const quotes =
        await fetchQuotes();

      state.market = {
        ...state.market,

        ...quotes
      };

      const extra =
        await fetchExtraMarketData();

      state.market = {
        ...state.market,

        ...extra
      };

      const analyses = {};

      for (
        const index of
          Object.keys(
            INDICES
          )
      ) {
        try {
          analyses[index] =
            await analyzeIndex(
              index
            );

          state.analysis[index] =
            analyses[index];
        } catch (error) {
          analyses[index] = {
            index,

            available:
              false,

            error:
              error.message
          };
        }
      }

      res.json({
        success:
          true,

        selectedIndex,

        market: {
          indices:
            state.market,

          giftNifty:
            state.market
              .GIFT_NIFTY,

          indiaVix:
            state.market
              .INDIA_VIX
        },

        analyses,

        selectedAnalysis:
          analyses[
            selectedIndex
          ] || null,

        generatedAt:
          nowISO()
      });
    } catch (error) {
      res.status(500).json({
        success:
          false,

        error:
          error.response?.data ||
          error.message
      });
    }
  }
);

/* =========================================================
   OPTION CONTRACTS
   ========================================================= */

app.get(
  "/api/options/contracts",
  async (req, res) => {
    const index =
      normalizeIndex(
        req.query.index
      );

    try {
      const contracts =
        await fetchOptionContracts(
          index
        );

      const expiries = [
        ...new Set(
          contracts
            .map(
              item =>
                item.expiry
            )
            .filter(Boolean)
        )
      ].sort(
        (a, b) =>
          new Date(a).getTime() -
          new Date(b).getTime()
      );

      res.json({
        success:
          true,

        index,

        nearestExpiry:
          expiries[0] ||
          null,

        expiries,

        contracts,

        generatedAt:
          nowISO()
      });
    } catch (error) {
      res.status(500).json({
        success:
          false,

        index,

        error:
          error.response?.data ||
          error.message
      });
    }
  }
);

/* =========================================================
   OPTION CHAIN
   ========================================================= */

app.get(
  "/api/options/chain",
  async (req, res) => {
    const index =
      normalizeIndex(
        req.query.index
      );

    const expiry =
      req.query.expiry ||
      null;

    try {
      const result =
        await fetchOptionChain(
          index,
          expiry
        );

      const market =
        state.market[index];

      /*
       * If market state isn't loaded,
       * fetch live quote.
       */
      let spot =
        market?.price ||
        null;

      if (!spot) {
        const quotes =
          await fetchQuotes();

        state.market = {
          ...state.market,
          ...quotes
        };

        spot =
          state.market[
            index
          ]?.price ||
          null;
      }

      const rows =
        normalizeOptionChain(
          result.data,
          index
        );

      /*
       * Greeks for all chain
       * instruments, maximum 50
       * per Upstox request.
       */
      const relevant =
        selectRelevantStrikes(
          rows,
          spot || 0,
          25
        );

      const greekKeys = [];

      for (
        const row of
          relevant
      ) {
        if (
          row.CE
            ?.instrumentKey
        ) {
          greekKeys.push(
            row.CE
              .instrumentKey
          );
        }

        if (
          row.PE
            ?.instrumentKey
        ) {
          greekKeys.push(
            row.PE
              .instrumentKey
          );
        }
      }

      const greekData =
        await fetchOptionGreeks(
          greekKeys
        );

      for (
        const row of
          relevant
      ) {
        const ce =
          row.CE
            ?.instrumentKey
            ? greekData[
                row.CE
                  .instrumentKey
              ]
            : null;

        const pe =
          row.PE
            ?.instrumentKey
            ? greekData[
                row.PE
                  .instrumentKey
              ]
            : null;

        if (ce) {
          row.CE.delta =
            round(
              ce.delta ??
                row.CE.delta,
              4
            );

          row.CE.gamma =
            round(
              ce.gamma ??
                row.CE.gamma,
              6
            );

          row.CE.theta =
            round(
              ce.theta ??
                row.CE.theta,
              4
            );

          row.CE.vega =
            round(
              ce.vega ??
                row.CE.vega,
              4
            );

          row.CE.iv =
            round(
              ce.iv ??
                row.CE.iv,
              4
            );
        }

        if (pe) {
          row.PE.delta =
            round(
              pe.delta ??
                row.PE.delta,
              4
            );

          row.PE.gamma =
            round(
              pe.gamma ??
                row.PE.gamma,
              6
            );

          row.PE.theta =
            round(
              pe.theta ??
                row.PE.theta,
              4
            );

          row.PE.vega =
            round(
              pe.vega ??
                row.PE.vega,
              4
            );

          row.PE.iv =
            round(
              pe.iv ??
                row.PE.iv,
              4
            );
        }
      }

      const summary =
        optionSummary(
          rows,
          spot || 0
        );

      res.json({
        success:
          true,

        index,

        expiry:
          result.expiry,

        spot,

        summary,

        chain:
          rows,

        generatedAt:
          nowISO()
      });
    } catch (error) {
      res.status(500).json({
        success:
          false,

        index,

        error:
          error.response?.data ||
          error.message
      });
    }
  }
);

/* =========================================================
   GREEKS
   ========================================================= */

app.get(
  "/api/options/greeks",
  async (req, res) => {
    const instrumentKey =
      String(
        req.query
          .instrument_key ||
        ""
      ).trim();

    if (!instrumentKey) {
      return res.status(400).json({
        success:
          false,

        error:
          "instrument_key is required"
      });
    }

    try {
      const data =
        await fetchOptionGreeks(
          instrumentKey.split(",")
        );

      res.json({
        success:
          true,

        data
      });
    } catch (error) {
      res.status(500).json({
        success:
          false,

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

app.get(
  "/api/news",
  async (req, res) => {
    try {
      const news =
        await fetchNews();

      res.json({
        success:
          true,

        news,

        updatedAt:
          state.lastNewsFetch
      });
    } catch (error) {
      res.status(500).json({
        success:
          false,

        news:
          state.news,

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   CHAT
   ========================================================= */

app.post(
  "/api/chat",
  async (req, res) => {
    if (
      !OPENROUTER_API_KEY
    ) {
      return res.status(503).json({
        success:
          false,

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
      return res.status(400).json({
        success:
          false,

        error:
          "Message is required"
      });
    }

    try {
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
                  "You are Era AI, a professional Indian market analysis assistant. " +
                  "Use supplied market context. " +
                  "Do not claim certainty or guaranteed profit. " +
                  "Explain technical and options reasoning clearly."
              },

              {
                role:
                  "user",

                content:
                  JSON.stringify({
                    question:
                      message,

                    market:
                      state.market,

                    analysis:
                      state.analysis
                  })
              }
            ],

            temperature:
              0.2
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

      const answer =
        response.data
          ?.choices?.[0]
          ?.message?.content ||
        "Era could not generate a response.";

      res.json({
        success:
          true,

        answer
      });
    } catch (error) {
      res.status(500).json({
        success:
          false,

        error:
          error.response?.data ||
          error.message
      });
    }
  }
);

/* =========================================================
   TTS
   ========================================================= */

app.post(
  "/api/tts",
  async (req, res) => {
    res.status(410).json({
      success:
        false,

      disabled:
        true,

      message:
        "Voice output is disabled in Era AI V6."
    });
  }
);

/* =========================================================
   SETTINGS
   ========================================================= */

app.get(
  "/api/settings",
  (req, res) => {
    res.json({
      success:
        true,

      settings:
        state.settings
    });
  }
);

app.post(
  "/api/settings",
  (req, res) => {
    const body =
      req.body || {};

    if (
      body.movementThreshold !==
      undefined
    ) {
      state.settings
        .movementThreshold =
        clamp(
          safeNumber(
            body.movementThreshold,
            20
          ),
          1,
          1000
        );
    }

    if (
      body.minConfidence !==
      undefined
    ) {
      state.settings
        .minConfidence =
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
      success:
        true,

      settings:
        state.settings
    });
  }
);

/* =========================================================
   HISTORY
   ========================================================= */

app.get(
  "/api/history",
  (req, res) => {
    res.json({
      success:
        true,

      history:
        state.history,

      activeTrades:
        state.activeTrades,

      alerts:
        state.alerts.slice(
          -100
        )
    });
  }
);

app.post(
  "/api/history",
  (req, res) => {
    const trade =
      req.body?.trade;

    if (!trade) {
      return res.status(400).json({
        success:
          false,

        error:
          "trade is required"
      });
    }

    state.history.push({
      ...trade,

      recordedAt:
        nowISO()
    });

    state.history =
      state.history.slice(
        -500
      );

    saveState();

    res.json({
      success:
        true
    });
  }
);

/* =========================================================
   PUSH PUBLIC KEY
   ========================================================= */

app.get(
  "/api/push/public-key",
  (req, res) => {
    res.json({
      success:
        true,

      publicKey:
        VAPID_PUBLIC_KEY ||
        null
    });
  }
);

/* =========================================================
   PUSH SUBSCRIBE
   ========================================================= */

app.post(
  "/api/subscribe",
  (req, res) => {
    const subscription =
      req.body
        ?.subscription;

    if (
      !subscription ||
      !subscription.endpoint
    ) {
      return res.status(400).json({
        success:
          false,

        error:
          "Valid push subscription is required"
      });
    }

    const exists =
      state.pushSubscriptions.some(
        item =>
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
      success:
        true,

      subscribed:
        true
    });
  }
);

/* =========================================================
   PUSH TEST
   ========================================================= */

app.post(
  "/api/push/test",
  async (req, res) => {
    try {
      await sendPushNotification({
        type:
          "TEST",

        title:
          "Era AI — Test Notification",

        body:
          "Push notifications are working.",

        createdAt:
          nowISO()
      });

      res.json({
        success:
          true,

        message:
          "Test notification sent"
      });
    } catch (error) {
      res.status(500).json({
        success:
          false,

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   ENGINE
   ========================================================= */

app.get(
  "/api/engine",
  (req, res) => {
    res.json({
      success:
        true,

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
  }
);

app.post(
  "/api/engine/start",
  (req, res) => {
    state.engineRunning =
      true;

    res.json({
      success:
        true,

      running:
        true
    });
  }
);

app.post(
  "/api/engine/stop",
  (req, res) => {
    state.engineRunning =
      false;

    res.json({
      success:
        true,

      running:
        false
    });
  }
);

/* =========================================================
   PRE-MARKET
   ========================================================= */

async function sendPreMarketNotification() {
  const dateKey =
    new Date()
      .toLocaleDateString(
        "en-IN",
        {
          timeZone:
            "Asia/Kolkata"
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
        item =>
          `${item.index}: ${
            item.signal ||
            "WAIT"
          }`
      )
      .join(" | ");

  await sendPushNotification({
    type:
      "PRE_MARKET",

    title:
      "Era AI — Next Day Watchlist",

    body:
      summary ||
      "Era is preparing the next market setup.",

    createdAt:
      nowISO()
  });
}

/* =========================================================
   PERIODIC WORKERS
   ========================================================= */

setInterval(
  async () => {
    if (
      !state.engineRunning
    ) {
      return;
    }

    await runAutonomousScan();
  },
  state.settings
    .scanIntervalMs
);

setInterval(
  async () => {
    await fetchNews();
  },
  state.settings
    .newsIntervalMs
);

setInterval(
  async () => {
    const now =
      new Date();

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
      india.getHours() *
        60 +
      india.getMinutes();

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
    Object.keys(
      INDICES
    ).join(", ")
  );

  console.log(
    "20+ movement filter:",
    state.settings
      .movementThreshold
  );

  console.log(
    "Minimum confidence:",
    state.settings
      .minConfidence
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

  setTimeout(
    () => {
      runAutonomousScan().catch(
        error =>
          console.error(
            "Initial scan:",
            error.message
          )
      );
    },
    3000
  );
}

/* =========================================================
   SERVER
   ========================================================= */

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
