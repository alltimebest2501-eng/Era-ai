require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const UpstoxClient = require("upstox-js-sdk");

const app = express();

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = "https://alltimebest2501-eng.github.io/Era-ai/";
const UPSTOX_API = "https://api.upstox.com";
const UPSTOX_V3_API = "https://api.upstox.com/v3";

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.use(express.json({ limit: "1mb" }));

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
  { name: "NIFTY", key: NIFTY_KEY },
  { name: "BANKNIFTY", key: BANKNIFTY_KEY },
  { name: "FINNIFTY", key: FINNIFTY_KEY },
  { name: "SENSEX", key: SENSEX_KEY }
];

/* =========================================================
   BASIC HELPERS
========================================================= */

function configureUpstoxSDK() {
  if (!process.env.UPSTOX_ACCESS_TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is missing");
  }

  const defaultClient = UpstoxClient.ApiClient.instance;
  const oauth = defaultClient.authentications["OAUTH2"];

  oauth.accessToken = process.env.UPSTOX_ACCESS_TOKEN;

  return defaultClient;
}

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

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 2) {
  if (!Number.isFinite(Number(value))) return null;

  const factor = Math.pow(10, decimals);
  return Math.round(Number(value) * factor) / factor;
}

function firstDefined(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      value !== "" &&
      !Number.isNaN(Number(value))
    ) {
      return value;
    }
  }

  return null;
}

/* =========================================================
   MARKET DATA
========================================================= */

function normalizeQuote(quote) {
  if (!quote) {
    return {
      lastPrice: null,
      netChange: null,
      previousClose: null,
      open: null,
      high: null,
      low: null,
      close: null,
      volume: null
    };
  }

  const ohlc = quote.ohlc || {};

  const lastPrice = num(
    firstDefined(
      quote.last_price,
      quote.lastPrice,
      quote.ltp,
      quote.lp,
      quote.close,
      ohlc.close
    )
  );

  const previousClose = num(
    firstDefined(
      quote.prev_close,
      quote.previous_close,
      quote.previousClose,
      quote.prevClose,
      ohlc.close
    )
  );

  const netChange = num(
    firstDefined(
      quote.net_change,
      quote.netChange,
      quote.change,
      lastPrice !== null && previousClose !== null
        ? lastPrice - previousClose
        : null
    )
  );

  return {
    lastPrice,
    netChange,
    previousClose,
    open: num(firstDefined(quote.open, ohlc.open)),
    high: num(firstDefined(quote.high, ohlc.high)),
    low: num(firstDefined(quote.low, ohlc.low)),
    close: num(firstDefined(quote.close, ohlc.close, lastPrice)),
    volume: num(
      firstDefined(
        quote.volume,
        quote.volume_traded,
        quote.volumeTraded,
        ohlc.volume
      )
    )
  };
}

function findQuote(quotes, key) {
  if (!quotes || typeof quotes !== "object") return null;

  if (quotes[key]) return quotes[key];

  const encoded = encodeURIComponent(key);

  if (quotes[encoded]) return quotes[encoded];

  for (const [quoteKey, quoteValue] of Object.entries(quotes)) {
    if (
      quoteKey === key ||
      decodeURIComponent(quoteKey) === key ||
      quoteValue?.instrument_token === key ||
      quoteValue?.instrument_key === key
    ) {
      return quoteValue;
    }
  }

  return null;
}

async function getLiveMarketData() {
  try {
    const instrumentKeys = [
      NIFTY_KEY,
      BANKNIFTY_KEY,
      FINNIFTY_KEY,
      SENSEX_KEY,
      VIX_KEY,
      GIFT_KEY
    ].join(",");

    const response = await axios.get(
      `${UPSTOX_API}/v2/market-quote/quotes`,
      {
        params: {
          instrument_key: instrumentKeys
        },
        headers: authHeaders(),
        timeout: 15000
      }
    );

    const quotes = response.data?.data || {};

    return {
      success: true,
      timestamp: new Date().toISOString(),
      nifty: normalizeQuote(findQuote(quotes, NIFTY_KEY)),
      banknifty: normalizeQuote(findQuote(quotes, BANKNIFTY_KEY)),
      finnifty: normalizeQuote(findQuote(quotes, FINNIFTY_KEY)),
      sensex: normalizeQuote(findQuote(quotes, SENSEX_KEY)),
      indiaVix: normalizeQuote(findQuote(quotes, VIX_KEY)),
      giftNifty: normalizeQuote(findQuote(quotes, GIFT_KEY))
    };
  } catch (error) {
    const status = error.response?.status || 500;

    let detail = error.message || "Market data request failed";

    if (error.response?.data) {
      try {
        detail =
          typeof error.response.data === "string"
            ? error.response.data
            : JSON.stringify(error.response.data);
      } catch {
        detail = String(error.response.data);
      }
    }

    console.error("[MARKET ERROR]", status, detail);

    return {
      success: false,
      error: "Unable to fetch live market data",
      status,
      detail
    };
  }
}

/* =========================================================
   HISTORICAL / INTRADAY CANDLES
========================================================= */

async function getIntradayCandles(
  instrumentKey = NIFTY_KEY,
  interval = 5
) {
  try {
    const encodedInstrument = encodeURIComponent(instrumentKey);

    const url =
      `${UPSTOX_V3_API}/historical-candle/intraday/` +
      `${encodedInstrument}/minutes/${interval}`;

    const response = await axios.get(url, {
      headers: authHeaders(),
      timeout: 15000
    });

    const rawData = response.data?.data;

    let candles = [];

    if (Array.isArray(rawData?.candles)) {
      candles = rawData.candles;
    } else if (Array.isArray(rawData)) {
      candles = rawData;
    } else if (Array.isArray(response.data?.candles)) {
      candles = response.data.candles;
    }

    /*
      Upstox can return newest candle first.
      Normalize to chronological order.
    */

    candles = candles
      .filter((c) => Array.isArray(c) && c.length >= 5)
      .map((c) => ({
        timestamp: c[0],
        open: num(c[1]),
        high: num(c[2]),
        low: num(c[3]),
        close: num(c[4]),
        volume: num(c[5], 0),
        oi: num(c[6], 0)
      }))
      .filter(
        (c) =>
          c.timestamp &&
          c.open !== null &&
          c.high !== null &&
          c.low !== null &&
          c.close !== null
      )
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() -
          new Date(b.timestamp).getTime()
      );

    return {
      success: true,
      instrumentKey,
      timeframe: `${interval} minute`,
      candles
    };
  } catch (error) {
    const status = error.response?.status || 500;

    let detail = error.message || "Candle request failed";

    if (error.response?.data) {
      try {
        detail =
          typeof error.response.data === "string"
            ? error.response.data
            : JSON.stringify(error.response.data);
      } catch {
        detail = String(error.response.data);
      }
    }

    console.error(
      "[CANDLE ERROR]",
      instrumentKey,
      status,
      detail
    );

    return {
      success: false,
      instrumentKey,
      timeframe: `${interval} minute`,
      candles: [],
      error: "Unable to fetch intraday candles",
      status,
      detail
    };
  }
}

/* =========================================================
   TECHNICAL INDICATORS
========================================================= */

function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  if (values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let ema = 0;

  for (let i = 0; i < period; i++) {
    ema += values[i];
  }

  ema /= period;

  for (let i = period; i < values.length; i++) {
    ema =
      (values[i] - ema) * multiplier +
      ema;
  }

  return ema;
}

function calculateRSI(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

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
  if (!Array.isArray(candles) || candles.length === 0) {
    return null;
  }

  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;

  for (const candle of candles) {
    const typicalPrice =
      (candle.high + candle.low + candle.close) / 3;

    const volume = Number(candle.volume) || 0;

    cumulativePriceVolume +=
      typicalPrice * volume;

    cumulativeVolume += volume;
  }

  if (cumulativeVolume <= 0) {
    return null;
  }

  return cumulativePriceVolume / cumulativeVolume;
}

function getSupportResistance(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return {
      support: null,
      resistance: null
    };
  }

  const recent = candles.slice(-20);

  const lows = recent
    .map((c) => c.low)
    .filter((v) => Number.isFinite(v));

  const highs = recent
    .map((c) => c.high)
    .filter((v) => Number.isFinite(v));

  return {
    support:
      lows.length > 0
        ? Math.min(...lows)
        : null,

    resistance:
      highs.length > 0
        ? Math.max(...highs)
        : null
  };
}

/* =========================================================
   TECHNICAL ANALYSIS
========================================================= */

async function getTechnicalAnalysis(
  instrumentKey = NIFTY_KEY
) {
  try {
    const candleResult =
      await getIntradayCandles(
        instrumentKey,
        5
      );

    if (
      !candleResult.success ||
      candleResult.candles.length < 2
    ) {
      return {
        success: true,
        instrumentKey,
        timeframe: "5 minute",
        candles: candleResult.candles?.length || 0,
        current: null,
        ema9: null,
        ema20: null,
        ema50: null,
        rsi: null,
        vwap: null,
        support: null,
        resistance: null,
        trend: "UNKNOWN",
        momentum: "UNKNOWN",
        dataQuality: "INSUFFICIENT",
        error:
          candleResult.error ||
          "Insufficient intraday candles"
      };
    }

    const candles = candleResult.candles;

    const closes = candles
      .map((c) => c.close)
      .filter((v) => Number.isFinite(v));

    const current =
      closes.length > 0
        ? closes[closes.length - 1]
        : null;

    const ema9 = calculateEMA(closes, 9);
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);

    const rsi = calculateRSI(closes, 14);

    const vwap = calculateVWAP(candles);

    const {
      support,
      resistance
    } = getSupportResistance(candles);

    let trend = "SIDEWAYS";

    if (
      current !== null &&
      ema9 !== null &&
      ema20 !== null &&
      ema50 !== null
    ) {
      if (
        current > ema9 &&
        ema9 > ema20 &&
        ema20 > ema50
      ) {
        trend = "BULLISH";
      } else if (
        current < ema9 &&
        ema9 < ema20 &&
        ema20 < ema50
      ) {
        trend = "BEARISH";
      }
    } else {
      trend = "UNKNOWN";
    }

    let momentum = "NEUTRAL";

    if (rsi !== null) {
      if (rsi >= 60) {
        momentum = "POSITIVE";
      } else if (rsi <= 40) {
        momentum = "NEGATIVE";
      }
    }

    return {
      success: true,
      instrumentKey,
      timeframe: "5 minute",
      candles: candles.length,
      current: round(current),
      ema9: round(ema9),
      ema20: round(ema20),
      ema50: round(ema50),
      rsi: round(rsi),
      vwap: round(vwap),
      support: round(support),
      resistance: round(resistance),
      trend,
      momentum,
      dataQuality:
        candles.length >= 50
          ? "GOOD"
          : "PARTIAL"
    };
  } catch (error) {
    console.error(
      "[TECHNICAL ERROR]",
      error.message
    );

    return {
      success: false,
      instrumentKey,
      timeframe: "5 minute",
      candles: 0,
      trend: "UNKNOWN",
      momentum: "UNKNOWN",
      dataQuality: "ERROR",
      error: error.message
    };
  }
}

/* =========================================================
   OPTION CONTRACTS
========================================================= */

const optionContracts = new Map();

const liveOptionData = new Map();

let optionSockets = [];

let liveOptionInitialized = false;

let liveOptionStartupStarted = false;

const OPTION_SUBSCRIPTION_LIMIT = 5000;
const MAX_OPTION_SOCKETS = 2;

function clearOptionWebSockets() {
  for (const socket of optionSockets) {
    try {
      if (socket && typeof socket.disconnect === "function") {
        socket.disconnect();
      }
    } catch (error) {
      console.error(
        "[LIVE OPTIONS] Socket disconnect error:",
        error.message
      );
    }
  }

  optionSockets = [];
}

function extractOptionPrice(message) {
  if (!message) return null;

  const directCandidates = [
    message.ltp,
    message.last_price,
    message.lastPrice,
    message.lp,
    message.close
  ];

  for (const value of directCandidates) {
    const n = Number(value);

    if (Number.isFinite(n)) {
      return n;
    }
  }

  const ltpc = message.ltpc;

  if (ltpc) {
    const n = Number(
      firstDefined(
        ltpc.ltp,
        ltpc.last_price,
        ltpc.lastPrice,
        ltpc.lp
      )
    );

    if (Number.isFinite(n)) {
      return n;
    }
  }

  return null;
}

function processOptionMessage(message) {
  try {
    if (!message) return;

    if (Buffer.isBuffer(message)) {
      message = message.toString("utf8");
    }

    if (typeof message === "string") {
      try {
        message = JSON.parse(message);
      } catch {
        return;
      }
    }

    const data =
      message.data ||
      message.feeds ||
      message;

    if (!data || typeof data !== "object") {
      return;
    }

    for (const [instrumentKey, feed] of Object.entries(data)) {
      const price = extractOptionPrice(feed);

      if (!Number.isFinite(price)) {
        continue;
      }

      const existing =
        liveOptionData.get(instrumentKey) || {};

      liveOptionData.set(instrumentKey, {
        ...existing,
        instrumentKey,
        ltp: price,
        lastUpdated: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error(
      "[LIVE OPTIONS] Message parse error:",
      error.message
    );
  }
}

function getSocketStatus(index) {
  const socket = optionSockets[index];

  if (!socket) {
    return {
      exists: false,
      connected: false
    };
  }

  return {
    exists: true,
    connected:
      socket.__eraConnected === true
  };
}

async function fetchAllLiveOptionContracts() {
  try {
    optionContracts.clear();

    const discovered = [];

    for (const underlying of OPTION_UNDERLYINGS) {
      try {
        const response = await axios.get(
          `${UPSTOX_API}/v2/option/contract`,
          {
            params: {
              instrument_key:
                underlying.key
            },
            headers: authHeaders(),
            timeout: 20000
          }
        );

        const data = response.data?.data;

        if (Array.isArray(data)) {
          for (const contract of data) {
            if (!contract) continue;

            const instrumentKey =
              contract.instrument_key ||
              contract.instrumentKey;

            if (!instrumentKey) continue;

            const optionType =
              contract.option_type ||
              contract.optionType;

            const strikePrice = num(
              firstDefined(
                contract.strike_price,
                contract.strikePrice
              )
            );

            const expiry =
              contract.expiry ||
              contract.expiry_date ||
              contract.expiryDate;

            const tradingSymbol =
              contract.trading_symbol ||
              contract.tradingSymbol ||
              contract.name ||
              instrumentKey;

            const item = {
              ...contract,
              instrument_key: instrumentKey,
              option_type: optionType,
              strike_price: strikePrice,
              expiry,
              trading_symbol: tradingSymbol,
              underlying:
                underlying.name
            };

            optionContracts.set(
              instrumentKey,
              item
            );

            discovered.push(item);
          }
        }
      } catch (error) {
        console.error(
          `[LIVE OPTIONS] Contract discovery failed for ${underlying.name}:`,
          error.response?.data ||
            error.message
        );
      }
    }

    const filtered = discovered.filter(
      (contract) => {
        const type =
          String(
            contract.option_type || ""
          ).toUpperCase();

        return (
          type === "CE" ||
          type === "PE"
        );
      }
    );

    return filtered;
  } catch (error) {
    console.error(
      "[LIVE OPTIONS] Contract discovery error:",
      error.message
    );

    return [];
  }
}

function wait(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

async function startLiveOptionWebSocket() {
  if (liveOptionStartupStarted) {
    return;
  }

  liveOptionStartupStarted = true;

  try {
    configureUpstoxSDK();

    console.log(
      "[LIVE OPTIONS] Starting contract discovery..."
    );

    const contracts =
      await fetchAllLiveOptionContracts();

    console.log(
      `[LIVE OPTIONS] Discovered ${contracts.length} option contracts`
    );

    if (contracts.length === 0) {
      console.error(
        "[LIVE OPTIONS] No option contracts discovered"
      );

      liveOptionInitialized = true;
      return;
    }

    const keys = contracts
      .map((contract) =>
        contract.instrument_key
      )
      .filter(Boolean);

    const chunks = [];

    for (
      let i = 0;
      i < keys.length &&
      chunks.length < MAX_OPTION_SOCKETS;
      i += OPTION_SUBSCRIPTION_LIMIT
    ) {
      chunks.push(
        keys.slice(
          i,
          i + OPTION_SUBSCRIPTION_LIMIT
        )
      );
    }

    console.log(
      `[LIVE OPTIONS] Creating ${chunks.length} WebSocket connection(s)`
    );

    clearOptionWebSockets();

    for (
      let index = 0;
      index < chunks.length;
      index++
    ) {
      const instrumentKeys =
        chunks[index];

      try {
        const streamer =
          new UpstoxClient.MarketDataStreamerV3(
            [],
            "ltpc"
          );

        streamer.__eraConnected = false;
        streamer.__eraIndex = index;

        streamer.autoReconnect(
          true,
          10,
          999999
        );

        streamer.on("open", () => {
          streamer.__eraConnected = true;

          console.log(
            `[LIVE OPTIONS] WebSocket #${index + 1} connected`
          );

          try {
            streamer.subscribe(
              instrumentKeys,
              "ltpc"
            );

            console.log(
              `[LIVE OPTIONS] WebSocket #${index + 1} subscribed ${instrumentKeys.length} contracts`
            );
          } catch (error) {
            console.error(
              `[LIVE OPTIONS] WebSocket #${index + 1} subscribe error:`,
              error.message
            );
          }
        });

        streamer.on(
          "message",
          (message) => {
            processOptionMessage(
              message
            );
          }
        );

        streamer.on(
          "error",
          (error) => {
            streamer.__eraConnected = false;

            console.error(
              `[LIVE OPTIONS] WebSocket #${index + 1} error:`,
              error?.message ||
                error
            );
          }
        );

        streamer.on(
          "close",
          () => {
            streamer.__eraConnected = false;

            console.warn(
              `[LIVE OPTIONS] WebSocket #${index + 1} closed`
            );
          }
        );

        streamer.on(
          "reconnecting",
          () => {
            console.warn(
              `[LIVE OPTIONS] WebSocket #${index + 1} reconnecting...`
            );
          }
        );

        optionSockets.push(
          streamer
        );

        try {
          streamer.connect();
        } catch (error) {
          console.error(
            `[LIVE OPTIONS] WebSocket #${index + 1} connect error:`,
            error.message
          );
        }

        await wait(1000);
      } catch (error) {
        console.error(
          `[LIVE OPTIONS] Failed to create WebSocket #${index + 1}:`,
          error.message
        );
      }
    }

    liveOptionInitialized = true;

    console.log(
      "[LIVE OPTIONS] WebSocket startup completed"
    );
  } catch (error) {
    liveOptionInitialized = true;

    console.error(
      "[LIVE OPTIONS] Startup error:",
      error.message
    );
  }
}

/* =========================================================
   OPTION STATUS
========================================================= */

function getLiveOptionStatus() {
  let liveContracts = 0;

  for (const [instrumentKey, value] of liveOptionData.entries()) {
    if (
      value &&
      Number.isFinite(Number(value.ltp))
    ) {
      liveContracts++;
    }
  }

  const subscribedContracts =
    optionSockets.reduce(
      (total, socket) => {
        if (!socket) return total;

        return total;
      },
      0
    );

  const socket1 =
    optionSockets[0];

  const socket2 =
    optionSockets[1];

  const socket1Subscribed =
    optionContracts.size > 0
      ? Math.min(
          OPTION_SUBSCRIPTION_LIMIT,
          optionContracts.size
        )
      : 0;

  const socket2Subscribed =
    optionContracts.size >
    OPTION_SUBSCRIPTION_LIMIT
      ? Math.min(
          OPTION_SUBSCRIPTION_LIMIT,
          optionContracts.size -
            OPTION_SUBSCRIPTION_LIMIT
        )
      : 0;

  const totalSubscribed =
    socket1Subscribed +
    socket2Subscribed;

  const lastMessage1 =
    socket1?.__eraLastMessage ||
    null;

  const lastMessage2 =
    socket2?.__eraLastMessage ||
    null;

  return {
    initialized:
      liveOptionInitialized,

    discoveredContracts:
      optionContracts.size,

    liveContracts,

    subscribedContracts:
      totalSubscribed,

    maxNormalLTPCSubscriptions:
      OPTION_SUBSCRIPTION_LIMIT *
      MAX_OPTION_SOCKETS,

    websocketConnections:
      optionSockets.length,

    websocket1:
      socket1?.__eraConnected === true,

    websocket2:
      socket2?.__eraConnected === true,

    websocket1LastMessage:
      lastMessage1,

    websocket2LastMessage:
      lastMessage2,

    socket1Subscribed,
    socket2Subscribed,

    subscribedLimitPerConnection:
      OPTION_SUBSCRIPTION_LIMIT,

    maxNormalConnections:
      MAX_OPTION_SOCKETS,

    coveragePercent:
      optionContracts.size > 0
        ? round(
            (liveContracts /
              optionContracts.size) *
              100,
            2
          )
        : 0
  };
}

/* =========================================================
   OPTION CONTRACT API
========================================================= */

app.get(
  "/api/options/contracts",
  async (req, res) => {
    try {
      const instrumentKey =
        req.query.instrument_key;

      if (!instrumentKey) {
        return res.status(400).json({
          success: false,
          error:
            "instrument_key is required"
        });
      }

      const response =
        await axios.get(
          `${UPSTOX_API}/v2/option/contract`,
          {
            params: {
              instrument_key:
                instrumentKey
            },
            headers: authHeaders(),
            timeout: 15000
          }
        );

      return res.json({
        success: true,
        data:
          response.data?.data || []
      });
    } catch (error) {
      return res.status(
        error.response?.status || 500
      ).json({
        success: false,
        error:
          "Unable to fetch option contracts",
        detail:
          error.response?.data ||
          error.message
      });
    }
  }
);

/* =========================================================
   OPTION CHAIN
========================================================= */

function getNearestExpiry(contracts) {
  const dates = contracts
    .map(
      (c) =>
        c.expiry ||
        c.expiry_date ||
        c.expiryDate
    )
    .filter(Boolean)
    .map(String)
    .sort();

  return dates.length > 0
    ? dates[0]
    : null;
}

function overlayLivePrice(
  instrumentKey,
  fallbackPrice = null
) {
  const live =
    liveOptionData.get(
      instrumentKey
    );

  if (
    live &&
    Number.isFinite(Number(live.ltp))
  ) {
    return Number(live.ltp);
  }

  return fallbackPrice;
}

app.get(
  "/api/options/chain",
  async (req, res) => {
    try {
      const instrumentKey =
        req.query.instrument_key;

      let expiryDate =
        req.query.expiry_date;

      if (!instrumentKey) {
        return res.status(400).json({
          success: false,
          error:
            "instrument_key is required"
        });
      }

      if (!expiryDate) {
        const contracts =
          Array.from(
            optionContracts.values()
          ).filter(
            (c) =>
              c.underlying &&
              OPTION_UNDERLYINGS.some(
                (u) =>
                  u.key ===
                  instrumentKey &&
                  u.name ===
                    c.underlying
              )
          );

        expiryDate =
          getNearestExpiry(
            contracts
          );
      }

      const response =
        await axios.get(
          `${UPSTOX_API}/v2/option/chain`,
          {
            params: {
              instrument_key:
                instrumentKey,
              expiry_date:
                expiryDate
            },
            headers: authHeaders(),
            timeout: 15000
          }
        );

      const raw =
        response.data?.data;

      let chain = [];

      if (Array.isArray(raw)) {
        chain = raw;
      } else if (
        Array.isArray(raw?.chain)
      ) {
        chain = raw.chain;
      } else if (
        raw &&
        typeof raw === "object"
      ) {
        chain = Object.values(raw);
      }

      const normalized =
        chain.map((item) => {
          const strike =
            num(
              firstDefined(
                item.strike_price,
                item.strikePrice,
                item.strike
              )
            );

          const call =
            item.call_options ||
            item.callOptions ||
            item.CE ||
            item.ce ||
            null;

          const put =
            item.put_options ||
            item.putOptions ||
            item.PE ||
            item.pe ||
            null;

          const callInstrumentKey =
            call?.instrument_key ||
            call?.instrumentKey ||
            null;

          const putInstrumentKey =
            put?.instrument_key ||
            put?.instrumentKey ||
            null;

          const callLtp =
            overlayLivePrice(
              callInstrumentKey,
              num(
                firstDefined(
                  call?.market_data?.ltp,
                  call?.marketData?.ltp,
                  call?.ltp
                )
              )
            );

          const putLtp =
            overlayLivePrice(
              putInstrumentKey,
              num(
                firstDefined(
                  put?.market_data?.ltp,
                  put?.marketData?.ltp,
                  put?.ltp
                )
              )
            );

          return {
            strike,

            call: call
              ? {
                  ...call,
                  instrument_key:
                    callInstrumentKey,
                  ltp: callLtp
                }
              : null,

            put: put
              ? {
                  ...put,
                  instrument_key:
                    putInstrumentKey,
                  ltp: putLtp
                }
              : null
          };
        });

      return res.json({
        success: true,
        instrumentKey,
        expiry: expiryDate,
        data: normalized
      });
    } catch (error) {
      return res.status(
        error.response?.status || 500
      ).json({
        success: false,
        error:
          "Unable to fetch option chain",
        detail:
          error.response?.data ||
          error.message
      });
    }
  }
);

/* =========================================================
   OPTION ANALYSIS
========================================================= */

async function getOptionAnalysis(
  instrumentKey = NIFTY_KEY
) {
  try {
    const contracts =
      Array.from(
        optionContracts.values()
      ).filter(
        (contract) => {
          const underlying =
            String(
              contract.underlying || ""
            ).toUpperCase();

          const target =
            OPTION_UNDERLYINGS.find(
              (item) =>
                item.key ===
                instrumentKey
            );

          return (
            target &&
            underlying ===
              target.name
          );
        }
      );

    let expiry =
      getNearestExpiry(
        contracts
      );

    if (!expiry) {
      return {
        success: true,
        instrumentKey,
        expiry: null,
        totalCallOI: 0,
        totalPutOI: 0,
        pcr: null,
        maxPain: null,
        bias: "NEUTRAL",
        strikes: []
      };
    }

    const response =
      await axios.get(
        `${UPSTOX_API}/v2/option/chain`,
        {
          params: {
            instrument_key:
              instrumentKey,
            expiry_date:
              expiry
          },
          headers: authHeaders(),
          timeout: 15000
        }
      );

    const raw =
      response.data?.data;

    let chain = [];

    if (Array.isArray(raw)) {
      chain = raw;
    } else if (
      Array.isArray(raw?.chain)
    ) {
      chain = raw.chain;
    } else if (
      raw &&
      typeof raw === "object"
    ) {
      chain = Object.values(raw);
    }

    let totalCallOI = 0;
    let totalPutOI = 0;

    const strikeData = [];

    for (const item of chain) {
      const strike =
        num(
          firstDefined(
            item.strike_price,
            item.strikePrice,
            item.strike
          )
        );

      if (strike === null) {
        continue;
      }

      const call =
        item.call_options ||
        item.callOptions ||
        item.CE ||
        item.ce ||
        null;

      const put =
        item.put_options ||
        item.putOptions ||
        item.PE ||
        item.pe ||
        null;

      const callOI =
        num(
          firstDefined(
            call?.market_data?.oi,
            call?.marketData?.oi,
            call?.oi,
            call?.open_interest,
            call?.openInterest
          ),
          0
        );

      const putOI =
        num(
          firstDefined(
            put?.market_data?.oi,
            put?.marketData?.oi,
            put?.oi,
            put?.open_interest,
            put?.openInterest
          ),
          0
        );

      totalCallOI += callOI;
      totalPutOI += putOI;

      strikeData.push({
        strike,
        callOI,
        putOI
      });
    }

    const pcr =
      totalCallOI > 0
        ? totalPutOI /
          totalCallOI
        : null;

    let bias = "NEUTRAL";

    if (pcr !== null) {
      if (pcr > 1.15) {
        bias = "BULLISH";
      } else if (pcr < 0.85) {
        bias = "BEARISH";
      }
    }

    /*
      Max pain calculation
    */

    let maxPain = null;
    let minimumPain =
      Infinity;

    for (const candidate of strikeData) {
      let totalPain = 0;

      for (const strike of strikeData) {
        const callPain =
          Math.max(
            candidate.strike -
              strike.strike,
            0
          ) *
          strike.callOI;

        const putPain =
          Math.max(
            strike.strike -
              candidate.strike,
            0
          ) *
          strike.putOI;

        totalPain +=
          callPain +
          putPain;
      }

      if (
        totalPain <
        minimumPain
      ) {
        minimumPain =
          totalPain;

        maxPain =
          candidate.strike;
      }
    }

    return {
      success: true,
      instrumentKey,
      expiry,
      totalCallOI,
      totalPutOI,
      pcr,
      maxPain,
      bias,
      strikes:
        strikeData
          .map(
            (x) => x.strike
          )
          .sort(
            (a, b) =>
              a - b
          )
    };
  } catch (error) {
    console.error(
      "[OPTION ANALYSIS ERROR]",
      error.response?.data ||
        error.message
    );

    return {
      success: false,
      instrumentKey,
      expiry: null,
      totalCallOI: 0,
      totalPutOI: 0,
      pcr: null,
      maxPain: null,
      bias: "NEUTRAL",
      strikes: [],
      error:
        "Unable to calculate option analysis"
    };
  }
}

/* =========================================================
   LIVE OPTION STATUS
========================================================= */

app.get(
  "/api/options/live-status",
  (req, res) => {
    const status =
      getLiveOptionStatus();

    /*
      Refresh last-message timestamps
      from currently active sockets.
    */

    for (
      let i = 0;
      i < optionSockets.length;
      i++
    ) {
      const socket =
        optionSockets[i];

      if (
        socket &&
        liveOptionData.size > 0
      ) {
        /*
          Don't manufacture a timestamp.
          Actual message timestamps are
          set below in websocket message listener.
        */
      }
    }

    return res.json({
      success: true,
      ...status
    });
  }
);

app.get(
  "/api/options/live",
  (req, res) => {
    const data =
      Array.from(
        liveOptionData.values()
      );

    return res.json({
      success: true,
      count: data.length,
      data
    });
  }
);

/* =========================================================
   ERA ANALYSIS ENGINE
========================================================= */

async function getEraAnalysis() {
  try {
    const [
      market,
      technical,
      options
    ] = await Promise.all([
      getLiveMarketData(),
      getTechnicalAnalysis(
        NIFTY_KEY
      ),
      getOptionAnalysis(
        NIFTY_KEY
      )
    ]);

    const reasons = [];

    let confidence = 0;

    /*
      Technical confirmation
    */

    if (
      technical.trend ===
      "BULLISH"
    ) {
      confidence += 30;

      reasons.push(
        "NIFTY EMA structure is bullish."
      );
    } else if (
      technical.trend ===
      "BEARISH"
    ) {
      confidence += 30;

      reasons.push(
        "NIFTY EMA structure is bearish."
      );
    }

    /*
      RSI confirmation
    */

    if (
      technical.rsi !== null
    ) {
      if (
        technical.rsi >= 60
      ) {
        confidence += 15;

        reasons.push(
          "RSI momentum is positive."
        );
      } else if (
        technical.rsi <= 40
      ) {
        confidence += 15;

        reasons.push(
          "RSI momentum is negative."
        );
      }
    }

    /*
      VWAP confirmation
    */

    if (
      technical.current !== null &&
      technical.vwap !== null
    ) {
      if (
        technical.current >
        technical.vwap
      ) {
        confidence += 10;

        reasons.push(
          "Price is above VWAP."
        );
      } else if (
        technical.current <
        technical.vwap
      ) {
        confidence += 10;

        reasons.push(
          "Price is below VWAP."
        );
      }
    }

    /*
      Options confirmation
    */

    if (
      options.bias ===
      "BULLISH"
    ) {
      confidence += 25;

      reasons.push(
        "Options PCR confirms bullish bias."
      );
    } else if (
      options.bias ===
      "BEARISH"
    ) {
      confidence += 25;

      reasons.push(
        "Options PCR confirms bearish bias."
      );
    }

    confidence =
      Math.min(
        100,
        Math.max(
          0,
          Math.round(
            confidence
          )
        )
      );

    let direction =
      "WAIT";

    /*
      Strong direction requires
      technical + options alignment.
    */

    if (
      technical.trend ===
        "BULLISH" &&
      options.bias ===
        "BULLISH" &&
      confidence >= 55
    ) {
      direction =
        "BUY";
    } else if (
      technical.trend ===
        "BEARISH" &&
      options.bias ===
        "BEARISH" &&
      confidence >= 55
    ) {
      direction =
        "SELL";
    }

    /*
      If technical data is incomplete,
      force WAIT.
    */

    if (
      technical.dataQuality ===
        "INSUFFICIENT" ||
      technical.trend ===
        "UNKNOWN"
    ) {
      direction =
        "WAIT";

      reasons.length = 0;

      reasons.push(
        "Technical data is insufficient for a confirmed trade."
      );
    }

    /*
      Setup values
    */

    let entry = null;
    let stopLoss = null;
    let target1 = null;
    let target2 = null;
    let target3 = null;
    let riskReward = null;

    const current =
      technical.current;

    const support =
      technical.support;

    const resistance =
      technical.resistance;

    if (
      direction === "BUY" &&
      current !== null &&
      support !== null
    ) {
      entry =
        round(current);

      stopLoss =
        round(support);

      const risk =
        entry -
        stopLoss;

      if (risk > 0) {
        target1 =
          round(
            entry +
              risk
          );

        target2 =
          round(
            entry +
              risk * 2
          );

        target3 =
          round(
            entry +
              risk * 3
          );

        riskReward =
          round(
            (target2 -
              entry) /
              risk,
            2
          );
      }
    }

    if (
      direction === "SELL" &&
      current !== null &&
      resistance !== null
    ) {
      entry =
        round(current);

      stopLoss =
        round(resistance);

      const risk =
        stopLoss -
        entry;

      if (risk > 0) {
        target1 =
          round(
            entry -
              risk
          );

        target2 =
          round(
            entry -
              risk * 2
          );

        target3 =
          round(
            entry -
              risk * 3
          );

        riskReward =
          round(
            (entry -
              target2) /
              risk,
            2
          );
      }
    }

    /*
      WAIT means no trade setup.
    */

    if (
      direction === "WAIT"
    ) {
      entry = null;
      stopLoss = null;
      target1 = null;
      target2 = null;
      target3 = null;
      riskReward = null;
    }

    let invalidation =
      "No trade until technical and option confirmation align.";

    if (
      direction === "BUY"
    ) {
      invalidation =
        "BUY setup invalidates if price breaks below the defined stop-loss/support.";
    } else if (
      direction === "SELL"
    ) {
      invalidation =
        "SELL setup invalidates if price breaks above the defined stop-loss/resistance.";
    }

    return {
      success: true,
      timestamp:
        new Date().toISOString(),

      signal: {
        direction,
        confidence,
        entry,
        stopLoss,
        target1,
        target2,
        target3,
        riskReward
      },

      market,
      technical,
      options,
      reasons,
      invalidation
    };
  } catch (error) {
    console.error(
      "[ERA ANALYSIS ERROR]",
      error.message
    );

    return {
      success: false,
      timestamp:
        new Date().toISOString(),

      signal: {
        direction: "WAIT",
        confidence: 0,
        entry: null,
        stopLoss: null,
        target1: null,
        target2: null,
        target3: null,
        riskReward: null
      },

      reasons: [
        "Era analysis could not be completed."
      ],

      invalidation:
        "No trade until live data is available.",

      error:
        error.message
    };
  }
}

/* =========================================================
   ANALYSIS API
========================================================= */

app.get(
  "/api/analysis",
  async (req, res) => {
    const result =
      await getEraAnalysis();

    return res.json(result);
  }
);

/* =========================================================
   NEWS API
========================================================= */

app.get(
  "/api/news",
  async (req, res) => {
    try {
      const apiKey =
        process.env.NEWS_API_KEY;

      if (!apiKey) {
        return res.json({
          success: true,
          data: [],
          message:
            "NEWS_API_KEY is not configured"
        });
      }

      const response =
        await axios.get(
          "https://newsapi.org/v2/top-headlines",
          {
            params: {
              country: "in",
              category: "business",
              pageSize: 20,
              apiKey
            },
            timeout: 15000
          }
        );

      const articles =
        Array.isArray(
          response.data?.articles
        )
          ? response.data.articles
          : [];

      const data =
        articles.map(
          (article) => ({
            title:
              article.title ||
              "",
            description:
              article.description ||
              "",
            url:
              article.url ||
              "",
            image:
              article.urlToImage ||
              "",
            source:
              article.source?.name ||
              "",
            publishedAt:
              article.publishedAt ||
              ""
          })
        );

      return res.json({
        success: true,
        data
      });
    } catch (error) {
      console.error(
        "[NEWS ERROR]",
        error.response?.data ||
          error.message
      );

      return res.json({
        success: false,
        data: [],
        error:
          "Unable to fetch news"
      });
    }
  }
);

/* =========================================================
   OPENROUTER AI CHAT
========================================================= */

async function getAIChatReply({
  message,
  language,
  history,
  analysis
}) {
  const apiKey =
    process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is missing"
    );
  }

  const model =
    process.env.OPENROUTER_MODEL ||
    "openai/gpt-4o-mini";

  const systemPrompt = `
You are Era AI V5, a professional AI trading assistant.

The user communicates with you mainly by voice.

Reply in the SAME LANGUAGE/style as the user.
If the user speaks Hindi/Hinglish, reply in clear Hindi written in English letters.

Rules:
- Never invent live market prices.
- Use the supplied market data when discussing live prices.
- Never guarantee profit.
- Never claim certainty about market direction.
- If the system signal is WAIT, do not force a BUY or SELL.
- Clearly distinguish live market data from analysis.
- Explain trading setups using:
  Direction
  Entry
  Stop Loss
  Target 1
  Target 2
  Target 3
  Risk/Reward
  Confirmations
  Invalidation
- If confirmation is insufficient, say WAIT / NO TRADE.
- Keep voice responses natural and concise.
- Do not encourage reckless trading or oversized positions.
- Do not pretend to have executed a trade.
`;

  const contextMessage = `
CURRENT ERA ANALYSIS:

${JSON.stringify(
  analysis,
  null,
  2
)}
`;

  const messages = [
    {
      role: "system",
      content:
        systemPrompt
    },

    {
      role: "system",
      content:
        contextMessage
    }
  ];

  if (
    Array.isArray(history)
  ) {
    for (
      const item of history.slice(
        -20
      )
    ) {
      if (
        item &&
        (item.role ===
          "user" ||
          item.role ===
            "assistant") &&
        typeof item.content ===
          "string"
      ) {
        messages.push({
          role: item.role,
          content:
            item.content
        });
      }
    }
  }

  messages.push({
    role: "user",
    content: message
  });

  const response =
    await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model,
        messages,
        temperature: 0.25,
        max_tokens: 700
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
            "Era AI V5"
        },
        timeout: 30000
      }
    );

  const answer =
    response.data?.choices?.[0]
      ?.message?.content;

  if (!answer) {
    throw new Error(
      "OpenRouter returned an empty response"
    );
  }

  return answer;
}

app.post(
  "/api/chat",
  async (req, res) => {
    try {
      const message =
        typeof req.body?.message ===
        "string"
          ? req.body.message.trim()
          : "";

      const language =
        typeof req.body?.language ===
        "string"
          ? req.body.language
          : "en";

      const history =
        Array.isArray(
          req.body?.history
        )
          ? req.body.history
          : [];

      if (!message) {
        return res.status(400).json({
          success: false,
          error:
            "Message is required"
        });
      }

      const analysis =
        await getEraAnalysis();

      const answer =
        await getAIChatReply({
          message,
          language,
          history,
          analysis
        });

      return res.json({
        success: true,
        reply: answer,
        analysis:
          analysis.signal || null
      });
    } catch (error) {
      console.error(
        "[CHAT ERROR]",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        success: false,
        error:
          "AI response failed",
        detail:
          error.response?.data ||
          error.message
      });
    }
  }
);

/* =========================================================
   ELEVENLABS NATURAL VOICE
========================================================= */

app.post(
  "/api/tts",
  async (req, res) => {
    try {
      const apiKey =
        process.env.ELEVENLABS_API_KEY;

      const voiceId =
        process.env.ELEVENLABS_VOICE_ID;

      const text =
        typeof req.body?.text ===
        "string"
          ? req.body.text.trim()
          : "";

      if (!apiKey) {
        return res.status(500).json({
          success: false,
          error:
            "ELEVENLABS_API_KEY is missing"
        });
      }

      if (!voiceId) {
        return res.status(500).json({
          success: false,
          error:
            "ELEVENLABS_VOICE_ID is missing"
        });
      }

      if (!text) {
        return res.status(400).json({
          success: false,
          error:
            "Text is required"
        });
      }

      const cleanText =
        text.slice(0, 4000);

      const response =
        await axios.post(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
            voiceId
          )}?output_format=mp3_44100_128`,
          {
            text: cleanText,

            model_id:
              "eleven_multilingual_v2",

            voice_settings: {
              stability: 0.42,
              similarity_boost: 0.82,
              style: 0.35,
              use_speaker_boost: true
            }
          },
          {
            headers: {
              "xi-api-key":
                apiKey,
              "Content-Type":
                "application/json",
              Accept:
                "audio/mpeg"
            },

            responseType:
              "arraybuffer",

            timeout: 30000
          }
        );

      const audioBuffer =
        Buffer.from(
          response.data
        );

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.setHeader(
        "Content-Length",
        audioBuffer.length
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      return res
        .status(200)
        .send(audioBuffer);
    } catch (error) {
      let detail =
        error.message ||
        "Unknown ElevenLabs error";

      if (error.response?.data) {
        try {
          detail =
            Buffer.from(
              error.response.data
            ).toString("utf8");
        } catch {
          detail =
            String(
              error.response.data
            );
        }
      }

      console.error(
        "[ELEVENLABS TTS ERROR]",
        error.response?.status ||
          "",
        detail
      );

      return res.status(
        error.response?.status ||
          500
      ).json({
        success: false,
        error:
          "Natural voice generation failed",
        status:
          error.response?.status ||
          500,
        detail
      });
    }
  }
);

/* =========================================================
   ROOT HEALTH CHECK
========================================================= */

app.get(
  "/",
  (req, res) => {
    const optionStatus =
      getLiveOptionStatus();

    return res.json({
      app: "Era AI V5",

      status: "online",

      message:
        "Era AI V5 backend is running",

      liveOptions: {
        initialized:
          optionStatus.initialized,

        discoveredContracts:
          optionStatus.discoveredContracts,

        liveContracts:
          optionStatus.liveContracts,

        subscribedContracts:
          optionStatus.subscribedContracts,

        maxNormalLTPCSubscriptions:
          optionStatus.maxNormalLTPCSubscriptions,

        websocketConnections:
          optionStatus.websocketConnections,

        websocket1:
          optionStatus.websocket1,

        websocket2:
          optionStatus.websocket2
      },

      naturalVoice: {
        provider:
          "ElevenLabs",

        configured:
          Boolean(
            process.env.ELEVENLABS_API_KEY &&
              process.env
                .ELEVENLABS_VOICE_ID
          )
      }
    });
  }
);

/* =========================================================
   HEALTH ENDPOINT
========================================================= */

app.get(
  "/health",
  (req, res) => {
    const optionStatus =
      getLiveOptionStatus();

    return res.json({
      success: true,

      backend: "online",

      timestamp:
        new Date().toISOString(),

      upstoxConfigured:
        Boolean(
          process.env
            .UPSTOX_ACCESS_TOKEN
        ),

      openRouterConfigured:
        Boolean(
          process.env
            .OPENROUTER_API_KEY
        ),

      newsConfigured:
        Boolean(
          process.env
            .NEWS_API_KEY
        ),

      elevenLabsConfigured:
        Boolean(
          process.env
            .ELEVENLABS_API_KEY &&
            process.env
              .ELEVENLABS_VOICE_ID
        ),

      liveOptions:
        optionStatus
    });
  }
);

/* =========================================================
   WEBSOCKET MESSAGE TIMESTAMP PATCH
========================================================= */

function attachSocketTimestampTracking() {
  for (
    const socket of optionSockets
  ) {
    if (
      socket &&
      !socket.__eraTimestampAttached
    ) {
      socket.__eraTimestampAttached =
        true;

      const originalProcess =
        socket.__eraMessageHandler;

      if (!originalProcess) {
        socket.__eraMessageHandler =
          true;
      }
    }
  }
}

/*
  Because the SDK emits message events,
  update timestamp whenever liveOptionData
  receives a new value.
*/

const originalSet =
  liveOptionData.set.bind(
    liveOptionData
  );

liveOptionData.set = function (
  key,
  value
) {
  for (
    const socket of optionSockets
  ) {
    if (socket) {
      socket.__eraLastMessage =
        new Date().toISOString();
    }
  }

  return originalSet(
    key,
    value
  );
};

/* =========================================================
   SERVER START
========================================================= */

app.listen(PORT, () => {
  console.log(
    `Era AI V5 backend running on port ${PORT}`
  );

  console.log(
    `[UPSTOX] Access token configured: ${Boolean(
      process.env
        .UPSTOX_ACCESS_TOKEN
    )}`
  );

  console.log(
    `[OPENROUTER] API key configured: ${Boolean(
      process.env
        .OPENROUTER_API_KEY
    )}`
  );

  console.log(
    `[NEWS] API key configured: ${Boolean(
      process.env.NEWS_API_KEY
    )}`
  );

  console.log(
    `[ELEVENLABS] API key configured: ${Boolean(
      process.env
        .ELEVENLABS_API_KEY
    )}`
  );

  console.log(
    `[ELEVENLABS] Voice ID configured: ${Boolean(
      process.env
        .ELEVENLABS_VOICE_ID
    )}`
  );

  setTimeout(() => {
    startLiveOptionWebSocket().catch(
      (error) => {
        console.error(
          "[LIVE OPTIONS] Startup error:",
          error
        );
      }
    );
  }, 3000);
});
