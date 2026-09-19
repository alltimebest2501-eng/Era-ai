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
const VERSION = "8.0.0";

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const BACKEND_URL =
  process.env.BACKEND_URL ||
  "https://era-ai.onrender.com";

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

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

const INDICES = {
  NIFTY: {
    symbol: "NSE_INDEX|Nifty 50",
    name: "NIFTY 50",
    exchange: "NSE",
    lotSize: 65
  },
  BANKNIFTY: {
    symbol: "NSE_INDEX|Nifty Bank",
    name: "BANK NIFTY",
    exchange: "NSE",
    lotSize: 30
  },
  FINNIFTY: {
    symbol: "NSE_INDEX|Nifty Fin Service",
    name: "FIN NIFTY",
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
  notificationHistory: {},
  settings: {
    movementThreshold: 20,
    minConfidence: 60,
    scanIntervalMs: 60000,
    newsIntervalMs: 300000,
    notificationCooldownMs: 15 * 60 * 1000,
    notifications: {
      marketOpen: true,
      movement: true,
      tradeSetup: true,
      news: true,
      marketClose: true
    }
  }
};

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "era-state.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return;
    }

    const saved = JSON.parse(
      fs.readFileSync(STATE_FILE, "utf8")
    );

    if (Array.isArray(saved.pushSubscriptions)) {
      state.pushSubscriptions =
        saved.pushSubscriptions;
    }

    if (Array.isArray(saved.history)) {
      state.history = saved.history;
    }

    if (Array.isArray(saved.alerts)) {
      state.alerts = saved.alerts;
    }

    if (
      saved.settings &&
      typeof saved.settings === "object"
    ) {
      state.settings = {
        ...state.settings,
        ...saved.settings,
        notifications: {
          ...state.settings.notifications,
          ...(saved.settings.notifications || {})
        }
      };
    }

    if (
      saved.notificationHistory &&
      typeof saved.notificationHistory === "object"
    ) {
      state.notificationHistory =
        saved.notificationHistory;
    }
  } catch (error) {
    console.error(
      "[ERA] State load error:",
      error.message
    );
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          pushSubscriptions:
            state.pushSubscriptions,
          history: state.history,
          alerts: state.alerts,
          settings: state.settings,
          notificationHistory:
            state.notificationHistory
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      "[ERA] State save error:",
      error.message
    );
  }
}

loadState();

function round(value, decimals = 2) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  const factor = Math.pow(10, decimals);

  return (
    Math.round(number * factor) /
    factor
  );
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function clamp(value, min, max) {
  return Math.min(
    Math.max(value, min),
    max
  );
}

function nowISO() {
  return new Date().toISOString();
}

function normalizeIndex(index) {
  const key = String(index || "NIFTY")
    .trim()
    .toUpperCase();

  return INDICES[key]
    ? key
    : "NIFTY";
}

function getISTDate() {
  return new Date(
    new Date().toLocaleString(
      "en-US",
      {
        timeZone: "Asia/Kolkata"
      }
    )
  );
}

function isMarketOpen() {
  const now = getISTDate();
  const day = now.getDay();

  if (day === 0 || day === 6) {
    return false;
  }

  const minutes =
    now.getHours() * 60 +
    now.getMinutes();

  return (
    minutes >= 9 * 60 + 15 &&
    minutes <= 15 * 60 + 30
  );
}

function formatDate(date = new Date()) {
  return new Intl.DateTimeFormat(
    "en-IN",
    {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).format(date);
}

function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat(
    "en-IN",
    {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }
  ).format(date);
}

function log(...args) {
  console.log(
    `[ERA ${formatTime()}]`,
    ...args
  );
}

async function upstoxRequest(
  method,
  url,
  options = {}
) {
  if (!UPSTOX_ACCESS_TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is missing"
    );
  }

  const response = await axios({
    method,
    url,
    timeout:
      options.timeout || 15000,
    headers: {
      Accept: "application/json",
      Authorization:
        `Bearer ${UPSTOX_ACCESS_TOKEN}`,
      ...(options.headers || {})
    },
    params: options.params,
    data: options.data
  });

  return response.data;
}

function normalizeMarketQuote(
  key,
  quote
) {
  if (!quote) {
    return null;
  }

  const ohlc =
    quote.ohlc ||
    quote.OHLC ||
    {};

  const ltp = safeNumber(
    quote.last_price ??
      quote.lastPrice ??
      quote.ltp ??
      quote.close
  );

  const open = safeNumber(
    ohlc.open ??
      quote.open
  );

  const high = safeNumber(
    ohlc.high ??
      quote.high
  );

  const low = safeNumber(
    ohlc.low ??
      quote.low
  );

  const prevClose =
    safeNumber(
      quote.prev_close ??
        quote.previous_close ??
        quote.prevClose
    );

  let change =
    safeNumber(
      quote.net_change ??
        quote.change
    );

  if (!change && prevClose) {
    change = ltp - prevClose;
  }

  let changePercent =
    safeNumber(
      quote.percent_change ??
        quote.change_percent ??
        quote.pChange
    );

  if (!changePercent && prevClose) {
    changePercent =
      (change / prevClose) * 100;
  }

  return {
    key,
    name:
      INDICES[key]?.name ||
      key,
    symbol:
      INDICES[key]?.symbol ||
      EXTRA_SYMBOLS[key] ||
      "",
    exchange:
      INDICES[key]?.exchange ||
      "",
    ltp: round(ltp),
    price: round(ltp),
    open: round(open),
    high: round(high),
    low: round(low),
    prevClose: round(prevClose),
    change: round(change),
    changePercent:
      round(changePercent, 2),
    volume: safeNumber(
      quote.volume ??
        quote.volume_traded ??
        quote.volumeTraded
    ),
    timestamp:
      quote.timestamp ||
      nowISO(),
    available:
      Number.isFinite(ltp) &&
      ltp > 0,
    source: "UPSTOX"
  };
}

async function fetchMarketQuotes() {
  const instruments = [
    ...Object.entries(INDICES).map(
      ([key, item]) => ({
        key,
        instrumentKey:
          item.symbol
      })
    ),
    {
      key: "GIFT_NIFTY",
      instrumentKey:
        EXTRA_SYMBOLS.GIFT_NIFTY
    },
    {
      key: "INDIA_VIX",
      instrumentKey:
        EXTRA_SYMBOLS.INDIA_VIX
    }
  ];

  const result = {};

  for (
    let i = 0;
    i < instruments.length;
    i++
  ) {
    const item = instruments[i];

    try {
      const data =
        await upstoxRequest(
          "GET",
          "https://api.upstox.com/v3/market-quote/quotes",
          {
            params: {
              instrument_key:
                item.instrumentKey
            }
          }
        );

      const raw =
        data?.data || {};

      const first =
        raw[item.instrumentKey] ||
        Object.values(raw)[0];

      result[item.key] =
        normalizeMarketQuote(
          item.key,
          first
        );
    } catch (error) {
      log(
        `Market quote failed ${item.key}:`,
        error.message
      );

      result[item.key] = null;
    }
  }

  return result;
}
function findQuoteForIndex(
  rawData,
  index
) {
  const config =
    INDICES[index];
  if (
    !config ||
    !rawData
  ) {
    return null;
  }
  const keys = [
    config.symbol,
    config.symbol
      .replace("|", ":"),
    index,
    config.name
  ];
  for (const key of keys) {
    if (
      key &&
      rawData[key]
    ) {
      return rawData[key];
    }
  }
  const target =
    config.symbol
      .toUpperCase();
  const found =
    Object.entries(
      rawData
    ).find(
      ([key]) => {
        const upper =
          String(key)
            .toUpperCase();
        return (
          upper === target ||
          upper.includes(index)
        );
      }
    );
  return found
    ? found[1]
    : null;
}

function normalizeFullQuote(
  index,
  raw
) {
  if (!raw) {
    return {
      index,
      name:
        INDICES[index]?.name ||
        index,
      instrumentKey:
        INDICES[index]?.symbol ||
        null,
      available: false,
      error:
        "No quote data",
      source:
        "upstox-v3"
    };
  }

  const ltpc =
    raw.ltpc || {};
  const ohlc =
    raw.ohlc || {};

  const ltp =
    safeNumber(
      raw.last_price ??
      raw.lastPrice ??
      ltpc.ltp ??
      raw.ltp ??
      ohlc.close ??
      0
    );

  let previousClose =
    raw.prev_close_price ??
    raw.previous_close ??
    raw.previousClose ??
    ltpc.cp ??
    null;

  let change =
    raw.net_change ??
    raw.netChange ??
    raw.change ??
    null;

  const open =
    raw.open ??
    raw.open_price ??
    ohlc.open ??
    null;

  const high =
    raw.high ??
    raw.high_price ??
    ohlc.high ??
    null;

  const low =
    raw.low ??
    raw.low_price ??
    ohlc.low ??
    null;

  let close =
    raw.close ??
    raw.close_price ??
    ohlc.close ??
    ltp;

  if (
    Number.isFinite(
      Number(previousClose)
    ) &&
    Number(previousClose) > 0
  ) {
    previousClose =
      Number(previousClose);

    change =
      ltp -
      previousClose;
  }

  if (
    (!previousClose ||
      Number(previousClose) <= 0) &&
    Number.isFinite(
      Number(change)
    ) &&
    Number(change) !== 0
  ) {
    const calculated =
      ltp -
      Number(change);

    if (
      calculated > 0
    ) {
      previousClose =
        calculated;
    }
  }

  if (
    !Number.isFinite(
      Number(previousClose)
    ) ||
    Number(previousClose) <= 0
  ) {
    previousClose = 0;
  }

  if (
    !Number.isFinite(
      Number(change)
    )
  ) {
    change =
      previousClose > 0
        ? ltp - previousClose
        : 0;
  }

  const changePercent =
    previousClose > 0
      ? (
          change /
          previousClose
        ) * 100
      : 0;

  const timestamp =
    raw.timestamp ??
    raw.last_trade_time ??
    ltpc.ltt ??
    nowISO();

  return {
    index,
    name:
      INDICES[index]?.name ||
      index,
    instrumentKey:
      INDICES[index]?.symbol ||
      null,
    available:
      true,
    price:
      round(ltp),
    previousClose:
      round(previousClose),
    change:
      round(change),
    changePercent:
      round(
        changePercent,
        3
      ),
    open:
      open !== null
        ? round(open)
        : null,
    high:
      high !== null
        ? round(high)
        : null,
    low:
      low !== null
        ? round(low)
        : null,
    close:
      close !== null
        ? round(close)
        : round(ltp),
    sessionClose:
      close !== null
        ? round(close)
        : round(ltp),
    volume:
      safeNumber(
        raw.volume ??
        ohlc.volume ??
        0
      ),
    averagePrice:
      safeNumber(
        raw.average_price ??
        raw.averagePrice ??
        0
      ),
    oi:
      safeNumber(
        raw.oi ??
        0
      ),
    lowerCircuit:
      safeNumber(
        raw.lower_circuit_limit ??
        0
      ),
    upperCircuit:
      safeNumber(
        raw.upper_circuit_limit ??
        0
      ),
    timestamp,
    lastTradeTime:
      raw.last_trade_time ??
      ltpc.ltt ??
      null,
    stale: false,
    source:
      "upstox-v3"
  };
}

async function fetchQuotes() {
  const rawData =
    await fetchFullMarketQuotes();

  const result = {};

  for (
    const index of Object.keys(
      INDICES
    )
  ) {
    const raw =
      findQuoteForIndex(
        rawData,
        index
      );

    result[index] =
      normalizeFullQuote(
        index,
        raw
      );
  }

  return result;
}

async function refreshMarket() {
  try {
    const quotes =
      await fetchQuotes();

    for (
      const index of Object.keys(
        INDICES
      )
    ) {
      const current =
        quotes[index];

      if (
        current &&
        current.available
      ) {
        state.market[index] =
          current;
      }
    }

    state.lastSuccess =
      nowISO();
    state.lastError = null;

    return state.market;
  } catch (error) {
    state.lastError =
      error.message;

    log(
      "Market refresh failed:",
      error.message
    );

    return state.market;
  }
}

async function fetchCandles(
  index,
  interval = "5minute",
  days = 5
) {
  const config =
    INDICES[index];

  if (!config) {
    throw new Error(
      `Unknown index: ${index}`
    );
  }

  const toDate =
    new Date();

  const fromDate =
    new Date(
      toDate.getTime() -
      days *
        24 *
        60 *
        60 *
        1000
    );

  const from =
    fromDate
      .toISOString()
      .slice(0, 10);

  const to =
    toDate
      .toISOString()
      .slice(0, 10);

  const url =
    `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(
      config.symbol
    )}/${interval}/${to}/${from}`;

  const response =
    await upstoxRequest(
      url
    );

  const candles =
    response?.data?.candles ||
    [];

  return candles
    .map(candle => ({
      timestamp:
        candle[0],
      open:
        safeNumber(candle[1]),
      high:
        safeNumber(candle[2]),
      low:
        safeNumber(candle[3]),
      close:
        safeNumber(candle[4]),
      volume:
        safeNumber(candle[5]),
      oi:
        safeNumber(candle[6])
    }))
    .reverse();
}

function ema(
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
    values.length < period
  ) {
    return values[
      values.length - 1
    ];
  }

  const multiplier =
    2 /
    (period + 1);

  let result = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    result +=
      safeNumber(
        values[i]
      );
  }

  result /=
    period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result =
      (
        values[i] -
        result
      ) *
        multiplier +
      result;
  }

  return result;
}

function rsi(
  values,
  period = 14
) {
  if (
    !Array.isArray(values) ||
    values.length <
      period + 1
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
    const diff =
      safeNumber(
        values[i]
      ) -
      safeNumber(
        values[i - 1]
      );

    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
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
      safeNumber(
        values[i]
      ) -
      safeNumber(
        values[i - 1]
      );

    const gain =
      diff > 0
        ? diff
        : 0;

    const loss =
      diff < 0
        ? -diff
        : 0;

    averageGain =
      (
        averageGain *
          (period - 1) +
        gain
      ) /
      period;

    averageLoss =
      (
        averageLoss *
          (period - 1) +
        loss
      ) /
      period;
  }

  if (
    averageLoss === 0
  ) {
    return 100;
  }

  const rs =
    averageGain /
    averageLoss;

  return 100 -
    100 / (1 + rs);
}

function calculateVWAP(
  candles
) {
  if (
    !Array.isArray(candles) ||
    candles.length === 0
  ) {
    return null;
  }

  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (
    const candle of candles
  ) {
    const typicalPrice =
      (
        safeNumber(
          candle.high
        ) +
        safeNumber(
          candle.low
        ) +
        safeNumber(
          candle.close
        )
      ) / 3;

    const volume =
      safeNumber(
        candle.volume
      );

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
function findQuoteForIndex(rawData,index){const config=INDICES[index];if(!config||!rawData)return null;const keys=[config.symbol,config.symbol.replace("|",":"),index,config.name];for(const key of keys){if(key&&rawData[key])return rawData[key]}const target=config.symbol.toUpperCase();const found=Object.entries(rawData).find(([key])=>{const upper=String(key).toUpperCase();return upper===target||upper.includes(index)});return found?found[1]:null}

function normalizeFullQuote(index,raw){
if(!raw)return{index,name:INDICES[index]?.name||index,instrumentKey:INDICES[index]?.symbol||null,available:false,error:"No quote data",source:"upstox-v3"};
const ltpc=raw.ltpc||{},ohlc=raw.ohlc||{};
const ltp=safeNumber(raw.last_price??raw.lastPrice??ltpc.ltp??raw.ltp??ohlc.close??0);
let previousClose=raw.prev_close_price??raw.previous_close??raw.previousClose??ltpc.cp??null;
let change=raw.net_change??raw.netChange??raw.change??null;
const open=raw.open??raw.open_price??ohlc.open??null;
const high=raw.high??raw.high_price??ohlc.high??null;
const low=raw.low??raw.low_price??ohlc.low??null;
let close=raw.close??raw.close_price??ohlc.close??ltp;

if(Number.isFinite(Number(previousClose))&&Number(previousClose)>0){
previousClose=Number(previousClose);
change=ltp-previousClose;
}

if((!previousClose||Number(previousClose)<=0)&&Number.isFinite(Number(change))&&Number(change)!==0){
const calculated=ltp-Number(change);
if(calculated>0)previousClose=calculated;
}

if(!Number.isFinite(Number(previousClose))||Number(previousClose)<=0)previousClose=0;

if(!Number.isFinite(Number(change))){
change=previousClose>0?ltp-previousClose:0;
}

const changePercent=previousClose>0?(change/previousClose)*100:0;
const timestamp=raw.timestamp??raw.last_trade_time??ltpc.ltt??nowISO();

return{
index,
name:INDICES[index]?.name||index,
instrumentKey:INDICES[index]?.symbol||null,
available:true,
price:round(ltp),
previousClose:round(previousClose),
change:round(change),
changePercent:round(changePercent,3),
open:open!==null?round(open):null,
high:high!==null?round(high):null,
low:low!==null?round(low):null,
close:close!==null?round(close):round(ltp),
sessionClose:close!==null?round(close):round(ltp),
volume:safeNumber(raw.volume??ohlc.volume??0),
averagePrice:safeNumber(raw.average_price??raw.averagePrice??0),
oi:safeNumber(raw.oi??0),
lowerCircuit:safeNumber(raw.lower_circuit_limit??0),
upperCircuit:safeNumber(raw.upper_circuit_limit??0),
timestamp,
lastTradeTime:raw.last_trade_time??ltpc.ltt??null,
stale:false,
source:"upstox-v3"
};
}

async function fetchQuotes(){
const rawData=await fetchFullMarketQuotes();
const result={};
for(const index of Object.keys(INDICES)){
const raw=findQuoteForIndex(rawData,index);
result[index]=normalizeFullQuote(index,raw);
}
return result;
}

async function fetchExtraMarketData(){
const result={GIFT_NIFTY:{available:false},INDIA_VIX:{available:false}};
try{
const keys=Object.values(EXTRA_SYMBOLS).join(",");
const data=(await upstoxRequest("https://api.upstox.com/v3/market-quote/quotes",{instrument_key:keys})).data||{};

for(const[name,symbol]of Object.entries(EXTRA_SYMBOLS)){
let raw=data[symbol]||data[symbol.replace("|",":")]||data[name];

if(!raw){
const found=Object.entries(data).find(([key])=>String(key).toUpperCase().includes(name));
if(found)raw=found[1];
}

if(!raw)continue;

const ltpc=raw.ltpc||{};
const price=safeNumber(raw.last_price??ltpc.ltp??raw.ltp??raw.close??0);
let previousClose=safeNumber(raw.prev_close_price??raw.previous_close??ltpc.cp??0);
let change=safeNumber(raw.net_change??raw.change??0);

if(previousClose>0){
change=price-previousClose;
}else if(change!==0){
previousClose=price-change;
}

const changePercent=previousClose>0?(change/previousClose)*100:0;

result[name]={
available:true,
price:round(price),
previousClose:round(previousClose),
change:round(change),
changePercent:round(changePercent,3),
timestamp:raw.timestamp??raw.last_trade_time??ltpc.ltt??nowISO(),
source:"upstox-v3"
};
}
}catch(error){
console.error("[ERA] Extra market error:",error.response?.data||error.message);
}
return result;
}

async function refreshMarketData(){
const quotes=await fetchQuotes();

state.market={
...state.market,
...quotes
};

const extra=await fetchExtraMarketData();

state.market.GIFT_NIFTY=extra.GIFT_NIFTY;
state.market.INDIA_VIX=extra.INDIA_VIX;

state.lastSuccess=nowISO();
state.lastError=null;

return state.market;
}

async function fetchIntradayCandles(index,interval=5){
const config=INDICES[index];
if(!config)return[];

try{
const response=await upstoxRequest(
`https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(config.symbol)}/minutes/${interval}`
);

let candles=response.data?.candles||[];

candles=candles.filter(candle=>
Array.isArray(candle)&&
candle.length>=6&&
Number.isFinite(Number(candle[4]))
);

candles.sort(
(a,b)=>new Date(a[0]).getTime()-new Date(b[0]).getTime()
);

console.log(`[ERA] ${index} intraday candles: ${candles.length}`);

return candles;
}catch(error){
console.error(
`[ERA] Intraday candle error ${index}:`,
error.response?.data||error.message
);
return[];
}
}

async function fetchHistoricalCandles(index,interval=5){
const config=INDICES[index];
if(!config)return[];

try{
const endDate=new Date();

const startDate=new Date(
endDate.getTime()-
7*24*60*60*1000
);

const to=endDate.toISOString().slice(0,10);
const from=startDate.toISOString().slice(0,10);

const response=await upstoxRequest(
`https://api.upstox.com/v3/historical-candle/${encodeURIComponent(config.symbol)}/minutes/${interval}/${to}/${from}`
);

let candles=response.data?.candles||[];

candles=candles.filter(
candle=>Array.isArray(candle)&&candle.length>=6
);

candles.sort(
(a,b)=>new Date(a[0]).getTime()-new Date(b[0]).getTime()
);

return candles;
}catch(error){
console.error(
`[ERA] Historical candle error ${index}:`,
error.response?.data||error.message
);
return[];
}
}

function syncLatestCandle(candles,livePrice){
if(
!Array.isArray(candles)||
candles.length===0||
!Number.isFinite(Number(livePrice))
)return candles||[];

const result=candles.map(candle=>[...candle]);
const last=result[result.length-1];

if(!last||last.length<5)return result;

const price=Number(livePrice);

last[4]=price;

if(Number(last[2])<price)last[2]=price;
if(Number(last[3])>price)last[3]=price;

return result;
}

function ema(values,period){
if(!Array.isArray(values)||values.length<period)return null;

const first=
values.slice(0,period)
.reduce((a,b)=>a+Number(b),0)/period;

const multiplier=2/(period+1);
let result=first;

for(let i=period;i<values.length;i++){
result=(Number(values[i])-result)*multiplier+result;
}

return result;
}

function rsi(values,period=14){
if(!Array.isArray(values)||values.length<=period)return null;

let gains=0;
let losses=0;

for(
let i=values.length-period;
i<values.length;
i++
){
const previous=Number(values[i-1]);
const current=Number(values[i]);
const diff=current-previous;

if(diff>0)gains+=diff;
else losses+=Math.abs(diff);
}

const avgGain=gains/period;
const avgLoss=losses/period;

if(avgLoss===0)return 100;

const rs=avgGain/avgLoss;

return 100-100/(1+rs);
}

function calculateVWAP(candles){
if(!Array.isArray(candles)||candles.length===0)return null;

let totalPV=0;
let totalVolume=0;

const last=candles[candles.length-1];

const lastDate=new Date(last[0])
.toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata"});

for(const candle of candles){
const date=new Date(candle[0])
.toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata"});

if(date!==lastDate)continue;

const high=Number(candle[2]);
const low=Number(candle[3]);
const close=Number(candle[4]);
const volume=Number(candle[5]);

if(
!Number.isFinite(high)||
!Number.isFinite(low)||
!Number.isFinite(close)||
!Number.isFinite(volume)||
volume<=0
)continue;

const typical=(high+low+close)/3;

totalPV+=typical*volume;
totalVolume+=volume;
}

if(totalVolume<=0)return null;

return totalPV/totalVolume;
}

function detectStructure(candles){
if(!Array.isArray(candles)||candles.length<10){
return{
label:"RANGE",
bos:false,
choch:false,
details:null
};
}

const recent=candles.slice(-10);
const previous=candles.slice(-20,-10);

const recentHigh=Math.max(
...recent.map(c=>Number(c[2]))
);

const recentLow=Math.min(
...recent.map(c=>Number(c[3]))
);

const previousHigh=previous.length
?Math.max(...previous.map(c=>Number(c[2])))
:recentHigh;

const previousLow=previous.length
?Math.min(...previous.map(c=>Number(c[3])))
:recentLow;

let label="RANGE";

if(
recentHigh>previousHigh&&
recentLow>previousLow
){
label="HH_HL";
}else if(
recentHigh<previousHigh&&
recentLow<previousLow
){
label="LH_LL";
}

const lastClose=Number(
candles[candles.length-1][4]
);

const bosUp=lastClose>previousHigh;
const bosDown=lastClose<previousLow;

return{
label,
bos:bosUp||bosDown,
choch:
(label==="HH_HL"&&bosDown)||
(label==="LH_LL"&&bosUp),
details:{
recentHigh:round(recentHigh),
recentLow:round(recentLow),
previousHigh:round(previousHigh),
previousLow:round(previousLow)
}
};
}

function technicalAnalysis(candles,price){
if(!Array.isArray(candles)||candles.length===0){
return{
candleCount:0,
ema9:null,
ema20:null,
ema50:null,
rsi:null,
vwap:null,
support:null,
resistance:null,
trend:"UNKNOWN",
structure:"RANGE",
structureDetails:null
};
}

const closes=candles.map(c=>Number(c[4]));

const ema9=ema(closes,9);
const ema20=ema(closes,20);
const ema50=ema(closes,50);

const current=Number(price);

let trend="SIDEWAYS";

if(
ema9!==null&&
ema20!==null&&
ema50!==null
){
if(
current>ema9&&
ema9>ema20&&
ema20>ema50
){
trend="BULLISH";
}else if(
current<ema9&&
ema9<ema20&&
ema20<ema50
){
trend="BEARISH";
}
}else if(
ema9!==null&&
ema20!==null
){
if(current>ema9&&ema9>ema20){
trend="BULLISH";
}else if(current<ema9&&ema9<ema20){
trend="BEARISH";
}
}

const recent=candles.slice(-20);

const support=Math.min(
...recent.map(c=>Number(c[3]))
);

const resistance=Math.max(
...recent.map(c=>Number(c[2]))
);

const structure=detectStructure(candles);

return{
candleCount:candles.length,
ema9:ema9!==null?round(ema9):null,
ema20:ema20!==null?round(ema20):null,
ema50:ema50!==null?round(ema50):null,
rsi:rsiValue(closes),
vwap:calculateVWAP(candles),
support:round(support),
resistance:round(resistance),
trend,
structure:structure.label,
structureDetails:structure.details,
bos:structure.bos,
choch:structure.choch
};
}

function rsiValue(closes){
const value=rsi(closes,14);
return value!==null?round(value,2):null;
}

async function fetchOptionContracts(index){
const config=INDICES[index];

if(!config){
throw new Error(`Invalid index: ${index}`);
}

const response=await upstoxRequest(
"https://api.upstox.com/v2/option/contract",
{
instrument_key:config.symbol
}
);

return response.data||[];
}

async function findNearestExpiry(index){
const contracts=await fetchOptionContracts(index);

const today=new Date()
.toISOString()
.slice(0,10);

const expiries=[
...new Set(
contracts
.map(item=>item.expiry)
.filter(Boolean)
)
]
.sort();

return expiries.find(
expiry=>expiry>=today
)||expiries[0]||null;
}
async function fetchOptionContracts(index){const config=INDICES[index];if(!config)throw new Error(`Invalid index: ${index}`);const response=await upstoxRequest("https://api.upstox.com/v2/option/contract",{instrument_key:config.symbol});return response.data||[]}
async function findNearestExpiry(index){const contracts=await fetchOptionContracts(index);const today=new Date().toISOString().slice(0,10);const expiries=[...new Set(contracts.map(item=>item.expiry).filter(Boolean))].filter(expiry=>expiry>=today).sort();return expiries[0]||null}
async function fetchOptionChain(index,expiryDate=null){const config=INDICES[index];let expiry=expiryDate;if(!expiry)expiry=await findNearestExpiry(index);if(!expiry)throw new Error(`No expiry found for ${index}`);const response=await upstoxRequest("https://api.upstox.com/v2/option/chain",{instrument_key:config.symbol,expiry_date:expiry});return{expiry,data:response.data||[]}}
async function fetchOptionGreeks(instrumentKeys){if(!Array.isArray(instrumentKeys)||instrumentKeys.length===0)return{};const unique=[...new Set(instrumentKeys.filter(Boolean))].slice(0,50);if(!unique.length)return{};try{const response=await upstoxRequest("https://api.upstox.com/v3/market-quote/option-greek",{instrument_key:unique.join(",")});return response.data||{}}catch(error){console.error("[ERA] Greeks error:",error.response?.data||error.message);return{}}}
function normalizeOptionSide(side,strikeFallback){if(!side)return null;const marketData=side.market_data||side.marketData||side;const greeks=side.option_greeks||side.optionGreeks||side.greeks||{};const instrumentKey=side.instrument_key||side.instrumentKey||marketData.instrument_key||marketData.instrumentKey||null;const strike=safeNumber(side.strike_price??side.strikePrice??strikeFallback);return{type:side.type||side.option_type||side.optionType||null,strike,instrumentKey,ltp:safeNumber(marketData.ltp??marketData.last_price??marketData.lastPrice??side.ltp??0),oi:safeNumber(marketData.oi??marketData.open_interest??side.oi??0),changeOI:safeNumber(marketData.change_oi??marketData.changeOi??side.change_oi??0),volume:safeNumber(marketData.volume??side.volume??0),iv:safeNumber(greeks.iv??greeks.implied_volatility??side.iv??0),delta:safeNumber(greeks.delta??side.delta??0),gamma:safeNumber(greeks.gamma??side.gamma??0),theta:safeNumber(greeks.theta??side.theta??0),vega:safeNumber(greeks.vega??side.vega??0),rho:safeNumber(greeks.rho??side.rho??0)}}
function normalizeOptionChain(chainData){const rows=[];for(const item of chainData||[]){const strike=safeNumber(item.strike_price??item.strikePrice??item.strike);const callRaw=item.call_options||item.callOptions||item.CE||item.ce||null;const putRaw=item.put_options||item.putOptions||item.PE||item.pe||null;const call=normalizeOptionSide(callRaw,strike);const put=normalizeOptionSide(putRaw,strike);if(!call&&!put)continue;rows.push({strike,expiry:item.expiry||item.expiry_date||null,call,put})}rows.sort((a,b)=>a.strike-b.strike);return rows}
function mergeGreeks(rows,greeks){for(const row of rows){for(const sideName of["call","put"]){const side=row[sideName];if(!side||!side.instrumentKey)continue;const data=greeks[side.instrumentKey];if(!data)continue;side.iv=safeNumber(data.iv??data.implied_volatility??side.iv);side.delta=safeNumber(data.delta??side.delta);side.gamma=safeNumber(data.gamma??side.gamma);side.theta=safeNumber(data.theta??side.theta);side.vega=safeNumber(data.vega??side.vega);side.rho=safeNumber(data.rho??side.rho)}}return rows}
function calculateOptionSummary(rows,spot){let callOI=0;let putOI=0;let maxCallOI=null;let maxPutOI=null;let atm=null;let atmDistance=Infinity;for(const row of rows){const callOIValue=safeNumber(row.call?.oi);const putOIValue=safeNumber(row.put?.oi);callOI+=callOIValue;putOI+=putOIValue;if(!maxCallOI||callOIValue>maxCallOI.oi)maxCallOI={strike:row.strike,oi:callOIValue};if(!maxPutOI||putOIValue>maxPutOI.oi)maxPutOI={strike:row.strike,oi:putOIValue};const distance=Math.abs(row.strike-spot);if(distance<atmDistance){atmDistance=distance;atm=row.strike}}const pcr=callOI>0?putOI/callOI:0;let sentiment="NEUTRAL";if(pcr>=1.05)sentiment="BULLISH";else if(pcr<=0.80)sentiment="BEARISH";return{callOI,putOI,pcr:round(pcr,3),sentiment,atm,maxCallOI,maxPutOI}}
function movementFromPrevious(index,currentPrice){const previous=state.previousPrices[index];if(!Number.isFinite(Number(previous))){state.previousPrices[index]=currentPrice;return{points:0,percent:0,significant:false,direction:"NONE"}}const points=currentPrice-previous;const percent=previous!==0?(points/previous)*100:0;state.previousPrices[index]=currentPrice;const threshold=Number(state.settings.movementThreshold);return{points:round(points),percent:round(percent,3),significant:Math.abs(points)>=threshold,direction:points>0?"UP":points<0?"DOWN":"FLAT"}}
function calculateConfidence(market,technical,movement,optionSummary){let confidence=50;const reasons=[];const risks=[];if(movement.significant){confidence+=8;reasons.push(`${Math.abs(movement.points)} point movement confirmed`)}if(movement.direction==="UP"){if(technical.trend==="BULLISH"){confidence+=10;reasons.push("EMA trend supports upside")}if(technical.trend==="BEARISH"){confidence-=10;risks.push("EMA trend conflicts with upside")}if(technical.structure==="HH_HL"){confidence+=8;reasons.push("Higher-high / higher-low structure")}if(optionSummary?.sentiment==="BULLISH"){confidence+=8;reasons.push("Option sentiment supports upside")}if(optionSummary?.sentiment==="BEARISH"){confidence-=6;risks.push("Option sentiment conflicts with upside")}}if(movement.direction==="DOWN"){if(technical.trend==="BEARISH"){confidence+=10;reasons.push("EMA trend supports downside")}if(technical.trend==="BULLISH"){confidence-=10;risks.push("EMA trend conflicts with downside")}if(technical.structure==="LH_LL"){confidence+=8;reasons.push("Lower-high / lower-low structure")}if(optionSummary?.sentiment==="BEARISH"){confidence+=8;reasons.push("Option sentiment supports downside")}if(optionSummary?.sentiment==="BULLISH"){confidence-=6;risks.push("Option sentiment conflicts with downside")}}if(technical.vwap!==null)confidence+=3;if(technical.rsi!==null){if(movement.direction==="UP"&&technical.rsi>=50&&technical.rsi<=70){confidence+=6;reasons.push("RSI confirms bullish momentum")}if(movement.direction==="DOWN"&&technical.rsi<=50&&technical.rsi>=30){confidence+=6;reasons.push("RSI confirms bearish momentum")}if(technical.rsi>75){confidence-=4;risks.push("RSI is overheated")}if(technical.rsi<25){confidence-=4;risks.push("RSI is deeply oversold")}}const threshold=Number(state.settings.movementThreshold);if(!movement.significant)risks.push(`${threshold}+ point movement not confirmed`);confidence=clamp(confidence,20,95);let suggestion;if(confidence>=75&&movement.significant)suggestion="TRADE CONSIDER";else if(confidence>=60)suggestion="WAIT FOR CONFIRMATION";else suggestion="AVOID / NO TRADE";return{confidence:Math.round(confidence),suggestion,reasons,risks}}
function createOptionTrades(index,market,movement,confidenceData,rows){if(!market||!market.available)return[];if(!movement.significant)return[];if(confidenceData.confidence<=60)return[];const direction=movement.direction;const optionType=direction==="UP"?"CE":direction==="DOWN"?"PE":null;if(!optionType)return[];const spot=Number(market.price);const sorted=[...rows].sort((a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot)).slice(0,9);const trades=[];for(const row of sorted){const side=optionType==="CE"?row.call:row.put;if(!side||!side.instrumentKey)continue;const entry=Number(side.ltp);if(!Number.isFinite(entry)||entry<=0)continue;const stopLoss=entry*(confidenceData.confidence>=75?0.83:0.80);const risk=entry-stopLoss;if(risk<=0)continue;const target1=entry+risk*1.5;const target2=entry+risk*2.5;const target3=entry+risk*3.5;trades.push({index,instrumentKey:side.instrumentKey,optionType,strike:row.strike,signal:"BUY",direction,entry:round(entry),stopLoss:round(stopLoss),targets:[round(target1),round(target2),round(target3)],rr:3.5,confidence:confidenceData.confidence,status:confidenceData.confidence>=75?"CONFIRMED":"SETUP",invalidation:`Option price below ${round(stopLoss)}`,generatedAt:nowISO()})}return trades.slice(0,3)}
async function analyzeIndex(index){const market=state.market[index];if(!market||!market.available)return{index,available:false,error:"Market data unavailable",generatedAt:nowISO()};let candles=await fetchIntradayCandles(index,5);if(candles.length===0)candles=await fetchHistoricalCandles(index,5);candles=syncLatestCandle(candles,market.price);const technical=technicalAnalysis(candles,market.price);let optionRows=[];let optionSummary=null;let expiry=null;try{const chain=await fetchOptionChain(index);expiry=chain.expiry;optionRows=normalizeOptionChain(chain.data);if(optionRows.length){const relevant=[...optionRows].sort((a,b)=>Math.abs(a.strike-market.price)-Math.abs(b.strike-market.price)).slice(0,25);const instrumentKeys=[];for(const row of relevant){if(row.call?.instrumentKey)instrumentKeys.push(row.call.instrumentKey);if(row.put?.instrumentKey)instrumentKeys.push(row.put.instrumentKey)}const greeks=await fetchOptionGreeks(instrumentKeys);optionRows=mergeGreeks(optionRows,greeks);optionSummary=calculateOptionSummary(optionRows,market.price)}}catch(error){console.error(`[ERA] Option analysis error ${index}:`,error.response?.data||error.message);optionSummary=null}const movement=movementFromPrevious(index,market.price);let signal="NONE";if(movement.significant){if(movement.direction==="UP")signal="BUY";else if(movement.direction==="DOWN")signal="SELL"}const confidenceData=calculateConfidence(market,technical,movement,optionSummary);const trades=createOptionTrades(index,market,movement,confidenceData,optionRows);return{index,available:true,market,candles:{interval:5,count:candles.length,latest:candles.length?candles[candles.length-1]:null,source:candles.length?"upstox-v3":"none"},movement,technical,options:{expiry,summary:optionSummary,rows:optionRows},signal,confidence:confidenceData.confidence,reasons:confidenceData.reasons,risks:confidenceData.risks,suggestion:confidenceData.suggestion,trades,generatedAt:nowISO()}}
function tradeFingerprint(trade){return[trade.index,trade.strike,trade.optionType,trade.signal].join("|")}
async function sendPush(payload){if(!VAPID_PUBLIC_KEY||!VAPID_PRIVATE_KEY)return;const subscriptions=Array.isArray(state.pushSubscriptions)?state.pushSubscriptions:[];for(const subscription of subscriptions){try{await webpush.sendNotification(subscription,JSON.stringify(payload))}catch(error){if(error.statusCode===404||error.statusCode===410){state.pushSubscriptions=state.pushSubscriptions.filter(item=>item.endpoint!==subscription.endpoint);saveState()}}}}
async function notifyTrade(trade){if(!state.settings.notifications?.tradeSetup)return;const fingerprint=tradeFingerprint(trade);const existing=state.alerts.find(alert=>alert.fingerprint===fingerprint);const cooldownMs=Number(state.settings.notificationCooldownMs||900000);const lastSent=Number(state.notificationHistory[`trade:${fingerprint}`]||0);if(lastSent&&Date.now()-lastSent<cooldownMs)return;if(existing&&existing.confidence===trade.confidence&&lastSent)return;state.notificationHistory[`trade:${fingerprint}`]=Date.now();const alert={id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,type:"TRADE",fingerprint,trade,confidence:trade.confidence,createdAt:nowISO()};state.alerts.unshift(alert);state.alerts=state.alerts.slice(0,100);saveState();await sendPush({title:`Era AI — ${trade.index}`,body:`${trade.optionType} ${trade.strike} | ${trade.signal} | Confidence ${trade.confidence}%`,data:trade})}
async function notifyMarketMove(index,movement,market){if(!movement.significant)return;const bucket=Math.floor(Math.abs(movement.points)/Number(state.settings.movementThreshold));const key=`${index}|${movement.direction}|${bucket}`;if(!state.settings.notifications?.movement)return;const moveCooldownKey=`${index}:move:${movement.direction}`;const lastMoveAlert=Number(state.notificationHistory[moveCooldownKey]||0);if(Date.now()-lastMoveAlert<Number(state.settings.notificationCooldownMs||900000))return;if(state.previousSignals[`${index}:move`]===key&&lastMoveAlert)return;state.previousSignals[`${index}:move`]=key;state.notificationHistory[moveCooldownKey]=Date.now();saveState();await sendPush({title:`${index} Market Move`,body:`${movement.direction} ${Math.abs(movement.points)} points | ${round(market.price)}`,data:{index,movement,market}})}
let scannerBusy=false;
async function monitorMarketState(){if(scannerBusy)return;scannerBusy=true;try{await refreshMarketData();if(!isMarketHours()){state.lastScan=nowISO();return}for(const index of Object.keys(INDICES)){try{const analysis=await analyzeIndex(index);state.analysis[index]=analysis;await notifyMarketMove(index,analysis.movement,analysis.market);if(Array.isArray(analysis.trades)){for(const trade of analysis.trades)await notifyTrade(trade)}}catch(error){console.error(`[ERA] Analysis error ${index}:`,error.response?.data||error.message)}}state.activeTrades=Object.values(state.analysis).flatMap(item=>item?.trades||[]);state.lastScan=nowISO();state.lastSuccess=nowISO();state.lastError=null}catch(error){state.lastError={message:error.message,at:nowISO(),details:error.response?.data||null};console.error("[ERA] Scanner error:",error.response?.data||error.message)}finally{scannerBusy=false}}
async function fetchNews(){try{const query=encodeURIComponent("Nifty BankNifty Sensex stock market India");const url=`https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`;const response=await axios.get(url,{timeout:20000});const xml=response.data||"";const items=xml.match(/<item>[\s\S]*?<\/item>/g)||[];const news=items.slice(0,20).map(item=>{const title=(item.match(/<title>([\s\S]*?)<\/title>/)||[])[1];const link=(item.match(/<link>([\s\S]*?)<\/link>/)||[])[1];const pubDate=(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)||[])[1];return{title:title?title.replace(/<!\[CDATA\[/g,"").replace(/\]\]>/g,"").trim():"",link:link?link.trim():"",pubDate:pubDate?pubDate.trim():""}}).filter(item=>item.title);state.news=news;state.lastNewsFetch=nowISO();return news}catch(error){console.error("[ERA] News error:",error.message);return state.news}}
let lastPreMarketDate=null;
async function preMarketCheck(){const{weekday,hour,minute}=getIndiaTimeParts();const weekdays=["Mon","Tue","Wed","Thu","Fri"];if(!weekdays.includes(weekday))return;const total=hour*60+minute;if(total<540||total>=555)return;const dateKey=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Kolkata"});if(lastPreMarketDate===dateKey)return;lastPreMarketDate=dateKey;await sendPush({title:"Era AI — Pre-Market Watchlist",body:"Market opens at 09:15 IST. Check NIFTY, BANKNIFTY, FINNIFTY and SENSEX setup.",data:{type:"PRE_MARKET"}})}
app.get("/",(req,res)=>{res.json({ok:true,app:"Era AI",version:VERSION,status:"running",marketOpen:isMarketHours(),backend:BACKEND_URL,updatedAt:nowISO()})});
app.get("/health",(req,res)=>{res.json({ok:true,version:VERSION,engineRunning:state.engineRunning,marketOpen:isMarketHours(),lastSuccess:state.lastSuccess,lastError:state.lastError,lastScan:state.lastScan,lastNewsFetch:state.lastNewsFetch,timestamp:nowISO()})});

app.get("/api/market",async(req,res)=>{try{await refreshMarketData();res.json({ok:true,version:VERSION,market:state.market,markets:state.market,marketOpen:isMarketHours(),updatedAt:nowISO()})}catch(error){res.status(500).json({ok:false,error:error.message,market:state.market,marketOpen:isMarketHours(),updatedAt:nowISO()})}});

app.get("/api/analysis",async(req,res)=>{try{await refreshMarketData();const results={};for(const index of Object.keys(INDICES)){results[index]=await analyzeIndex(index);state.analysis[index]=results[index]}state.activeTrades=Object.values(results).flatMap(item=>item?.trades||[]);state.lastScan=nowISO();res.json({ok:true,version:VERSION,market:state.market,markets:state.market,analysis:results,indexes:results,selectedIndex:normalizeIndex(req.query.index)||"NIFTY",selected:results[normalizeIndex(req.query.index)||"NIFTY"],activeTrades:state.activeTrades,marketOpen:isMarketHours(),updatedAt:nowISO()})}catch(error){state.lastError=error.message;res.status(500).json({ok:false,error:error.message,market:state.market,analysis:state.analysis,updatedAt:nowISO()})}});

app.get("/api/options/contracts",async(req,res)=>{try{const index=normalizeIndex(req.query.index);const contracts=await fetchOptionContracts(index);res.json({ok:true,index,contracts,updatedAt:nowISO()})}catch(error){res.status(500).json({ok:false,error:error.message})}});

app.get("/api/options/chain",async(req,res)=>{try{const index=normalizeIndex(req.query.index);const expiry=req.query.expiry||null;const market=state.market[index];const chain=await fetchOptionChain(index,expiry);let rows=normalizeOptionChain(chain.data);const keys=[];for(const row of rows){if(row.call?.instrumentKey)keys.push(row.call.instrumentKey);if(row.put?.instrumentKey)keys.push(row.put.instrumentKey)}const greeks=await fetchOptionGreeks(keys);rows=mergeGreeks(rows,greeks);const spot=safeNumber(market?.price);const summary=calculateOptionSummary(rows,spot);res.json({ok:true,index,expiry:chain.expiry,spot,rows,data:rows,summary,updatedAt:nowISO()})}catch(error){res.status(500).json({ok:false,error:error.message})}});

app.get("/api/options/greeks",async(req,res)=>{try{const raw=String(req.query.instrumentKeys||req.query.instrument_key||"");const keys=raw.split(",").map(x=>x.trim()).filter(Boolean);const data=await fetchOptionGreeks(keys);res.json({ok:true,data,updatedAt:nowISO()})}catch(error){res.status(500).json({ok:false,error:error.message})}});

app.get("/api/news",async(req,res)=>{try{const news=await fetchNews();res.json({ok:true,news,updatedAt:nowISO()})}catch(error){res.status(500).json({ok:false,news:state.news,error:error.message})}});

app.post("/api/chat",async(req,res)=>{try{if(!OPENROUTER_API_KEY)return res.status(503).json({ok:false,error:"OPENROUTER_API_KEY is not configured"});const message=String(req.body?.message||"").trim();if(!message)return res.status(400).json({ok:false,error:"Message is required"});const systemPrompt=`You are Era AI, a premium Indian stock-market assistant.
Use the supplied market and analysis data.
Never invent live prices.
If data is unavailable or insufficient,
say WAIT / DATA UNAVAILABLE.
For trade setups use:
Direction
Entry
Stop Loss
Targets
Risk Reward
Status
Confirmations
Reasons
Invalidation
Do not claim certainty.`;const userContext={market:state.market,analysis:state.analysis,message};const response=await axios.post("https://openrouter.ai/api/v1/chat/completions",{model:OPENROUTER_MODEL,messages:[{role:"system",content:systemPrompt},{role:"user",content:JSON.stringify(userContext)}],temperature:0.2},{timeout:30000,headers:{Authorization:`Bearer ${OPENROUTER_API_KEY}`,"Content-Type":"application/json","HTTP-Referer":BACKEND_URL,"X-Title":"Era AI"}});const answer=response.data?.choices?.[0]?.message?.content||"No response.";res.json({ok:true,answer})}catch(error){console.error("[ERA] Chat error:",error.response?.data||error.message);res.status(500).json({ok:false,error:error.response?.data||error.message})}});

app.post("/api/tts",(req,res)=>{res.status(410).json({ok:false,error:"TTS endpoint is currently disabled"})});

app.get("/api/settings",(req,res)=>{res.json({ok:true,settings:state.settings})});

app.post("/api/settings",(req,res)=>{try{const body=req.body||{};if(body.movementThreshold!==undefined){const value=Number(body.movementThreshold);if(Number.isFinite(value)&&value>0)state.settings.movementThreshold=value}if(body.notificationCooldownMs!==undefined){const value=Number(body.notificationCooldownMs);if(Number.isFinite(value)&&value>=60000&&value<=86400000)state.settings.notificationCooldownMs=value}if(body.notifications&&typeof body.notifications==="object"){for(const key of Object.keys(state.settings.notifications)){if(body.notifications[key]!==undefined)state.settings.notifications[key]=Boolean(body.notifications[key])}}if(body.minConfidence!==undefined){const value=Number(body.minConfidence);if(Number.isFinite(value)&&value>=1&&value<=100)state.settings.minConfidence=value}saveState();res.json({ok:true,settings:state.settings})}catch(error){res.status(400).json({ok:false,error:error.message})}});

app.get("/api/history",(req,res)=>{res.json({ok:true,history:state.history})});

app.post("/api/history",(req,res)=>{try{const trade=req.body||{};const record={...trade,id:trade.id||`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,createdAt:trade.createdAt||nowISO()};state.history.unshift(record);state.history=state.history.slice(0,500);saveState();res.json({ok:true,trade:record})}catch(error){res.status(400).json({ok:false,error:error.message})}});

app.get("/api/push/public-key",(req,res)=>{res.json({ok:true,publicKey:VAPID_PUBLIC_KEY||null})});

app.post("/api/subscribe",(req,res)=>{try{const subscription=req.body?.subscription||req.body;if(!subscription||!subscription.endpoint)return res.status(400).json({ok:false,error:"Invalid subscription"});const exists=state.pushSubscriptions.some(item=>item.endpoint===subscription.endpoint);if(!exists){state.pushSubscriptions.push(subscription);saveState()}res.json({ok:true,subscribed:true,subscriptions:state.pushSubscriptions.length})}catch(error){res.status(400).json({ok:false,error:error.message})}});

app.post("/api/push/test",async(req,res)=>{try{if(!VAPID_PUBLIC_KEY||!VAPID_PRIVATE_KEY)return res.status(503).json({ok:false,error:"VAPID keys are not configured"});if(!state.pushSubscriptions.length)return res.status(400).json({ok:false,error:"No push subscriptions are registered"});await sendPush({title:"Era AI Test",body:"Push notifications are working.",data:{type:"TEST"}});res.json({ok:true,subscriptions:state.pushSubscriptions.length})}catch(error){res.status(500).json({ok:false,error:error.message})}});

app.get("/api/engine",(req,res)=>{res.json({ok:true,running:state.engineRunning,lastScan:state.lastScan,lastSuccess:state.lastSuccess,lastError:state.lastError})});

app.post("/api/engine/start",async(req,res)=>{state.engineRunning=true;try{await monitorMarketState()}catch(_){}res.json({ok:true,running:true})});

app.post("/api/engine/stop",(req,res)=>{state.engineRunning=false;res.json({ok:true,running:false})});

setInterval(async()=>{if(!state.engineRunning)return;try{await monitorMarketState()}catch(error){console.error("[ERA] Periodic scanner:",error.message)}},state.settings.scanIntervalMs);

setInterval(async()=>{try{await fetchNews()}catch(_){}},state.settings.newsIntervalMs);

setInterval(async()=>{try{await preMarketCheck()}catch(error){console.error("[ERA] Pre-market:",error.message)}},5*60*1000);

(async()=>{try{console.log(`[ERA] Starting Era AI ${VERSION}`);console.log(`[ERA] Backend: ${BACKEND_URL}`);console.log(`[ERA] Market open: ${isMarketHours()}`);await fetchNews()}catch(error){console.error("[ERA] Initial news error:",error.message)}setTimeout(async()=>{try{if(state.engineRunning)await monitorMarketState()}catch(error){console.error("[ERA] Initial scan error:",error.message)}},3000)})();

app.listen(PORT,"0.0.0.0",()=>{console.log(`Era AI ${VERSION} running on port ${PORT}`)});
