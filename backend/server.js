const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const webpush = require('web-push');

const app = express();
app.use(cors());
app.use(express.json());

// Fast Health Ping (Prevents Render Sleep Mode)
app.get('/ping', (req, res) => {
  res.status(200).send('Era V6 Full Engine Active');
});

// VAPID Push Setup
let subscriptions = [];
try {
  const vapidKeys = webpush.generateVAPIDKeys();
  webpush.setVapidDetails(
    'mailto:era-ai@example.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
} catch (e) {
  console.log('VAPID Init Warning:', e.message);
}

app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  if (subscription && subscription.endpoint) {
    subscriptions.push(subscription);
  }
  res.status(201).json({ success: true });
});

function triggerNotification(title, body) {
  const payload = JSON.stringify({ title, body, url: '/?from=notification' });
  subscriptions.forEach(sub => {
    webpush.sendNotification(sub, payload).catch(err => console.error(err));
  });
}

// 1. Option Chain & Market Data Endpoint (Restored)
app.get('/api/option-chain', (req, res) => {
  // Returns market data structure required by index.html
  res.json({
    status: 'success',
    niftyPrice: 24500,
    bankNiftyPrice: 52200,
    pcrRatio: 1.15,
    smcSignal: { type: 'BUY', pattern: 'Fair Value Gap (FVG)', zone: '24480 - 24520' }
  });
});

// 2. Real-Time Tick & 20-30 Point Movement Scanner
let lastPrice = 0;
app.post('/api/market-tick', (req, res) => {
  const { price, high, low, vwap } = req.body || {};

  if (price && lastPrice > 0) {
    const diff = price - lastPrice;
    const absDiff = Math.abs(diff);

    if (absDiff >= 20) {
      const type = diff > 0 ? 'BUY' : 'SELL';
      triggerNotification(
        `🚨 ERA: ${absDiff.toFixed(0)}+ Pts Surge!`,
        `Move: ${diff > 0 ? '+' : ''}${diff.toFixed(1)} pts. Signal: ${type}`
      );
    }
  }
  if (price) lastPrice = price;

  res.json({ success: true, status: 'scanned', currentPrice: price || lastPrice });
});

// Scheduled Morning/Evening Push Alerts
cron.schedule('15 9 * * 1-5', () => {
  triggerNotification('🔔 Market Opened', 'Era AI is active for SMC & Option analysis.');
});

cron.schedule('30 15 * * 1-5', () => {
  triggerNotification('📊 Market Closed', 'Tomorrow trade plan ready on dashboard.');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Era AI active on port ${PORT}`));
