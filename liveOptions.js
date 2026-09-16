const axios = require("axios");
const UpstoxClient = require("upstox-js-sdk");

const UPSTOX_BASE = "https://api.upstox.com/v2";

const OPTION_UNDERLYINGS = [
  {
    name: "NIFTY",
    key: "NSE_INDEX|Nifty 50"
  },
  {
    name: "BANKNIFTY",
    key: "NSE_INDEX|Nifty Bank"
  },
  {
    name: "FINNIFTY",
    key: "NSE_INDEX|Nifty Fin Service"
  },
  {
    name: "SENSEX",
    key: "BSE_INDEX|SENSEX"
  }
];

/*
  Upstox V3 normal limits:
  LTPC      : 5000 individual
  Greeks    : 3000 individual
  Full      : 2000 individual

  We keep these configurable so the backend
  never blindly sends an oversized subscription.
*/

const LTPC_LIMIT = 5000;
const GREEKS_LIMIT = 3000;

const optionContracts = new Map();
const liveOptions = new Map();

let streamer = null;
let greeksStreamer = null;

let initialized = false;

function authHeaders() {
  return {
    Authorization:
      `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`,
    Accept: "application/json"
  };
}

/* -------------------------------------------------------
   FETCH ALL CURRENT CONTRACTS
------------------------------------------------------- */

async function fetchAllOptionContracts() {
  const all = [];

  for (const underlying of OPTION_UNDERLYINGS) {
    try {
      console.log(
        `[OPTIONS] Loading contracts: ${underlying.name}`
      );

      const response = await axios.get(
        `${UPSTOX_BASE}/option/contract`,
        {
          params: {
            instrument_key: underlying.key
          },
          headers: authHeaders(),
          timeout: 20000
        }
      );

      const rows =
        response.data?.data || [];

      for (const contract of rows) {
        if (
          !contract.instrument_key ||
          !contract.instrument_type
        ) {
          continue;
        }

        if (
          contract.instrument_type !== "CE" &&
          contract.instrument_type !== "PE"
        ) {
          continue;
        }

        const normalized = {
          ...contract,
          underlying_name:
            underlying.name,
          underlying_key:
            underlying.key
        };

        optionContracts.set(
          contract.instrument_key,
          normalized
        );

        all.push(normalized);
      }

      console.log(
        `[OPTIONS] ${underlying.name}: ${rows.length} contracts`
      );

    } catch (error) {
      console.error(
        `[OPTIONS] Failed loading ${underlying.name}:`,
        error.response?.data ||
        error.message
      );
    }
  }

  console.log(
    `[OPTIONS] TOTAL CONTRACTS DISCOVERED: ${optionContracts.size}`
  );

  return all;
}

/* -------------------------------------------------------
   SAVE LIVE TICK
------------------------------------------------------- */

function updateLiveOption(instrumentKey, patch) {
  const old =
    liveOptions.get(instrumentKey) || {};

  const updated = {
    ...old,
    ...patch,
    instrument_key: instrumentKey,
    updated_at:
      new Date().toISOString()
  };

  liveOptions.set(
    instrumentKey,
    updated
  );
}

/* -------------------------------------------------------
   DECODE UPSTOX MESSAGE
------------------------------------------------------- */

function decodeMessage(data) {
  try {
    if (Buffer.isBuffer(data)) {
      const text =
        data.toString("utf8");

      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }

    if (typeof data === "string") {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }

    if (data && typeof data === "object") {
      return data;
    }

    return null;

  } catch {
    return null;
  }
}

/* -------------------------------------------------------
   EXTRACT COMMON MARKET VALUES
------------------------------------------------------- */

function extractMarketData(feed) {
  const market =
    feed?.marketFF ||
    feed?.marketFullFeed ||
    feed?.market_full_feed ||
    feed?.market ||
    {};

  const ltpc =
    feed?.ltpc ||
    market?.ltpc ||
    {};

  const ohlc =
    market?.ohlc ||
    {};

  return {
    ltp:
      ltpc?.ltp ??
      market?.ltp ??
      null,

    volume:
      market?.vtt ??
      market?.volume ??
      null,

    oi:
      market?.oi ??
      null,

    oi_change:
      market?.oi_change ??
      market?.oiChange ??
      null,

    bid:
      market?.bid_price ??
      market?.bid ??
      null,

    ask:
      market?.ask_price ??
      market?.ask ??
      null,

    open:
      ohlc?.open ??
      null,

    high:
      ohlc?.high ??
      null,

    low:
      ohlc?.low ??
      null,

    close:
      ohlc?.close ??
      null
  };
}

/* -------------------------------------------------------
   START LTPC STREAM
------------------------------------------------------- */

function startLTPCStreamer(instrumentKeys) {
  if (!instrumentKeys.length) {
    console.log(
      "[OPTIONS] No option instruments for LTPC."
    );
    return;
  }

  const keys =
    instrumentKeys.slice(
      0,
      LTPC_LIMIT
    );

  console.log(
    `[OPTIONS] Starting LTPC WebSocket for ${keys.length} contracts`
  );

  const defaultClient =
    UpstoxClient.ApiClient.instance;

  const oauth =
    defaultClient.authentications["OAUTH2"];

  oauth.accessToken =
    process.env.UPSTOX_ACCESS_TOKEN;

  streamer =
    new UpstoxClient.MarketDataStreamerV3();

  streamer.autoReconnect(
    true,
    10,
    999999
  );

  streamer.on("open", () => {
    console.log(
      "[OPTIONS] LTPC WebSocket connected"
    );

    /*
      Subscribe all discovered contracts
      up to Upstox's LTPC limit.
    */

    streamer.subscribe(
      keys,
      "ltpc"
    );

    console.log(
      `[OPTIONS] LTPC subscribed: ${keys.length}`
    );
  });

  streamer.on("message", data => {
    const decoded =
      decodeMessage(data);

    if (!decoded) {
      return;
    }

    /*
      Depending on SDK/feed format,
      instrument feeds can be nested.
    */

    const feeds =
      decoded.feeds ||
      decoded.data ||
      decoded;

    if (
      !feeds ||
      typeof feeds !== "object"
    ) {
      return;
    }

    for (
      const [instrumentKey, feed]
      of Object.entries(feeds)
    ) {
      const market =
        extractMarketData(feed);

      updateLiveOption(
        instrumentKey,
        market
      );
    }
  });

  streamer.on("error", error => {
    console.error(
      "[OPTIONS] LTPC WebSocket error:",
      error
    );
  });

  streamer.on("close", () => {
    console.log(
      "[OPTIONS] LTPC WebSocket closed"
    );
  });

  streamer.on(
    "reconnecting",
    () => {
      console.log(
        "[OPTIONS] LTPC reconnecting..."
      );
    }
  );

  streamer.connect();
}

/* -------------------------------------------------------
   START GREEKS STREAM
------------------------------------------------------- */

function startGreeksStreamer(instrumentKeys) {
  if (!instrumentKeys.length) {
    console.log(
      "[OPTIONS] No option instruments for Greeks."
    );
    return;
  }

  const keys =
    instrumentKeys.slice(
      0,
      GREEKS_LIMIT
    );

  console.log(
    `[OPTIONS] Starting Greeks WebSocket for ${keys.length} contracts`
  );

  const defaultClient =
    UpstoxClient.ApiClient.instance;

  const oauth =
    defaultClient.authentications["OAUTH2"];

  oauth.accessToken =
    process.env.UPSTOX_ACCESS_TOKEN;

  greeksStreamer =
    new UpstoxClient.MarketDataStreamerV3();

  greeksStreamer.autoReconnect(
    true,
    10,
    999999
  );

  greeksStreamer.on("open", () => {
    console.log(
      "[OPTIONS] Greeks WebSocket connected"
    );

    greeksStreamer.subscribe(
      keys,
      "option_greeks"
    );

    console.log(
      `[OPTIONS] Greeks subscribed: ${keys.length}`
    );
  });

  greeksStreamer.on(
    "message",
    data => {
      const decoded =
        decodeMessage(data);

      if (!decoded) {
        return;
      }

      const feeds =
        decoded.feeds ||
        decoded.data ||
        decoded;

      if (
        !feeds ||
        typeof feeds !== "object"
      ) {
        return;
      }

      for (
        const [instrumentKey, feed]
        of Object.entries(feeds)
      ) {
        const greeks =
          feed?.optionGreeks ||
          feed?.option_greeks ||
          feed?.greeks ||
          feed;

        if (
          greeks &&
          typeof greeks === "object"
        ) {
          updateLiveOption(
            instrumentKey,
            {
              iv:
                greeks.iv ??
                greeks.implied_volatility ??
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
                null
            }
          );
        }
      }
    }
  );

  greeksStreamer.on(
    "error",
    error => {
      console.error(
        "[OPTIONS] Greeks WebSocket error:",
        error
      );
    }
  );

  greeksStreamer.on(
    "close",
    () => {
      console.log(
        "[OPTIONS] Greeks WebSocket closed"
      );
    }
  );

  greeksStreamer.connect();
}

/* -------------------------------------------------------
   INITIALIZE EVERYTHING
------------------------------------------------------- */

async function initializeLiveOptions() {
  if (initialized) {
    return;
  }

  if (
    !process.env.UPSTOX_ACCESS_TOKEN
  ) {
    console.error(
      "[OPTIONS] UPSTOX_ACCESS_TOKEN missing."
    );

    return;
  }

  initialized = true;

  try {
    const contracts =
      await fetchAllOptionContracts();

    const instrumentKeys =
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

    console.log(
      `[OPTIONS] Unique option contracts: ${instrumentKeys.length}`
    );

    /*
      LTPC:
      up to 5000 contracts
    */

    startLTPCStreamer(
      instrumentKeys
    );

    /*
      Greeks:
      up to 3000 contracts
    */

    startGreeksStreamer(
      instrumentKeys
    );

  } catch (error) {
    initialized = false;

    console.error(
      "[OPTIONS] Initialization failed:",
      error
    );
  }
}

/* -------------------------------------------------------
   REFRESH CONTRACT LIST
------------------------------------------------------- */

async function refreshLiveOptions() {
  try {
    console.log(
      "[OPTIONS] Refreshing contract list..."
    );

    const contracts =
      await fetchAllOptionContracts();

    return contracts.length;

  } catch (error) {
    console.error(
      "[OPTIONS] Contract refresh error:",
      error
    );

    return 0;
  }
}

/*
  Refresh contract metadata every 30 minutes.
  This catches newly listed/rolled contracts.
*/

setInterval(
  () => {
    refreshLiveOptions()
      .catch(console.error);
  },
  30 * 60 * 1000
);

/* -------------------------------------------------------
   GETTERS
------------------------------------------------------- */

function getLiveOption(
  instrumentKey
) {
  return (
    liveOptions.get(
      instrumentKey
    ) || null
  );
}

function getAllLiveOptions() {
  const result = [];

  for (
    const [instrumentKey, live]
    of liveOptions.entries()
  ) {
    const contract =
      optionContracts.get(
        instrumentKey
      );

    result.push({
      ...(contract || {}),
      ...(live || {})
    });
  }

  return result;
}

function getContracts() {
  return [
    ...optionContracts.values()
  ];
}

function getOptionStats() {
  return {
    contracts_discovered:
      optionContracts.size,

    live_contracts:
      liveOptions.size,

    nifty:
      optionCount(
        "NSE_INDEX|Nifty 50"
      ),

    banknifty:
      optionCount(
        "NSE_INDEX|Nifty Bank"
      ),

    finnifty:
      optionCount(
        "NSE_INDEX|Nifty Fin Service"
      ),

    sensex:
      optionCount(
        "BSE_INDEX|SENSEX"
      )
  };
}

function optionCount(
  underlyingKey
) {
  let count = 0;

  for (
    const contract
    of optionContracts.values()
  ) {
    if (
      contract.underlying_key ===
      underlyingKey
    ) {
      count++;
    }
  }

  return count;
}

module.exports = {
  initializeLiveOptions,
  refreshLiveOptions,
  getLiveOption,
  getAllLiveOptions,
  getContracts,
  getOptionStats
};
