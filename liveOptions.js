"use strict";

/*
=========================================================
ERA AI V6 — LIVE OPTIONS ENGINE
=========================================================

Supported:
- NIFTY
- BANKNIFTY
- FINNIFTY
- SENSEX

Features:
- Live option contracts
- Expiry discovery
- CE / PE
- Strike prices
- LTP
- OI
- Change OI
- Volume
- IV
- Greeks
- ATM detection
- Nearby strike scanning
- PCR
- Option-side comparison
- Autonomous scanner helpers
=========================================================
*/

const axios = require("axios");

const UPSTOX_ACCESS_TOKEN =
  process.env.UPSTOX_ACCESS_TOKEN || "";

const UPSTOX_BASE_URL =
  "https://api.upstox.com";

/* =========================================================
   INDEX CONFIG
   ========================================================= */

const INDEX_CONFIG = {
  NIFTY: {
    name: "NIFTY",
    instrumentKey: "NSE_INDEX|Nifty 50",
    exchange: "NSE"
  },

  BANKNIFTY: {
    name: "BANKNIFTY",
    instrumentKey: "NSE_INDEX|Nifty Bank",
    exchange: "NSE"
  },

  FINNIFTY: {
    name: "FINNIFTY",
    instrumentKey: "NSE_INDEX|Nifty Fin Service",
    exchange: "NSE"
  },

  SENSEX: {
    name: "SENSEX",
    instrumentKey: "BSE_INDEX|SENSEX",
    exchange: "BSE"
  }
};

/* =========================================================
   HELPERS
   ========================================================= */

function normalizeIndex(index) {
  const key = String(index || "NIFTY")
    .trim()
    .toUpperCase();

  if (!INDEX_CONFIG[key]) {
    throw new Error(
      `Unsupported index: ${index}`
    );
  }

  return key;
}

function num(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function round(value, decimals = 2) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return null;
  }

  const factor =
    Math.pow(10, decimals);

  return (
    Math.round(
      Number(value) * factor
    ) / factor
  );
}

function uniqueSorted(values) {
  return [
    ...new Set(
      values
        .filter(
          (v) =>
            v !== null &&
            v !== undefined &&
            v !== ""
        )
        .map(String)
    )
  ].sort();
}

/* =========================================================
   UPSTOX REQUEST
   ========================================================= */

async function upstoxGet(
  endpoint,
  params = {}
) {
  if (!UPSTOX_ACCESS_TOKEN) {
    throw new Error(
      "UPSTOX_ACCESS_TOKEN is not configured"
    );
  }

  const response =
    await axios.get(
      `${UPSTOX_BASE_URL}${endpoint}`,
      {
        params,
        timeout: 15000,

        headers: {
          Accept:
            "application/json",

          Authorization:
            `Bearer ${UPSTOX_ACCESS_TOKEN}`
        }
      }
    );

  return response.data;
}

/* =========================================================
   OPTION CONTRACTS
   ========================================================= */

async function getOptionContracts(
  index
) {
  const key =
    normalizeIndex(index);

  const config =
    INDEX_CONFIG[key];

  const data =
    await upstoxGet(
      "/v2/option/contract",
      {
        instrument_key:
          config.instrumentKey
      }
    );

  return Array.isArray(data?.data)
    ? data.data
    : [];
}

/* =========================================================
   CONTRACT NORMALIZER
   ========================================================= */

function normalizeContract(
  contract,
  index
) {
  const optionType =
    String(
      contract.option_type ??
      contract.optionType ??
      contract.instrument_type ??
      contract.instrumentType ??
      ""
    ).toUpperCase();

  const strikePrice =
    contract.strike_price ??
    contract.strikePrice ??
    contract.strike ??
    null;

  const expiry =
    contract.expiry ??
    contract.expiry_date ??
    contract.expiryDate ??
    null;

  return {
    index,

    instrumentKey:
      contract.instrument_key ??
      contract.instrumentKey ??
      null,

    tradingSymbol:
      contract.trading_symbol ??
      contract.tradingSymbol ??
      contract.tradingsymbol ??
      null,

    optionType:
      optionType === "CALL"
        ? "CE"
        : optionType === "PUT"
        ? "PE"
        : optionType,

    strikePrice:
      round(num(strikePrice)),

    expiry,

    lotSize:
      num(
        contract.lot_size ??
        contract.lotSize
      ),

    tickSize:
      num(
        contract.tick_size ??
        contract.tickSize
      ),

    underlyingKey:
      contract.underlying_key ??
      contract.underlyingKey ??
      INDEX_CONFIG[index]
        .instrumentKey
  };
}

/* =========================================================
   NORMALIZED CONTRACT LIST
   ========================================================= */

async function getNormalizedContracts(
  index
) {
  const key =
    normalizeIndex(index);

  const contracts =
    await getOptionContracts(key);

  return contracts
    .map(
      (contract) =>
        normalizeContract(
          contract,
          key
        )
    )
    .filter(
      (contract) =>
        contract.instrumentKey &&
        contract.strikePrice
    );
}

/* =========================================================
   EXPIRIES
   ========================================================= */

async function getExpiries(
  index
) {
  const contracts =
    await getNormalizedContracts(
      index
    );

  return uniqueSorted(
    contracts.map(
      (contract) =>
        contract.expiry
    )
  );
}

/* =========================================================
   OPTION CHAIN
   ========================================================= */

async function getOptionChain(
  index,
  expiry = null
) {
  const key =
    normalizeIndex(index);

  const config =
    INDEX_CONFIG[key];

  const params = {
    instrument_key:
      config.instrumentKey
  };

  if (expiry) {
    params.expiry_date =
      expiry;
  }

  const data =
    await upstoxGet(
      "/v2/option/chain",
      params
    );

  return Array.isArray(data?.data)
    ? data.data
    : [];
}

/* =========================================================
   MARKET DATA EXTRACTION
   ========================================================= */

function extractMarketData(
  option
) {
  const market =
    option?.market_data ??
    option?.marketData ??
    option ??
    {};

  const greeks =
    option?.option_greeks ??
    option?.optionGreeks ??
    option?.greeks ??
    {};

  return {
    ltp: round(
      num(
        market.ltp ??
        market.last_price ??
        market.lastPrice
      )
    ),

    closePrice: round(
      num(
        market.close_price ??
        market.closePrice
      )
    ),

    volume: num(
      market.volume
    ),

    oi: num(
      market.oi ??
      market.open_interest ??
      market.openInterest
    ),

    changeOi: num(
      market.change_in_oi ??
      market.changeOi ??
      market.oi_change ??
      market.oiChange
    ),

    bidPrice: round(
      num(
        market.bid_price ??
        market.bidPrice
      )
    ),

    askPrice: round(
      num(
        market.ask_price ??
        market.askPrice
      )
    ),

    iv: round(
      num(
        market.iv ??
        market.implied_volatility ??
        market.impliedVolatility
      )
    ),

    delta: round(
      num(
        greeks.delta
      ),
      4
    ),

    gamma: round(
      num(
        greeks.gamma
      ),
      6
    ),

    theta: round(
      num(
        greeks.theta
      ),
      4
    ),

    vega: round(
      num(
        greeks.vega
      ),
      4
    ),

    rho: round(
      num(
        greeks.rho
      ),
      4
    )
  };
}

/* =========================================================
   CHAIN NORMALIZATION
   ========================================================= */

function normalizeChain(
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

    if (
      strike === null ||
      strike === undefined
    ) {
      continue;
    }

    const call =
      item.call_options ??
      item.callOptions ??
      item.CE ??
      item.ce ??
      item.call ??
      null;

    const put =
      item.put_options ??
      item.putOptions ??
      item.PE ??
      item.pe ??
      item.put ??
      null;

    const ce =
      call
        ? {
            instrumentKey:
              call.instrument_key ??
              call.instrumentKey ??
              null,

            tradingSymbol:
              call.trading_symbol ??
              call.tradingSymbol ??
              null,

            data:
              extractMarketData(
                call
              )
          }
        : null;

    const pe =
      put
        ? {
            instrumentKey:
              put.instrument_key ??
              put.instrumentKey ??
              null,

            tradingSymbol:
              put.trading_symbol ??
              put.tradingSymbol ??
              null,

            data:
              extractMarketData(
                put
              )
          }
        : null;

    rows.push({
      index,

      strikePrice:
        round(num(strike)),

      expiry:
        item.expiry ??
        item.expiry_date ??
        item.expiryDate ??
        null,

      underlyingSpot:
        round(
          num(
            item.underlying_spot_price ??
            item.underlyingSpotPrice ??
            item.underlying_value
          )
        ),

      CE: ce,
      PE: pe
    });
  }

  return rows.sort(
    (a, b) =>
      a.strikePrice -
      b.strikePrice
  );
}

/* =========================================================
   ATM STRIKE
   ========================================================= */

function findATM(
  chain,
  spot
) {
  if (
    !chain.length ||
    !spot
  ) {
    return null;
  }

  return chain.reduce(
    (closest, row) => {
      if (!closest) {
        return row;
      }

      const currentDistance =
        Math.abs(
          row.strikePrice -
          spot
        );

      const closestDistance =
        Math.abs(
          closest.strikePrice -
          spot
        );

      return currentDistance <
        closestDistance
        ? row
        : closest;
    },
    null
  );
}

/* =========================================================
   NEARBY STRIKES
   ========================================================= */

function getNearbyStrikes(
  chain,
  spot,
  count = 9
) {
  if (
    !chain.length ||
    !spot
  ) {
    return [];
  }

  return [
    ...chain
  ]
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
    )
    .sort(
      (a, b) =>
        a.strikePrice -
        b.strikePrice
    );
}

/* =========================================================
   PCR
   ========================================================= */

function calculatePCR(
  chain
) {
  let callOI = 0;
  let putOI = 0;

  for (
    const row of chain
  ) {
    callOI += num(
      row.CE?.data?.oi
    );

    putOI += num(
      row.PE?.data?.oi
    );
  }

  const pcr =
    callOI > 0
      ? putOI / callOI
      : null;

  let sentiment =
    "NEUTRAL";

  if (
    pcr !== null
  ) {
    if (pcr >= 1.05) {
      sentiment =
        "BULLISH";
    } else if (
      pcr <= 0.80
    ) {
      sentiment =
        "BEARISH";
    }
  }

  return {
    callOI,
    putOI,
    pcr:
      pcr === null
        ? null
        : round(pcr, 3),

    sentiment
  };
}

/* =========================================================
   MAX OI LEVELS
   ========================================================= */

function findOILevels(
  chain
) {
  let maxCall = null;
  let maxPut = null;

  for (
    const row of chain
  ) {
    const callOI =
      num(
        row.CE?.data?.oi
      );

    const putOI =
      num(
        row.PE?.data?.oi
      );

    if (
      !maxCall ||
      callOI >
        maxCall.oi
    ) {
      maxCall = {
        strike:
          row.strikePrice,
        oi: callOI
      };
    }

    if (
      !maxPut ||
      putOI >
        maxPut.oi
    ) {
      maxPut = {
        strike:
          row.strikePrice,
        oi: putOI
      };
    }
  }

  return {
    highestCallOI:
      maxCall,

    highestPutOI:
      maxPut
  };
}

/* =========================================================
   OPTION PRESSURE
   ========================================================= */

function calculateOptionPressure(
  row
) {
  const ce =
    row.CE?.data || {};

  const pe =
    row.PE?.data || {};

  let score = 0;

  if (
    ce.ltp &&
    ce.volume
  ) {
    score += 1;
  }

  if (
    pe.ltp &&
    pe.volume
  ) {
    score -= 1;
  }

  if (
    ce.changeOi > 0 &&
    ce.ltp > ce.closePrice
  ) {
    score += 2;
  }

  if (
    pe.changeOi > 0 &&
    pe.ltp > pe.closePrice
  ) {
    score -= 2;
  }

  let bias =
    "NEUTRAL";

  if (score >= 2) {
    bias =
      "CALL_SUPPORT";
  }

  if (score <= -2) {
    bias =
      "PUT_SUPPORT";
  }

  return {
    score,
    bias
  };
}

/* =========================================================
   STRIKE SCORING
   ========================================================= */

function scoreStrike(
  row,
  spot,
  direction
) {
  const optionType =
    direction === "BUY"
      ? "CE"
      : "PE";

  const option =
    row[optionType];

  if (!option) {
    return null;
  }

  const data =
    option.data || {};

  let score = 0;

  const distance =
    Math.abs(
      row.strikePrice -
      spot
    );

  /*
   * Prefer ATM / nearby strikes.
   */
  if (
    distance <=
    Math.max(
      50,
      spot * 0.002
    )
  ) {
    score += 20;
  } else if (
    distance <=
    Math.max(
      100,
      spot * 0.004
    )
  ) {
    score += 12;
  } else {
    score += 5;
  }

  if (
    data.volume > 0
  ) {
    score += 10;
  }

  if (
    data.oi > 0
  ) {
    score += 10;
  }

  if (
    data.changeOi > 0
  ) {
    score += 5;
  }

  if (
    data.ltp > 0
  ) {
    score += 10;
  }

  return {
    score:
      Math.min(
        score,
        55
      ),

    strike:
      row.strikePrice,

    optionType,

    instrumentKey:
      option.instrumentKey,

    tradingSymbol:
      option.tradingSymbol,

    ltp:
      data.ltp,

    oi:
      data.oi,

    changeOi:
      data.changeOi,

    volume:
      data.volume,

    iv:
      data.iv,

    greeks: {
      delta:
        data.delta,

      gamma:
        data.gamma,

      theta:
        data.theta,

      vega:
        data.vega,

      rho:
        data.rho
    }
  };
}

/* =========================================================
   BEST STRIKES
   ========================================================= */

function findBestStrikes(
  chain,
  spot,
  direction
) {
  return chain
    .map(
      (row) =>
        scoreStrike(
          row,
          spot,
          direction
        )
    )
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.score -
        a.score
    );
}

/* =========================================================
   FULL OPTION SNAPSHOT
   ========================================================= */

async function getOptionSnapshot(
  index,
  expiry = null,
  spot = null
) {
  const key =
    normalizeIndex(index);

  const rawChain =
    await getOptionChain(
      key,
      expiry
    );

  const chain =
    normalizeChain(
      rawChain,
      key
    );

  let underlyingSpot =
    spot;

  if (
    !underlyingSpot &&
    chain.length
  ) {
    underlyingSpot =
      chain.find(
        (row) =>
          row.underlyingSpot
      )
        ?.underlyingSpot ||
      null;
  }

  const atm =
    findATM(
      chain,
      underlyingSpot
    );

  const nearby =
    getNearbyStrikes(
      chain,
      underlyingSpot,
      11
    );

  const pcr =
    calculatePCR(
      chain
    );

  const oiLevels =
    findOILevels(
      chain
    );

  const callCandidates =
    findBestStrikes(
      nearby,
      underlyingSpot,
      "BUY"
    );

  const putCandidates =
    findBestStrikes(
      nearby,
      underlyingSpot,
      "SELL"
    );

  return {
    index: key,

    expiry,

    spot:
      underlyingSpot,

    atmStrike:
      atm?.strikePrice ||
      null,

    pcr,

    oiLevels,

    chain,

    nearbyStrikes:
      nearby,

    scanner: {
      callCandidates,
      putCandidates
    },

    generatedAt:
      new Date().toISOString()
  };
}

/* =========================================================
   AUTONOMOUS OPTION SCAN
   ========================================================= */

async function scanOptionSetups({
  index,
  expiry = null,
  spot,
  marketDirection = null,
  minimumScore = 20
}) {
  const snapshot =
    await getOptionSnapshot(
      index,
      expiry,
      spot
    );

  const results = [];

  if (
    !snapshot.spot
  ) {
    return {
      ...snapshot,
      setups: []
    };
  }

  /*
   * Scan BOTH sides.
   *
   * Even if underlying market is moving UP,
   * Era still checks PE for reversal/opposite setups.
   */
  const callCandidates =
    findBestStrikes(
      snapshot.nearbyStrikes,
      snapshot.spot,
      "BUY"
    );

  const putCandidates =
    findBestStrikes(
      snapshot.nearbyStrikes,
      snapshot.spot,
      "SELL"
    );

  for (
    const candidate of
      callCandidates
  ) {
    if (
      candidate.score >=
      minimumScore
    ) {
      results.push({
        index,

        strikePrice:
          candidate.strike,

        optionType:
          "CE",

        signal:
          "BUY",

        score:
          candidate.score,

        entry:
          candidate.ltp,

        oi:
          candidate.oi,

        changeOi:
          candidate.changeOi,

        volume:
          candidate.volume,

        iv:
          candidate.iv,

        greeks:
          candidate.greeks,

        tradingSymbol:
          candidate.tradingSymbol,

        instrumentKey:
          candidate.instrumentKey
      });
    }
  }

  for (
    const candidate of
      putCandidates
  ) {
    if (
      candidate.score >=
      minimumScore
    ) {
      results.push({
        index,

        strikePrice:
          candidate.strike,

        optionType:
          "PE",

        signal:
          "BUY",

        score:
          candidate.score,

        entry:
          candidate.ltp,

        oi:
          candidate.oi,

        changeOi:
          candidate.changeOi,

        volume:
          candidate.volume,

        iv:
          candidate.iv,

        greeks:
          candidate.greeks,

        tradingSymbol:
          candidate.tradingSymbol,

        instrumentKey:
          candidate.instrumentKey
      });
    }
  }

  /*
   * Highest-quality setups first,
   * but keep multiple qualifying setups.
   */
  results.sort(
    (a, b) =>
      b.score -
      a.score
  );

  return {
    ...snapshot,

    marketDirection,

    setups:
      results
  };
}

/* =========================================================
   OPTION EXPIRY + CHAIN API HELPER
   ========================================================= */

async function getOptionData(
  index,
  expiry = null,
  spot = null
) {
  const key =
    normalizeIndex(index);

  let selectedExpiry =
    expiry;

  const expiries =
    await getExpiries(
      key
    );

  if (
    !selectedExpiry &&
    expiries.length
  ) {
    selectedExpiry =
      expiries[0];
  }

  const snapshot =
    await getOptionSnapshot(
      key,
      selectedExpiry,
      spot
    );

  return {
    ...snapshot,

    availableExpiries:
      expiries,

    selectedExpiry
  };
}

/* =========================================================
   EXPORTS
   ========================================================= */

module.exports = {
  INDEX_CONFIG,

  normalizeIndex,

  getOptionContracts,

  getNormalizedContracts,

  getExpiries,

  getOptionChain,

  normalizeChain,

  findATM,

  getNearbyStrikes,

  calculatePCR,

  findOILevels,

  getOptionSnapshot,

  scanOptionSetups,

  getOptionData
};
