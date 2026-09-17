#!/usr/bin/env node
/**
 * longxyz-new-stock-watcher.mjs (v2 — API-based)
 *
 * Long.xyz exposes a real, unauthenticated endpoint that lists every
 * currently supported stock numeraire with its address and live price:
 *
 *   GET https://api.long.xyz/v1/robinhood/asset-states
 *
 * This replaces the earlier blockchain-event-scanning version — same
 * goal (alert only when a genuinely NEW stock pair is added), much
 * simpler and more reliable mechanism (no RPC, no event ABI, no ethers
 * dependency at all).
 *
 * Setup: same TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars as the
 * other watchers.
 *
 * Run:
 *   node longxyz-new-stock-watcher.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

// ---- Config -----------------------------------------------------------

const API_URL = 'https://api.long.xyz/v1/robinhood/asset-states';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID_HERE')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5_000);
const PORT = process.env.PORT || 8000;

// Optional residential proxy — required because api.long.xyz's WAF blocks
// plain datacenter-IP traffic (the kind Railway/Render/etc use) with a 403.
// Format: http://username:password@proxy-host:port (get this from your
// proxy provider, e.g. DataImpulse, Evomi, IPRoyal).
const PROXY_URL = process.env.PROXY_URL || null;
const proxyAgent = PROXY_URL ? new ProxyAgent(PROXY_URL) : null;

async function proxiedFetch(url, options = {}) {
  if (proxyAgent) {
    return undiciFetch(url, { ...options, dispatcher: proxyAgent });
  }
  return fetch(url, options); // falls through to plain fetch if no proxy configured
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'longxyz-known-tickers.json');

let lastCheckAt = null;
let knownCount = 0;

// ---- State ------------------------------------------------------------

function loadSeen() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return new Set(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveSeen(seenSet) {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...seenSet], null, 2));
}

// ---- Telegram ------------------------------------------------------------

async function sendTelegramMessage(text) {
  if (TELEGRAM_CHAT_IDS.includes('YOUR_CHAT_ID_HERE') || TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.warn('[warn] Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars.');
    console.log('[would send]', text);
    return;
  }

  await Promise.all(TELEGRAM_CHAT_IDS.map(async (chatId) => {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[error] Telegram send failed for chat ${chatId}:`, res.status, body);
    }
  }));
}

function formatMessage(asset) {
  const lines = [
    `🆕 *Long.xyz added a new stock pair!*`,
    `Ticker: *${asset.symbol}*`,
    `Address: \`${asset.address}\``,
    `Price: $${asset.priceUsd}`,
    `Status: ${asset.status}`,
  ];
  return lines.join('\n');
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', lastCheckAt, knownTickers: knownCount }));
  });
  server.listen(PORT, () => console.log(`Health check server listening on :${PORT}`));
}

// ---- Main loop ------------------------------------------------------------

async function fetchAssetStates() {
  const res = await proxiedFetch(API_URL, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://app.long.xyz/',
      'Origin': 'https://app.long.xyz',
    },
  });

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(`Expected JSON but got "${contentType}" (status ${res.status}). First 200 chars: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${res.status}: request failed`);
  }
  return body.states; // [{ address, symbol, status, priceUsd, ... }]
}

async function tick(seen, isFirstRun) {
  let states;
  try {
    states = await fetchAssetStates();
  } catch (err) {
    console.error('[error] fetching asset-states:', err.message);
    return;
  }

  lastCheckAt = new Date();

  const newAssets = states.filter((a) => !seen.has(a.symbol.toUpperCase()));

  if (isFirstRun) {
    for (const a of states) seen.add(a.symbol.toUpperCase());
    saveSeen(seen);
    knownCount = seen.size;
    console.log(`[init] Baseline recorded: ${states.length} existing tickers. Watching for new ones...`);
    return;
  }

  if (newAssets.length === 0) {
    console.log(`[${lastCheckAt.toISOString()}] No new tickers (${states.length} total, ${knownCount} known).`);
    return;
  }

  console.log(`[${lastCheckAt.toISOString()}] ${newAssets.length} new ticker(s) found!`);
  for (const asset of newAssets) {
    console.log(' ->', asset.symbol, asset.address);
    await sendTelegramMessage(formatMessage(asset));
    seen.add(asset.symbol.toUpperCase());
  }
  saveSeen(seen);
  knownCount = seen.size;
}

async function main() {
  console.log('Long.xyz new-stock-pair watcher (API-based) starting...');
  console.log(`Polling ${API_URL} every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(proxyAgent ? '[init] Using residential proxy for requests.' : '[warn] No PROXY_URL set — requests will likely be blocked (403) by api.long.xyz\'s bot protection.');

  startHealthServer();

  let seen = loadSeen();
  const isFirstRun = seen === null;
  if (isFirstRun) seen = new Set();
  knownCount = seen.size;

  await sendTelegramMessage(
    isFirstRun
      ? `👋 Long.xyz new-stock-pair watcher started. Building baseline now...`
      : `👋 Long.xyz new-stock-pair watcher restarted, resuming with ${seen.size} known tickers.`
  );

  await tick(seen, isFirstRun);
  setInterval(() => tick(seen, false), POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
