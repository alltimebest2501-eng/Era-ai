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

const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";


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


/* ================= AI CHAT ================= */

app.post("/api/chat", async (req, res) => {

  try {

    const apiKey =
      process.env.OPENROUTER_API_KEY;

    if (!apiKey) {

      return res.status(500).json({
        success: false,
        error: "OPENROUTER_API_KEY is missing"
      });

    }

    const message =
      req.body?.message;

    const history =
      Array.isArray(req.body?.history)
        ? req.body.history
        : [];

    if (!message || !String(message).trim()) {

      return res.status(400).json({
        success: false,
        error: "Message is required"
      });

    }


    /* ================= ERA SYSTEM ================= */

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

For trading questions:
- Do not invent live market prices.
- Do not pretend to have live data unless it is actually provided.
- Clearly distinguish facts, analysis and uncertainty.
- If conditions are not sufficiently confirmed, say WAIT or NO TRADE.
- Never guarantee profit.
- Explain Entry, Stop Loss, Targets, Risk/Reward and invalidation when a trade setup is being discussed.

You are Era AI, not ChatGPT.

For normal questions, answer naturally like an intelligent personal assistant.
`
    };


    /* ================= HISTORY ================= */

    const safeHistory = history
      .slice(-20)
      .filter(item =>
        item &&
        (item.role === "user" ||
         item.role === "assistant") &&
        typeof item.content === "string"
      )
      .map(item => ({
        role: item.role,
        content: item.content
      }));


    const messages = [
      systemMessage,
      ...safeHistory,
      {
        role: "user",
        content: String(message).trim()
      }
    ];


    /* ================= OPENROUTER ================= */

    const response = await axios.post(
      OPENROUTER_URL,
      {
        model:
          process.env.OPENROUTER_MODEL ||
          "openai/gpt-4o-mini",

        messages: messages,

        temperature: 0.4,

        max_tokens: 800
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

        timeout: 30000
      }
    );


    const answer =
      response.data?.choices?.[0]?.message?.content;


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
      reply: answer
    });


  } catch (error) {

    console.error(
      "AI Chat Error:",
      error.response?.data ||
      error.message
    );


    const openRouterError =
      error.response?.data?.error?.message;


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


/* ================= NEWS ================= */

app.get("/api/news", async (req, res) => {

  try {

    /*
      News API key optional.
      If NEWS_API_KEY is added in Render,
      Era can fetch business/market news.
    */

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


    const response = await axios.get(
      "https://newsapi.org/v2/everything",
      {
        params: {
          q:
            "Indian stock market OR Nifty OR Sensex OR NSE OR BSE",

          language: "en",

          sortBy: "publishedAt",

          pageSize: 20,

          apiKey: apiKey
        },

        timeout: 15000
      }
    );


    const articles =
      Array.isArray(response.data?.articles)
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

      data: news

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
      error:
        "Unable to fetch option contracts"
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
        error:
          "expiry_date is required"
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
      error:
        "Unable to fetch option chain"
    });

  }

});


/* ================= SERVER ================= */

app.listen(PORT, () => {

  console.log(
    `Era AI backend running on port ${PORT}`
  );

});
