require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const UPSTOX_BASE =
  "https://api.upstox.com";

const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";


/* =====================================================
   UPSTOX AUTH
===================================================== */

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


/* =====================================================
   HEALTH
===================================================== */

app.get("/", (req, res) => {

  res.json({
    app: "Era AI",
    status: "online",
    message: "Era AI backend is running"
  });

});


/* =====================================================
   LIVE MARKET DATA
===================================================== */

async function getLiveMarketData() {

  try {

    const instrumentKeys = [
      "NSE_INDEX|Nifty 50",
      "NSE_INDEX|India VIX",
      "GLOBAL_INDEX|SGX NIFTY"
    ].join(",");


    const response = await axios.get(
      `${UPSTOX_BASE}/v3/market-quote/quotes`,
      {
        params: {
          instrument_key: instrumentKeys
        },

        headers: authHeaders(),

        timeout: 15000
      }
    );


    const data =
      response.data?.data || {};


    const nifty =
      data["NSE_INDEX:Nifty 50"] || {};

    const vix =
      data["NSE_INDEX:India VIX"] || {};

    const gift =
      data["GLOBAL_INDEX:SGX NIFTY"] || {};


    return {

      success: true,

      timestamp:
        new Date().toISOString(),

      nifty: {

        lastPrice:
          nifty.last_price ?? null,

        netChange:
          nifty.net_change ?? null,

        ohlc:
          nifty.ohlc || {},

        previousClose:
          nifty.prev_close_price ??
          nifty.ohlc?.close ??
          null,

        volume:
          nifty.volume ?? null

      },

      indiaVix: {

        lastPrice:
          vix.last_price ?? null,

        netChange:
          vix.net_change ?? null,

        previousClose:
          vix.prev_close_price ??
          vix.ohlc?.close ??
          null

      },

      giftNifty: {

        lastPrice:
          gift.last_price ?? null,

        netChange:
          gift.net_change ?? null,

        previousClose:
          gift.prev_close_price ??
          gift.ohlc?.close ??
          null

      }

    };


  } catch (error) {

    console.error(
      "Live market data error:",
      error.response?.data ||
      error.message
    );


    return {

      success: false,

      error:
        error.response?.data?.errors?.[0]?.message ||
        error.response?.data?.message ||
        error.message ||
        "Unable to fetch live market data"

    };

  }

}


/* =====================================================
   MARKET DATA API
===================================================== */

app.get("/api/market", async (req, res) => {

  try {

    const market =
      await getLiveMarketData();


    if (!market.success) {

      return res.status(500).json(
        market
      );

    }


    res.json(market);


  } catch (error) {

    console.error(
      "Market route error:",
      error.message
    );


    res.status(500).json({

      success: false,

      error:
        error.message ||
        "Market data failed"

    });

  }

});


/* =====================================================
   AI CHAT
===================================================== */

app.post("/api/chat", async (req, res) => {

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
      Array.isArray(req.body?.history)
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


    /* =================================================
       FETCH LIVE MARKET DATA BEFORE AI
    ================================================= */

    const market =
      await getLiveMarketData();


    let marketContext = "";


    if (market.success) {

      marketContext = `

LIVE MARKET DATA:

NIFTY 50
- Current Price: ${market.nifty.lastPrice ?? "N/A"}
- Change: ${market.nifty.netChange ?? "N/A"}
- Previous Close: ${market.nifty.previousClose ?? "N/A"}
- Open: ${market.nifty.ohlc?.open ?? "N/A"}
- High: ${market.nifty.ohlc?.high ?? "N/A"}
- Low: ${market.nifty.ohlc?.low ?? "N/A"}

INDIA VIX
- Current: ${market.indiaVix.lastPrice ?? "N/A"}
- Change: ${market.indiaVix.netChange ?? "N/A"}
- Previous Close: ${market.indiaVix.previousClose ?? "N/A"}

GIFT NIFTY
- Current: ${market.giftNifty.lastPrice ?? "N/A"}
- Change: ${market.giftNifty.netChange ?? "N/A"}
- Previous Close: ${market.giftNifty.previousClose ?? "N/A"}

IMPORTANT:
This data was fetched from the connected market-data API.
Do not say that you have no live market data if the values above are available.

However:
- Never guarantee whether Nifty will open up or down.
- GIFT NIFTY is an indicator of pre-market/global sentiment, not a guaranteed prediction of NSE opening.
- Clearly distinguish live facts from analysis.
- If data is insufficient, say WAIT or NO TRADE.
`;

    } else {

      marketContext = `

LIVE MARKET DATA STATUS:
Unable to retrieve live market data right now.

Do NOT invent market prices.
Tell the user that live market data is temporarily unavailable.
`;


    }


    /* =================================================
       ERA SYSTEM
    ================================================= */

    const systemMessage = {

      role: "system",

      content: `
You are Era AI, a premium voice-controlled AI assistant.

You are designed primarily for stock-market assistance.

The user may speak in:
- Hindi
- Hinglish
- Gujarati
- English

Always understand the user's language and reply in the same language when possible.

Keep answers clear, practical and concise because your response may also be spoken aloud by voice.

${marketContext}

TRADING RULES:

1. Never invent live market prices.

2. Use the LIVE MARKET DATA supplied above whenever relevant.

3. If the user asks:
   "Nifty ka live price kya hai?"
   give the current Nifty price from the supplied data.

4. If the user asks:
   "Kal Nifty up open hogi ya down?"
   analyze available GIFT NIFTY, Nifty, VIX and other supplied information.

5. Do NOT present an opening prediction as a certainty.

6. Clearly use terms such as:
   - Bullish bias
   - Bearish bias
   - Neutral
   - WAIT
   when appropriate.

7. GIFT NIFTY is not a guaranteed prediction of NSE opening.

8. If conditions are not sufficiently confirmed:
   say WAIT or NO TRADE.

9. Never guarantee profit.

10. For a trading setup, when sufficient information exists, explain:
   - Direction
   - Entry
   - Stop Loss
   - Targets
   - Risk/Reward
   - Confirmations
   - Invalidation

11. Do not claim to have live data if the supplied data is unavailable.

You are Era AI, not ChatGPT.

For normal questions, answer naturally like an intelligent personal assistant.
`

    };


    /* =================================================
       HISTORY
    ================================================= */

    const safeHistory =
      history
        .slice(-20)
        .filter(item =>
          item &&
          (
            item.role === "user" ||
            item.role === "assistant"
          ) &&
          typeof item.content === "string"
        )
        .map(item => ({

          role:
            item.role,

          content:
            item.content

        }));


    const messages = [

      systemMessage,

      ...safeHistory,

      {

        role: "user",

        content:
          String(message).trim()

      }

    ];


    /* =================================================
       OPENROUTER
    ================================================= */

    const response =
      await axios.post(

        OPENROUTER_URL,

        {

          model:
            process.env.OPENROUTER_MODEL ||
            "openai/gpt-4o-mini",

          messages:
            messages,

          temperature:
            0.4,

          max_tokens:
            800

        },

        {

          headers: {

            Authorization:
              `Bearer ${apiKey}`,

            "Content-Type":
              "application/json",

            "HTTP-Referer":
              "https://shopybuzz.in",

            "X-Title":
              "Era AI"

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

      console.error(
        "OpenRouter response:",
        response.data
      );


      return res.status(500).json({

        success: false,

        error:
          "AI ne koi response return nahi kiya"

      });

    }


    res.json({

      success: true,

      reply:
        answer

    });


  } catch (error) {

    console.error(

      "AI Chat Error:",

      error.response?.data ||
      error.message

    );


    const openRouterError =
      error.response?.data
        ?.error?.message;


    res.status(
      error.response?.status || 500
    ).json({

      success: false,

      error:
        openRouterError ||
        error.message ||
        "AI response failed"

    });

  }

});


/* =====================================================
   NEWS
===================================================== */

app.get("/api/news", async (req, res) => {

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

            apiKey:
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
      articles.map(article => ({

        title:
          article.title || "",

        description:
          article.description || "",

        url:
          article.url || "",

        image:
          article.urlToImage || "",

        source:
          article.source?.name || "",

        publishedAt:
          article.publishedAt || ""

      }));


    res.json({

      success: true,

      data:
        news

    });


  } catch (error) {

    console.error(

      "News Error:",

      error.response?.data ||
      error.message

    );


    res.status(500).json({

      success: false,

      error:
        "Unable to fetch news"

    });

  }

});


/* =====================================================
   OPTION CONTRACTS
   EXISTING LOGIC PRESERVED
===================================================== */

app.get(
  "/api/options/contracts",
  async (req, res) => {

    try {

      const instrumentKey =
        req.query.instrument_key ||
        "NSE_INDEX|Nifty 50";


      const response =
        await axios.get(

          `${UPSTOX_BASE}/v2/option/contract`,

          {

            params: {

              instrument_key:
                instrumentKey

            },

            headers:
              authHeaders()

          }

        );


      res.json({

        success: true,

        data:
          response.data.data

      });


    } catch (error) {

      console.error(

        "Option contract error:",

        error.response?.data ||
        error.message

      );


      res.status(500).json({

        success: false,

        error:
          "Unable to fetch option contracts"

      });

    }

  }

);


/* =====================================================
   OPTION CHAIN
   EXISTING LOGIC PRESERVED
===================================================== */

app.get(
  "/api/options/chain",
  async (req, res) => {

    try {

      const instrumentKey =
        req.query.instrument_key ||
        "NSE_INDEX|Nifty 50";


      const expiry =
        req.query.expiry_date;


      if (!expiry) {

        return res.status(400).json({

          success: false,

          error:
            "expiry_date is required"

        });

      }


      const response =
        await axios.get(

          `${UPSTOX_BASE}/v2/option/chain`,

          {

            params: {

              instrument_key:
                instrumentKey,

              expiry_date:
                expiry

            },

            headers:
              authHeaders()

          }

        );


      res.json({

        success: true,

        data:
          response.data.data

      });


    } catch (error) {

      console.error(

        "Option chain error:",

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
   SERVER
===================================================== */

app.listen(
  PORT,
  () => {

    console.log(
      `Era AI backend running on port ${PORT}`
    );

  }
);
