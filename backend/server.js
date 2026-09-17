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
  {
    name: "NIFTY",
    key: NIFTY_KEY,
    strikeStep: 50
  },
  {
    name: "BANKNIFTY",
    key: BANKNIFTY_KEY,
    strikeStep: 100
  },
  {
    name: "FINNIFTY",
    key: FINNIFTY_KEY,
    strikeStep: 50
  },
  {
    name: "SENSEX",
    key: SENSEX_KEY,
    strikeStep: 100
  }
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
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is missing"
    );
  }

  const client =
    UpstoxClient.ApiClient.instance;

  const oauth =
    client.authentications["OAUTH2"];

  oauth.accessToken =
    process.env.UPSTOX_ACCESS_TOKEN;

  return client;
}

function authHeaders() {
  if (!process.env.UPSTOX_ACCESS_TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is missing"
    );
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
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone: "Asia/Kolkata",
        hour12: false,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }
    ).formatToParts(new Date());

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

  return day !== "Sat" &&
         day !== "Sun";
}

function isMarketOpen() {
  if (!isWeekday()) return false;

  const m = indiaMinutes();

  return m >= 555 && m <= 930;
}

function isMarketOpenWindow() {
  if (!isWeekday()) return false;

  const m = indiaMinutes();

  // NSE market monitoring window: 09:15 AM - 03:30 PM
  return m >= 555 && m <= 930;
}

function isMarketClosed() {
  if (!isWeekday()) return false;

  return indiaMinutes() > 930;
}
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
    return {
      sent: 0,
      failed: 0
    };
  }

  let sent = 0;
  let failed = 0;

  const payload = JSON.stringify({
    title,
    body,
    type,
    data,
    timestamp:
      new Date().toISOString()
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

  return {
    sent,
    failed
  };
}

app.get(
  "/api/push/public-key",
  (req, res) => {
    res.json({
      success: true,
      enabled: PUSH_ENABLED,
      publicKey:
        VAPID_PUBLIC_KEY || null
    });
  }
);

app.post(
  "/api/push/subscribe",
  (req, res) => {
    try {
      const subscription =
        req.body?.subscription ||
        req.body;

      if (!subscription?.endpoint) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid push subscription"
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
        total:
          pushSubscriptions.size
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
    const endpoint =
      req.body?.endpoint;

    if (endpoint) {
      const id =
        Buffer
          .from(endpoint)
          .toString("base64url");

      pushSubscriptions.delete(id);
    }

    res.json({
      success: true
    });
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

  const short =
    key.split("|")[1];

  for (const k of Object.keys(data)) {
    if (
      k.includes(short)
    ) {
      return data[k];
    }
  }

  return {};
}

function normalizeQuote(q) {
  const ohlc =
    q?.ohlc || {};

  return {
    lastPrice:
      q?.last_price ??
      null,

    netChange:
      q?.net_change ??
      null,

    previousClose:
      q?.prev_close_price ??
      ohlc.close ??
      null,

    open:
      q?.open ??
      ohlc.open ??
      null,

    high:
      q?.high ??
      ohlc.high ??
      null,

    low:
      q?.low ??
      ohlc.low ??
      null,

    close:
      q?.close ??
      ohlc.close ??
      null,

    volume:
      q?.volume ??
      ohlc.volume ??
      null
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
            instrument_key:
              instruments
          },
          headers:
            authHeaders(),
          timeout: 15000
        }
      );

    const data =
      response.data?.data ||
      {};

    return {
      success: true,

      timestamp:
        new Date().toISOString(),

      nifty:
        normalizeQuote(
          findQuote(
            data,
            NIFTY_KEY
          )
        ),

      banknifty:
        normalizeQuote(
          findQuote(
            data,
            BANKNIFTY_KEY
          )
        ),

      finnifty:
        normalizeQuote(
          findQuote(
            data,
            FINNIFTY_KEY
          )
        ),

      sensex:
        normalizeQuote(
          findQuote(
            data,
            SENSEX_KEY
          )
        ),

      indiaVix:
        normalizeQuote(
          findQuote(
            data,
            VIX_KEY
          )
        ),

      giftNifty:
        normalizeQuote(
          findQuote(
            data,
            GIFT_KEY
          )
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
      return res
        .status(500)
        .json(data);
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
      encodeURIComponent(
        instrumentKey
      );

    const response =
      await axios.get(
        `${UPSTOX_V3}/historical-candle/intraday/${encoded}/minutes/${interval}`,
        {
          headers:
            authHeaders(),
          timeout: 15000
        }
      );

    return parseCandles(
      response.data?.data?.candles ||
      []
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
      encodeURIComponent(
        instrumentKey
      );

    const today =
      getIndiaDate();

    const from =
      new Date();

    from.setDate(
      from.getDate() - 7
    );

    const parts =
      new Intl.DateTimeFormat(
        "en-CA",
        {
          timeZone:
            "Asia/Kolkata",
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
          headers:
            authHeaders(),
          timeout: 20000
        }
      );

    return parseCandles(
      response.data?.data?.candles ||
      []
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
      candles =
        historical;
    }
  }

  return candles.slice(-300);
}

/* =========================================================
   EMA
========================================================= */

function calculateEMA(
  values,
  period
) {
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
      .reduce(
        (a, b) => a + b,
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

  return Number(
    ema.toFixed(2)
  );
}

/* =========================================================
   RSI
========================================================= */

function calculateRSI(
  values,
  period = 14
) {
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
      change > 0
        ? change
        : 0;

    const loss =
      change < 0
        ? Math.abs(change)
        : 0;

    avgGain =
      (avgGain *
        (period - 1) +
        gain) /
      period;

    avgLoss =
      (avgLoss *
        (period - 1) +
        loss) /
      period;
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

/* =========================================================
   VWAP
========================================================= */

function calculateVWAP(
  candles
) {
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

    if (
      volume <= 0
    ) continue;

    const typical =
      (
        c.high +
        c.low +
        c.close
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

  return Number(
    (
      totalPV /
      totalVolume
    ).toFixed(2)
  );
}

/* =========================================================
   ATR
========================================================= */

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
    const c =
      candles[i];

    const p =
      candles[i - 1];

    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(
          c.high -
          p.close
        ),
        Math.abs(
          c.low -
          p.close
        )
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
      ) /
      recent.length
    ).toFixed(2)
  );
}

/* =========================================================
   MACD
========================================================= */

function calculateMACD(
  values
) {
  if (
    values.length < 35
  ) {
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
      values.slice(
        0,
        i + 1
      );

    const fast =
      calculateEMA(
        slice,
        12
      );

    const slow =
      calculateEMA(
        slice,
        26
      );

    if (
      fast !== null &&
      slow !== null
    ) {
      macdSeries.push(
        fast - slow
      );
    }
  }

  if (
    macdSeries.length <
    9
  ) {
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
    macd:
      Number(
        macd.toFixed(2)
      ),

    signal,

    histogram:
      signal !== null
        ? Number(
            (
              macd -
              signal
            ).toFixed(2)
          )
        : null
  };
}

/* =========================================================
   BOLLINGER BANDS
========================================================= */

function calculateBollinger(
  values,
  period = 20
) {
  if (
    values.length <
    period
  ) {
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
        Math.pow(
          value - mean,
          2
        ),
      0
    ) / period;

  const sd =
    Math.sqrt(
      variance
    );

  return {
    middle:
      Number(
        mean.toFixed(2)
      ),

    upper:
      Number(
        (
          mean +
          2 * sd
        ).toFixed(2)
      ),

    lower:
      Number(
        (
          mean -
          2 * sd
        ).toFixed(2)
      ),

    width:
      Number(
        (
          4 * sd
        ).toFixed(2)
      )
  };
}

/* =========================================================
   STOCHASTIC
========================================================= */

function calculateStochastic(
  candles,
  period = 14
) {
  if (
    candles.length <
    period
  ) {
    return {
      k: null,
      d: null
    };
  }

  const recent =
    candles.slice(-period);

  const highest =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );

  const lowest =
    Math.min(
      ...recent.map(
        c => c.low
      )
    );

  const close =
    candles[
      candles.length - 1
    ].close;

  const k =
    highest === lowest
      ? 50
      : (
          (close - lowest) /
          (highest - lowest)
        ) * 100;

  return {
    k: Number(
      k.toFixed(2)
    ),
    d: Number(
      k.toFixed(2)
    )
  };
}

/* =========================================================
   CCI
========================================================= */

function calculateCCI(
  candles,
  period = 20
) {
  if (
    candles.length <
    period
  ) {
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
        sum +
        Math.abs(
          value - mean
        ),
      0
    ) / period;

  if (
    deviation === 0
  ) {
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

/* =========================================================
   OBV
========================================================= */

function calculateOBV(
  candles
) {
  if (
    candles.length < 2
  ) {
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
      obv +=
        candles[i].volume;
    } else if (
      candles[i].close <
      candles[i - 1].close
    ) {
      obv -=
        candles[i].volume;
    }
  }

  return obv;
}

/* =========================================================
   ADX
========================================================= */

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
    const c =
      candles[i];

    const p =
      candles[i - 1];

    tr.push(
      Math.max(
        c.high - c.low,
        Math.abs(
          c.high -
          p.close
        ),
        Math.abs(
          c.low -
          p.close
        )
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
      down > up &&
      down > 0
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
        atr *
        (period - 1) +
        tr[i]
      ) / period;

    plus =
      (
        plus *
        (period - 1) +
        plusDM[i]
      ) / period;

    minus =
      (
        minus *
        (period - 1) +
        minusDM[i]
      ) / period;

    const plusDI =
      atr
        ? 100 * plus / atr
        : 0;

    const minusDI =
      atr
        ? 100 * minus / atr
        : 0;

    const sum =
      plusDI +
      minusDI;

    dx.push(
      sum
        ? 100 *
          Math.abs(
            plusDI -
            minusDI
          ) /
          sum
        : 0
    );
  }

  if (
    dx.length <
    period
  ) {
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
        adx *
        (period - 1) +
        dx[i]
      ) / period;
  }

  return Number(
    adx.toFixed(2)
  );
}

/* =========================================================
   SUPPORT / RESISTANCE
========================================================= */

function calculateSupportResistance(
  candles
) {
  if (
    !candles?.length
  ) {
    return {
      support: null,
      resistance: null
    };
  }

  const recent =
    candles.slice(-30);

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
      Number(
        Math.min(
          ...lows
        ).toFixed(2)
      ),

    resistance:
      Number(
        Math.max(
          ...highs
        ).toFixed(2)
      )
  };
}

/* =========================================================
   PRICE ACTION
========================================================= */

function detectCandlePattern(
  candles
) {
  if (
    candles.length < 3
  ) {
    return "NONE";
  }

  const c =
    candles[
      candles.length - 1
    ];

  const p =
    candles[
      candles.length - 2
    ];

  const body =
    Math.abs(
      c.close -
      c.open
    );

  const range =
    Math.max(
      c.high -
      c.low,
      0.0001
    );

  const upper =
    c.high -
    Math.max(
      c.open,
      c.close
    );

  const lower =
    Math.min(
      c.open,
      c.close
    ) -
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

  if (
    body / range < 0.12
  ) {
    return "DOJI";
  }

  return "NORMAL";
}

/* =========================================================
   VOLUME
========================================================= */

function calculateVolumeAnalysis(
  candles
) {
  if (
    candles.length < 21
  ) {
    return {
      current: null,
      average: null,
      ratio: null,
      state: "UNKNOWN"
    };
  }

  const current =
    Number(
      candles[
        candles.length - 1
      ].volume || 0
    );

  const previous =
    candles
      .slice(-21, -1)
      .map(
        c =>
          Number(
            c.volume || 0
          )
      );

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
    average:
      Number(
        average.toFixed(0)
      ),
    ratio:
      ratio !== null
        ? Number(
            ratio.toFixed(2)
          )
        : null,
    state
  };
}

/* =========================================================
   MARKET STRUCTURE
========================================================= */

function detectMarketStructure(
  candles
) {
  if (
    candles.length < 20
  ) {
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
    Math.floor(
      recent.length / 2
    );

  const first =
    recent.slice(
      0,
      mid
    );

  const second =
    recent.slice(mid);

  const firstHigh =
    Math.max(
      ...first.map(
        c => c.high
      )
    );

  const secondHigh =
    Math.max(
      ...second.map(
        c => c.high
      )
    );

  const firstLow =
    Math.min(
      ...first.map(
        c => c.low
      )
    );

  const secondLow =
    Math.min(
      ...second.map(
        c => c.low
      )
    );

  const swingHigh =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );

  const swingLow =
    Math.min(
      ...recent.map(
        c => c.low
      )
    );

  let structure = "RANGE";
  let bos = "NONE";
  let choch = "NONE";

  if (
    secondHigh > firstHigh &&
    secondLow > firstLow
  ) {
    structure =
      "BULLISH_HH_HL";

    bos =
      "BULLISH_BOS";
  } else if (
    secondHigh < firstHigh &&
    secondLow < firstLow
  ) {
    structure =
      "BEARISH_LH_LL";

    bos =
      "BEARISH_BOS";
  } else if (
    secondHigh > firstHigh ||
    secondLow > firstLow
  ) {
    structure =
      "TRANSITION";

    choch =
      "POSSIBLE_CHOCH";
  }

  const range =
    swingHigh -
    swingLow;

  const current =
    recent[
      recent.length - 1
    ].close;

  let strength = 0;

  if (range > 0) {
    const location =
      Math.abs(
        current -
        (
          swingHigh +
          swingLow
        ) / 2
      ) /
      range;

    strength =
      Math.min(
        100,
        Math.round(
          location * 200
        )
      );
  }

  return {
    structure,
    bos,
    choch,

    swingHigh:
      Number(
        swingHigh.toFixed(2)
      ),

    swingLow:
      Number(
        swingLow.toFixed(2)
      ),

    trendStrength:
      strength
  };
}

/* =========================================================
   LIQUIDITY
========================================================= */

function detectLiquidity(
  candles
) {
  if (
    candles.length < 10
  ) {
    return {
      equalHighs: false,
      equalLows: false,
      liquiditySweep: "NONE"
    };
  }

  const recent =
    candles.slice(-10);

  const highs =
    recent.map(
      c => c.high
    );

  const lows =
    recent.map(
      c => c.low
    );

  const highRange =
    Math.max(...highs) -
    Math.min(...highs);

  const lowRange =
    Math.max(...lows) -
    Math.min(...lows);

  const last =
    recent[
      recent.length - 1
    ];

  const previous =
    recent.slice(
      0,
      -1
    );

  const prevHigh =
    Math.max(
      ...previous.map(
        c => c.high
      )
    );

  const prevLow =
    Math.min(
      ...previous.map(
        c => c.low
      )
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

    liquiditySweep:
      sweep
  };
}

/* =========================================================
   FVG / IMBALANCE
========================================================= */

function detectFVG(
  candles
) {
  if (
    candles.length < 3
  ) {
    return {
      type: "NONE",
      low: null,
      high: null
    };
  }

  const a =
    candles[
      candles.length - 3
    ];

  const b =
    candles[
      candles.length - 2
    ];

  const c =
    candles[
      candles.length - 1
    ];

  if (
    c.low > a.high
  ) {
    return {
      type: "BULLISH_FVG",
      low: a.high,
      high: c.low
    };
  }

  if (
    c.high < a.low
  ) {
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

function calculateFibonacci(
  candles
) {
  if (
    candles.length < 20
  ) {
    return null;
  }

  const recent =
    candles.slice(-50);

  const high =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );

  const low =
    Math.min(
      ...recent.map(
        c => c.low
      )
    );

  const range =
    high - low;

  return {
    high,
    low,

    level236:
      Number(
        (
          high -
          range * 0.236
        ).toFixed(2)
      ),

    level382:
      Number(
        (
          high -
          range * 0.382
        ).toFixed(2)
      ),

    level500:
      Number(
        (
          high -
          range * 0.5
        ).toFixed(2)
      ),

    level618:
      Number(
        (
          high -
          range * 0.618
        ).toFixed(2)
      ),

    level786:
      Number(
        (
          high -
          range * 0.786
        ).toFixed(2)
      )
  };
}

/* =========================================================
   COMPLETE TECHNICAL ANALYSIS
========================================================= */

async function getTechnicalAnalysis(
  instrumentKey
) {
  try {
    const candles =
      await getAnalysisCandles(
        instrumentKey,
        5
      );

    if (
      candles.length < 30
    ) {
      return {
        success: false,
        status:
          "INSUFFICIENT_DATA",
        candles:
          candles.length
      };
    }

    const closes =
      candles.map(
        c => c.close
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

    const ema100 =
      calculateEMA(
        closes,
        100
      );

    const ema200 =
      calculateEMA(
        closes,
        200
      );

    const rsi =
      calculateRSI(
        closes,
        14
      );

    const vwap =
      calculateVWAP(
        candles
      );

    const atr =
      calculateATR(
        candles,
        14
      );

    const adx =
      calculateADX(
        candles,
        14
      );

    const macd =
      calculateMACD(
        closes
      );

    const bollinger =
      calculateBollinger(
        closes
      );

    const stochastic =
      calculateStochastic(
        candles
      );

    const cci =
      calculateCCI(
        candles
      );

    const obv =
      calculateOBV(
        candles
      );

    const sr =
      calculateSupportResistance(
        candles
      );

    const pattern =
      detectCandlePattern(
        candles
      );

    const structure =
      detectMarketStructure(
        candles
      );

    const liquidity =
      detectLiquidity(
        candles
      );

    const fvg =
      detectFVG(
        candles
      );

    const fibonacci =
      calculateFibonacci(
        candles
      );

    const volume =
      calculateVolumeAnalysis(
        candles
      );

    let trend =
      "SIDEWAYS";

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
    }

    let momentum =
      "NEUTRAL";

    if (
      rsi !== null
    ) {
      if (
        rsi >= 60
      ) {
        momentum =
          "POSITIVE";
      } else if (
        rsi <= 40
      ) {
        momentum =
          "NEGATIVE";
      }
    }

    return {
      success: true,
      status: "OK",

      instrumentKey,

      timeframe:
        "5m",

      candles:
        candles.length,

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

      support:
        sr.support,

      resistance:
        sr.resistance,

      trend,
      momentum,

      candlestick:
        pattern,

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
      error:
        error.message
    };
  }
}

/* =========================================================
   OPTION CONTRACTS
========================================================= */

async function fetchAllOptionContracts() {
  const all =
    new Map();

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
            headers:
              authHeaders(),
            timeout: 20000
          }
        );

      const rows =
        response.data?.data ||
        [];

      for (
        const contract
        of rows
      ) {
        if (
          !contract.instrument_key
        ) {
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
    optionContracts.set(
      key,
      value
    );
  }

  return [
    ...optionContracts.values()
  ];
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
            headers:
              authHeaders(),
            timeout: 20000
          }
        );

      res.json({
        success: true,
        data:
          response.data?.data ||
          []
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
   OPTION WEBSOCKET
========================================================= */

function updateLiveOption(
  instrumentKey,
  data
) {
  const previous =
    liveOptionData.get(
      instrumentKey
    ) || {};

  liveOptionData.set(
    instrumentKey,
    {
      ...previous,
      ...data,

      instrument_key:
        instrumentKey,

      updated_at:
        new Date().toISOString()
    }
  );
}

function decodeSocketData(
  data
) {
  try {
    if (
      data &&
      typeof data === "object" &&
      !Buffer.isBuffer(data)
    ) {
      return data;
    }

    if (
      Buffer.isBuffer(data)
    ) {
      return JSON.parse(
        data.toString("utf8")
      );
    }

    if (
      typeof data === "string"
    ) {
      return JSON.parse(data);
    }
  } catch {
    return null;
  }

  return null;
}

function extractOptionFeed(
  feed
) {
  if (!feed) return {};

  const ltpc =
    feed.ltpc ||
    {};

  const greeks =
    feed.optionGreeks ||
    feed.option_greeks ||
    feed.firstLevelWithGreeks
      ?.optionGreeks ||
    {};

  const level =
    feed.firstLevelWithGreeks ||
    {};

  return {
    ltp:
      ltpc.ltp ??
      null,

    close:
      ltpc.cp ??
      null,

    lastTradeTime:
      ltpc.ltt ??
      null,

    lastTradeQuantity:
      ltpc.ltq ??
      null,

    volume:
      feed.vtt ??
      level.vtt ??
      null,

    oi:
      feed.oi ??
      level.oi ??
      null,

    previousOI:
      feed.poi ??
      level.poi ??
      null,

    oiChange:
      feed.oi != null &&
      feed.poi != null
        ? Number(feed.oi) -
          Number(feed.poi)
        : null,

    bid:
      feed.firstDepth?.bidP ??
      feed.bidP ??
      null,

    ask:
      feed.firstDepth?.askP ??
      feed.askP ??
      null,

    iv:
      greeks.iv ??
      null,

    delta:
      greeks.delta ??
      null,

    gamma:
      greeks.gamma ??
      null,

    theta:
      greeks.theta ??
      null,

    vega:
      greeks.vega ??
      null,

    rho:
      greeks.rho ??
      null
  };
}

function handleSocketMessage(
  raw,
  socketNumber
) {
  const decoded =
    decodeSocketData(raw);

  if (!decoded) return;

  const feeds =
    decoded.feeds ||
    decoded.data ||
    {};

  for (
    const [
      instrumentKey,
      feed
    ] of Object.entries(
      feeds
    )
  ) {
    if (
      instrumentKey ===
      "currentTs"
    ) {
      continue;
    }

    const parsed =
      extractOptionFeed(
        feed
      );

    updateLiveOption(
      instrumentKey,
      parsed
    );
  }

  const now =
    new Date().toISOString();

  if (
    socketNumber === 1
  ) {
    websocket1LastMessage =
      now;
  } else {
    websocket2LastMessage =
      now;
  }
}

function createStreamer(
  socketNumber,
  keys
) {
  if (!keys.length) {
    return null;
  }

  configureUpstoxSDK();

  const streamer =
    new UpstoxClient
      .MarketDataStreamerV3(
        [],
        "ltpc"
      );

  streamer.autoReconnect(
    true,
    10,
    999999
  );

  streamer.on(
    "open",
    () => {
      console.log(
        `Option WebSocket #${socketNumber} connected`
      );

      try {
        streamer.subscribe(
          keys,
          "ltpc"
        );

        if (
          socketNumber === 1
        ) {
          websocket1Connected =
            true;

          subscribed1 =
            keys.length;

          websocket1Error =
            null;
        } else {
          websocket2Connected =
            true;

          subscribed2 =
            keys.length;

          websocket2Error =
            null;
        }
      } catch (error) {
        console.error(
          "Subscription error:",
          error.message
        );
      }
    }
  );

  streamer.on(
    "message",
    data => {
      handleSocketMessage(
        data,
        socketNumber
      );
    }
  );

  streamer.on(
    "error",
    error => {
      console.error(
        `WebSocket #${socketNumber} error:`,
        error.message
      );

      if (
        socketNumber === 1
      ) {
        websocket1Error =
          error.message;
      } else {
        websocket2Error =
          error.message;
      }
    }
  );

  streamer.on(
    "close",
    () => {
      if (
        socketNumber === 1
      ) {
        websocket1Connected =
          false;
      } else {
        websocket2Connected =
          false;
      }
    }
  );

  streamer.connect();

  return streamer;
}

async function startLiveOptionWebSocket() {
  try {
    console.log(
      "Loading option contracts..."
    );

    const contracts =
      await fetchAllOptionContracts();

    const keys =
      contracts
        .map(
          c =>
            c.instrument_key
        )
        .filter(Boolean);

    if (!keys.length) {
      throw new Error(
        "No option contracts found"
      );
    }

    const first =
      keys.slice(
        0,
        MAX_PER_CONNECTION
      );

    const second =
      keys.slice(
        MAX_PER_CONNECTION,
        MAX_PER_CONNECTION *
          MAX_CONNECTIONS
      );

    streamer1 =
      createStreamer(
        1,
        first
      );

    if (second.length) {
      setTimeout(() => {
        streamer2 =
          createStreamer(
            2,
            second
          );
      }, 1000);
    }

    console.log(
      `Live option universe: ${keys.length}`
    );
  } catch (error) {
    console.error(
      "Option websocket initialization failed:",
      error.message
    );
  }
}

/* =========================================================
   LIVE OPTION API
========================================================= */

app.get(
  "/api/options/live-status",
  (req, res) => {
    res.json({
      success: true,

      websocket:
        websocket1Connected ||
        websocket2Connected,

      websocket1:
        websocket1Connected,

      websocket2:
        websocket2Connected,

      websocket1LastMessage,
      websocket2LastMessage,

      websocket1Error,
      websocket2Error,

      discoveredContracts:
        optionContracts.size,

      liveContracts:
        liveOptionData.size,

      subscribedContracts:
        subscribed1 +
        subscribed2,

      socket1Subscribed:
        subscribed1,

      socket2Subscribed:
        subscribed2
    });
  }
);

app.get(
  "/api/options/live",
  (req, res) => {
    const key =
      req.query.instrument_key;

    if (key) {
      return res.json({
        success: true,
        data: {
          ...(optionContracts.get(key) || {}),
          ...(liveOptionData.get(key) || {})
        }
      });
    }

    const data = [];

    for (
      const [
        instrumentKey,
        contract
      ] of optionContracts.entries()
    ) {
      data.push({
        ...contract,
        ...(liveOptionData.get(
          instrumentKey
        ) || {})
      });
    }

    res.json({
      success: true,
      count: data.length,
      liveCount:
        liveOptionData.size,
      data
    });
  }
);

/* =========================================================
   OPTION CHAIN
========================================================= */

async function getOptionChain(
  instrumentKey,
  expiry
) {
  const response =
    await axios.get(
      `${UPSTOX_BASE}/option/chain`,
      {
        params: {
          instrument_key:
            instrumentKey,
          expiry_date:
            expiry
        },
        headers:
          authHeaders(),
        timeout: 15000
      }
    );

  const rows =
    response.data?.data ||
    [];

  return rows.map(row => {
    const call =
      row.call_options ||
      {};

    const put =
      row.put_options ||
      {};

    const callKey =
      call.instrument_key;

    const putKey =
      put.instrument_key;

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

    if (
      callLive?.ltp != null
    ) {
      row.call_options = {
        ...call,

        market_data: {
          ...(call.market_data || {}),

          ltp:
            callLive.ltp,

          oi:
            callLive.oi ??
            call.market_data?.oi,

          volume:
            callLive.volume ??
            call.market_data?.volume,

          oi_change:
            callLive.oiChange ??
            call.market_data?.oi_change,

          iv:
            callLive.iv ??
            call.market_data?.iv
        }
      };
    }

    if (
      putLive?.ltp != null
    ) {
      row.put_options = {
        ...put,

        market_data: {
          ...(put.market_data || {}),

          ltp:
            putLive.ltp,

          oi:
            putLive.oi ??
            put.market_data?.oi,

          volume:
            putLive.volume ??
            put.market_data?.volume,

          oi_change:
            putLive.oiChange ??
            put.market_data?.oi_change,

          iv:
            putLive.iv ??
            put.market_data?.iv
        }
      };
    }

    return row;
  });
}

app.get(
  "/api/options/chain",
  async (req, res) => {
    try {
      const instrumentKey =
        req.query.instrument_key ||
        NIFTY_KEY;

      const expiry =
        req.query.expiry_date;

      if (!expiry) {
        return res.status(400).json({
          success: false,
          error:
            "expiry_date is required"
        });
      }

      const data =
        await getOptionChain(
          instrumentKey,
          expiry
        );

      res.json({
        success: true,
        data
      });
    } catch (error) {
      console.error(
        "Option chain error:",
        error.message
      );

      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   EXPIRY
========================================================= */

async function getNearestExpiry(
  instrumentKey
) {
  try {
    const response =
      await axios.get(
        `${UPSTOX_BASE}/option/contract`,
        {
          params: {
            instrument_key:
              instrumentKey
          },
          headers:
            authHeaders(),
          timeout: 15000
        }
      );

    const rows =
      response.data?.data ||
      [];

    const today =
      getIndiaDate();

    const expiries = [
      ...new Set(
        rows
          .map(
            x =>
              x.expiry ||
              x.expiry_date
          )
          .filter(
            x =>
              x &&
              x >= today
          )
      )
    ].sort();

    return (
      expiries[0] ||
      null
    );
  } catch {
    return null;
  }
}

/* =========================================================
   OPTION ANALYSIS
========================================================= */

async function getOptionAnalysis(
  instrumentKey
) {
  try {
    const expiry =
      await getNearestExpiry(
        instrumentKey
      );

    if (!expiry) {
      return {
        success: false,
        error:
          "No expiry"
      };
    }

    const chain =
      await getOptionChain(
        instrumentKey,
        expiry
      );

    let callOI = 0;
    let putOI = 0;

    let callVolume = 0;
    let putVolume = 0;

    const strikes = [];

    for (
      const row of chain
    ) {
      const strike =
        Number(
          row.strike_price
        );

      if (
        !Number.isFinite(
          strike
        )
      ) {
        continue;
      }

      strikes.push(
        strike
      );

      const call =
        row.call_options
          ?.market_data ||
        {};

      const put =
        row.put_options
          ?.market_data ||
        {};

      callOI +=
        Number(
          call.oi || 0
        );

      putOI +=
        Number(
          put.oi || 0
        );

      callVolume +=
        Number(
          call.volume || 0
        );

      putVolume +=
        Number(
          put.volume || 0
        );
    }

    const pcr =
      callOI > 0
        ? putOI / callOI
        : null;

    let bias =
      "NEUTRAL";

    if (
      pcr !== null
    ) {
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
    }

    return {
      success: true,

      expiry,

      totalCallOI:
        callOI,

      totalPutOI:
        putOI,

      totalCallVolume:
        callVolume,

      totalPutVolume:
        putVolume,

      pcr:
        pcr !== null
          ? Number(
              pcr.toFixed(3)
            )
          : null,

      bias,

      strikes
    };
  } catch (error) {
    return {
      success: false,
      error:
        error.message
    };
  }
}

/* =========================================================
   RELEVANT OPTION CONTRACTS
========================================================= */

function getRelevantContracts(
  underlying,
  spot
) {
  const cfg =
    OPTION_UNDERLYINGS.find(
      x =>
        x.name ===
        underlying
    );

  if (
    !cfg ||
    !Number.isFinite(spot)
  ) {
    return [];
  }

  const today =
    getIndiaDate();

  const expiries = [
    ...new Set(
      [
        ...optionContracts.values()
      ]
        .filter(
          c =>
            c.underlying_name ===
            underlying
        )
        .map(
          c =>
            c.expiry ||
            c.expiry_date
        )
        .filter(
          e =>
            e &&
            e >= today
        )
    )
  ].sort();

  const expiry =
    expiries[0];

  if (!expiry) {
    return [];
  }

  const atm =
    Math.round(
      spot /
      cfg.strikeStep
    ) *
    cfg.strikeStep;

  const min =
    atm -
    cfg.strikeStep *
    MAX_RELEVANT_STRIKES;

  const max =
    atm +
    cfg.strikeStep *
    MAX_RELEVANT_STRIKES;

  return [
    ...optionContracts.values()
  ]
    .filter(c => {
      const strike =
        Number(
          c.strike_price ??
          c.strike ??
          c.strikePrice
        );

      const cExpiry =
        c.expiry ||
        c.expiry_date;

      return (
        c.underlying_name ===
          underlying &&

        cExpiry ===
          expiry &&

        strike >= min &&
        strike <= max &&

        (
          c.instrument_type ===
            "CE" ||
          c.instrument_type ===
            "PE"
        )
      );
    })
    .sort(
      (a, b) => {
        const sa =
          Number(
            a.strike_price
          );

        const sb =
          Number(
            b.strike_price
          );

        return (
          Math.abs(sa - atm) -
          Math.abs(sb - atm)
        );
      }
    );
}

/* =========================================================
   OPTION MOVEMENT DETECTOR
========================================================= */

function detectOptionMovement(
  instrumentKey,
  price
) {
  if (
    !Number.isFinite(price)
  ) {
    return null;
  }

  const previous =
    optionSnapshots.get(
      instrumentKey
    );

  optionSnapshots.set(
    instrumentKey,
    {
      price,
      time:
        Date.now()
    }
  );

  if (!previous) {
    return null;
  }

  const movement =
    price -
    previous.price;

  const points =
    Math.abs(movement);

  if (
    points <
    MOVEMENT_TRIGGER
  ) {
    return null;
  }

  return {
    points:
      Number(
        points.toFixed(2)
      ),

    direction:
      movement > 0
        ? "UP"
        : "DOWN",

    from:
      previous.price,

    to:
      price,

    triggered:
      true
  };
}

/* =========================================================
   OPTION TRADE CONFIDENCE
========================================================= */

async function analyzeOptionTrade(
  contract,
  movement
) {
  if (!movement) {
    return null;
  }

  const underlying =
    contract.underlying_name;

  const cfg =
    OPTION_UNDERLYINGS.find(
      x =>
        x.name ===
        underlying
    );

  if (!cfg) {
    return null;
  }

  const market =
    await getLiveMarketData();

  if (!market.success) {
    return null;
  }

  const quoteMap = {
    NIFTY:
      market.nifty,
    BANKNIFTY:
      market.banknifty,
    FINNIFTY:
      market.finnifty,
    SENSEX:
      market.sensex
  };

  const spot =
    quoteMap[
      underlying
    ]?.lastPrice;

  if (!Number.isFinite(spot)) {
    return null;
  }

  const [
    technical,
    options
  ] = await Promise.all([
    getTechnicalAnalysis(
      cfg.key
    ),

    getOptionAnalysis(
      cfg.key
    )
  ]);

  if (!technical.success) {
    return null;
  }

  const isCall =
    contract.instrument_type ===
    "CE";

  const isPut =
    contract.instrument_type ===
    "PE";

  const live =
    liveOptionData.get(
      contract.instrument_key
    ) || {};

  const entry =
    Number(live.ltp);

  if (!Number.isFinite(entry)) {
    return null;
  }

  let confidence = 0;

  const confirmations = [];
  const conflicts = [];

  /* -------------------------
     TREND
  ------------------------- */

  if (
    (
      isCall &&
      technical.trend ===
        "BULLISH"
    ) ||
    (
      isPut &&
      technical.trend ===
        "BEARISH"
    )
  ) {
    confidence += 20;

    confirmations.push(
      "Underlying trend aligned"
    );
  } else {
    conflicts.push(
      "Underlying trend not aligned"
    );
  }

  /* -------------------------
     VWAP
  ------------------------- */

  if (
    technical.vwap !== null
  ) {
    if (
      isCall &&
      spot >
        technical.vwap
    ) {
      confidence += 10;

      confirmations.push(
        "Price above VWAP"
      );
    } else if (
      isPut &&
      spot <
        technical.vwap
    ) {
      confidence += 10;

      confirmations.push(
        "Price below VWAP"
      );
    } else {
      conflicts.push(
        "VWAP conflict"
      );
    }
  }

  /* -------------------------
     RSI
  ------------------------- */

  if (
    technical.rsi !== null
  ) {
    if (
      isCall &&
      technical.rsi >= 55
    ) {
      confidence += 10;

      confirmations.push(
        `RSI ${technical.rsi} bullish`
      );
    } else if (
      isPut &&
      technical.rsi <= 45
    ) {
      confidence += 10;

      confirmations.push(
        `RSI ${technical.rsi} bearish`
      );
    }
  }

  /* -------------------------
     MACD
  ------------------------- */

  const histogram =
    technical.macd
      ?.histogram;

  if (
    histogram !== null &&
    histogram !== undefined
  ) {
    if (
      (
        isCall &&
        histogram > 0
      ) ||
      (
        isPut &&
        histogram < 0
      )
    ) {
      confidence += 10;

      confirmations.push(
        "MACD momentum aligned"
      );
    } else {
      conflicts.push(
        "MACD conflict"
      );
    }
  }

  /* -------------------------
     MARKET STRUCTURE
  ------------------------- */

  const structure =
    technical.structure
      ?.structure;

  if (
    (
      isCall &&
      structure ===
        "BULLISH_HH_HL"
    ) ||
    (
      isPut &&
      structure ===
        "BEARISH_LH_LL"
    )
  ) {
    confidence += 10;

    confirmations.push(
      "Market structure aligned"
    );
  }

  /* -------------------------
     ADX
  ------------------------- */

  if (
    technical.adx !== null &&
    technical.adx >= 20
  ) {
    confidence += 5;

    confirmations.push(
      `ADX ${technical.adx} trend strength`
    );
  }

  /* -------------------------
     VOLUME
  ------------------------- */

  if (
    technical.volume?.ratio >=
    1.2
  ) {
    confidence += 5;

    confirmations.push(
      "Volume expansion"
    );
  }

  /* -------------------------
     OPTION CHAIN
  ------------------------- */

  if (
    options.success
  ) {
    if (
      (
        isCall &&
        options.bias ===
          "BULLISH"
      ) ||
      (
        isPut &&
        options.bias ===
          "BEARISH"
      )
    ) {
      confidence += 15;

      confirmations.push(
        "Option chain bias aligned"
      );
    } else if (
      options.bias !==
      "NEUTRAL"
    ) {
      conflicts.push(
        "Option chain conflict"
      );
    }
  }

  /* -------------------------
     PRICE ACTION
  ------------------------- */

  if (
    (
      isCall &&
      [
        "BULLISH_ENGULFING",
        "HAMMER"
      ].includes(
        technical.candlestick
      )
    ) ||
    (
      isPut &&
      [
        "BEARISH_ENGULFING",
        "SHOOTING_STAR"
      ].includes(
        technical.candlestick
      )
    )
  ) {
    confidence += 5;

    confirmations.push(
      `Price action: ${technical.candlestick}`
    );
  }

  /* -------------------------
     MOVEMENT
  ------------------------- */

  if (
    movement.points >=
    MOVEMENT_TRIGGER
  ) {
    confirmations.push(
      `Option moved ${movement.points} points`
    );
  }

  confidence =
    Math.min(
      100,
      Math.round(
        confidence
      )
    );

  /*
   * IMPORTANT:
   * >50 = trade candidate
   * <=50 = WAIT
   */

  if (
    confidence <=
    CONFIDENCE_THRESHOLD
  ) {
    return {
      validTrade: false,

      status:
        "WAIT",

      confidence,

      underlying,

      optionType:
        contract.instrument_type,

      strike:
        Number(
          contract.strike_price
        ),

      expiry:
        contract.expiry ||
        contract.expiry_date,

      entry,

      movement,

      confirmations,

      conflicts
    };
  }

  /* =====================================================
     DYNAMIC TRADE LEVELS
  ===================================================== */

  const atr =
    Number(
      technical.atr || 0
    );

  /*
   * 20-30 points is the movement trigger,
   * NOT the maximum target.
   */

  const targetBase =
    Math.max(
      MOVEMENT_TRIGGER,
      movement.points,
      atr * 1.1
    );

  const risk =
    Math.max(
      8,
      Math.min(
        targetBase * 0.45,
        entry * 0.12
      )
    );

  const sl =
    Math.max(
      0.05,
      entry - risk
    );

  const t1 =
    entry +
    targetBase;

  const t2 =
    entry +
    Math.max(
      targetBase * 1.8,
      risk * 2
    );

  const t3 =
    entry +
    Math.max(
      targetBase * 2.6,
      risk * 3
    );

  const rr =
    (
      (t2 - entry) /
      (entry - sl)
    );

  return {
    validTrade: true,

    status:
      "ACTIVE",

    direction:
      "BUY",

    confidence,

    underlying,

    underlyingInstrumentKey:
      cfg.key,

    optionType:
      contract.instrument_type,

    strike:
      Number(
        contract.strike_price
      ),

    expiry:
      contract.expiry ||
      contract.expiry_date,

    instrumentKey:
      contract.instrument_key,

    entry:
      Number(
        entry.toFixed(2)
      ),

    sl:
      Number(
        sl.toFixed(2)
      ),

    t1:
      Number(
        t1.toFixed(2)
      ),

    t2:
      Number(
        t2.toFixed(2)
      ),

    t3:
      Number(
        t3.toFixed(2)
      ),

    rr:
      Number(
        rr.toFixed(2)
      ),

    movement,

    confirmations,

    conflicts,

    invalidation:
      isCall
        ? `Underlying loses ${technical.vwap ?? "VWAP"} / bullish structure invalidates`
        : `Underlying regains ${technical.vwap ?? "VWAP"} / bearish structure invalidates`,

    technicalSnapshot: {
      spot,
      trend:
        technical.trend,
      rsi:
        technical.rsi,
      vwap:
        technical.vwap,
      atr:
        technical.atr,
      adx:
        technical.adx,
      structure:
        technical.structure,
      candlestick:
        technical.candlestick
    },

    optionSnapshot: {
      oi:
        live.oi ?? null,
      oiChange:
        live.oiChange ?? null,
      volume:
        live.volume ?? null,
      iv:
        live.iv ?? null,
      delta:
        live.delta ?? null,
      gamma:
        live.gamma ?? null,
      theta:
        live.theta ?? null,
      vega:
        live.vega ?? null,
      rho:
        live.rho ?? null
    }
  };
}

/* =========================================================
   ALERT CREATION
========================================================= */

function alertSignature(trade) {
  return [
    trade.underlying,
    trade.optionType,
    trade.strike,
    trade.expiry
  ].join("|");
}

function alreadyRecentlyAlerted(
  trade
) {
  const signature =
    alertSignature(
      trade
    );

  const previous =
    alerts.find(
      a =>
        a.signature ===
        signature
    );

  if (!previous) {
    return false;
  }

  return (
    Date.now() -
      new Date(
        previous.createdAt
      ).getTime() <
    ALERT_COOLDOWN
  );
}

async function createTradeAlert(
  trade
) {
  if (
    !trade?.validTrade
  ) {
    return null;
  }

  if (
    alreadyRecentlyAlerted(
      trade
    )
  ) {
    return null;
  }

  const alert = {
    id:
      `ERA-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`,

    signature:
      alertSignature(
        trade
      ),

    createdAt:
      new Date().toISOString(),

    read: false,

    ...trade
  };

  alerts.unshift(
    alert
  );

  while (
    alerts.length > 200
  ) {
    alerts.pop();
  }

  activeTrades.set(
    alert.id,
    alert
  );

  await sendPushNotification({
    title:
      `Era AI • ${trade.underlying} ${trade.optionType}`,

    body:
      `${trade.strike} ${trade.optionType} • BUY • Entry ${trade.entry} • Confidence ${trade.confidence}%`,

    type:
      "TRADE_ALERT",

    data: {
      alertId:
        alert.id,

      underlying:
        trade.underlying,

      strike:
        trade.strike,

      optionType:
        trade.optionType,

      expiry:
        trade.expiry,

      confidence:
        trade.confidence
    }
  });

  return alert;
}

/* =========================================================
   MONITOR RELEVANT OPTIONS
========================================================= */

async function monitorOptions() {
  if (
    !isMarketOpen()
  ) {
    return;
  }

  if (
    monitorBusy
  ) {
    return;
  }

  monitorBusy = true;

  try {
    const market =
      await getLiveMarketData();

    if (!market.success) {
      return;
    }

    const markets = [
      {
        name:
          "NIFTY",
        quote:
          market.nifty
      },
      {
        name:
          "BANKNIFTY",
        quote:
          market.banknifty
      },
      {
        name:
          "FINNIFTY",
        quote:
          market.finnifty
      },
      {
        name:
          "SENSEX",
        quote:
          market.sensex
      }
    ];

    for (
      const item
      of markets
    ) {
      const spot =
        Number(
          item.quote?.lastPrice
        );

      if (
        !Number.isFinite(
          spot
        )
      ) {
        continue;
      }

      const relevant =
        getRelevantContracts(
          item.name,
          spot
        );

      /*
       * Check live websocket prices.
       * If websocket has not supplied a price yet,
       * skip the contract instead of inventing one.
       */

      for (
        const contract
        of relevant
      ) {
        const live =
          liveOptionData.get(
            contract.instrument_key
          );

        const price =
          Number(
            live?.ltp
          );

        if (
          !Number.isFinite(
            price
          )
        ) {
          continue;
        }

        const movement =
          detectOptionMovement(
            contract.instrument_key,
            price
          );

        if (!movement) {
          continue;
        }

        console.log(
          `[MOVEMENT] ${item.name} ${contract.instrument_type} ${contract.strike_price}: ${movement.points} points`
        );

        const trade =
          await analyzeOptionTrade(
            contract,
            movement
          );

        if (
          trade?.validTrade
        ) {
          await createTradeAlert(
            trade
          );
        }
      }
    }

    lastMonitorAt =
      new Date().toISOString();
  } catch (error) {
    console.error(
      "Monitor error:",
      error.message
    );
  } finally {
    monitorBusy = false;
  }
}

/* =========================================================
   TRADE STATUS MONITOR
========================================================= */

async function updateActiveTrades() {
  if (
    !activeTrades.size
  ) {
    return;
  }

  for (
    const [
      id,
      trade
    ] of activeTrades.entries()
  ) {
    const live =
      liveOptionData.get(
        trade.instrumentKey
      );

    const price =
      Number(
        live?.ltp
      );

    if (
      !Number.isFinite(
        price
      )
    ) {
      continue;
    }

    let newStatus =
      trade.status;

    if (
      price <=
      trade.sl
    ) {
      newStatus =
        "SL_HIT";
    } else if (
      price >=
      trade.t3
    ) {
      newStatus =
        "T3_HIT";
    } else if (
      price >=
      trade.t2
    ) {
      newStatus =
        "T2_HIT";
    } else if (
      price >=
      trade.t1
    ) {
      newStatus =
        "T1_HIT";
    }

    if (
      newStatus !==
      trade.status
    ) {
      trade.status =
        newStatus;

      trade.lastPrice =
        price;

      trade.updatedAt =
        new Date().toISOString();

      await sendPushNotification({
        title:
          `Era AI • ${trade.underlying} ${trade.optionType}`,

        body:
          `${trade.strike} ${trade.optionType} status: ${newStatus} • LTP ${price}`,

        type:
          "TRADE_UPDATE",

        data: {
          alertId:
            id,

          status:
            newStatus
        }
      });
    }
  }
}

/* =========================================================
   MARKET OPEN / CLOSE
========================================================= */

async function handleMarketSession() {
  const today =
    getIndiaDate();

  if (
    isMarketOpenWindow() &&
    lastMarketOpenNotification !==
      today
  ) {
    lastMarketOpenNotification =
      today;

    await sendPushNotification({
      title:
        "Era AI • Market Open",

      body:
        "Market open. Era AI has started autonomous monitoring across NIFTY, BANKNIFTY, FINNIFTY and SENSEX.",

      type:
        "MARKET_OPEN"
    });
  }

  if (
    isMarketClosed() &&
    lastMarketCloseAnalysis !==
      today
  ) {
    lastMarketCloseAnalysis =
      today;

    await createTomorrowPlan();
  }
}

/* =========================================================
   TOMORROW PLAN
========================================================= */

async function createTomorrowPlan() {
  try {
    const market =
      await getLiveMarketData();

    if (!market.success) {
      return null;
    }

    const analyses = {};

    for (
      const item
      of OPTION_UNDERLYINGS
    ) {
      analyses[
        item.name
      ] =
        await getTechnicalAnalysis(
          item.key
        );
    }

    const options = {};

    for (
      const item
      of OPTION_UNDERLYINGS
    ) {
      options[
        item.name
      ] =
        await getOptionAnalysis(
          item.key
        );
    }

    const plans = [];

    for (
      const item
      of OPTION_UNDERLYINGS
    ) {
      const technical =
        analyses[
          item.name
        ];

      const option =
        options[
          item.name
        ];

      if (
        !technical?.success
      ) {
        continue;
      }

      let primary =
        "WAIT";

      if (
        technical.trend ===
        "BULLISH"
      ) {
        primary =
          "BULLISH SCENARIO";
      } else if (
        technical.trend ===
        "BEARISH"
      ) {
        primary =
          "BEARISH SCENARIO";
      }

      plans.push({
        market:
          item.name,

        scenario:
          primary,

        trend:
          technical.trend,

        structure:
          technical.structure,

        vwap:
          technical.vwap,

        support:
          technical.support,

        resistance:
          technical.resistance,

        rsi:
          technical.rsi,

        atr:
          technical.atr,

        optionBias:
          option?.bias ||
          "UNKNOWN",

        pcr:
          option?.pcr ||
          null,

        confirmation:
          technical.trend ===
          "BULLISH"
            ? `Look for price to hold above VWAP and confirm bullish structure near ${technical.resistance ?? "resistance"}.`
            : technical.trend ===
              "BEARISH"
            ? `Look for price to remain below VWAP and confirm bearish structure near ${technical.support ?? "support"}.`
            : "Wait for a confirmed breakout or breakdown.",

        invalidation:
          technical.trend ===
          "BULLISH"
            ? `Bullish scenario invalid if structure fails and price loses VWAP/support.`
            : technical.trend ===
              "BEARISH"
            ? `Bearish scenario invalid if price reclaims VWAP/resistance.`
            : "No trade until structure becomes directional."
      });
    }

    latestTomorrowPlan = {
      date:
        todayPlusOne(),

      createdAt:
        new Date().toISOString(),

      market,

      scenarios:
        plans
    };

    await sendPushNotification({
      title:
        "Era AI • Tomorrow Plan",

      body:
        "Today's market analysis is complete. Era AI has prepared the next-session scenarios, confirmations and invalidation levels.",

      type:
        "TOMORROW_PLAN"
    });

    return latestTomorrowPlan;
  } catch (error) {
    console.error(
      "Tomorrow plan error:",
      error.message
    );

    return null;
  }
}

function todayPlusOne() {
  const d =
    new Date();

  d.setDate(
    d.getDate() + 1
  );

  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(d);

  const map = {};

  for (
    const p of parts
  ) {
    map[p.type] =
      p.value;
  }

  return `${map.year}-${map.month}-${map.day}`;
}

/* =========================================================
   AUTONOMOUS LOOP
========================================================= */

async function autonomousCycle() {
  try {
    await handleMarketSession();

    if (
      isMarketOpen()
    ) {
      await monitorOptions();

      await updateActiveTrades();
    }
  } catch (error) {
    console.error(
      "Autonomous cycle error:",
      error.message
    );
  }
}

function startAutonomousEngine() {
  if (
    monitorTimer
  ) {
    return;
  }

  monitorRunning =
    true;

  console.log(
    `Era AI autonomous engine started. Interval: ${MONITOR_INTERVAL}ms`
  );

  autonomousCycle();

  monitorTimer =
    setInterval(
      autonomousCycle,
      MONITOR_INTERVAL
    );
}

/* =========================================================
   ALERT APIs
========================================================= */

app.get(
  "/api/alerts",
  (req, res) => {
    res.json({
      success: true,

      alerts:
        alerts.slice(0, 100),

      unread:
        alerts.filter(
          a =>
            !a.read
        ).length
    });
  }
);

app.get(
  "/api/alerts/:id",
  (req, res) => {
    const alert =
      alerts.find(
        a =>
          a.id ===
          req.params.id
      );

    if (!alert) {
      return res.status(404).json({
        success: false,
        error:
          "Alert not found"
      });
    }

    res.json({
      success: true,
      alert
    });
  }
);

app.post(
  "/api/alerts/:id/read",
  (req, res) => {
    const alert =
      alerts.find(
        a =>
          a.id ===
          req.params.id
      );

    if (!alert) {
      return res.status(404).json({
        success: false
      });
    }

    alert.read = true;

    res.json({
      success: true,
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
      success: true,

      running:
        monitorRunning,

      marketOpen:
        isMarketOpen(),

      interval:
        MONITOR_INTERVAL,

      movementTrigger:
        MOVEMENT_TRIGGER,

      confidenceThreshold:
        CONFIDENCE_THRESHOLD,

      lastMonitorAt,

      activeTrades:
        activeTrades.size,

      alerts:
        alerts.length,

      pushEnabled:
        PUSH_ENABLED,

      pushSubscriptions:
        pushSubscriptions.size
    });
  }
);

app.get(
  "/api/plan/tomorrow",
  (req, res) => {
    res.json({
      success: true,
      plan:
        latestTomorrowPlan
    });
  }
);

/* =========================================================
   ANALYSIS
========================================================= */

async function getEraAnalysis(
  instrumentKey = NIFTY_KEY
) {
  const market =
    await getLiveMarketData();

  const technical =
    await getTechnicalAnalysis(
      instrumentKey
    );

  const options =
    await getOptionAnalysis(
      instrumentKey
    );

  if (
    !technical.success
  ) {
    return {
      success: false,
      error:
        "Technical data unavailable"
    };
  }

  let confidence = 0;

  const reasons = [];

  if (
    technical.trend ===
    "BULLISH"
  ) {
    confidence += 20;

    reasons.push(
      "Bullish EMA structure"
    );
  }

  if (
    technical.trend ===
    "BEARISH"
  ) {
    confidence += 20;

    reasons.push(
      "Bearish EMA structure"
    );
  }

  if (
    technical.rsi >= 55 ||
    technical.rsi <= 45
  ) {
    confidence += 10;

    reasons.push(
      `RSI ${technical.rsi}`
    );
  }

  if (
    technical.vwap !== null &&
    technical.current !== null
  ) {
    confidence += 10;

    reasons.push(
      `VWAP ${technical.vwap}`
    );
  }

  if (
    technical.adx !== null &&
    technical.adx >= 20
  ) {
    confidence += 10;

    reasons.push(
      `ADX ${technical.adx}`
    );
  }

  if (
    options.success &&
    options.bias !==
      "NEUTRAL"
  ) {
    confidence += 15;

    reasons.push(
      `Option bias ${options.bias}`
    );
  }

  if (
    technical.volume?.ratio >=
    1.2
  ) {
    confidence += 5;

    reasons.push(
      "Volume expansion"
    );
  }

  if (
    technical.structure
      ?.structure ===
      "BULLISH_HH_HL" ||
    technical.structure
      ?.structure ===
      "BEARISH_LH_LL"
  ) {
    confidence += 10;

    reasons.push(
      "Market structure confirmation"
    );
  }

  confidence =
    Math.min(
      100,
      Math.round(
        confidence
      )
    );

  let direction =
    "WAIT";

  if (
    confidence >
      CONFIDENCE_THRESHOLD
  ) {
    if (
      technical.trend ===
      "BULLISH"
    ) {
      direction =
        "BUY";
    } else if (
      technical.trend ===
      "BEARISH"
    ) {
      direction =
        "SELL";
    }
  }

  const current =
    technical.current;

  const support =
    technical.support;

  const resistance =
    technical.resistance;

  let entry = null;
  let sl = null;
  let t1 = null;
  let t2 = null;
  let t3 = null;

  if (
    direction !==
      "WAIT" &&
    current !== null
  ) {
    entry =
      Number(
        current.toFixed(2)
      );

    if (
      direction ===
      "BUY"
    ) {
      sl =
        support ??
        Number(
          (
            current -
            (
              technical.atr ||
              current *
                0.005
            )
          ).toFixed(2)
        );

      const risk =
        Math.max(
          1,
          current -
            sl
        );

      t1 =
        Number(
          (
            current +
            risk
          ).toFixed(2)
        );

      t2 =
        Number(
          (
            current +
            risk * 2
          ).toFixed(2)
        );

      t3 =
        Number(
          (
            current +
            risk * 3
          ).toFixed(2)
        );
    } else {
      sl =
        resistance ??
        Number(
          (
            current +
            (
              technical.atr ||
              current *
                0.005
            )
          ).toFixed(2)
        );

      const risk =
        Math.max(
          1,
          sl -
            current
        );

      t1 =
        Number(
          (
            current -
            risk
          ).toFixed(2)
        );

      t2 =
        Number(
          (
            current -
            risk * 2
          ).toFixed(2)
        );

      t3 =
        Number(
          (
            current -
            risk * 3
          ).toFixed(2)
        );
    }
  }

  return {
    success: true,

    signal: {
      direction,

      confidence,

      status:
        direction ===
        "WAIT"
          ? "NO TRADE"
          : "TRADE CANDIDATE",

      entry,
      sl,
      t1,
      t2,
      t3,

      rr:
        entry !== null &&
        sl !== null &&
        t2 !== null
          ? Number(
              (
                Math.abs(
                  t2 - entry
                ) /
                Math.abs(
                  entry - sl
                )
              ).toFixed(2)
            )
          : null
    },

    market,

    technical,

    options,

    reasons,

    invalidation:
      direction ===
      "BUY"
        ? "Bullish structure/VWAP support failure invalidates the setup."
        : direction ===
          "SELL"
        ? "Bearish structure/VWAP resistance failure invalidates the setup."
        : "No trade until confirmations align."
  };
}

app.get(
  "/api/analysis",
  async (req, res) => {
    try {
      const instrumentKey =
        req.query.instrument_key ||
        NIFTY_KEY;

      const analysis =
        await getEraAnalysis(
          instrumentKey
        );

      res.json(
        analysis
      );
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
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
      if (
        !process.env.NEWS_API_KEY
      ) {
        return res.json({
          success: false,
          error:
            "NEWS_API_KEY is missing"
        });
      }

      const response =
        await axios.get(
          "https://newsapi.org/v2/everything",
          {
            params: {
              q:
                "NIFTY OR BANKNIFTY OR NSE OR BSE OR Indian stock market",

              language:
                "en",

              sortBy:
                "publishedAt",

              pageSize:
                30,

              apiKey:
                process.env.NEWS_API_KEY
            },

            timeout: 15000
          }
        );

      res.json({
        success: true,

        articles:
          response.data?.articles ||
          []
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   PERFORMANCE / HISTORY
========================================================= */

app.get(
  "/api/history",
  (req, res) => {
    res.json({
      success: true,
      trades:
        alerts
          .filter(
            a =>
              [
                "T1_HIT",
                "T2_HIT",
                "T3_HIT",
                "SL_HIT"
              ].includes(
                a.status
              )
          )
          .slice(0, 100)
    });
  }
);

app.get(
  "/api/performance",
  (req, res) => {
    const completed =
      alerts.filter(
        a =>
          [
            "T1_HIT",
            "T2_HIT",
            "T3_HIT",
            "SL_HIT"
          ].includes(
            a.status
          )
      );

    const wins =
      completed.filter(
        a =>
          [
            "T1_HIT",
            "T2_HIT",
            "T3_HIT"
          ].includes(
            a.status
          )
      ).length;

    const losses =
      completed.filter(
        a =>
          a.status ===
          "SL_HIT"
      ).length;

    const winRate =
      completed.length
        ? Number(
            (
              wins /
              completed.length *
              100
            ).toFixed(2)
          )
        : 0;

    res.json({
      success: true,

      totalSignals:
        alerts.length,

      completed:
        completed.length,

      wins,

      losses,

      winRate
    });
  }
);

/* =========================================================
   OPENROUTER CHAT
========================================================= */

app.post(
  "/api/chat",
  async (req, res) => {
    try {
      const apiKey =
        process.env.OPENROUTER_API_KEY;

      if (!apiKey) {
        return res.status(500).json({
          success: false,
          error:
            "OPENROUTER_API_KEY is missing"
        });
      }

      const message =
        String(
          req.body?.message ||
          ""
        ).trim();

      if (!message) {
        return res.status(400).json({
          success: false,
          error:
            "Message is required"
        });
      }

      const analysis =
        await getEraAnalysis(
          req.body?.instrument_key ||
          NIFTY_KEY
        );

      const system = `
You are Era AI, a premium Indian stock-market AI assistant.

Respond naturally in the user's language:
Hindi/Hinglish, Gujarati, or English.

Never invent live market prices.
Use the supplied market context.
Do not guarantee profit or certainty.

If confirmations are weak, say WAIT / NO TRADE.

When a trade candidate exists, clearly show:
Direction
Entry
SL
T1
T2
T3
R:R
Confidence
Confirmations
Invalidation

Confidence above 50% is the configured trade threshold,
but confidence is analytical and not a guarantee.
`;

      const response =
        await axios.post(
          OPENROUTER_URL,
          {
            model:
              process.env.OPENROUTER_MODEL ||
              "openai/gpt-4o-mini",

            messages: [
              {
                role:
                  "system",
                content:
                  system
              },

              {
                role:
                  "user",
                content:
                  JSON.stringify({
                    message,
                    analysis
                  })
              }
            ],

            temperature:
              0.3,

            max_tokens:
              1200
          },
          {
            headers: {
              Authorization:
                `Bearer ${apiKey}`,

              "Content-Type":
                "application/json",

              "HTTP-Referer":
                process.env.APP_URL ||
                "https://era-ai.onrender.com",

              "X-Title":
                "Era AI"
            },

            timeout:
              30000
          }
        );

      const reply =
        response.data
          ?.choices?.[0]
          ?.message
          ?.content ||
        "Era AI could not generate a response.";

      res.json({
        success: true,
        reply,
        analysis
      });
    } catch (error) {
      console.error(
        "Chat error:",
        error.response?.data ||
        error.message
      );

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
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,
      app:
        "Era AI V6",
      status:
        "online",
      autonomous:
        monitorRunning,
      marketOpen:
        isMarketOpen(),
      liveOptions:
        liveOptionData.size,
      alerts:
        alerts.length,
      push:
        PUSH_ENABLED,
      timestamp:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   SERVER START
========================================================= */

app.listen(
  PORT,
  async () => {
    console.log(
      `Era AI V6 running on port ${PORT}`
    );

    console.log(
      `Confidence threshold: >${CONFIDENCE_THRESHOLD}%`
    );

    console.log(
      `Option movement trigger: ${MOVEMENT_TRIGGER}+ points`
    );

    console.log(
      `Autonomous interval: ${MONITOR_INTERVAL}ms`
    );

    console.log(
      "Starting live option engine..."
    );

    setTimeout(
      startLiveOptionWebSocket,
      3000
    );

    /*
     * Autonomous engine runs on the server,
     * so monitoring does not depend on the
     * browser remaining open.
     */
    setTimeout(
      startAutonomousEngine,
      5000
    );
  }
);
