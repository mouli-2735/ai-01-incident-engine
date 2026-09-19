// lib/alertGenerator.js
// Simulated "live" alert feed for demo purposes: periodically writes a new
// Alert doc to Mongo, reusing the same service names the Correlate Agent's
// CLUSTER_DEFS already recognize (payments/cdn/auth) so new alerts naturally
// join existing incidents, plus a couple of "noise" services that never
// correlate into anything — same as the seeded data.
//
// This is a polling-friendly source, not a push source: the frontend just
// re-fetches GET /api/alerts on an interval and sees new rows appear. No
// websockets/SSE, no long-lived connections — nothing for a flaky network or
// a strict hosting proxy to break mid-demo.

const { Alert } = require('../models');
const { serviceFamily } = require('./patternKey');

const TEMPLATES = [
  { service: 'payments-db', severity: 'high', message: 'Connection pool exhausted ({n}/100 in use)' },
  { service: 'payments-db', severity: 'medium', message: 'Query latency p99 > {n}00ms on orders table' },
  { service: 'payments-api', severity: 'high', message: '5xx error rate spiked to {n}% on /checkout' },
  { service: 'checkout-service', severity: 'high', message: 'Timeout calling payments-api after {n}00ms' },
  { service: 'cdn-edge', severity: 'medium', message: 'Cache hit ratio dropped to {n}% on edge-node-eu-{n2}' },
  { service: 'cdn-edge', severity: 'high', message: 'TLS handshake failures on edge-node-eu-{n2}' },
  { service: 'frontend-web', severity: 'medium', message: 'Page load p95 increased to {n}.2s for EU users' },
  { service: 'auth-service', severity: 'high', message: 'Token validation failures spiked to {n}%' },
  { service: 'user-db', severity: 'medium', message: 'Unusual read pattern on sessions table ({n} req/s)' },
  // noise — deliberately unrelated services, never cluster into an incident
  { service: 'search-index', severity: 'low', message: 'Reindex job running {n}s longer than usual' },
  { service: 'notifications-worker', severity: 'low', message: 'Queue depth at {n} messages' },
];

let counter = 0;
let timer = null;

function fillTemplate(str) {
  return str
    .replace('{n2}', String(3 + Math.floor(Math.random() * 4)))
    .replace('{n}', String(10 + Math.floor(Math.random() * 90)));
}

async function generateOneAlert() {
  const tpl = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
  counter += 1;

  const alertId = `LIVE-${Date.now()}-${counter}`;
  const doc = {
    alertId,
    source: 'live-sim',
    service: tpl.service,
    serviceFamily: serviceFamily(tpl.service),
    severity: tpl.severity,
    message: fillTemplate(tpl.message),
    timestamp: new Date(),
    raw: { generated: true },
  };

  try {
    await Alert.create(doc);
    console.log(`[live-alerts] generated ${alertId} (${tpl.service})`);
  } catch (err) {
    // non-fatal — a duplicate alertId or a transient Mongo hiccup shouldn't
    // kill the generator loop
    console.error('[live-alerts] failed to create alert:', err.message);
  }
}

/**
 * Starts the background generator. Safe to call once at server startup,
 * after connectDB() has resolved.
 * @param {number} intervalMs how often to emit a new alert (default 8s)
 */
function startLiveAlertGenerator(intervalMs = 8000) {
  if (timer) return timer; // already running
  timer = setInterval(() => {
    generateOneAlert().catch(() => {});
  }, intervalMs);
  console.log(`[live-alerts] generator started — new alert every ${intervalMs / 1000}s`);
  return timer;
}

function stopLiveAlertGenerator() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startLiveAlertGenerator, stopLiveAlertGenerator, generateOneAlert };
