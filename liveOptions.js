const axios = require("axios");

const UPSTOX_V2 = "https://api.upstox.com/v2";

const UPSTOX_ACCESS_TOKEN =
  process.env.UPSTOX_ACCESS_TOKEN || "";

/* =========================================================
   SUPPORTED OPTION INDICES
========================================================= */

const OPTION_UNDERLYINGS = [
  {
    name: "NIFTY",
    key: "NSE_INDEX|Nifty 50",
  },
  {
    name: "BANKNIFTY",
    key: "NSE_INDEX|Nifty Bank",
  },
  {
    name: "FINNIFTY",
    key: "NSE_INDEX|Nifty Fin Service",
  },
  {
    name: "SENSEX",
    key: "BSE_INDEX|SENSEX",
  },
];

/* =========================================================
   RUNTIME CACHE
========================================================= */

const optionContracts = new Map();

const liveOptionData = new Map();

let initialized = false;
let lastRefresh = null;
let lastError = null;

/* =========================================================
   HELPERS
========================================================= */

function getHeaders() {
  if (!UPSTOX_ACCESS_TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is missing"
    );
  }

  return {
    Accept: "application/json",
    Authorization:
      `Bearer ${UPSTOX_ACCESS_TOKEN}`,
  };
}

function normalizeNumber(
  value,
  fallback = null
) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

/* =========================================================
   FETCH CONTRACTS
========================================================= */

async function fetchContracts(
  underlying
) {
  const response =
    await axios.get(
      `${UPSTOX_V2}/option/contract`,
      {
        params: {
          instrument_key:
            underlying.key,
        },

        headers: getHeaders(),

        timeout: 15000,
      }
    );

  const contracts =
    Array.isArray(response?.data?.data)
      ? response.data.data
      : [];

  return contracts;
}

/* =========================================================
   NORMALIZE CONTRACT
========================================================= */

function normalizeContract(
  contract,
  underlying
) {
  return {
    underlying:
      underlying.name,

    underlyingKey:
      underlying.key,

    instrumentKey:
      contract.instrument_key ||
      contract.instrumentKey ||
      null,

    tradingSymbol:
      contract.trading_symbol ||
      contract.tradingSymbol ||
      contract.symbol ||
      null,

    expiry:
      contract.expiry ||
      contract.expiry_date ||
      contract.expiryDate ||
      null,

    strikePrice:
      normalizeNumber(
        contract.strike_price ??
          contract.strikePrice
      ),

    optionType:
      (
        contract.option_type ||
        contract.optionType ||
        ""
      ).toUpperCase(),

    lotSize:
      normalizeNumber(
        contract.lot_size ??
          contract.lotSize,
        null
      ),

    freezeQuantity:
      normalizeNumber(
        contract.freeze_quantity ??
          contract.freezeQuantity,
        null
      ),

    tickSize:
      normalizeNumber(
        contract.tick_size ??
          contract.tickSize,
        null
      ),

    raw: contract,
  };
}

/* =========================================================
   LOAD ALL CONTRACTS
========================================================= */

async function loadAllOptionContracts() {
  if (!UPSTOX_ACCESS_TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is missing"
    );
  }

  const loaded = new Map();

  for (
    const underlying of OPTION_UNDERLYINGS
  ) {
    try {
      const contracts =
        await fetchContracts(
          underlying
        );

      const normalized =
        contracts
          .map((contract) =>
            normalizeContract(
              contract,
              underlying
            )
          )
          .filter(
            (contract) =>
              contract.instrumentKey
          );

      loaded.set(
        underlying.name,
        normalized
      );

      console.log(
        `[OPTIONS] ${underlying.name}: ${normalized.length} contracts`
      );

      await sleep(100);
    } catch (error) {
      console.error(
        `[OPTIONS] ${underlying.name} contract error:`,
        error.response?.data ||
          error.message
      );

      loaded.set(
        underlying.name,
        []
      );
    }
  }

  for (const [
    name,
    contracts,
  ] of loaded.entries()) {
    optionContracts.set(
      name,
      contracts
    );
  }

  lastRefresh =
    new Date().toISOString();

  lastError = null;

  return getContractStats();
}

/* =========================================================
   CONTRACT STATS
========================================================= */

function getContractStats() {
  const stats = {};

  for (
    const underlying of OPTION_UNDERLYINGS
  ) {
    const contracts =
      optionContracts.get(
        underlying.name
      ) || [];

    stats[underlying.name] = {
      contracts:
        contracts.length,

      expiries:
        [
          ...new Set(
            contracts
              .map(
                (x) => x.expiry
              )
              .filter(Boolean)
          ),
        ].sort(),
    };
  }

  return stats;
}

/* =========================================================
   GET CONTRACTS
========================================================= */

function getContracts(
  index
) {
  const key =
    String(index || "NIFTY")
      .trim()
      .toUpperCase();

  return (
    optionContracts.get(key) ||
    []
  );
}

/* =========================================================
   GET EXPIRIES
========================================================= */

function getExpiries(
  index
) {
  const contracts =
    getContracts(index);

  return [
    ...new Set(
      contracts
        .map(
          (contract) =>
            contract.expiry
        )
        .filter(Boolean)
    ),
  ].sort();
}

/* =========================================================
   GET NEAREST EXPIRY
========================================================= */

function getNearestExpiry(
  index
) {
  const expiries =
    getExpiries(index);

  if (!expiries.length) {
    return null;
  }

  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  const future =
    expiries.filter(
      (expiry) =>
        expiry >= today
    );

  return (
    future[0] ||
    expiries[0] ||
    null
  );
}

/* =========================================================
   FILTER CONTRACTS
========================================================= */

function filterContracts({
  index = "NIFTY",
  expiry = null,
  optionType = null,
}) {
  let contracts =
    getContracts(index);

  if (expiry) {
    contracts =
      contracts.filter(
        (contract) =>
          contract.expiry ===
          expiry
      );
  }

  if (optionType) {
    const type =
      String(optionType)
        .toUpperCase();

    contracts =
      contracts.filter(
        (contract) =>
          contract.optionType ===
          type
      );
  }

  return contracts;
}

/* =========================================================
   SAVE LIVE DATA
========================================================= */

function updateLiveOption(
  instrumentKey,
  data
) {
  if (!instrumentKey) {
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

      instrumentKey,

      updatedAt:
        new Date().toISOString(),
    }
  );
}

/* =========================================================
   GET LIVE OPTION
========================================================= */

function getLiveOption(
  instrumentKey
) {
  return (
    liveOptionData.get(
      instrumentKey
    ) || null
  );
}

/* =========================================================
   GET LIVE OPTIONS
========================================================= */

function getLiveOptions({
  index = "NIFTY",
  expiry = null,
} = {}) {
  const contracts =
    filterContracts({
      index,
      expiry,
    });

  return contracts.map(
    (contract) => ({
      ...contract,

      live:
        getLiveOption(
          contract.instrumentKey
        ),
    })
  );
}

/* =========================================================
   GET STATUS
========================================================= */

function getStatus() {
  let totalContracts = 0;

  for (const contracts of optionContracts.values()) {
    totalContracts +=
      contracts.length;
  }

  return {
    initialized,

    lastRefresh,

    lastError,

    totalContracts,

    liveDataCount:
      liveOptionData.size,

    indices:
      getContractStats(),
  };
}

/* =========================================================
   INITIALIZE
========================================================= */

async function initializeLiveOptions() {
  if (initialized) {
    return getStatus();
  }

  try {
    console.log(
      "[OPTIONS] Initializing option contracts..."
    );

    initialized = false;

    await loadAllOptionContracts();

    initialized = true;

    console.log(
      "[OPTIONS] Option contracts initialized."
    );

    return getStatus();
  } catch (error) {
    initialized = false;

    lastError =
      error.message;

    console.error(
      "[OPTIONS] Initialization failed:",
      error.response?.data ||
        error.message
    );

    throw error;
  }
}

/* =========================================================
   REFRESH
========================================================= */

async function refreshOptionContracts() {
  try {
    console.log(
      "[OPTIONS] Refreshing contracts..."
    );

    await loadAllOptionContracts();

    console.log(
      "[OPTIONS] Contracts refreshed."
    );

    return getStatus();
  } catch (error) {
    lastError =
      error.message;

    console.error(
      "[OPTIONS] Refresh failed:",
      error.response?.data ||
        error.message
    );

    return getStatus();
  }
}

/* =========================================================
   AUTO REFRESH
========================================================= */

let refreshTimer = null;

function startOptionRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  refreshTimer =
    setInterval(
      refreshOptionContracts,
      30 * 60 * 1000
    );

  console.log(
    "[OPTIONS] Auto-refresh enabled: 30 minutes"
  );
}

function stopOptionRefresh() {
  if (refreshTimer) {
    clearInterval(
      refreshTimer
    );

    refreshTimer = null;
  }
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  OPTION_UNDERLYINGS,

  initializeLiveOptions,

  refreshOptionContracts,

  startOptionRefresh,

  stopOptionRefresh,

  loadAllOptionContracts,

  getContracts,

  getExpiries,

  getNearestExpiry,

  filterContracts,

  updateLiveOption,

  getLiveOption,

  getLiveOptions,

  getContractStats,

  getStatus,
};
