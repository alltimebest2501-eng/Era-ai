require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
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
  {
    name: "NIFTY",
    key: NIFTY_KEY
  },
  {
    name: "BANKNIFTY",
    key: BANKNIFTY_KEY
  },
  {
    name: "FINNIFTY",
    key: FINNIFTY_KEY
  },
  {
    name: "SENSEX",
    key: SENSEX_KEY
  }
];

/* =========================================================
   DATA STORAGE
========================================================= */

const DATA_DIR = path.join(__dirname, "era-data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const ALERTS_FILE = path.join(DATA_DIR, "alerts.json");
const PUSH_FILE = path.join(DATA_DIR, "push-subscriptions.json");

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) return fallback;

    return JSON.parse(raw);
  } catch (error) {
    console.error("[FILE READ ERROR]", file, error.message);
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(value, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("[FILE WRITE ERROR]", file, error.message);
  }
}

/* =========================================================
   SETTINGS
========================================================= */

let settings = readJson(SETTINGS_FILE, {
  voiceAssistant: true,

  backgroundMonitoring: true,

  tradeAlerts: true,

  advancedTrading: true,

  confidenceThreshold: Number(
    process.env.CONFIDENCE_THRESHOLD || 55
  ),

  movementTrigger: Number(
    process.env.MOVEMENT_TRIGGER || 0.35
  ),

  monitorInterval: Number(
    process.env.MONITOR_INTERVAL || 30000
  ),

  alertCooldown: Number(
    process.env.ALERT_COOLDOWN || 300000
  ),

  monitoredMarkets: [
    "NIFTY",
    "BANKNIFTY",
    "FINNIFTY",
    "SENSEX"
  ]
});

let tradeHistory = readJson(HISTORY_FILE, []);
let activeAlerts = readJson(ALERTS_FILE, []);
let pushSubscriptions = readJson(PUSH_FILE, []);

let lastAnalysis = null;
let lastMarket = null;

let monitorTimer = null;

let monitorState = {
  running: false,
  enabled: Boolean(settings.backgroundMonitoring),
  lastRun: null,
  lastError: null,
  cycles: 0,
  lastSignal: null,
  lastAlertAt: null
};

/* =========================================================
   OPTION LIVE STATE
========================================================= */

const optionContracts = new Map();
const liveOptionData = new Map();

let optionSockets = [];
let optionWsRunning = false;
let optionWsStarting = false;

let upstoxConfigured = false;

/* =========================================================
   PUSH NOTIFICATION CONFIGURATION
========================================================= */

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || "";

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || "";

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT ||
  "mailto:admin@example.com";

const pushConfigured =
  Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushConfigured) {
  try {
    webpush.setVapidDetails(
      VAPID_SUBJECT,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );

    console.log("[PUSH] Web Push configured");
  } catch (error) {
    console.error(
      "[PUSH] VAPID configuration error:",
      error.message
    );
  }
} else {
  console.warn(
    "[PUSH] VAPID keys missing. Push notifications disabled."
  );
}

/* =========================================================
   HELPERS
========================================================= */

function saveSettings() {
  writeJson(SETTINGS_FILE, settings);
}

function saveHistory() {
  writeJson(HISTORY_FILE, tradeHistory);
}

function saveAlerts() {
  writeJson(ALERTS_FILE, activeAlerts);
}

function savePushSubscriptions() {
  writeJson(PUSH_FILE, pushSubscriptions);
}

function num(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  return Number(n.toFixed(digits));
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function getIndiaDate() {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(new Date());

  const map = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  return `${map.year}-${map.month}-${map.day}`;
}

function authHeaders() {
  if (!process.env.UPSTOX_ACCESS_TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is missing"
    );
  }

  return {
    Accept: "application/json",

    "Content-Type":
      "application/json",

    Authorization:
      `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`
  };
}

async function upstoxGet(
  url,
  params = {}
) {
  const response =
    await axios.get(
      url,
      {
        headers: authHeaders(),
        params,
        timeout: 15000
      }
    );

  return response.data;
}

/* =========================================================
   MARKET DATA
========================================================= */

function normalizeQuote(q) {
  if (!q) return null;

  const ohlc =
    q.ohlc ||
    q.ohlcData ||
    {};

  const previousClose =
    num(
      q.cp ??
      q.prev_close ??
      q.previous_close ??
      q.close,
      0
    );

  const lastPrice =
    num(
      q.last_price ??
      q.lastPrice ??
      q.ltp ??
      q.lp,
      0
    );

  const change =
    q.net_change ??
    q.netChange ??
    (
      lastPrice &&
      previousClose
        ? lastPrice - previousClose
        : 0
    );

  return {
    lastPrice,

    netChange:
      round(change),

    previousClose,

    open:
      num(
        q.open ??
        ohlc.open
      ),

    high:
      num(
        q.high ??
        ohlc.high
      ),

    low:
      num(
        q.low ??
        ohlc.low
      ),

    close:
      num(
        q.close ??
        ohlc.close ??
        previousClose
      ),

    volume:
      num(
        q.volume ??
        q.vol
      ),

    timestamp:
      new Date().toISOString()
  };
}

async function getLiveMarketData() {
  const keys = [
    NIFTY_KEY,
    BANKNIFTY_KEY,
    FINNIFTY_KEY,
    SENSEX_KEY,
    VIX_KEY,
    GIFT_KEY
  ];

  const response =
    await upstoxGet(
      `${UPSTOX_BASE}/market-quote/quotes`,
      {
        instrument_key:
          keys.join(",")
      }
    );

  const raw =
    response?.data || {};

  function find(key) {
    if (raw[key]) {
      return normalizeQuote(
        raw[key]
      );
    }

    const encoded =
      encodeURIComponent(key);

    if (raw[encoded]) {
      return normalizeQuote(
        raw[encoded]
      );
    }

    const found =
      Object.entries(raw)
        .find(([k]) => {
          try {
            return (
              decodeURIComponent(k) === key
            );
          } catch {
            return k === key;
          }
        });

    return found
      ? normalizeQuote(found[1])
      : null;
  }

  return {
    success: true,

    timestamp:
      new Date().toISOString(),

    nifty:
      find(NIFTY_KEY),

    banknifty:
      find(BANKNIFTY_KEY),

    finnifty:
      find(FINNIFTY_KEY),

    sensex:
      find(SENSEX_KEY),

    indiaVix:
      find(VIX_KEY),

    giftNifty:
      find(GIFT_KEY)
  };
}

/* =========================================================
   CANDLES
========================================================= */

async function getIntradayCandles(
  instrumentKey = NIFTY_KEY,
  interval = 5
) {
  const encoded =
    encodeURIComponent(
      instrumentKey
    );

  const response =
    await upstoxGet(
      `${UPSTOX_V3}/historical-candle/intraday/${encoded}/minutes/${interval}`
    );

  return (
    response?.data?.candles || []
  );
}

async function getHistoricalCandles(
  instrumentKey = NIFTY_KEY,
  interval = 5
) {
  const end =
    new Date();

  const start =
    new Date(
      Date.now() -
      7 * 24 * 60 * 60 * 1000
    );

  const to =
    end.toISOString()
      .slice(0, 10);

  const from =
    start.toISOString()
      .slice(0, 10);

  const encoded =
    encodeURIComponent(
      instrumentKey
    );

  const response =
    await upstoxGet(
      `${UPSTOX_V3}/historical-candle/${encoded}/minutes/${interval}/${to}/${from}`
    );

  return (
    response?.data?.candles || []
  );
}

async function getAnalysisCandles(
  instrumentKey = NIFTY_KEY,
  interval = 5
) {
  let candles = [];

  try {
    candles =
      await getIntradayCandles(
        instrumentKey,
        interval
      );
  } catch (error) {
    console.error(
      "[INTRADAY ERROR]",
      error.response?.data ||
      error.message
    );
  }

  if (
    !Array.isArray(candles) ||
    candles.length < 60
  ) {
    try {
      candles =
        await getHistoricalCandles(
          instrumentKey,
          interval
        );
    } catch (error) {
      console.error(
        "[HISTORICAL ERROR]",
        error.response?.data ||
        error.message
      );
    }
  }

  candles =
    Array.isArray(candles)
      ? candles.slice(-200)
      : [];

  console.log(
    `[ANALYSIS CANDLES] ${instrumentKey} => ${candles.length}`
  );

  return candles;
}

function candleParts(candle) {
  return {
    timestamp:
      candle[0],

    open:
      num(candle[1]),

    high:
      num(candle[2]),

    low:
      num(candle[3]),

    close:
      num(candle[4]),

    volume:
      num(candle[5])
  };
}

/* =========================================================
   TECHNICAL INDICATORS
========================================================= */

function calculateEMA(
  values,
  period
) {
  if (!values.length) {
    return null;
  }

  if (
    values.length < period
  ) {
    return values[
      values.length - 1
    ];
  }

  const multiplier =
    2 / (period + 1);

  let result =
    values
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      values[i] *
        multiplier +
      result *
        (1 - multiplier);
  }

  return result;
}

function calculateRSI(
  values,
  period = 14
) {
  if (
    values.length <= period
  ) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses +=
        Math.abs(change);
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
    const change =
      values[i] -
      values[i - 1];

    const gain =
      Math.max(
        change,
        0
      );

    const loss =
      Math.max(
        -change,
        0
      );

    avgGain =
      (
        avgGain *
          (period - 1) +
        gain
      ) / period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        loss
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain /
    avgLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}

function calculateVWAP(
  candles
) {
  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (
    const raw of candles
  ) {
    const candle =
      candleParts(raw);

    const typical =
      (
        candle.high +
        candle.low +
        candle.close
      ) / 3;

    cumulativePV +=
      typical *
      candle.volume;

    cumulativeVolume +=
      candle.volume;
  }

  return cumulativeVolume
    ? cumulativePV /
        cumulativeVolume
    : null;
}

function calculateSupportResistance(
  candles
) {
  const recent =
    candles
      .slice(-20)
      .map(candleParts);

  if (!recent.length) {
    return {
      support: null,
      resistance: null
    };
  }

  return {
    support:
      Math.min(
        ...recent.map(
          x => x.low
        )
      ),

    resistance:
      Math.max(
        ...recent.map(
          x => x.high
        )
      )
  };
}

async function getTechnicalAnalysis(
  instrumentKey = NIFTY_KEY
) {
  const candles =
    await getAnalysisCandles(
      instrumentKey,
      5
    );

  if (!candles.length) {
    throw new Error(
      "No candle data available"
    );
  }

  const parsed =
    candles.map(candleParts);

  const closes =
    parsed.map(
      x => x.close
    );

  const current =
    closes[
      closes.length - 1
    ];

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

  const rsi14 =
    calculateRSI(
      closes,
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

  let trend =
    "SIDEWAYS";

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

  let momentum =
    "NEUTRAL";

  if (
    rsi14 >= 60
  ) {
    momentum =
      "POSITIVE";
  } else if (
    rsi14 <= 40
  ) {
    momentum =
      "NEGATIVE";
  }

  return {
    instrumentKey,

    candles:
      parsed,

    price:
      round(current),

    ema9:
      round(ema9),

    ema20:
      round(ema20),

    ema50:
      round(ema50),

    rsi14:
      round(rsi14),

    vwap:
      round(vwap),

    support:
      round(sr.support),

    resistance:
      round(sr.resistance),

    trend,

    momentum,

    timestamp:
      new Date().toISOString()
  };
}

/* =========================================================
   OPTIONS CONTRACTS
========================================================= */

async function fetchOptionContracts(
  instrumentKey
) {
  const response =
    await upstoxGet(
      `${UPSTOX_BASE}/option/contract`,
      {
        instrument_key:
          instrumentKey
      }
    );

  const contracts =
    response?.data || [];

  return Array.isArray(
    contracts
  )
    ? contracts
    : [];
}

function contractKey(contract) {
  return (
    contract.instrument_key ||
    contract.instrumentKey ||
    contract.instrument_token ||
    contract.instrumentToken ||
    null
  );
}

function contractExpiry(contract) {
  return (
    contract.expiry ||
    contract.expiry_date ||
    contract.expiryDate ||
    null
  );
}

function getNearestExpiryFromContracts(
  contracts
) {
  const today =
    getIndiaDate();

  const expiries =
    [
      ...new Set(
        contracts
          .map(
            contractExpiry
          )
          .filter(Boolean)
          .filter(
            x =>
              String(x) >= today
          )
      )
    ].sort();

  return (
    expiries[0] ||
    null
  );
}

async function getNearestExpiry(
  instrumentKey = NIFTY_KEY
) {
  const contracts =
    await fetchOptionContracts(
      instrumentKey
    );

  return getNearestExpiryFromContracts(
    contracts
  );
}

async function discoverOptionContracts() {
  optionContracts.clear();

  for (
    const underlying
    of OPTION_UNDERLYINGS
  ) {
    try {
      const contracts =
        await fetchOptionContracts(
          underlying.key
        );

      for (
        const contract
        of contracts
      ) {
        const key =
          contractKey(
            contract
          );

        if (!key) {
          continue;
        }

        optionContracts.set(
          key,
          {
            ...contract,

            underlying:
              underlying.name,

            underlyingKey:
              underlying.key
          }
        );
      }
    } catch (error) {
      console.error(
        `[OPTION CONTRACT ERROR] ${underlying.name}`,
        error.response?.data ||
        error.message
      );
    }
  }

  console.log(
    `[LIVE OPTIONS] Total discovered contracts: ${optionContracts.size}`
  );

  return optionContracts;
}

/* =========================================================
   LIVE OPTIONS
========================================================= */

function extractOptionFeed(
  message
) {
  if (!message) {
    return null;
  }

  const data =
    message.feeds ||
    message.data ||
    message.fullFeed ||
    message;

  if (
    !data ||
    typeof data !== "object"
  ) {
    return null;
  }

  let ltp = null;
  let oi = null;
  let iv = null;
  let bid = null;
  let ask = null;
  let greeks = null;

  const ltpc =
    data.ltpc ||
    data.ff?.ltpc ||
    data.fullFeed?.ltpc ||
    data.fullFeed?.marketFF?.ltpc;

  if (ltpc) {
    ltp =
      num(
        ltpc.ltp ??
        ltpc.lastPrice,
        null
      );
  }

  const market =
    data.marketFF ||
    data.fullFeed?.marketFF ||
    data.ff?.marketFF ||
    data.fullFeed;

  if (market) {
    const marketLtpc =
      market.ltpc || {};

    ltp =
      num(
        marketLtpc.ltp ??
        marketLtpc.lastPrice ??
        market.lastPrice ??
        ltp,
        ltp
      );

    oi =
      num(
        market.oi ??
        market.openInterest ??
        marketLtpc.oi,
        oi
      );

    iv =
      num(
        market.iv ??
        market.impliedVolatility,
        iv
      );

    bid =
      num(
        market.bidPrice ??
        market.bid?.price,
        bid
      );

    ask =
      num(
        market.askPrice ??
        market.ask?.price,
        ask
      );

    greeks =
      market.greeks ||
      market.Greeks ||
      null;
  }

  return {
    ltp,
    oi,
    iv,
    bid,
    ask,
    greeks,

    timestamp:
      new Date().toISOString()
  };
}

function updateLiveOption(
  instrumentKey,
  feed
) {
  if (
    !instrumentKey ||
    !feed
  ) {
    return;
  }

  const previous =
    liveOptionData.get(
      instrumentKey
    ) || {};

  liveOptionData.set(
    instrumentKey,
    {
      ...previous,
      ...feed,
      timestamp:
        new Date().toISOString()
    }
  );
}

function createOptionStreamer(
  keys,
  socketNumber
) {
  try {
    const streamer =
      new UpstoxClient
        .MarketDataStreamerV3(
          [],
          "ltpc"
        );

    streamer.autoReconnect(
      3,
      5
    );

    streamer.on(
      "open",
      () => {
        console.log(
          `[LIVE OPTIONS] WebSocket #${socketNumber} connected`
        );

        try {
          streamer.subscribe(
            keys,
            "ltpc"
          );
        } catch (error) {
          console.error(
            `[LIVE OPTIONS] Subscribe #${socketNumber} error`,
            error.message
          );
        }
      }
    );

    streamer.on(
      "message",
      message => {
        try {
          if (!message) {
            return;
          }

          if (
            message.feeds &&
            typeof message.feeds ===
              "object"
          ) {
            for (
              const [
                instrumentKey,
                rawFeed
              ]
              of Object.entries(
                message.feeds
              )
            ) {
              const feed =
                extractOptionFeed(
                  rawFeed
                );

              if (feed) {
                updateLiveOption(
                  instrumentKey,
                  feed
                );
              }
            }

            return;
          }

          const key =
            message.instrumentKey ||
            message.instrument_key ||
            message.key;

          if (key) {
            const feed =
              extractOptionFeed(
                message
              );

            if (feed) {
              updateLiveOption(
                key,
                feed
              );
            }
          }
        } catch (error) {
          console.error(
            "[LIVE OPTIONS] Message parse error",
            error.message
          );
        }
      }
    );

    streamer.on(
      "error",
      error => {
        console.error(
          `[LIVE OPTIONS] WebSocket #${socketNumber} error`,
          error?.message ||
          error
        );
      }
    );

    streamer.on(
      "close",
      () => {
        console.log(
          `[LIVE OPTIONS] WebSocket #${socketNumber} closed`
        );
      }
    );

    return streamer;
  } catch (error) {
    console.error(
      "[LIVE OPTIONS] Streamer creation error",
      error.message
    );

    return null;
  }
}

async function startLiveOptionWebSocket() {
  if (
    optionWsStarting ||
    optionWsRunning
  ) {
    return;
  }

  optionWsStarting = true;

  try {
    if (
      !process.env.UPSTOX_ACCESS_TOKEN
    ) {
      console.log(
        "[LIVE OPTIONS] Access token missing"
      );

      return;
    }

    await discoverOptionContracts();

    const keys =
      [
        ...optionContracts.keys()
      ];

    if (!keys.length) {
      console.log(
        "[LIVE OPTIONS] No option contracts found"
      );

      return;
    }

    const chunks = [];

    const chunkSize = 4500;

    for (
      let i = 0;
      i < keys.length;
      i += chunkSize
    ) {
      chunks.push(
        keys.slice(
          i,
          i + chunkSize
        )
      );
    }

    optionSockets = [];

    for (
      let i = 0;
      i <
        Math.min(
          chunks.length,
          2
        );
      i++
    ) {
      console.log(
        `[LIVE OPTIONS] Connecting WebSocket #${i + 1}...`
      );

      const socket =
        createOptionStreamer(
          chunks[i],
          i + 1
        );

      if (socket) {
        optionSockets.push(
          socket
        );

        try {
          socket.connect();
        } catch (error) {
          console.error(
            `[LIVE OPTIONS] Connect #${i + 1} error`,
            error.message
          );
        }
      }
    }

    optionWsRunning =
      optionSockets.length > 0;

    console.log(
      `[LIVE OPTIONS] Running with ${optionSockets.length} websocket(s)`
    );
  } catch (error) {
    console.error(
      "[LIVE OPTIONS] Startup error",
      error.message
    );
  } finally {
    optionWsStarting = false;
  }
}

/* =========================================================
   OPTION CHAIN
========================================================= */

async function getOptionChain(
  instrumentKey = NIFTY_KEY,
  expiry
) {
  const selectedExpiry =
    expiry ||
    await getNearestExpiry(
      instrumentKey
    );

  if (!selectedExpiry) {
    throw new Error(
      "No valid option expiry found"
    );
  }

  const response =
    await upstoxGet(
      `${UPSTOX_BASE}/option/chain`,
      {
        instrument_key:
          instrumentKey,

        expiry_date:
          selectedExpiry
      }
    );

  const rows =
    response?.data || [];

  const chain =
    rows.map(row => {
      const strike =
        num(
          row.strike_price ??
          row.strikePrice
        );

      const call =
        row.call_options ||
        row.call ||
        row.CE ||
        {};

      const put =
        row.put_options ||
        row.put ||
        row.PE ||
        {};

      const callKey =
        call.instrument_key ||
        call.instrumentKey;

      const putKey =
        put.instrument_key ||
        put.instrumentKey;

      const callLive =
        callKey
          ? liveOptionData.get(
              callKey
            )
          : null;

      const putLive =
        putKey
          ? liveOptionData.get(
              putKey
            )
          : null;

      const callMarket =
        call.market_data ||
        call.marketData ||
        call;

      const putMarket =
        put.market_data ||
        put.marketData ||
        put;

      return {
        strike,

        call: {
          instrumentKey:
            callKey,

          ltp:
            round(
              callLive?.ltp ??
              callMarket?.ltp ??
              callMarket?.last_price
            ),

          oi:
            num(
              callLive?.oi ??
              callMarket?.oi ??
              callMarket?.open_interest
            ),

          iv:
            num(
              callLive?.iv ??
              callMarket?.iv
            ),

          bid:
            num(
              callLive?.bid ??
              callMarket?.bid_price
            ),

          ask:
            num(
              callLive?.ask ??
              callMarket?.ask_price
            ),

          greeks:
            callLive?.greeks ||
            callMarket?.greeks ||
            null
        },

        put: {
          instrumentKey:
            putKey,

          ltp:
            round(
              putLive?.ltp ??
              putMarket?.ltp ??
              putMarket?.last_price
            ),

          oi:
            num(
              putLive?.oi ??
              putMarket?.oi ??
              putMarket?.open_interest
            ),

          iv:
            num(
              putLive?.iv ??
              putMarket?.iv
            ),

          bid:
            num(
              putLive?.bid ??
              putMarket?.bid_price
            ),

          ask:
            num(
              putLive?.ask ??
              putMarket?.ask_price
            ),

          greeks:
            putLive?.greeks ||
            putMarket?.greeks ||
            null
        }
      };
    });

  return {
    success: true,

    instrumentKey,

    expiry:
      selectedExpiry,

    rows:
      chain,

    timestamp:
      new Date().toISOString()
  };
}

/* =========================================================
   OPTION ANALYSIS
========================================================= */

function analyzeOptionRows(
  rows
) {
  let callOI = 0;
  let putOI = 0;

  for (
    const row of rows
  ) {
    callOI +=
      num(row.call?.oi);

    putOI +=
      num(row.put?.oi);
  }

  const pcr =
    callOI
      ? putOI / callOI
      : 0;

  let bias =
    "NEUTRAL";

  if (
    pcr > 1.15
  ) {
    bias =
      "BULLISH";
  } else if (
    pcr < 0.85
  ) {
    bias =
      "BEARISH";
  }

  let maxPain =
    null;

  if (rows.length) {
    let lowestPain =
      Infinity;

    for (
      const candidate
      of rows
    ) {
      const settlement =
        num(
          candidate.strike
        );

      let pain = 0;

      for (
        const row
        of rows
      ) {
        const strike =
          num(row.strike);

        const callOI =
          num(
            row.call?.oi
          );

        const putOI =
          num(
            row.put?.oi
          );

        pain +=
          Math.max(
            0,
            settlement - strike
          ) *
          callOI;

        pain +=
          Math.max(
            0,
            strike - settlement
          ) *
          putOI;
      }

      if (
        pain <
        lowestPain
      ) {
        lowestPain =
          pain;

        maxPain =
          settlement;
      }
    }
  }

  const resistance =
    rows
      .filter(
        row =>
          num(
            row.call?.oi
          ) > 0
      )
      .sort(
        (a, b) =>
          num(b.call.oi) -
          num(a.call.oi)
      )[0]?.strike ||
    null;

  const support =
    rows
      .filter(
        row =>
          num(
            row.put?.oi
          ) > 0
      )
      .sort(
        (a, b) =>
          num(b.put.oi) -
          num(a.put.oi)
      )[0]?.strike ||
    null;

  const ivs = [];

  for (
    const row of rows
  ) {
    if (
      num(row.call?.iv) > 0
    ) {
      ivs.push(
        num(row.call.iv)
      );
    }

    if (
      num(row.put?.iv) > 0
    ) {
      ivs.push(
        num(row.put.iv)
      );
    }
  }

  const avgIV =
    ivs.length
      ? ivs.reduce(
          (a, b) =>
            a + b,
          0
        ) / ivs.length
      : null;

  return {
    callOI,

    putOI,

    pcr:
      round(
        pcr,
        3
      ),

    maxPain,

    resistance,

    support,

    iv:
      round(avgIV),

    bias
  };
}

async function getOptionAnalysis(
  instrumentKey = NIFTY_KEY
) {
  const expiry =
    await getNearestExpiry(
      instrumentKey
    );

  const chain =
    await getOptionChain(
      instrumentKey,
      expiry
    );

  const summary =
    analyzeOptionRows(
      chain.rows
    );

  return {
    ...summary,

    expiry,

    rows:
      chain.rows,

    timestamp:
      new Date().toISOString()
  };
}

/* =========================================================
   ERA ADVANCED TRADING ENGINE
========================================================= */

async function getEraAnalysis() {
  const market =
    await getLiveMarketData();

  const technical =
    await getTechnicalAnalysis(
      NIFTY_KEY
    );

  const options =
    await getOptionAnalysis(
      NIFTY_KEY
    );

  const price =
    num(
      market.nifty?.lastPrice ||
      technical.price
    );

  let confidence = 0;

  const confirmations = [];

  if (
    technical.trend ===
      "BULLISH" ||
    technical.trend ===
      "BEARISH"
  ) {
    confidence += 30;

    confirmations.push(
      "EMA trend aligned"
    );
  }

  if (
    technical.rsi14 > 55 ||
    technical.rsi14 < 45
  ) {
    confidence += 15;

    confirmations.push(
      "RSI momentum confirmation"
    );
  }

  if (
    technical.vwap
  ) {
    if (
      price >
        technical.vwap &&
      technical.trend ===
        "BULLISH"
    ) {
      confidence += 10;

      confirmations.push(
        "Price above VWAP"
      );
    }

    if (
      price <
        technical.vwap &&
      technical.trend ===
        "BEARISH"
    ) {
      confidence += 10;

      confirmations.push(
        "Price below VWAP"
      );
    }
  }

  if (
    options.bias ===
      "BULLISH" ||
    options.bias ===
      "BEARISH"
  ) {
    confidence += 25;

    confirmations.push(
      "Options confirmation"
    );
  }

  let direction =
    "WAIT";

  if (
    technical.trend ===
      "BULLISH" &&
    options.bias ===
      "BULLISH"
  ) {
    direction =
      "BUY";
  }

  if (
    technical.trend ===
      "BEARISH" &&
    options.bias ===
      "BEARISH"
  ) {
    direction =
      "SELL";
  }

  let entry =
    price;

  let stopLoss =
    null;

  let target1 =
    null;

  let target2 =
    null;

  let target3 =
    null;

  if (
    direction ===
      "BUY" &&
    technical.support
  ) {
    stopLoss =
      technical.support;

    const risk =
      entry -
      stopLoss;

    if (risk > 0) {
      target1 =
        entry +
        risk;

      target2 =
        entry +
        risk * 2;

      target3 =
        entry +
        risk * 3;
    }
  }

  if (
    direction ===
      "SELL" &&
    technical.resistance
  ) {
    stopLoss =
      technical.resistance;

    const risk =
      stopLoss -
      entry;

    if (risk > 0) {
      target1 =
        entry -
        risk;

      target2 =
        entry -
        risk * 2;

      target3 =
        entry -
        risk * 3;
    }
  }

  if (
    confidence <
    Number(
      settings.confidenceThreshold
    )
  ) {
    direction =
      "WAIT";

    entry =
      price;

    stopLoss =
      null;

    target1 =
      null;

    target2 =
      null;

    target3 =
      null;
  }

  const risk =
    direction === "BUY" &&
    stopLoss
      ? entry -
        stopLoss
      : direction === "SELL" &&
          stopLoss
        ? stopLoss -
          entry
        : null;

  const reward =
    direction === "BUY" &&
    target2
      ? target2 -
        entry
      : direction === "SELL" &&
          target2
        ? entry -
          target2
        : null;

  const riskReward =
    risk > 0 &&
    reward > 0
      ? round(
          reward / risk,
          2
        )
      : null;

  const reasons = [
    `Trend: ${technical.trend}`,

    `Momentum: ${technical.momentum}`,

    `RSI: ${technical.rsi14}`,

    `VWAP: ${technical.vwap}`,

    `Options Bias: ${options.bias}`,

    `PCR: ${options.pcr}`,

    ...confirmations
  ];

  return {
    success: true,

    timestamp:
      new Date().toISOString(),

    signal: {
      direction,

      confidence:
        Math.min(
          100,
          Math.round(
            confidence
          )
        ),

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

      riskReward
    },

    market,

    technical,

    options: {
      expiry:
        options.expiry,

      pcr:
        options.pcr,

      maxPain:
        options.maxPain,

      iv:
        options.iv,

      bias:
        options.bias,

      callOI:
        options.callOI,

      putOI:
        options.putOI,

      support:
        options.support,

      resistance:
        options.resistance
    },

    reasons,

    invalidation:
      direction === "BUY"
        ? "Bullish structure invalidates below support."
        : direction === "SELL"
          ? "Bearish structure invalidates above resistance."
          : "No trade until technical and options confirmation align."
  };
}

/* =========================================================
   PUSH NOTIFICATION FUNCTIONS
========================================================= */

function isValidPushSubscription(
  subscription
) {
  return Boolean(
    subscription &&
    subscription.endpoint &&
    subscription.keys &&
    subscription.keys.p256dh &&
    subscription.keys.auth
  );
}

async function sendPushNotification(
  payload
) {
  if (!pushConfigured) {
    console.log(
      "[PUSH] Not configured"
    );

    return {
      sent: 0,
      failed: 0
    };
  }

  if (
    !pushSubscriptions.length
  ) {
    console.log(
      "[PUSH] No subscriptions"
    );

    return {
      sent: 0,
      failed: 0
    };
  }

  let sent = 0;
  let failed = 0;

  const message =
    JSON.stringify(
      payload
    );

  const expired = [];

  for (
    const subscription
    of pushSubscriptions
  ) {
    try {
      await webpush.sendNotification(
        subscription,
        message,
        {
          TTL: 60
        }
      );

      sent++;
    } catch (error) {
      failed++;

      console.error(
        "[PUSH ERROR]",
        error.statusCode,
        error.body ||
          error.message
      );

      if (
        error.statusCode === 404 ||
        error.statusCode === 410
      ) {
        expired.push(
          subscription.endpoint
        );
      }
    }
  }

  if (expired.length) {
    pushSubscriptions =
      pushSubscriptions.filter(
        sub =>
          !expired.includes(
            sub.endpoint
          )
      );

    savePushSubscriptions();
  }

  return {
    sent,
    failed
  };
}

async function sendTradeAlertPush(
  alert
) {
  const title =
    alert.direction === "BUY"
      ? "Era AI • BUY Setup"
      : "Era AI • SELL Setup";

  const body =
    `${alert.market} ${alert.direction} • ` +
    `Entry ${alert.entry} • ` +
    `SL ${alert.stopLoss} • ` +
    `T2 ${alert.target2} • ` +
    `Confidence ${alert.confidence}%`;

  return sendPushNotification({
    type:
      "TRADE_ALERT",

    title,

    body,

    alertId:
      alert.id,

    market:
      alert.market,

    direction:
      alert.direction,

    entry:
      alert.entry,

    stopLoss:
      alert.stopLoss,

    target1:
      alert.target1,

    target2:
      alert.target2,

    target3:
      alert.target3,

    riskReward:
      alert.riskReward,

    confidence:
      alert.confidence,

    url:
      process.env.APP_URL ||
      "/"
  });
}

/* =========================================================
   ALERT ENGINE
========================================================= */

function createAlertFromAnalysis(
  analysis
) {
  if (
    !analysis ||
    !analysis.signal
  ) {
    return null;
  }

  const signal =
    analysis.signal;

  if (
    !["BUY", "SELL"]
      .includes(
        signal.direction
      )
  ) {
    return null;
  }

  if (
    !signal.entry ||
    !signal.stopLoss ||
    !signal.target2
  ) {
    return null;
  }

  return {
    id:
      `ERA-${Date.now()}`,

    type:
      "TRADE_SETUP",

    market:
      "NIFTY",

    direction:
      signal.direction,

    confidence:
      signal.confidence,

    entry:
      signal.entry,

    stopLoss:
      signal.stopLoss,

    target1:
      signal.target1,

    target2:
      signal.target2,

    target3:
      signal.target3,

    riskReward:
      signal.riskReward,

    expiry:
      analysis.options?.expiry ||
      null,

    createdAt:
      new Date().toISOString(),

    status:
      "ACTIVE",

    reasons:
      analysis.reasons ||
      [],

    invalidation:
      analysis.invalidation
  };
}

function shouldCreateAlert(
  alert
) {
  if (!alert) {
    return false;
  }

  const latest =
    activeAlerts[0];

  if (!latest) {
    return true;
  }

  const age =
    Date.now() -
    new Date(
      latest.createdAt
    ).getTime();

  if (
    latest.market ===
      alert.market &&
    latest.direction ===
      alert.direction &&
    latest.entry ===
      alert.entry &&
    age <
      Number(
        settings.alertCooldown
      )
  ) {
    return false;
  }

  return true;
}

/* =========================================================
   BACKGROUND AUTONOMOUS ENGINE
========================================================= */

async function autonomousCycle() {
  if (
    !settings.backgroundMonitoring
  ) {
    return;
  }

  if (
    monitorState.running
  ) {
    return;
  }

  try {
    monitorState.running =
      true;

    monitorState.lastRun =
      new Date().toISOString();

    monitorState.cycles++;

    const analysis =
      await getEraAnalysis();

    lastAnalysis =
      analysis;

    const signal =
      analysis.signal;

    monitorState.lastSignal =
      signal;

    const alert =
      createAlertFromAnalysis(
        analysis
      );

    if (
      settings.tradeAlerts &&
      alert &&
      shouldCreateAlert(
        alert
      )
    ) {
      activeAlerts.unshift(
        alert
      );

      activeAlerts =
        activeAlerts.slice(
          0,
          100
        );

      saveAlerts();

      monitorState.lastAlertAt =
        alert.createdAt;

      console.log(
        `[ERA ALERT] ${alert.direction} ${alert.market} confidence=${alert.confidence}`
      );

      await sendTradeAlertPush(
        alert
      );
    }
  } catch (error) {
    monitorState.lastError =
      error.response?.data ||
      error.message ||
      String(error);

    console.error(
      "[AUTONOMOUS ERROR]",
      monitorState.lastError
    );
  } finally {
    monitorState.running =
      false;
  }
}

function startAutonomousEngine() {
  if (monitorTimer) {
    clearInterval(
      monitorTimer
    );
  }

  if (
    !settings.backgroundMonitoring
  ) {
    monitorState.enabled =
      false;

    console.log(
      "[ERA ENGINE] Background monitoring disabled"
    );

    return;
  }

  monitorState.enabled =
    true;

  const interval =
    Math.max(
      10000,
      Number(
        settings.monitorInterval
      ) || 30000
    );

  monitorTimer =
    setInterval(
      autonomousCycle,
      interval
    );

  console.log(
    `[ERA ENGINE] Background monitoring every ${interval}ms`
  );

  setTimeout(
    autonomousCycle,
    2500
  );
}

function stopAutonomousEngine() {
  if (monitorTimer) {
    clearInterval(
      monitorTimer
    );

    monitorTimer =
      null;
  }

  monitorState.enabled =
    false;

  monitorState.running =
    false;

  console.log(
    "[ERA ENGINE] Background monitoring stopped"
  );
}

/* =========================================================
   OPENROUTER AI
========================================================= */

async function askOpenRouter(
  message,
  history,
  analysis
) {
  if (
    !process.env.OPENROUTER_API_KEY
  ) {
    throw new Error(
      "OPENROUTER_API_KEY is missing"
    );
  }

  const system = `
You are Era AI V6, a premium voice-first Indian market assistant.

You support:
Hindi
Hinglish
Gujarati
English

Always respond in the same language style as the user.

Use only the live market context supplied below.

Never invent live prices.

Never guarantee profit.

Never claim certainty.

If the current signal is WAIT, do not force BUY or SELL.

When discussing a setup, explain:
Direction
Entry
Stop Loss
Target 1
Target 2
Target 3
Risk Reward
Confidence
Confirmations
Invalidation

Keep answers concise and voice friendly.

GIFT NIFTY alone is not enough to predict market direction.

LIVE ERA CONTEXT:

${JSON.stringify(
  analysis,
  null,
  2
)}
`;

  const messages = [
    {
      role:
        "system",

      content:
        system
    },

    ...(Array.isArray(
      history
    )
      ? history
          .slice(-10)
          .map(item => ({
            role:
              item.role ===
              "assistant"
                ? "assistant"
                : "user",

            content:
              String(
                item.content ||
                item.message ||
                ""
              )
          }))
      : []),

    {
      role:
        "user",

      content:
        message
    }
  ];

  const response =
    await axios.post(
      OPENROUTER_URL,
      {
        model:
          process.env.OPENROUTER_MODEL ||
          "openai/gpt-4o-mini",

        messages,

        temperature:
          0.3,

        max_tokens:
          1000
      },
      {
        headers: {
          Authorization:
            `Bearer ${process.env.OPENROUTER_API_KEY}`,

          "Content-Type":
            "application/json",

          "HTTP-Referer":
            process.env.APP_URL ||
            "https://alltimebest2501-eng.github.io/Era-ai/",

          "X-Title":
            "Era AI V6"
        },

        timeout:
          30000
      }
    );

  return (
    response.data
      ?.choices?.[0]
      ?.message?.content ||
    "Era ko abhi response generate karne mein problem aa rahi hai."
  );
}

/* =========================================================
   ELEVENLABS TTS
========================================================= */

async function textToSpeech(
  text
) {
  const apiKey =
    process.env.ELEVENLABS_API_KEY;

  const voiceId =
    process.env.ELEVENLABS_VOICE_ID;

  if (
    !apiKey ||
    !voiceId
  ) {
    throw new Error(
      "ElevenLabs configuration missing"
    );
  }

  const response =
    await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text,

        model_id:
          "eleven_multilingual_v2",

        output_format:
          "mp3_44100_128",

        voice_settings: {
          stability:
            0.42,

          similarity_boost:
            0.82,

          style:
            0.35,

          use_speaker_boost:
            true
        }
      },
      {
        headers: {
          "xi-api-key":
            apiKey,

          Accept:
            "audio/mpeg",

          "Content-Type":
            "application/json"
        },

        responseType:
          "arraybuffer",

        timeout:
          30000
      }
    );

  return response.data;
}

/* =========================================================
   NEWS
========================================================= */

async function fetchNews() {
  if (
    !process.env.NEWS_API_KEY
  ) {
    return {
      success:
        true,

      articles:
        [],

      message:
        "NEWS_API_KEY is not configured"
    };
  }

  const response =
    await axios.get(
      "https://newsapi.org/v2/everything",
      {
        params: {
          q:
            "Indian stock market OR Nifty OR Sensex OR NSE OR BSE",

          language:
            "en",

          sortBy:
            "publishedAt",

          pageSize:
            20,

          apiKey:
            process.env.NEWS_API_KEY
        },

        timeout:
          15000
      }
    );

  const articles =
    (
      response.data
        ?.articles || []
    ).map(
      article => ({
        title:
          article.title,

        description:
          article.description,

        url:
          article.url,

        image:
          article.urlToImage,

        source:
          article.source?.name,

        publishedAt:
          article.publishedAt
      })
    );

  return {
    success:
      true,

    articles,

    timestamp:
      new Date().toISOString()
  };
}

/* =========================================================
   PERFORMANCE
========================================================= */

function calculatePerformance() {
  const closed =
    tradeHistory.filter(
      trade =>
        trade.status ===
          "WIN" ||
        trade.status ===
          "LOSS"
    );

  const wins =
    closed.filter(
      trade =>
        trade.status ===
        "WIN"
    ).length;

  const losses =
    closed.filter(
      trade =>
        trade.status ===
        "LOSS"
    ).length;

  const pnl =
    closed.reduce(
      (sum, trade) =>
        sum +
        num(trade.pnl),
      0
    );

  return {
    totalTrades:
      closed.length,

    wins,

    losses,

    winRate:
      closed.length
        ? round(
            (
              wins /
              closed.length
            ) * 100,
            1
          )
        : 0,

    pnl:
      round(pnl),

    history:
      tradeHistory
        .slice(-100)
        .reverse()
  };
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      success:
        true,

      name:
        "Era AI V6",

      status:
        "online",

      timestamp:
        new Date().toISOString(),

      services: {
        upstox:
          upstoxConfigured,

        openrouter:
          Boolean(
            process.env.OPENROUTER_API_KEY
          ),

        elevenlabs:
          Boolean(
            process.env.ELEVENLABS_API_KEY &&
            process.env.ELEVENLABS_VOICE_ID
          ),

        news:
          Boolean(
            process.env.NEWS_API_KEY
          ),

        push:
          pushConfigured
      },

      engine: {
        backgroundMonitoring:
          settings.backgroundMonitoring,

        advancedTrading:
          settings.advancedTrading,

        tradeAlerts:
          settings.tradeAlerts,

        confidenceThreshold:
          settings.confidenceThreshold,

        monitorInterval:
          settings.monitorInterval
      },

      liveOptions: {
        running:
          optionWsRunning,

        contracts:
          optionContracts.size,

        liveData:
          liveOptionData.size
      }
    });
  }
);

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success:
        true,

      status:
        "online",

      timestamp:
        new Date().toISOString(),

      services: {
        upstox:
          upstoxConfigured,

        openrouter:
          Boolean(
            process.env.OPENROUTER_API_KEY
          ),

        elevenlabs:
          Boolean(
            process.env.ELEVENLABS_API_KEY &&
            process.env.ELEVENLABS_VOICE_ID
          ),

        news:
          Boolean(
            process.env.NEWS_API_KEY
          ),

        push:
          pushConfigured
      }
    });
  }
);

/* =========================================================
   MARKET API
========================================================= */

app.get(
  "/api/market",
  async (req, res) => {
    try {
      const market =
        await getLiveMarketData();

      lastMarket =
        market;

      res.json(
        market
      );
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
   ANALYSIS API
========================================================= */

app.get(
  "/api/analysis",
  async (req, res) => {
    try {
      const analysis =
        await getEraAnalysis();

      lastAnalysis =
        analysis;

      res.json(
        analysis
      );
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
   OPTION CONTRACTS API
========================================================= */

app.get(
  "/api/options/contracts",
  async (req, res) => {
    try {
      const key =
        req.query.instrument_key ||
        NIFTY_KEY;

      const contracts =
        await fetchOptionContracts(
          key
        );

      res.json({
        success:
          true,

        instrumentKey:
          key,

        expiry:
          getNearestExpiryFromContracts(
            contracts
          ),

        contracts
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
   OPTION CHAIN API
========================================================= */

app.get(
  "/api/options/chain",
  async (req, res) => {
    try {
      const key =
        req.query.instrument_key ||
        NIFTY_KEY;

      const chain =
        await getOptionChain(
          key,
          req.query.expiry
        );

      res.json(
        chain
      );
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
   LIVE OPTIONS API
========================================================= */

app.get(
  "/api/options/live-status",
  (req, res) => {
    res.json({
      success:
        true,

      running:
        optionWsRunning,

      starting:
        optionWsStarting,

      websocketConnections:
        optionSockets.length,

      discoveredContracts:
        optionContracts.size,

      liveContracts:
        liveOptionData.size,

      timestamp:
        new Date().toISOString()
    });
  }
);

app.get(
  "/api/options/live",
  (req, res) => {
    const instrumentKey =
      req.query.instrument_key;

    if (instrumentKey) {
      return res.json({
        success:
          true,

        contract:
          optionContracts.get(
            instrumentKey
          ) || null,

        live:
          liveOptionData.get(
            instrumentKey
          ) || null,

        timestamp:
          new Date().toISOString()
      });
    }

    const data = [];

    for (
      const [
        key,
        contract
      ]
      of optionContracts.entries()
    ) {
      data.push({
        instrumentKey:
          key,

        contract,

        live:
          liveOptionData.get(
            key
          ) || null
      });
    }

    res.json({
      success:
        true,

      count:
        data.length,

      data
    });
  }
);

/* =========================================================
   CHAT API
========================================================= */

app.post(
  "/api/chat",
  async (req, res) => {
    try {
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
            "message is required"
        });
      }

      const analysis =
        await getEraAnalysis();

      const answer =
        await askOpenRouter(
          message,
          req.body?.history ||
            [],
          analysis
        );

      res.json({
        success:
          true,

        reply:
          answer,

        analysis:
          analysis.signal ||
          null
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
   ELEVENLABS TTS
========================================================= */

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
          success:
            false,

          error:
            "text is required"
        });
      }

      const audio =
        await textToSpeech(
          text
        );

      res.set({
        "Content-Type":
          "audio/mpeg",

        "Content-Length":
          audio.length,

        "Cache-Control":
          "no-store"
      });

      res.send(
        audio
      );
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

app.get(
  "/api/tts/status",
  (req, res) => {
    res.json({
      success:
        true,

      configured:
        Boolean(
          process.env.ELEVENLABS_API_KEY &&
          process.env.ELEVENLABS_VOICE_ID
        ),

      voiceConfigured:
        Boolean(
          process.env.ELEVENLABS_VOICE_ID
        )
    });
  }
);

/* =========================================================
   NEWS API
========================================================= */

app.get(
  "/api/news",
  async (req, res) => {
    try {
      const news =
        await fetchNews();

      res.json(
        news
      );
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
   PUSH API
========================================================= */

/*
  Frontend:
  POST /api/push/subscribe

  Body:
  {
    endpoint: "...",
    keys: {
      p256dh: "...",
      auth: "..."
    }
  }
*/

app.get(
  "/api/push/public-key",
  (req, res) => {
    res.json({
      success:
        true,

      configured:
        pushConfigured,

      publicKey:
        VAPID_PUBLIC_KEY ||
        null
    });
  }
);

app.post(
  "/api/push/subscribe",
  (req, res) => {
    try {
      const subscription =
        req.body;

      if (
        !isValidPushSubscription(
          subscription
        )
      ) {
        return res.status(400).json({
          success:
            false,

          error:
            "Invalid push subscription"
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

        savePushSubscriptions();
      }

      res.json({
        success:
          true,

        subscribed:
          true,

        totalSubscriptions:
          pushSubscriptions.length
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

app.delete(
  "/api/push/subscribe",
  (req, res) => {
    const endpoint =
      req.body?.endpoint;

    if (!endpoint) {
      return res.status(400).json({
        success:
          false,

        error:
          "endpoint is required"
      });
    }

    pushSubscriptions =
      pushSubscriptions.filter(
        item =>
          item.endpoint !==
          endpoint
      );

    savePushSubscriptions();

    res.json({
      success:
        true,

      subscribed:
        false
    });
  }
);

app.post(
  "/api/push/test",
  async (req, res) => {
    try {
      if (
        !pushConfigured
      ) {
        return res.status(400).json({
          success:
            false,

          error:
            "Push notifications are not configured"
        });
      }

      const result =
        await sendPushNotification({
          type:
            "TEST",

          title:
            "Era AI • Test Alert",

          body:
            "Era background notification system is working.",

          url:
            process.env.APP_URL ||
            "/"
        });

      res.json({
        success:
          true,

        ...result
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
   ALERTS API
========================================================= */

app.get(
  "/api/alerts",
  (req, res) => {
    res.json({
      success:
        true,

      alerts:
        activeAlerts,

      count:
        activeAlerts.length
    });
  }
);

app.post(
  "/api/alerts/:id/close",
  (req, res) => {
    const id =
      req.params.id;

    const alert =
      activeAlerts.find(
        item =>
          item.id === id
      );

    if (!alert) {
      return res.status(404).json({
        success:
          false,

        error:
          "Alert not found"
      });
    }

    alert.status =
      "CLOSED";

    alert.closedAt =
      new Date().toISOString();

    saveAlerts();

    res.json({
      success:
        true,

      alert
    });
  }
);

/* =========================================================
   MONITOR STATUS
========================================================= */

app.get(
  "/api/monitor/status",
  (req, res) => {
    res.json({
      success:
        true,

      running:
        monitorState.running,

      enabled:
        settings.backgroundMonitoring,

      lastRun:
        monitorState.lastRun,

      lastError:
        monitorState.lastError,

      cycles:
        monitorState.cycles,

      lastSignal:
        monitorState.lastSignal,

      lastAlertAt:
        monitorState.lastAlertAt,

      interval:
        settings.monitorInterval,

      confidenceThreshold:
        settings.confidenceThreshold,

      pushConfigured:
        pushConfigured,

      pushSubscribers:
        pushSubscriptions.length
    });
  }
);

/* =========================================================
   SETTINGS API
========================================================= */

app.get(
  "/api/settings",
  (req, res) => {
    res.json({
      success:
        true,

      settings
    });
  }
);

app.post(
  "/api/settings",
  (req, res) => {
    try {
      const incoming =
        req.body || {};

      settings = {
        ...settings,

        ...incoming
      };

      if (
        incoming.confidenceThreshold !==
        undefined
      ) {
        settings.confidenceThreshold =
          Number(
            incoming.confidenceThreshold
          );
      }

      if (
        incoming.monitorInterval !==
        undefined
      ) {
        settings.monitorInterval =
          Number(
            incoming.monitorInterval
          );
      }

      if (
        incoming.alertCooldown !==
        undefined
      ) {
        settings.alertCooldown =
          Number(
            incoming.alertCooldown
          );
      }

      saveSettings();

      if (
        settings.backgroundMonitoring
      ) {
        startAutonomousEngine();
      } else {
        stopAutonomousEngine();
      }

      res.json({
        success:
          true,

        settings
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
   HISTORY API
========================================================= */

app.get(
  "/api/history",
  (req, res) => {
    res.json({
      success:
        true,

      history:
        tradeHistory
          .slice(-100)
          .reverse()
    });
  }
);

app.post(
  "/api/history",
  (req, res) => {
    try {
      const trade =
        req.body;

      if (!trade) {
        return res.status(400).json({
          success:
            false,

          error:
            "Trade data is required"
        });
      }

      const record = {
        id:
          trade.id ||
          `TRADE-${Date.now()}`,

        ...trade,

        createdAt:
          trade.createdAt ||
          new Date().toISOString()
      };

      tradeHistory.push(
        record
      );

      tradeHistory =
        tradeHistory.slice(
          -500
        );

      saveHistory();

      res.json({
        success:
          true,

        trade:
          record
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
   PERFORMANCE API
========================================================= */

app.get(
  "/api/performance",
  (req, res) => {
    res.json({
      success:
        true,

      ...calculatePerformance()
    });
  }
);

/* =========================================================
   MANUAL ENGINE CONTROL
========================================================= */

app.post(
  "/api/engine/start",
  (req, res) => {
    settings.backgroundMonitoring =
      true;

    saveSettings();

    startAutonomousEngine();

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
    settings.backgroundMonitoring =
      false;

    saveSettings();

    stopAutonomousEngine();

    res.json({
      success:
        true,

      running:
        false
    });
  }
);

app.post(
  "/api/engine/run-now",
  async (req, res) => {
    try {
      await autonomousCycle();

      res.json({
        success:
          true,

        state:
          monitorState,

        analysis:
          lastAnalysis
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
   START SERVER
========================================================= */

configureUpstoxSDK();

app.listen(
  PORT,
  () => {
    console.log("");
    console.log(
      "=========================================="
    );

    console.log(
      "        ERA AI V6 SERVER ONLINE"
    );

    console.log(
      "=========================================="
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Upstox: ${
        upstoxConfigured
          ? "READY"
          : "MISSING TOKEN"
      }`
    );

    console.log(
      `OpenRouter: ${
        process.env.OPENROUTER_API_KEY
          ? "READY"
          : "MISSING KEY"
      }`
    );

    console.log(
      `ElevenLabs: ${
        process.env.ELEVENLABS_API_KEY &&
        process.env.ELEVENLABS_VOICE_ID
          ? "READY"
          : "MISSING CONFIG"
      }`
    );

    console.log(
      `NewsAPI: ${
        process.env.NEWS_API_KEY
          ? "READY"
          : "MISSING KEY"
      }`
    );

    console.log(
      `Push: ${
        pushConfigured
          ? "READY"
          : "MISSING VAPID"
      }`
    );

    console.log(
      `Background Engine: ${
        settings.backgroundMonitoring
          ? "ON"
          : "OFF"
      }`
    );

    console.log(
      `Advanced Trading: ${
        settings.advancedTrading
          ? "ON"
          : "OFF"
      }`
    );

    console.log(
      "=========================================="
    );

    console.log("");
  }
);

/* =========================================================
   START BACKGROUND SERVICES
========================================================= */

setTimeout(
  () => {
    if (
      process.env.UPSTOX_ACCESS_TOKEN
    ) {
      startLiveOptionWebSocket();
    } else {
      console.log(
        "[LIVE OPTIONS] Waiting for UPSTOX_ACCESS_TOKEN"
      );
    }

    startAutonomousEngine();
  },
  3000
);

/* =========================================================
   GLOBAL ERROR HANDLERS
========================================================= */

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "[UNHANDLED REJECTION]",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "[UNCAUGHT EXCEPTION]",
      error
    );
  }
);
