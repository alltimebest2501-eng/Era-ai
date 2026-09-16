require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const UPSTOX_BASE =
  "https://api.upstox.com/v2";

function authHeaders() {

  if (!process.env.UPSTOX_ACCESS_TOKEN) {
    throw new Error("UPSTOX_ACCESS_TOKEN is missing");
  }

  return {
    Accept: "application/json",
    Authorization:
      `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`
  };
}


/* ================= HEALTH ================= */

app.get("/", (req, res) => {

  res.json({
    app: "Era AI",
    status: "online",
    message: "Era AI backend is running"
  });

});


/* ================= OPTION CONTRACTS ================= */

app.get("/api/options/contracts", async (req, res) => {

  try {

    const instrumentKey =
      req.query.instrument_key ||
      "NSE_INDEX|Nifty 50";

    const response = await axios.get(
      `${UPSTOX_BASE}/option/contract`,
      {
        params: {
          instrument_key:
            instrumentKey
        },
        headers: authHeaders()
      }
    );

    res.json({
      success: true,
      data: response.data.data
    });

  } catch (error) {

    console.error(
      "Option contract error:",
      error.response?.data ||
      error.message
    );

    res.status(500).json({
      success: false,
      error: "Unable to fetch option contracts"
    });

  }

});


/* ================= OPTION CHAIN ================= */

app.get("/api/options/chain", async (req, res) => {

  try {

    const instrumentKey =
      req.query.instrument_key ||
      "NSE_INDEX|Nifty 50";

    const expiry =
      req.query.expiry_date;

    if (!expiry) {

      return res.status(400).json({
        success: false,
        error: "expiry_date is required"
      });

    }

    const response = await axios.get(
      `${UPSTOX_BASE}/option/chain`,
      {
        params: {
          instrument_key:
            instrumentKey,

          expiry_date:
            expiry
        },

        headers: authHeaders()
      }
    );

    res.json({
      success: true,
      data: response.data.data
    });

  } catch (error) {

    console.error(
      "Option chain error:",
      error.response?.data ||
      error.message
    );

    res.status(500).json({
      success: false,
      error: "Unable to fetch option chain"
    });

  }

});


/* ================= SERVER ================= */

app.listen(PORT, () => {

  console.log(
    `Era AI backend running on port ${PORT}`
  );

});
