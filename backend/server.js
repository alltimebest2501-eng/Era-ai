require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const UpstoxClient = require("upstox-js-sdk");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const UPSTOX_BASE = "https://api.upstox.com/v2";
const UPSTOX_V3 = "https://api.upstox.com/v3";

const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";


/* =====================================================
   INSTRUMENT KEYS
===================================================== */

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


/* =====================================================
   LIVE OPTION CACHE
===================================================== */

const optionContracts = new Map();
const liveOptionData = new Map();


/* =====================================================
   WEBSOCKET STATE
===================================================== */

const LTPC_CONNECTION_LIMIT = 5000;
const MAX_WEBSOCKET_CONNECTIONS = 2;

let optionStreamer = null;
let optionStreamer2 = null;

let liveOptionsInitialized = false;
let liveOptionsInitializing = false;

let websocket1Connected = false;
let websocket2Connected = false;

let subscribedContracts1 = 0;
let subscribedContracts2 = 0;

let websocket1LastMessage = null;
let websocket2LastMessage = null;

let websocket1Error = null;
let websocket2Error = null;


/* =====================================================
   UPSTOX SDK AUTHENTICATION
===================================================== */

function configureUpstoxSDK() {

  if (!process.env.UPSTOX_ACCESS_TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is missing"
    );
  }

  const defaultClient =
    UpstoxClient.ApiClient.instance;

  const oauth =
    defaultClient.authentications["OAUTH2"];

  oauth.accessToken =
    process.env.UPSTOX_ACCESS_TOKEN;

  return defaultClient;
}


/* =====================================================
   AUTH HEADERS
===================================================== */

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


/* =====================================================
   HEALTH
===================================================== */

app.get("/", (req, res) => {

  const subscribed =
    subscribedContracts1 +
    subscribedContracts2;

  const max =
    LTPC_CONNECTION_LIMIT *
    MAX_WEBSOCKET_CONNECTIONS;

  res.json({

    app: "Era AI V5",

    status: "online",

    message:
      "Era AI V5 backend is running",

    liveOptions: {

      initialized:
        liveOptionsInitialized,

      discoveredContracts:
        optionContracts.size,

      liveContracts:
        liveOptionData.size,

      subscribedContracts:
        subscribed,

      maxNormalLTPCSubscriptions:
        max,

      websocketConnections:
        MAX_WEBSOCKET_CONNECTIONS,

      websocket1:
        websocket1Connected,

      websocket2:
        websocket2Connected,

      websocket1LastMessage,

      websocket2LastMessage,

      websocket1Error,

      websocket2Error
    },

    naturalVoice: {

      provider:
        "ElevenLabs",

      configured:
        Boolean(
          process.env.ELEVENLABS_API_KEY &&
          process.env.ELEVENLABS_VOICE_ID
        )
    }

  });

});


/* =====================================================
   ELEVENLABS NATURAL VOICE
===================================================== */

app.post(
  "/api/tts",
  async (req, res) => {

    const startedAt =
      Date.now();

    try {

      const apiKey =
        process.env.ELEVENLABS_API_KEY;

      const voiceId =
        process.env.ELEVENLABS_VOICE_ID;

      const text =
        typeof req.body?.text === "string"
          ? req.body.text.trim()
          : "";

      const language =
        typeof req.body?.language === "string"
          ? req.body.language
          : "en-IN";


      console.log(
        "======================================"
      );

      console.log(
        "[TTS] REQUEST RECEIVED"
      );

      console.log(
        "[TTS] Language:",
        language
      );

      console.log(
        "[TTS] API key configured:",
        Boolean(apiKey)
      );

      console.log(
        "[TTS] Voice ID configured:",
        Boolean(voiceId)
      );

      console.log(
        "[TTS] Text length:",
        text.length
      );


      if (!apiKey) {

        console.error(
          "[TTS ERROR] ELEVENLABS_API_KEY missing"
        );

        return res.status(500).json({

          success: false,

          error:
            "ELEVENLABS_API_KEY is missing"
        });
      }


      if (!voiceId) {

        console.error(
          "[TTS ERROR] ELEVENLABS_VOICE_ID missing"
        );

        return res.status(500).json({

          success: false,

          error:
            "ELEVENLABS_VOICE_ID is missing"
        });
      }


      if (!text) {

        console.error(
          "[TTS ERROR] Empty text"
        );

        return res.status(400).json({

          success: false,

          error:
            "Text is required"
        });
      }


      const cleanText =
        text.slice(0, 4000);


      console.log(
        "[TTS] Sending request to ElevenLabs..."
      );


      const response =
        await axios.post(

          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
            voiceId
          )}`,

          {

            text:
              cleanText,

            model_id:
              "eleven_multilingual_v2",

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

            params: {

              output_format:
                "mp3_44100_128"
            },

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

            timeout:
              30000
          }
        );


      const audioBuffer =
        Buffer.from(
          response.data
        );


      console.log(
        "[TTS] ElevenLabs HTTP:",
        response.status
      );

      console.log(
        "[TTS] Content-Type:",
        response.headers[
          "content-type"
        ]
      );

      console.log(
        "[TTS] Audio bytes:",
        audioBuffer.length
      );


      if (!audioBuffer.length) {

        throw new Error(
          "ElevenLabs returned empty audio"
        );
      }


      console.log(
        "[TTS] SUCCESS in",
        Date.now() - startedAt,
        "ms"
      );

      console.log(
        "======================================"
      );


      res.status(200);

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
        "no-store, no-cache, must-revalidate"
      );

      res.setHeader(
        "Accept-Ranges",
        "bytes"
      );


      return res.send(
        audioBuffer
      );


    } catch (error) {

      let detail =
        error.message ||
        "Unknown ElevenLabs error";


      if (
        error.response?.data
      ) {

        try {

          if (
            Buffer.isBuffer(
              error.response.data
            )
          ) {

            detail =
              error.response.data
                .toString("utf8");

          } else if (
            error.response.data
          ) {

            detail =
              JSON.stringify(
                error.response.data
              );
          }

        } catch {

          detail =
            String(
              error.response.data
            );
        }
      }


      console.error(
        "======================================"
      );

      console.error(
        "[TTS ERROR]"
      );

      console.error(
        "Message:",
        error.message
      );

      console.error(
        "HTTP status:",
        error.response?.status
      );

      console.error(
        "Content-Type:",
        error.response?.headers?.[
          "content-type"
        ]
      );

      console.error(
        "Provider response:",
        detail
      );

      console.error(
        "Time:",
        Date.now() - startedAt,
        "ms"
      );

      console.error(
        "======================================"
      );


      return res.status(
        error.response?.status || 500
      ).json({

        success: false,

        error:
          "Natural voice generation failed",

        status:
          error.response?.status || 500,

        detail
      });
    }
  }
);


/* =====================================================
   TTS STATUS / DIAGNOSTIC
===================================================== */

app.get(
  "/api/tts/status",
  (req, res) => {

    const apiKeyConfigured =
      Boolean(
        process.env.ELEVENLABS_API_KEY
      );

    const voiceConfigured =
      Boolean(
        process.env.ELEVENLABS_VOICE_ID
      );


    res.json({

      success: true,

      provider:
        "ElevenLabs",

      configured:
        apiKeyConfigured &&
        voiceConfigured,

      apiKey:
        apiKeyConfigured
          ? "configured"
          : "missing",

      voiceId:
        voiceConfigured
          ? "configured"
          : "missing",

      model:
        "eleven_multilingual_v2",

      outputFormat:
        "mp3_44100_128",

      serverTime:
        new Date().toISOString()
    });
  }
);


/* =====================================================
   QUOTE HELPER
===================================================== */

function findQuote(
  data,
  instrumentKey
) {

  if (
    !data ||
    typeof data !== "object"
  ) {

    return {};
  }


  if (
    data[instrumentKey]
  ) {

    return data[instrumentKey];
  }


  const encoded =
    instrumentKey.replace(
      "|",
      "%7C"
    );


  if (
    data[encoded]
  ) {

    return data[encoded];
  }


  const shortName =
    instrumentKey.split("|")[1];


  for (
    const key of Object.keys(data)
  ) {

    if (
      key.includes(shortName) ||
      key.includes(encoded)
    ) {

      return data[key];
    }
  }


  return {};
}


/* =====================================================
   LIVE MARKET
===================================================== */

async function getLiveMarketData() {

  try {

    const keys = [

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
              keys
          },

          headers:
            authHeaders(),

          timeout:
            15000
        }
      );


    const data =
      response.data?.data || {};


    const nifty =
      findQuote(
        data,
        NIFTY_KEY
      );

    const banknifty =
      findQuote(
        data,
        BANKNIFTY_KEY
      );

    const finnifty =
      findQuote(
        data,
        FINNIFTY_KEY
      );

    const sensex =
      findQuote(
        data,
        SENSEX_KEY
      );

    const vix =
      findQuote(
        data,
        VIX_KEY
      );

    const gift =
      findQuote(
        data,
        GIFT_KEY
      );


    function normalize(q) {

      const ohlc =
        q.ohlc || {};


      return {

        lastPrice:
          q.last_price ??
          null,

        netChange:
          q.net_change ??
          null,

        previousClose:
          q.prev_close_price ??
          ohlc.close ??
          null,

        open:
          q.open ??
          ohlc.open ??
          null,

        high:
          q.high ??
          ohlc.high ??
          null,

        low:
          q.low ??
          ohlc.low ??
          null,

        close:
          q.close ??
          ohlc.close ??
          null,

        volume:
          q.volume ??
          ohlc.volume ??
          null
      };
    }


    return {

      success: true,

      timestamp:
        new Date().toISOString(),

      nifty:
        normalize(nifty),

      banknifty:
        normalize(banknifty),

      finnifty:
        normalize(finnifty),

      sensex:
        normalize(sensex),

      indiaVix:
        normalize(vix),

      giftNifty:
        normalize(gift)
    };


  } catch (error) {

    console.error(
      "LIVE MARKET ERROR:",
      error.response?.data ||
      error.message
    );


    return {

      success: false,

      error:
        error.response?.data
          ?.errors?.[0]?.message ||

        error.response?.data
          ?.message ||

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


/* =====================================================
   INDIA DATE
===================================================== */

function getIndiaDate() {

  const now =
    new Date();


  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {

        timeZone:
          "Asia/Kolkata",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit"
      }
    ).formatToParts(now);


  const map = {};


  parts.forEach(
    p => {

      map[p.type] =
        p.value;
    }
  );


  return `${map.year}-${map.month}-${map.day}`;
}


/* =====================================================
   INTRADAY CANDLES
===================================================== */

async function getIntradayCandles(
  instrumentKey = NIFTY_KEY,
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

          timeout:
            15000
        }
      );


    const candles =
      response.data
        ?.data
        ?.candles || [];


    const parsed =
      candles

        .map(c => ({

          timestamp:
            c[0],

          open:
            Number(c[1]),

          high:
            Number(c[2]),

          low:
            Number(c[3]),

          close:
            Number(c[4]),

          volume:
            Number(c[5] || 0),

          oi:
            Number(c[6] || 0)

        }))

        .filter(c =>

          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close)

        )

        .reverse();


    console.log(
      `[CANDLES] ${instrumentKey} ${interval}m => ${parsed.length}`
    );


    return parsed;


  } catch (error) {

    console.error(
      `[CANDLE ERROR] ${instrumentKey}:`,
      error.response?.data ||
      error.message
    );


    return [];
  }
}


/* =====================================================
   HISTORICAL CANDLES
===================================================== */

async function getHistoricalCandles(
  instrumentKey = NIFTY_KEY,
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


    const fromParts =
      new Intl.DateTimeFormat(
        "en-CA",
        {

          timeZone:
            "Asia/Kolkata",

          year:
            "numeric",

          month:
            "2-digit",

          day:
            "2-digit"
        }
      ).formatToParts(from);


    const fromMap = {};


    fromParts.forEach(
      p => {

        fromMap[p.type] =
          p.value;
      }
    );


    const fromDate =
      `${fromMap.year}-${fromMap.month}-${fromMap.day}`;


    console.log(
      `[HISTORY] Requesting ${instrumentKey} from ${fromDate} to ${today}`
    );


    const response =
      await axios.get(

        `${UPSTOX_V3}/historical-candle/${encoded}/minutes/${interval}/${today}/${fromDate}`,

        {

          headers:
            authHeaders(),

          timeout:
            20000
        }
      );


    const candles =
      response.data
        ?.data
        ?.candles || [];


    const parsed =
      candles

        .map(c => ({

          timestamp:
            c[0],

          open:
            Number(c[1]),

          high:
            Number(c[2]),

          low:
            Number(c[3]),

          close:
            Number(c[4]),

          volume:
            Number(c[5] || 0),

          oi:
            Number(c[6] || 0)

        }))

        .filter(c =>

          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close)

        )

        .reverse();


    console.log(
      `[HISTORY] ${instrumentKey} => ${parsed.length} candles`
    );


    return parsed;


  } catch (error) {

    console.error(
      `[HISTORY ERROR] ${instrumentKey}:`,
      error.response?.data ||
      error.message
    );


    return [];
  }
}


/* =====================================================
   SMART ANALYSIS CANDLE LOADER
===================================================== */

async function getAnalysisCandles(
  instrumentKey = NIFTY_KEY,
  interval = 5
) {

  let candles =
    await getIntradayCandles(
      instrumentKey,
      interval
    );


  /*
    Current trading day may have fewer candles.
    We need enough history for EMA50 + RSI14.
  */

  if (
    candles.length < 60
  ) {

    console.log(
      `[CANDLE FALLBACK] Only ${candles.length} intraday candles. Loading historical candles...`
    );


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


  /*
    Keep latest 200 candles.
    This is enough for the calculations
    and keeps the response fast.
  */

  if (
    candles.length > 200
  ) {

    candles =
      candles.slice(-200);
  }


  console.log(
    `[ANALYSIS CANDLES] ${instrumentKey} => ${candles.length}`
  );


  return candles;
}


/* =====================================================
   EMA
===================================================== */

function calculateEMA(
  values,
  period
) {

  if (
    !Array.isArray(values) ||
    values.length < period
  ) {

    return null;
  }


  const multiplier =
    2 / (period + 1);


  let ema =
    values

      .slice(
        0,
        period
      )

      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / period;


  for (
    let i = period;
    i < values.length;
    i++
  ) {

    ema =
      (
        values[i] -
        ema
      ) *
      multiplier +
      ema;
  }


  return Number(
    ema.toFixed(2)
  );
}


/* =====================================================
   RSI
===================================================== */

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

    const change =
      values[i] -
      values[i - 1];


    if (
      change > 0
    ) {

      gains +=
        change;

    } else {

      losses +=
        Math.abs(change);
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


    averageGain =
      (
        averageGain *
        (period - 1) +
        gain
      ) / period;


    averageLoss =
      (
        averageLoss *
        (period - 1) +
        loss
      ) / period;
  }


  if (
    averageLoss === 0
  ) {

    return 100;
  }


  const rs =
    averageGain /
    averageLoss;


  const rsi =
    100 -
    100 / (1 + rs);


  return Number(
    rsi.toFixed(2)
  );
}


/* =====================================================
   VWAP
===================================================== */

function calculateVWAP(
  candles
) {

  if (
    !Array.isArray(candles) ||
    !candles.length
  ) {

    return null;
  }


  let cumulativePV = 0;
  let cumulativeVolume = 0;


  for (
    const c of candles
  ) {

    const volume =
      Number(
        c.volume || 0
      );


    if (
      volume <= 0
    ) {

      continue;
    }


    const typical =
      (
        c.high +
        c.low +
        c.close
      ) / 3;


    cumulativePV +=
      typical *
      volume;


    cumulativeVolume +=
      volume;
  }


  if (
    cumulativeVolume <= 0
  ) {

    return null;
  }


  return Number(
    (
      cumulativePV /
      cumulativeVolume
    ).toFixed(2)
  );
}


/* =====================================================
   SUPPORT / RESISTANCE
===================================================== */

function calculateSupportResistance(
  candles
) {

  if (
    !Array.isArray(candles) ||
    !candles.length
  ) {

    return {

      support: null,

      resistance: null
    };
  }


  const recent =
    candles.slice(-20);


  const lows =
    recent
      .map(
        c => Number(c.low)
      )
      .filter(
        Number.isFinite
      );


  const highs =
    recent
      .map(
        c => Number(c.high)
      )
      .filter(
        Number.isFinite
      );


  return {

    support:
      lows.length
        ? Number(
            Math.min(
              ...lows
            ).toFixed(2)
          )
        : null,

    resistance:
      highs.length
        ? Number(
            Math.max(
              ...highs
            ).toFixed(2)
          )
        : null
  };
}


/* =====================================================
   TECHNICAL ANALYSIS
===================================================== */

async function getTechnicalAnalysis(
  instrumentKey = NIFTY_KEY
) {

  try {

    const candles =
      await getAnalysisCandles(
        instrumentKey,
        5
      );


    if (
      candles.length < 20
    ) {

      console.warn(
        `[TECHNICAL] Insufficient candles: ${candles.length}`
      );


      return {

        success: false,

        status:
          "INSUFFICIENT_DATA",

        error:
          "Not enough candle history",

        instrumentKey,

        timeframe:
          "5 minute",

        candles:
          candles.length,

        current:
          candles.length
            ? candles[
                candles.length - 1
              ].close
            : null,

        ema9: null,
        ema20: null,
        ema50: null,
        rsi: null,
        vwap: null,
        support: null,
        resistance: null,
        trend: "UNKNOWN",
        momentum: "UNKNOWN"
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


    const rsi =
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
      ema9 !== null &&
      ema20 !== null &&
      ema50 !== null
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


    const result = {

      success: true,

      status:
        "OK",

      instrumentKey,

      timeframe:
        "5 minute",

      candles:
        candles.length,

      current,

      ema9,

      ema20,

      ema50,

      rsi,

      vwap,

      support:
        sr.support,

      resistance:
        sr.resistance,

      trend,

      momentum
    };


    console.log(
      "[TECHNICAL]",
      JSON.stringify(
        result
      )
    );


    return result;


  } catch (error) {

    console.error(
      "[TECHNICAL ERROR]",
      error.response?.data ||
      error.message
    );


    return {

      success: false,

      status:
        "ERROR",

      error:
        error.message,

      trend:
        "UNKNOWN",

      momentum:
        "UNKNOWN"
    };
  }
}


/* =====================================================
   OPTION CONTRACT API
===================================================== */

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

            timeout:
              20000
          }
        );


      res.json({

        success: true,

        data:
          response.data?.data ||
          []
      });


    } catch (error) {

      console.error(
        "OPTION CONTRACT ERROR:",
        error.response?.data ||
        error.message
      );


      res.status(500).json({

        success: false,

        error:
          error.response?.data
            ?.errors?.[0]?.message ||

          "Unable to fetch option contracts"
      });
    }
  }
);


/* =====================================================
   FETCH ALL LIVE OPTION CONTRACTS
===================================================== */

async function fetchAllLiveOptionContracts() {

  const all =
    new Map();


  for (
    const underlying
    of OPTION_UNDERLYINGS
  ) {

    try {

      console.log(
        `[LIVE OPTIONS] Loading ${underlying.name} contracts...`
      );


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

            timeout:
              20000
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


        if (
          contract.instrument_type !== "CE" &&
          contract.instrument_type !== "PE"
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
        `[LIVE OPTIONS] ${underlying.name}: ${rows.length} contracts`
      );


    } catch (error) {

      console.error(

        `[LIVE OPTIONS] ${underlying.name} contract error:`,

        error.response?.data ||
        error.message
      );
    }
  }


  optionContracts.clear();


  for (
    const [
      key,
      value
    ]
    of all
  ) {

    optionContracts.set(
      key,
      value
    );
  }


  console.log(
    `[LIVE OPTIONS] Total discovered contracts: ${optionContracts.size}`
  );


  return [
    ...optionContracts.values()
  ];
}


/* =====================================================
   LIVE OPTION UPDATE
===================================================== */

function updateLiveOption(
  instrumentKey,
  data
) {

  if (
    !instrumentKey
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

      ...data,

      instrument_key:
        instrumentKey,

      updated_at:
        new Date().toISOString()
    }
  );
}


/* =====================================================
   PARSE UPSTOX MESSAGE
===================================================== */

function parseUpstoxMessage(
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

      const text =
        data.toString(
          "utf8"
        );


      try {

        return JSON.parse(
          text
        );

      } catch {

        return null;
      }
    }


    if (
      typeof data === "string"
    ) {

      try {

        return JSON.parse(
          data
        );

      } catch {

        return null;
      }
    }


    return null;


  } catch {

    return null;
  }
}


/* =====================================================
   EXTRACT OPTION FEED
===================================================== */

function extractOptionFeed(
  feed
) {

  if (!feed) {
    return {};
  }


  const ltpc =
    feed.ltpc ||
    {};


  const firstLevel =
    feed.firstLevelWithGreeks ||
    {};


  const firstDepth =
    feed.firstDepth ||
    {};


  const greeks =
    feed.optionGreeks ||
    feed.option_greeks ||
    firstLevel.optionGreeks ||
    {};


  const volume =
    feed.vtt ??
    firstLevel.vtt ??
    null;


  const oi =
    feed.oi ??
    firstLevel.oi ??
    null;


  const previousOI =
    feed.poi ??
    firstLevel.poi ??
    null;


  const bid =
    firstDepth.bidP ??
    feed.bidP ??
    firstLevel.bidP ??
    null;


  const ask =
    firstDepth.askP ??
    feed.askP ??
    firstLevel.askP ??
    null;


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

    volume,

    oi,

    previousOI,

    oiChange:
      oi !== null &&
      previousOI !== null

        ? Number(oi) -
          Number(previousOI)

        : null,

    bid,

    ask,

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


/* =====================================================
   HANDLE LIVE MESSAGE
===================================================== */

function handleLiveOptionMessage(
  data,
  socketNumber
) {

  const decoded =
    parseUpstoxMessage(
      data
    );


  if (!decoded) {
    return;
  }


  const feeds =
    decoded.feeds ||
    decoded.data ||
    {};


  if (
    !feeds ||
    typeof feeds !== "object"
  ) {

    return;
  }


  for (
    const [
      instrumentKey,
      feed
    ]
    of Object.entries(
      feeds
    )
  ) {

    if (
      instrumentKey === "currentTs"
    ) {

      continue;
    }


    if (
      !feed ||
      typeof feed !== "object"
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


/* =====================================================
   CREATE OPTION STREAMER
===================================================== */

function createOptionStreamer(
  socketNumber,
  instrumentKeys
) {

  if (
    !instrumentKeys.length
  ) {

    return null;
  }


  configureUpstoxSDK();


  const streamer =
    new UpstoxClient.MarketDataStreamerV3(
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
        `[LIVE OPTIONS] WebSocket #${socketNumber} CONNECTED`
      );


      if (
        socketNumber === 1
      ) {

        websocket1Connected =
          true;

        websocket1Error =
          null;

      } else {

        websocket2Connected =
          true;

        websocket2Error =
          null;
      }


      try {

        streamer.subscribe(
          instrumentKeys,
          "ltpc"
        );


        if (
          socketNumber === 1
        ) {

          subscribedContracts1 =
            instrumentKeys.length;

        } else {

          subscribedContracts2 =
            instrumentKeys.length;
        }


        console.log(
          `[LIVE OPTIONS] WebSocket #${socketNumber} subscribed ${instrumentKeys.length} contracts`
        );


      } catch (error) {

        console.error(
          `[LIVE OPTIONS] WebSocket #${socketNumber} SUBSCRIBE ERROR:`,
          error
        );


        if (
          socketNumber === 1
        ) {

          subscribedContracts1 =
            0;

          websocket1Error =
            error.message;

        } else {

          subscribedContracts2 =
            0;

          websocket2Error =
            error.message;
        }
      }
    }
  );


  streamer.on(
    "message",
    data => {

      handleLiveOptionMessage(
        data,
        socketNumber
      );
    }
  );


  streamer.on(
    "error",
    error => {

      console.error(
        `[LIVE OPTIONS] WebSocket #${socketNumber} ERROR:`,
        error
      );


      const message =
        error?.message ||
        String(error);


      if (
        socketNumber === 1
      ) {

        websocket1Error =
          message;

      } else {

        websocket2Error =
          message;
      }
    }
  );


  streamer.on(
    "close",
    () => {

      console.log(
        `[LIVE OPTIONS] WebSocket #${socketNumber} CLOSED`
      );


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


  streamer.on(
    "reconnecting",
    () => {

      console.log(
        `[LIVE OPTIONS] WebSocket #${socketNumber} RECONNECTING...`
      );
    }
  );


  streamer.on(
    "autoReconnectStopped",
    data => {

      console.error(
        `[LIVE OPTIONS] WebSocket #${socketNumber} AUTO RECONNECT STOPPED:`,
        data
      );
    }
  );


  console.log(
    `[LIVE OPTIONS] Connecting WebSocket #${socketNumber}...`
  );


  streamer.connect();


  return streamer;
}


/* =====================================================
   START ALL OPTION WEBSOCKETS
===================================================== */

async function startLiveOptionWebSocket() {

  if (
    liveOptionsInitializing
  ) {

    console.log(
      "[LIVE OPTIONS] Initialization already running."
    );

    return;
  }


  liveOptionsInitializing =
    true;


  try {

    if (
      !process.env.UPSTOX_ACCESS_TOKEN
    ) {

      throw new Error(
        "UPSTOX_ACCESS_TOKEN is missing"
      );
    }


    configureUpstoxSDK();


    const contracts =
      await fetchAllLiveOptionContracts();


    const allKeys =
      [
        ...new Set(

          contracts

            .map(
              item =>
                item.instrument_key
            )

            .filter(Boolean)

        )
      ];


    if (
      !allKeys.length
    ) {

      throw new Error(
        "No option contracts discovered."
      );
    }


    console.log(
      `[LIVE OPTIONS] TOTAL CONTRACTS: ${allKeys.length}`
    );


    const capacity =
      LTPC_CONNECTION_LIMIT *
      MAX_WEBSOCKET_CONNECTIONS;


    if (
      allKeys.length >
      capacity
    ) {

      console.warn(
        `[LIVE OPTIONS] WARNING: ${allKeys.length} contracts found but maximum normal capacity is ${capacity}.`
      );
    }


    const socket1Keys =
      allKeys.slice(
        0,
        LTPC_CONNECTION_LIMIT
      );


    const socket2Keys =
      allKeys.slice(
        LTPC_CONNECTION_LIMIT,
        capacity
      );


    websocket1Connected =
      false;

    websocket2Connected =
      false;

    subscribedContracts1 =
      0;

    subscribedContracts2 =
      0;

    websocket1LastMessage =
      null;

    websocket2LastMessage =
      null;

    websocket1Error =
      null;

    websocket2Error =
      null;


    liveOptionData.clear();


    optionStreamer =
      createOptionStreamer(
        1,
        socket1Keys
      );


    if (
      socket2Keys.length
    ) {

      setTimeout(
        () => {

          try {

            optionStreamer2 =
              createOptionStreamer(
                2,
                socket2Keys
              );

          } catch (error) {

            console.error(
              "[LIVE OPTIONS] Socket #2 creation failed:",
              error
            );

            websocket2Error =
              error.message;
          }

        },
        1000
      );
    }


    liveOptionsInitialized =
      true;


    console.log(
      "[LIVE OPTIONS] WebSocket initialization started."
    );


  } catch (error) {

    console.error(
      "[LIVE OPTIONS] INITIALIZATION FAILED:",
      error
    );


    liveOptionsInitialized =
      false;


  } finally {

    liveOptionsInitializing =
      false;
  }
}


/* =====================================================
   LIVE OPTIONS STATUS
===================================================== */

app.get(
  "/api/options/live-status",
  (req, res) => {

    const discovered =
      optionContracts.size;


    const subscribed =
      subscribedContracts1 +
      subscribedContracts2;


    const maximum =
      LTPC_CONNECTION_LIMIT *
      MAX_WEBSOCKET_CONNECTIONS;


    const coveragePercent =
      discovered > 0

        ? Number(
            (
              Math.min(
                subscribed,
                discovered
              ) /
              discovered *
              100
            ).toFixed(2)
          )

        : 0;


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
        discovered,

      liveContracts:
        liveOptionData.size,

      subscribedContracts:
        subscribed,

      socket1Subscribed:
        subscribedContracts1,

      socket2Subscribed:
        subscribedContracts2,

      subscribedLimitPerConnection:
        LTPC_CONNECTION_LIMIT,

      maxNormalConnections:
        MAX_WEBSOCKET_CONNECTIONS,

      maxNormalLTPCSubscriptions:
        maximum,

      coveragePercent
    });
  }
);


/* =====================================================
   LIVE OPTIONS API
===================================================== */

app.get(
  "/api/options/live",
  (req, res) => {

    try {

      const instrumentKey =
        req.query.instrument_key;


      if (
        instrumentKey
      ) {

        const contract =
          optionContracts.get(
            instrumentKey
          ) || {};


        const live =
          liveOptionData.get(
            instrumentKey
          ) || {};


        return res.json({

          success: true,

          data: {

            ...contract,

            ...live
          }
        });
      }


      const result = [];


      for (
        const [
          key,
          contract
        ]
        of optionContracts
      ) {

        const live =
          liveOptionData.get(
            key
          ) || {};


        result.push({

          ...contract,

          ...live
        });
      }


      res.json({

        success: true,

        count:
          result.length,

        liveCount:
          liveOptionData.size,

        data:
          result
      });


    } catch (error) {

      console.error(
        "LIVE OPTIONS API ERROR:",
        error
      );


      res.status(500).json({

        success: false,

        error:
          error.message
      });
    }
  }
);


/* =====================================================
   OPTION CHAIN
===================================================== */

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

        timeout:
          15000
      }
    );


  const rows =
    response.data?.data ||
    [];


  if (
    !Array.isArray(rows)
  ) {

    return rows;
  }


  return rows.map(
    row => {

      const call =
        row.call_options ||
        {};


      const put =
        row.put_options ||
        {};


      const callKey =
        call.instrument_key ||
        call.instrumentKey ||
        null;


      const putKey =
        put.instrument_key ||
        put.instrumentKey ||
        null;


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
        callLive &&
        callLive.ltp !== null &&
        callLive.ltp !== undefined
      ) {

        row.call_options = {

          ...call,

          market_data: {

            ...(call.market_data || {}),

            ltp:
              callLive.ltp,

            close_price:
              callLive.close ??
              call.market_data?.close_price
          }
        };
      }


      if (
        putLive &&
        putLive.ltp !== null &&
        putLive.ltp !== undefined
      ) {

        row.put_options = {

          ...put,

          market_data: {

            ...(put.market_data || {}),

            ltp:
              putLive.ltp,

            close_price:
              putLive.close ??
              put.market_data?.close_price
          }
        };
      }


      return row;
    }
  );
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
        "OPTION CHAIN ERROR:",
        error.response?.data ||
        error.message
      );


      res.status(500).json({

        success: false,

        error:
          "Unable to fetch option chain"
      });
    }
  }
);


/* =====================================================
   NEAREST EXPIRY
===================================================== */

async function getNearestExpiry(
  instrumentKey = NIFTY_KEY
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

          timeout:
            15000
        }
      );


    const contracts =
      response.data?.data ||
      [];


    const today =
      getIndiaDate();


    const expiries =
      [
        ...new Set(

          contracts

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
      ]

      .sort();


    return (
      expiries[0] ||
      null
    );


  } catch (error) {

    console.error(
      "EXPIRY ERROR:",
      error.response?.data ||
      error.message
    );


    return null;
  }
}


/* =====================================================
   OPTION ANALYSIS
===================================================== */

async function getOptionAnalysis(
  instrumentKey = NIFTY_KEY
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
          "No valid expiry found"
      };
    }


    const chain =
      await getOptionChain(
        instrumentKey,
        expiry
      );


    if (
      !Array.isArray(chain) ||
      !chain.length
    ) {

      return {

        success: false,

        error:
          "Option chain is empty"
      };
    }


    let totalCallOI = 0;
    let totalPutOI = 0;
    let maxPain = null;

    const strikes = [];


    for (
      const row
      of chain
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
        row.call_options ||
        {};


      const put =
        row.put_options ||
        {};


      const callMarket =
        call.market_data ||
        {};


      const putMarket =
        put.market_data ||
        {};


      const callOI =
        Number(
          callMarket.oi ||
          0
        );


      const putOI =
        Number(
          putMarket.oi ||
          0
        );


      totalCallOI +=
        callOI;


      totalPutOI +=
        putOI;
    }


    const pcr =
      totalCallOI > 0

        ? totalPutOI /
          totalCallOI

        : null;


    /* =================================================
       MAX PAIN
    ================================================= */

    if (
      strikes.length
    ) {

      let lowestPain =
        Infinity;


      for (
        const testStrike
        of strikes
      ) {

        let pain = 0;


        for (
          const row
          of chain
        ) {

          const strike =
            Number(
              row.strike_price
            );


          const call =
            row.call_options ||
            {};


          const put =
            row.put_options ||
            {};


          const callMarket =
            call.market_data ||
            {};


          const putMarket =
            put.market_data ||
            {};


          const callOI =
            Number(
              callMarket.oi ||
              0
            );


          const putOI =
            Number(
              putMarket.oi ||
              0
            );


          if (
            testStrike >
            strike
          ) {

            pain +=
              (
                testStrike -
                strike
              ) *
              callOI;
          }


          if (
            testStrike <
            strike
          ) {

            pain +=
              (
                strike -
                testStrike
              ) *
              putOI;
          }
        }


        if (
          pain <
          lowestPain
        ) {

          lowestPain =
            pain;

          maxPain =
            testStrike;
        }
      }
    }


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

      instrumentKey,

      expiry,

      totalCallOI,

      totalPutOI,

      pcr,

      maxPain,

      bias,

      strikes
    };


  } catch (error) {

    console.error(
      "OPTION ANALYSIS ERROR:",
      error.response?.data ||
      error.message
    );


    return {

      success: false,

      error:
        error.message
    };
  }
}


/* =====================================================
   COMPLETE ERA ANALYSIS
===================================================== */

async function getEraAnalysis() {

  const [
    market,
    technical,
    options
  ] =
    await Promise.all([

      getLiveMarketData(),

      getTechnicalAnalysis(
        NIFTY_KEY
      ),

      getOptionAnalysis(
        NIFTY_KEY
      )

    ]);


  let direction =
    "WAIT";


  let confidence =
    0;


  const reasons = [];


  /* =================================================
     TECHNICAL CONFIRMATION
  ================================================= */

  if (
    technical.success
  ) {

    if (
      technical.trend ===
      "BULLISH"
    ) {

      confidence +=
        30;

      reasons.push(
        "Technical trend bullish"
      );

    } else if (
      technical.trend ===
      "BEARISH"
    ) {

      confidence +=
        30;

      reasons.push(
        "Technical trend bearish"
      );
    }


    if (
      technical.rsi !== null
    ) {

      if (
        technical.rsi > 55
      ) {

        confidence +=
          15;

        reasons.push(
          "RSI positive"
        );

      } else if (
        technical.rsi < 45
      ) {

        confidence +=
          15;

        reasons.push(
          "RSI negative"
        );
      }
    }


    if (
      technical.vwap !== null &&
      technical.current !== null
    ) {

      if (
        technical.current >
        technical.vwap
      ) {

        confidence +=
          10;

        reasons.push(
          "Price above VWAP"
        );

      } else if (
        technical.current <
        technical.vwap
      ) {

        confidence +=
          10;

        reasons.push(
          "Price below VWAP"
        );
      }
    }
  }


  /* =================================================
     OPTION CONFIRMATION
  ================================================= */

  if (
    options.success
  ) {

    if (
      options.bias ===
      "BULLISH"
    ) {

      confidence +=
        25;

      reasons.push(
        "Option PCR indicates bullish bias"
      );

    } else if (
      options.bias ===
      "BEARISH"
    ) {

      confidence +=
        25;

      reasons.push(
        "Option PCR indicates bearish bias"
      );
    }
  }


  const technicalTrend =
    technical.success
      ? technical.trend
      : "UNKNOWN";


  const optionBias =
    options.success
      ? options.bias
      : "UNKNOWN";


  /*
    Both technical + options must agree.
  */

  if (
    technicalTrend ===
      "BULLISH" &&
    optionBias ===
      "BULLISH"
  ) {

    direction =
      "BUY";

  } else if (
    technicalTrend ===
      "BEARISH" &&
    optionBias ===
      "BEARISH"
  ) {

    direction =
      "SELL";

  } else {

    direction =
      "WAIT";
  }


  let entry = null;
  let stopLoss = null;
  let target1 = null;
  let target2 = null;
  let target3 = null;


  /* =================================================
     TRADE LEVELS
  ================================================= */

  if (
    technical.success &&
    direction !== "WAIT" &&
    technical.current !== null
  ) {

    entry =
      technical.current;


    if (
      direction === "BUY" &&
      technical.support !== null
    ) {

      stopLoss =
        technical.support;


      const risk =
        entry -
        stopLoss;


      if (
        risk > 0
      ) {

        target1 =
          Number(
            (
              entry +
              risk
            ).toFixed(2)
          );

        target2 =
          Number(
            (
              entry +
              risk * 2
            ).toFixed(2)
          );

        target3 =
          Number(
            (
              entry +
              risk * 3
            ).toFixed(2)
          );
      }
    }


    if (
      direction === "SELL" &&
      technical.resistance !== null
    ) {

      stopLoss =
        technical.resistance;


      const risk =
        stopLoss -
        entry;


      if (
        risk > 0
      ) {

        target1 =
          Number(
            (
              entry -
              risk
            ).toFixed(2)
          );

        target2 =
          Number(
            (
              entry -
              risk * 2
            ).toFixed(2)
          );

        target3 =
          Number(
            (
              entry -
              risk * 3
            ).toFixed(2)
          );
      }
    }
  }


  const riskReward =
    entry !== null &&
    stopLoss !== null &&
    target2 !== null &&
    Math.abs(
      entry - stopLoss
    ) > 0

      ? Number(
          (
            Math.abs(
              target2 -
              entry
            ) /
            Math.abs(
              entry -
              stopLoss
            )
          ).toFixed(2)
        )

      : null;


  /*
    Confidence safeguard.
  */

  if (
    confidence < 55
  ) {

    direction =
      "WAIT";

    entry = null;
    stopLoss = null;
    target1 = null;
    target2 = null;
    target3 = null;
  }


  const invalidation =
    direction === "BUY"

      ? "Bullish setup invalid if price loses key support and confirmation fails."

      : direction === "SELL"

        ? "Bearish setup invalid if price breaks key resistance and confirmation fails."

        : "No trade until technical and option confirmation align.";


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
}


/* =====================================================
   ANALYSIS API
===================================================== */

app.get(
  "/api/analysis",
  async (req, res) => {

    try {

      const analysis =
        await getEraAnalysis();


      res.json(
        analysis
      );


    } catch (error) {

      console.error(
        "ANALYSIS ERROR:",
        error
      );


      res.status(500).json({

        success: false,

        error:
          error.message
      });
    }
  }
);


/* =====================================================
   NEWS
===================================================== */

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

              apiKey
            },

            timeout:
              15000
          }
        );


      const articles =
        Array.isArray(
          response.data?.articles
        )

          ? response.data.articles

          : [];


      const news =
        articles.map(
          article => ({

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


      res.json({

        success: true,

        data:
          news
      });


    } catch (error) {

      console.error(
        "NEWS ERROR:",
        error.response?.data ||
        error.message
      );


      res.status(500).json({

        success: false,

        error:
          "Unable to fetch news"
      });
    }
  }
);


/* =====================================================
   AI CHAT
===================================================== */

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
        req.body?.message;


      const history =
        Array.isArray(
          req.body?.history
        )

          ? req.body.history

          : [];


      if (
        !message ||
        !String(message).trim()
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Message is required"
        });
      }


      const analysis =
        await getEraAnalysis();


      let analysisContext =
        "";


      if (
        analysis.success
      ) {

        analysisContext = `

LIVE ERA ANALYSIS:

SIGNAL:
${analysis.signal.direction}

CONFIDENCE:
${analysis.signal.confidence}%

ENTRY:
${analysis.signal.entry ?? "N/A"}

STOP LOSS:
${analysis.signal.stopLoss ?? "N/A"}

TARGET 1:
${analysis.signal.target1 ?? "N/A"}

TARGET 2:
${analysis.signal.target2 ?? "N/A"}

TARGET 3:
${analysis.signal.target3 ?? "N/A"}

RISK/REWARD:
${
  analysis.signal.riskReward
    ? analysis.signal.riskReward.toFixed(2)
    : "N/A"
}

NIFTY LIVE PRICE:
${analysis.market?.nifty?.lastPrice ?? "N/A"}

GIFT NIFTY:
${analysis.market?.giftNifty?.lastPrice ?? "N/A"}

INDIA VIX:
${analysis.market?.indiaVix?.lastPrice ?? "N/A"}

TECHNICAL TREND:
${analysis.technical?.trend ?? "N/A"}

RSI:
${analysis.technical?.rsi ?? "N/A"}

VWAP:
${analysis.technical?.vwap ?? "N/A"}

EMA 9:
${analysis.technical?.ema9 ?? "N/A"}

EMA 20:
${analysis.technical?.ema20 ?? "N/A"}

EMA 50:
${analysis.technical?.ema50 ?? "N/A"}

SUPPORT:
${analysis.technical?.support ?? "N/A"}

RESISTANCE:
${analysis.technical?.resistance ?? "N/A"}

CANDLE COUNT:
${analysis.technical?.candles ?? "N/A"}

OPTION BIAS:
${analysis.options?.bias ?? "N/A"}

PCR:
${analysis.options?.pcr ?? "N/A"}

MAX PAIN:
${analysis.options?.maxPain ?? "N/A"}

REASONS:
${analysis.reasons.join("; ")}

INVALIDATION:
${analysis.invalidation}

`;
      }


      const systemMessage = {

        role:
          "system",

        content: `
You are Era AI V5, a premium voice-controlled stock-market assistant.

The user may speak Hindi, Hinglish, Gujarati or English.

Reply in the same language as the user.

You receive live market data and calculated analysis from the Era backend.

IMPORTANT:

- Never invent live prices.
- Never guarantee profit.
- Never claim certainty about market direction.
- Clearly distinguish LIVE DATA from ANALYSIS.
- If signal is WAIT, do not force BUY or SELL.
- If confirmations are insufficient, say WAIT / NO TRADE.
- Entry, SL and targets are analytical levels, not guaranteed execution prices.

For a trading setup explain:

Direction
Entry
Stop Loss
Target 1
Target 2
Target 3
Risk/Reward
Confirmations
Invalidation

If the user asks for live Nifty price, use the supplied live Nifty value.

If the user asks whether Nifty is bullish/bearish, consider:

- Nifty
- GIFT NIFTY
- India VIX
- technical analysis
- option analysis

Do not use GIFT NIFTY alone as a prediction.

If the user asks for a trade and confirmation is weak:
say WAIT / NO TRADE.

Keep responses concise and voice-friendly.

${analysisContext}
`
      };


      const safeHistory =
        history

          .slice(-20)

          .filter(
            item =>
              item &&
              (
                item.role === "user" ||
                item.role === "assistant"
              ) &&
              typeof item.content ===
                "string"
          )

          .map(
            item => ({

              role:
                item.role,

              content:
                item.content
            })
          );


      const messages = [

        systemMessage,

        ...safeHistory,

        {

          role:
            "user",

          content:
            String(
              message
            ).trim()
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
                `Bearer ${apiKey}`,

              "Content-Type":
                "application/json",

              "HTTP-Referer":
                "https://alltimebest2501-eng.github.io/Era-ai/",

              "X-Title":
                "Era AI V5"
            },

            timeout:
              30000
          }
        );


      const answer =
        response.data
          ?.choices?.[0]
          ?.message?.content;


      if (!answer) {

        return res.status(500).json({

          success: false,

          error:
            "AI ne koi response return nahi kiya"
        });
      }


      res.json({

        success: true,

        reply:
          answer,

        analysis:
          analysis.success
            ? analysis.signal
            : null
      });


    } catch (error) {

      console.error(
        "AI CHAT ERROR:",
        error.response?.data ||
        error.message
      );


      res.status(
        error.response?.status ||
        500
      ).json({

        success: false,

        error:
          error.response?.data
            ?.error?.message ||

          error.message ||

          "AI response failed"
      });
    }
  }
);


/* =====================================================
   START SERVER
===================================================== */

app.listen(
  PORT,
  () => {

    console.log(
      "======================================"
    );

    console.log(
      `Era AI V5 backend running on port ${PORT}`
    );

    console.log(
      "[ELEVENLABS] API key configured:",
      Boolean(
        process.env.ELEVENLABS_API_KEY
      )
    );

    console.log(
      "[ELEVENLABS] Voice ID configured:",
      Boolean(
        process.env.ELEVENLABS_VOICE_ID
      )
    );

    console.log(
      "[UPSTOX] Access token configured:",
      Boolean(
        process.env.UPSTOX_ACCESS_TOKEN
      )
    );

    console.log(
      "[OPENROUTER] API key configured:",
      Boolean(
        process.env.OPENROUTER_API_KEY
      )
    );

    console.log(
      "======================================"
    );


    setTimeout(
      () => {

        startLiveOptionWebSocket()

          .catch(
            error => {

              console.error(
                "[LIVE OPTIONS] Startup error:",
                error
              );
            }
          );

      },
      3000
    );
  }
);
