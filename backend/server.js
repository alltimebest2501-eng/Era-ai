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
const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";

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

const CONFIDENCE_THRESHOLD =
  Number(process.env.CONFIDENCE_THRESHOLD || 50);

const MOVEMENT_TRIGGER =
  Number(process.env.OPTION_MOVEMENT_TRIGGER || 20);

const MONITOR_INTERVAL =
  Number(process.env.MONITOR_INTERVAL_MS || 20000);

const ALERT_COOLDOWN =
  Number(process.env.ALERT_COOLDOWN_MS || 180000);

const MAX_RELEVANT_STRIKES =
  Number(process.env.MAX_RELEVANT_STRIKES || 10);

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
   WEBSOCKET STATE
========================================================= */

const MAX_CONNECTIONS = 2;
const MAX_PER_CONNECTION = 5000;

let streamer1 = null;
let streamer2 = null;

let websocket1Connected = false;
let websocket2Connected = false;

let websocket1Error = null;
let websocket2Error = null;

let websocket1LastMessage = null;
let websocket2LastMessage = null;

let subscribed1 = 0;
let subscribed2 = 0;

/* =========================================================
   PUSH / VAPID
========================================================= */

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || "";

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || "";

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT ||
  "mailto:era-ai@example.com";

const PUSH_ENABLED =
  Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (PUSH_ENABLED) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );

  console.log("Era AI Push: ENABLED");
} else {
  console.log(
    "Era AI Push: DISABLED - VAPID keys missing"
  );
}

/* =========================================================
   UPSTOX AUTH
========================================================= */

function configureUpstoxSDK() {
  if (!process.env.UPSTOX_ACCESS_TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is missing");
  }

  const client = UpstoxClient.ApiClient.instance;
  const oauth = client.authentications["OAUTH2"];

  oauth.accessToken =
    process.env.UPSTOX_ACCESS_TOKEN;

  return client;
}

function authHeaders() {
  if (!process.env.UPSTOX_ACCESS_TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is missing");
  }

  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization:
      `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`
  };
}

/* =========================================================
   INDIA TIME
========================================================= */

function indiaParts() {
  const parts =
    new Intl.DateTimeFormat("en-GB", {
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

  return (
    Number(p.hour) * 60 +
    Number(p.minute)
  );
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

function isMarketOpenWindow() {
  if (!isWeekday()) return false;

  const m = indiaMinutes();

  return m >= 555 && m <= 930;
}

function isMarketClosed() {
  if (!isWeekday()) return false;

  return indiaMinutes() > 930;
}

/* =========================================================
   PUSH NOTIFICATION
========================================================= */

async function sendPushNotification({
  title,
  body,
  type = "ERA",
  data = {}
}) {
  if (!PUSH_ENABLED) {
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  const payload = JSON.stringify({
    title,
    body,
    type,
    data,
    timestamp: new Date().toISOString()
  });

  for (
    const [id, subscription]
    of pushSubscriptions.entries()
  ) {
    try {
      await webpush.sendNotification(
        subscription,
        payload
      );

      sent++;
    } catch (error) {
      failed++;

      if (
        error.statusCode === 404 ||
        error.statusCode === 410
      ) {
        pushSubscriptions.delete(id);
      }

      console.error(
        "Push error:",
        error.message
      );
    }
  }

  return { sent, failed };
}

app.get(
  "/api/push/public-key",
  (req, res) => {
    res.json({
      success: true,
      enabled: PUSH_ENABLED,
      publicKey: VAPID_PUBLIC_KEY || null
    });
  }
);

app.post(
  "/api/push/subscribe",
  (req, res) => {
    try {
      const subscription =
        req.body?.subscription || req.body;

      if (!subscription?.endpoint) {
        return res.status(400).json({
          success: false,
          error: "Invalid push subscription"
        });
      }

      const id =
        Buffer
          .from(subscription.endpoint)
          .toString("base64url");

      pushSubscriptions.set(
        id,
        subscription
      );

      res.json({
        success: true,
        subscribed: true,
        total: pushSubscriptions.size
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

app.post(
  "/api/push/unsubscribe",
  (req, res) => {
    const endpoint = req.body?.endpoint;

    if (endpoint) {
      const id =
        Buffer
          .from(endpoint)
          .toString("base64url");

      pushSubscriptions.delete(id);
    }

    res.json({ success: true });
  }
);

app.post(
  "/api/push/test",
  async (req, res) => {
    const result =
      await sendPushNotification({
        title: "Era AI",
        body:
          "Background monitoring is connected.",
        type: "TEST"
      });

    res.json({
      success: true,
      ...result
    });
  }
);

/* =========================================================
   MARKET QUOTE
========================================================= */

function findQuote(data, key) {
  if (!data) return {};

  if (data[key]) {
    return data[key];
  }

  const short = key.split("|")[1];

  for (const k of Object.keys(data)) {
    if (k.includes(short)) {
      return data[k];
    }
  }

  return {};
}

function normalizeQuote(q) {
  const ohlc = q?.ohlc || {};

  return {
    lastPrice: q?.last_price ?? null,
    netChange: q?.net_change ?? null,
    previousClose:
      q?.prev_close_price ??
      ohlc.close ??
      null,
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

    const response =
      await axios.get(
        `${UPSTOX_BASE}/market-quote/quotes`,
        {
          params: {
            instrument_key: instruments
          },
          headers: authHeaders(),
          timeout: 15000
        }
      );

    const data =
      response.data?.data || {};

    return {
      success: true,
      timestamp: new Date().toISOString(),

      nifty:
        normalizeQuote(
          findQuote(data, NIFTY_KEY)
        ),

      banknifty:
        normalizeQuote(
          findQuote(data, BANKNIFTY_KEY)
        ),

      finnifty:
        normalizeQuote(
          findQuote(data, FINNIFTY_KEY)
        ),

      sensex:
        normalizeQuote(
          findQuote(data, SENSEX_KEY)
        ),

      indiaVix:
        normalizeQuote(
          findQuote(data, VIX_KEY)
        ),

      giftNifty:
        normalizeQuote(
          findQuote(data, GIFT_KEY)
        )
    };
  } catch (error) {
    console.error(
      "Market error:",
      error.response?.data ||
      error.message
    );

    return {
      success: false,
      error:
        error.response?.data?.message ||
        error.message
    };
  }
}

app.get(
  "/api/market",
  async (req, res) => {
    const data =
      await getLiveMarketData();

    if (!data.success) {
      return res.status(500).json(data);
    }

    res.json(data);
  }
);

/* =========================================================
   CANDLES
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
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .reverse();
}

async function getIntradayCandles(
  instrumentKey,
  interval = 5
) {
  try {
    const encoded =
      encodeURIComponent(instrumentKey);

    const response =
      await axios.get(
        `${UPSTOX_V3}/historical-candle/intraday/${encoded}/minutes/${interval}`,
        {
          headers: authHeaders(),
          timeout: 15000
        }
      );

    return parseCandles(
      response.data?.data?.candles || []
    );
  } catch (error) {
    console.error(
      "Intraday candle error:",
      error.message
    );

    return [];
  }
}

async function getHistoricalCandles(
  instrumentKey,
  interval = 5
) {
  try {
    const encoded =
      encodeURIComponent(instrumentKey);

    const today = getIndiaDate();

    const from = new Date();
    from.setDate(from.getDate() - 7);

    const parts =
      new Intl.DateTimeFormat(
        "en-CA",
        {
          timeZone: "Asia/Kolkata",
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        }
      ).formatToParts(from);

    const map = {};

    for (const p of parts) {
      map[p.type] = p.value;
    }

    const fromDate =
      `${map.year}-${map.month}-${map.day}`;

    const response =
      await axios.get(
        `${UPSTOX_V3}/historical-candle/${encoded}/minutes/${interval}/${today}/${fromDate}`,
        {
          headers: authHeaders(),
          timeout: 20000
        }
      );

    return parseCandles(
      response.data?.data?.candles || []
    );
  } catch (error) {
    console.error(
      "Historical candle error:",
      error.message
    );

    return [];
  }
}

async function getAnalysisCandles(
  instrumentKey,
  interval = 5
) {
  let candles =
    await getIntradayCandles(
      instrumentKey,
      interval
    );

  if (candles.length < 60) {
    const historical =
      await getHistoricalCandles(
        instrumentKey,
        interval
      );

    if (
      historical.length >
      candles.length
    ) {
      candles = historical;
    }
  }

  return candles.slice(-300);
}

/* =========================================================
   INDICATORS
========================================================= */

function calculateEMA(values, period) {
  if (
    !values ||
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let ema =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) /
    period;

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

  return Number(ema.toFixed(2));
}

function calculateRSI(values, period = 14) {
  if (
    !values ||
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
    const change =
      values[i] -
      values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    const gain =
      change > 0 ? change : 0;

    const loss =
      change < 0 ? Math.abs(change) : 0;

    avgGain =
      (
        avgGain * (period - 1) +
        gain
      ) / period;

    avgLoss =
      (
        avgLoss * (period - 1) +
        loss
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return Number(
    (
      100 -
      100 / (1 + rs)
    ).toFixed(2)
  );
}

function calculateVWAP(candles) {
  if (
    !candles ||
    !candles.length
  ) {
    return null;
  }

  let totalPV = 0;
  let totalVolume = 0;

  for (const c of candles) {
    const volume =
      Number(c.volume || 0);

    if (volume <= 0) continue;

    const typical =
      (
        c.high +
        c.low +
        c.close
      ) / 3;

    totalPV += typical * volume;
    totalVolume += volume;
  }

  if (totalVolume <= 0) {
    return null;
  }

  return Number(
    (
      totalPV / totalVolume
    ).toFixed(2)
  );
}

function calculateATR(
  candles,
  period = 14
) {
  if (
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
    const c = candles[i];
    const p = candles[i - 1];

    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }

  const recent =
    trs.slice(-period);

  return Number(
    (
      recent.reduce(
        (a, b) => a + b,
        0
      ) / recent.length
    ).toFixed(2)
  );
}

function calculateMACD(values) {
  if (values.length < 35) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const macdSeries = [];

  for (
    let i = 26;
    i < values.length;
    i++
  ) {
    const slice =
      values.slice(0, i + 1);

    const fast =
      calculateEMA(slice, 12);

    const slow =
      calculateEMA(slice, 26);

    if (
      fast !== null &&
      slow !== null
    ) {
      macdSeries.push(
        fast - slow
      );
    }
  }

  if (macdSeries.length < 9) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const signal =
    calculateEMA(
      macdSeries,
      9
    );

  const macd =
    macdSeries[
      macdSeries.length - 1
    ];

  return {
    macd: Number(macd.toFixed(2)),
    signal,
    histogram:
      signal !== null
        ? Number(
            (macd - signal).toFixed(2)
          )
        : null
  };
}

function calculateBollinger(
  values,
  period = 20
) {
  if (values.length < period) {
    return null;
  }

  const slice =
    values.slice(-period);

  const mean =
    slice.reduce(
      (a, b) => a + b,
      0
    ) / period;

  const variance =
    slice.reduce(
      (sum, value) =>
        sum +
        Math.pow(value - mean, 2),
      0
    ) / period;

  const sd =
    Math.sqrt(variance);

  return {
    middle: Number(mean.toFixed(2)),
    upper: Number(
      (mean + 2 * sd).toFixed(2)
    ),
    lower: Number(
      (mean - 2 * sd).toFixed(2)
    ),
    width: Number(
      (4 * sd).toFixed(2)
    )
  };
}

function calculateStochastic(
  candles,
  period = 14
) {
  if (candles.length < period) {
    return { k: null, d: null };
  }

  const recent =
    candles.slice(-period);

  const highest =
    Math.max(
      ...recent.map(c => c.high)
    );

  const lowest =
    Math.min(
      ...recent.map(c => c.low)
    );

  const close =
    candles[candles.length - 1].close;

  const k =
    highest === lowest
      ? 50
      : (
          (close - lowest) /
          (highest - lowest)
        ) * 100;

  return {
    k: Number(k.toFixed(2)),
    d: Number(k.toFixed(2))
  };
}

function calculateCCI(
  candles,
  period = 20
) {
  if (candles.length < period) {
    return null;
  }

  const recent =
    candles.slice(-period);

  const tp =
    recent.map(
      c =>
        (
          c.high +
          c.low +
          c.close
        ) / 3
    );

  const mean =
    tp.reduce(
      (a, b) => a + b,
      0
    ) / period;

  const deviation =
    tp.reduce(
      (sum, value) =>
        sum + Math.abs(value - mean),
      0
    ) / period;

  if (deviation === 0) {
    return 0;
  }

  const current =
    tp[tp.length - 1];

  return Number(
    (
      (current - mean) /
      (0.015 * deviation)
    ).toFixed(2)
  );
}

function calculateOBV(candles) {
  if (candles.length < 2) {
    return null;
  }

  let obv = 0;

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    if (
      candles[i].close >
      candles[i - 1].close
    ) {
      obv += candles[i].volume;
    } else if (
      candles[i].close <
      candles[i - 1].close
    ) {
      obv -= candles[i].volume;
    }
  }

  return obv;
}

function calculateADX(
  candles,
  period = 14
) {
  if (
    candles.length <
    period * 2
  ) {
    return null;
  }

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const c = candles[i];
    const p = candles[i - 1];

    tr.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );

    const up =
      c.high - p.high;

    const down =
      p.low - c.low;

    plusDM.push(
      up > down && up > 0
        ? up
        : 0
    );

    minusDM.push(
      down > up && down > 0
        ? down
        : 0
    );
  }

  let atr =
    tr
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  let plus =
    plusDM
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  let minus =
    minusDM
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  const dx = [];

  for (
    let i = period;
    i < tr.length;
    i++
  ) {
    atr =
      (
        atr * (period - 1) +
        tr[i]
      ) / period;

    plus =
      (
        plus * (period - 1) +
        plusDM[i]
      ) / period;

    minus =
      (
        minus * (period - 1) +
        minusDM[i]
      ) / period;

    const plusDI =
      atr ? 100 * plus / atr : 0;

    const minusDI =
      atr ? 100 * minus / atr : 0;

    const sum =
      plusDI + minusDI;

    dx.push(
      sum
        ? 100 *
          Math.abs(
            plusDI - minusDI
          ) /
          sum
        : 0
    );
  }

  if (dx.length < period) {
    return null;
  }

  let adx =
    dx
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;

  for (
    let i = period;
    i < dx.length;
    i++
  ) {
    adx =
      (
        adx * (period - 1) +
        dx[i]
      ) / period;
  }

  return Number(adx.toFixed(2));
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function calculateSupportResistance(candles) {
  if (!candles?.length) {
    return {
      support: null,
      resistance: null
    };
  }

  const recent =
    candles.slice(-30);

  const lows =
    recent.map(c => c.low);

  const highs =
    recent.map(c => c.high);

  return {
    support: Number(
      Math.min(...lows).toFixed(2)
    ),
    resistance: Number(
      Math.max(...highs).toFixed(2)
    )
  };
}

/* =========================================================
   PRICE ACTION
========================================================= */

function detectCandlePattern(candles) {
  if (candles.length < 3) {
    return "NONE";
  }

  const c =
    candles[candles.length - 1];

  const p =
    candles[candles.length - 2];

  const body =
    Math.abs(c.close - c.open);

  const range =
    Math.max(
      c.high - c.low,
      0.0001
    );

  const upper =
    c.high -
    Math.max(c.open, c.close);

  const lower =
    Math.min(c.open, c.close) -
    c.low;

  if (
    c.close > c.open &&
    p.close < p.open &&
    c.open <= p.close &&
    c.close >= p.open
  ) {
    return "BULLISH_ENGULFING";
  }

  if (
    c.close < c.open &&
    p.close > p.open &&
    c.open >= p.close &&
    c.close <= p.open
  ) {
    return "BEARISH_ENGULFING";
  }

  if (
    lower > body * 2 &&
    upper < body
  ) {
    return "HAMMER";
  }

  if (
    upper > body * 2 &&
    lower < body
  ) {
    return "SHOOTING_STAR";
  }

  if (body / range < 0.12) {
    return "DOJI";
  }

  return "NORMAL";
}

/* =========================================================
   VOLUME
========================================================= */

function calculateVolumeAnalysis(candles) {
  if (candles.length < 21) {
    return {
      current: null,
      average: null,
      ratio: null,
      state: "UNKNOWN"
    };
  }

  const current =
    Number(
      candles[candles.length - 1].volume || 0
    );

  const previous =
    candles
      .slice(-21, -1)
      .map(c => Number(c.volume || 0));

  const average =
    previous.reduce(
      (a, b) => a + b,
      0
    ) / previous.length;

  const ratio =
    average > 0
      ? current / average
      : null;

  let state = "NORMAL";

  if (
    ratio !== null &&
    ratio >= 1.5
  ) {
    state = "EXPANSION";
  } else if (
    ratio !== null &&
    ratio <= 0.65
  ) {
    state = "CONTRACTION";
  }

  return {
    current,
    average: Number(
      average.toFixed(0)
    ),
    ratio:
      ratio !== null
        ? Number(ratio.toFixed(2))
        : null,
    state
  };
}

/* =========================================================
   MARKET STRUCTURE
========================================================= */

function detectMarketStructure(candles) {
  if (candles.length < 20) {
    return {
      structure: "UNKNOWN",
      bos: "NONE",
      choch: "NONE",
      swingHigh: null,
      swingLow: null,
      trendStrength: 0
    };
  }

  const recent =
    candles.slice(-20);

  const mid =
    Math.floor(recent.length / 2);

  const first =
    recent.slice(0, mid);

  const second =
    recent.slice(mid);

  const firstHigh =
    Math.max(...first.map(c => c.high));

  const secondHigh =
    Math.max(...second.map(c => c.high));

  const firstLow =
    Math.min(...first.map(c => c.low));

  const secondLow =
    Math.min(...second.map(c => c.low));

  const swingHigh =
    Math.max(...recent.map(c => c.high));

  const swingLow =
    Math.min(...recent.map(c => c.low));

  let structure = "RANGE";
  let bos = "NONE";
  let choch = "NONE";

  if (
    secondHigh > firstHigh &&
    secondLow > firstLow
  ) {
    structure = "BULLISH_HH_HL";
    bos = "BULLISH_BOS";
  } else if (
    secondHigh < firstHigh &&
    secondLow < firstLow
  ) {
    structure = "BEARISH_LH_LL";
    bos = "BEARISH_BOS";
  } else if (
    secondHigh > firstHigh ||
    secondLow > firstLow
  ) {
    structure = "TRANSITION";
    choch = "POSSIBLE_CHOCH";
  }

  const range =
    swingHigh - swingLow;

  const current =
    recent[recent.length - 1].close;

  let strength = 0;

  if (range > 0) {
    const location =
      Math.abs(
        current -
        (swingHigh + swingLow) / 2
      ) / range;

    strength =
      Math.min(
        100,
        Math.round(location * 200)
      );
  }

  return {
    structure,
    bos,
    choch,

    swingHigh:
      Number(swingHigh.toFixed(2)),

    swingLow:
      Number(swingLow.toFixed(2)),

    trendStrength:
      strength
  };
}

/* =========================================================
   LIQUIDITY
========================================================= */

function detectLiquidity(candles) {
  if (candles.length < 10) {
    return {
      equalHighs: false,
      equalLows: false,
      liquiditySweep: "NONE"
    };
  }

  const recent =
    candles.slice(-10);

  const highs =
    recent.map(c => c.high);

  const lows =
    recent.map(c => c.low);

  const highRange =
    Math.max(...highs) -
    Math.min(...highs);

  const lowRange =
    Math.max(...lows) -
    Math.min(...lows);

  const last =
    recent[recent.length - 1];

  const previous =
    recent.slice(0, -1);

  const prevHigh =
    Math.max(
      ...previous.map(c => c.high)
    );

  const prevLow =
    Math.min(
      ...previous.map(c => c.low)
    );

  let sweep = "NONE";

  if (
    last.high > prevHigh &&
    last.close < prevHigh
  ) {
    sweep =
      "BUY_SIDE_LIQUIDITY_SWEEP";
  }

  if (
    last.low < prevLow &&
    last.close > prevLow
  ) {
    sweep =
      "SELL_SIDE_LIQUIDITY_SWEEP";
  }

  return {
    equalHighs:
      highRange <
      Math.max(
        1,
        last.close * 0.001
      ),

    equalLows:
      lowRange <
      Math.max(
        1,
        last.close * 0.001
      ),

    liquiditySweep: sweep
  };
}

/* =========================================================
   FVG
========================================================= */

function detectFVG(candles) {
  if (candles.length < 3) {
    return {
      type: "NONE",
      low: null,
      high: null
    };
  }

  const a =
    candles[candles.length - 3];

  const c =
    candles[candles.length - 1];

  if (c.low > a.high) {
    return {
      type: "BULLISH_FVG",
      low: a.high,
      high: c.low
    };
  }

  if (c.high < a.low) {
    return {
      type: "BEARISH_FVG",
      low: c.high,
      high: a.low
    };
  }

  return {
    type: "NONE",
    low: null,
    high: null
  };
}

/* =========================================================
   FIBONACCI
========================================================= */

function calculateFibonacci(candles) {
  if (candles.length < 20) {
    return null;
  }

  const recent =
    candles.slice(-50);

  const high =
    Math.max(...recent.map(c => c.high));

  const low =
    Math.min(...recent.map(c => c.low));

  const range =
    high - low;

  return {
    high,
    low,

    level236:
      Number(
        (high - range * 0.236).toFixed(2)
      ),

    level382:
      Number(
        (high - range * 0.382).toFixed(2)
      ),

    level500:
      Number(
        (high - range * 0.5).toFixed(2)
      ),

    level618:
      Number(
        (high - range * 0.618).toFixed(2)
      ),

    level786:
      Number(
        (high - range * 0.786).toFixed(2)
      )
  };
}

/* =========================================================
   COMPLETE TECHNICAL ANALYSIS
========================================================= */

async function getTechnicalAnalysis(instrumentKey) {
  try {
    const candles =
      await getAnalysisCandles(
        instrumentKey,
        5
      );

    if (candles.length < 30) {
      return {
        success: false,
        status: "INSUFFICIENT_DATA",
        candles: candles.length
      };
    }

    const closes =
      candles.map(c => c.close);

    const current =
      closes[closes.length - 1];

    const ema9 =
      calculateEMA(closes, 9);

    const ema20 =
      calculateEMA(closes, 20);

    const ema50 =
      calculateEMA(closes, 50);

    const ema100 =
      calculateEMA(closes, 100);

    const ema200 =
      calculateEMA(closes, 200);

    const rsi =
      calculateRSI(closes, 14);

    const vwap =
      calculateVWAP(candles);

    const atr =
      calculateATR(candles, 14);

    const adx =
      calculateADX(candles, 14);

    const macd =
      calculateMACD(closes);

    const bollinger =
      calculateBollinger(closes);

    const stochastic =
      calculateStochastic(candles);

    const cci =
      calculateCCI(candles);

    const obv =
      calculateOBV(candles);

    const sr =
      calculateSupportResistance(candles);

    const pattern =
      detectCandlePattern(candles);

    const structure =
      detectMarketStructure(candles);

    const liquidity =
      detectLiquidity(candles);

    const fvg =
      detectFVG(candles);

    const fibonacci =
      calculateFibonacci(candles);

    const volume =
      calculateVolumeAnalysis(candles);

    let trend = "SIDEWAYS";

    if (
      ema9 &&
      ema20 &&
      ema50
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
      status: "OK",
      instrumentKey,
      timeframe: "5m",
      candles: candles.length,
      current,

      ema9,
      ema20,
      ema50,
      ema100,
      ema200,

      rsi,
      vwap,
      atr,
      adx,

      macd,
      bollinger,
      stochastic,
      cci,
      obv,

      support: sr.support,
      resistance: sr.resistance,

      trend,
      momentum,

      candlestick: pattern,
      structure,
      liquidity,
      fvg,
      fibonacci,
      volume
    };
  } catch (error) {
    return {
      success: false,
      status: "ERROR",
      error: error.message
    };
  }
}

/* =========================================================
   OPTION CONTRACTS
========================================================= */

async function fetchAllOptionContracts() {
  const all = new Map();

  for (
    const underlying
    of OPTION_UNDERLYINGS
  ) {
    try {
      const response =
        await axios.get(
          `${UPSTOX_BASE}/option/contract`,
          {
            params: {
              instrument_key:
                underlying.key
            },
            headers: authHeaders(),
            timeout: 20000
          }
        );

      const rows =
        response.data?.data || [];

      for (
        const contract
        of rows
      ) {
        if (!contract.instrument_key) {
          continue;
        }

        const type =
          contract.instrument_type;

        if (
          type !== "CE" &&
          type !== "PE"
        ) {
          continue;
        }

        all.set(
          contract.instrument_key,
          {
            ...contract,
            underlying_name:
              underlying.name,
            underlying_key:
              underlying.key
          }
        );
      }

      console.log(
        `${underlying.name}: ${rows.length} option contracts`
      );
    } catch (error) {
      console.error(
        `${underlying.name} contract error:`,
        error.response?.data ||
        error.message
      );
    }
  }

  optionContracts.clear();

  for (
    const [key, value]
    of all.entries()
  ) {
    optionContracts.set(key, value);
  }

  return [...optionContracts.values()];
}

app.get(
  "/api/options/contracts",
  async (req, res) => {
    try {
      const instrumentKey =
        req.query.instrument_key ||
        NIFTY_KEY;

      const response =
        await axios.get(
          `${UPSTOX_BASE}/option/contract`,
          {
            params: {
              instrument_key:
                instrumentKey
            },
            headers: authHeaders(),
            timeout: 20000
          }
        );

      res.json({
        success: true,
        data:
          response.data?.data || []
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
