#!/usr/bin/env node
/**
 * longxyz-new-stock-watcher.mjs (v3 — blockchain-based)
 *
 * api.long.xyz's REST API is behind bot-protection that blocks both
 * datacenter AND residential proxy traffic with a 403 (likely a JS
 * challenge or fingerprint check) — so this version goes back to reading
 * directly from Robinhood Chain via RPC, which has no such protection.
 * Any public JSON-RPC node can be queried by anyone, including scripts.
 *
 * How it works:
 * 1. Seeds a baseline of 68 known stock numeraires directly from
 *    verified addresses (SEED_NUMERAIRES below — sourced from the
 *    Long.xyz asset-states API response you fetched manually, so these
 *    addresses are confirmed accurate, including ON and DDOG which were
 *    recently added).
 * 2. On startup, verifies each seed address's on-chain symbol() actually
 *    matches its expected ticker — catches any wrong address immediately.
 * 3. Every POLL_INTERVAL_MS, checks for new `Created` events on the
 *    Airlock contract. For each one, resolves its numeraire via
 *    getAssetData(). If that numeraire was never seen before, alerts.
 * 4. Logs a heartbeat every single tick, so "it's alive" is always
 *    visible in the logs, not just when something changes.
 *
 * Setup: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID env vars.
 *
 * Run:
 *   npm install ethers
 *   node longxyz-new-stock-watcher.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

// ---- Config -----------------------------------------------------------

const RPC_URL = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const AIRLOCK_ADDRESS = '0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID_HERE')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5_000);
const LOG_CHUNK_SIZE = Number(process.env.LOG_CHUNK_SIZE || 2_000);
const PORT = process.env.PORT || 8000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'longxyz-known-numeraires.json');

const AIRLOCK_ABI = [
  'event Created(address indexed asset, address hook, address creator, bytes32 poolId, uint256 epochStart, uint256 epochEnd, string name)',
  'function getAssetData(address asset) view returns (address numeraire, address timelock, address governance, address liquidityMigrator, address poolInitializer, address pool)',
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
];

// Verified from api.long.xyz's own asset-states response (fetched manually,
// includes the 6 tickers added since the original spreadsheet: DDOG, GLXY,
// ON, PENG, RCAT, RUN). ETH's address is the native zero-address — it has
// no ERC20 contract, so it's handled specially (added to known set without
// a symbol() check).
const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

const SEED_NUMERAIRES = {
  USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  AI: '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18',
  NVDAx3L: '0xf51fb54de60f6e16252e852a5ed0e60b8307606a',
  OPENAIx1L: '0xfe09fb328be1c286b4f597ed34764b7472ae72c5',
  ANTHROPICx1L: '0x1937cad42b17d43bb2b347ce16d5288887c46c33',
  AAPL: '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9',
  AMC: '0x05a3d1cd21d0c88145e82600e62e7e496e0f222b',
  AMD: '0x86923f96303d656e4aa86d9d42d1e57ad2023fdc',
  AMZN: '0x12f190a9f9d7d37a250758b26824b97ce941bf54',
  ASML: '0x47f93d52cbec7c6d2cfc080e154002370a60daea',
  BA: '0x4d21483a44bf67a86b77e3da301411880797d452',
  BABA: '0xad25ac6c84d497db898fa1e8387bf6af3532a1c4',
  BB: '0x48e39e56acdba37b09020c0b734a613c9a2f100a',
  BE: '0x822cc93ffd030293e9842c30bbd678f530701867',
  CCL: '0x9651342cea770ae9a2969ba2a52611523146aef9',
  COIN: '0x6330d8c3178a418788df01a47479c0ce7ccf450b',
  COST: '0x4ea005168d7f09a7a0ba9d1def21a479950e44c2',
  CRCL: '0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5',
  CRWV: '0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3',
  DDOG: '0x27c99fbde9d0d2aa4f4bfb4943f237843ddf6958',
  DELL: '0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd',
  DJT: '0x1d11f0496982706c5e14a514d4e79f2e6bde4516',
  F: '0x25c288e6d899b9bc30160965ad9644c67e73be0c',
  FIG: '0x41f4267525a8aff329540ef24fd83d9044758b33',
  GLXY: '0x2d427692e928fa156ec22acfabafa0447c5805b7',
  GME: '0x1b0e319c6a659f002271b69db8a7df2f911c153e',
  GOOGL: '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3',
  HIMS: '0xccee82fe024c36fa15e1005ede3e9e4787e23d09',
  IBM: '0x980dcf6766fa79f5cf0c4aadb3ab477ff15a9619',
  INTC: '0xc72b96e0e48ecd4dc75e1e45396e26300bc39681',
  JNJ: '0x03dfbbe0ac4e7bcdafd08ed41a400326b77d8c80',
  LLY: '0x8005d266423c7ea827372c9c864491e5786600ea',
  LMT: '0x329fcaceb9ad6f9580dd5f643fed0646900d043c',
  LULU: '0x4e62068525ab11fe768e29dfd00ef909b9803016',
  META: '0xc0d6457c16cc70d6790dd43521c899c87ce02f35',
  MRNA: '0x43b07d15ce533bec5476d70c22a78a1b2b662155',
  MSFT: '0xe93237c50d904957cf27e7b1133b510c669c2e74',
  MSTR: '0xec262a75e413fafd0df80480274532c79d42da09',
  MU: '0xff080c8ce2e5feadaca0da81314ae59d232d4afd',
  NBIS: '0x9d9c6684f596f66a64c030b93a886d51fd4d7931',
  NET: '0x116f00968269b7bfbad4109ce591d6e74c0601d4',
  NFLX: '0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8',
  NU: '0x408c14038a04f7bd235329e26d2bf569ee20e250',
  NVDA: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
  ON: '0xbbd09f72b025360fee5c928053dca6248d35be54',
  ORCL: '0xb0992820e760d836549ba69bc7598b4af75dee03',
  PENG: '0x9b23573b156b52565012f5ce02cdf60afbaa70be',
  PFE: '0x7066a64c24e4206cd62e83bf198c1e7eb361f51e',
  PLTR: '0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a',
  QUBT: '0x59818904ab4ce163b3ce4ffb64f2d6ca02c434b4',
  RBLX: '0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8',
  RCAT: '0xfde6b5d9bb419b10c23268c74e369abff39c0460',
  RDDT: '0x05b37fb53a299a1b874a619e1c4c404d52c36f4c',
  RIVN: '0xb1bf26c1d20ff267a4f93550d1e0d06ac40a114b',
  RUN: '0x756bc80af765c82da966a788858d65adf14f3793',
  SHOP: '0xf53f66751b1eff985311b693531e3290f600c410',
  SKHY: '0x84cab63bc87912e71ad199ff14a0ba45de68fef8',
  SNAP: '0xf6589f11bc40b669e584073f428b05562f568733',
  SNDK: '0xb90a19ff0af67f7779aff50a882a9cff42446400',
  SNOW: '0xba0cab75495255d0cb58e22b648bfed4ecd1f47e',
  SOFI: '0x98e75885157c80992a8d41b696d8c9c6fb30a926',
  SPCX: '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea',
  TSLA: '0x322f0929c4625ed5bad873c95208d54e1c003b2d',
  TSM: '0x58ffe4a942d3885baa22d7520691f611ef09e7aa',
  TTWO: '0x5e81213613b6b86eab4c6c50d718d34359459786',
  UPS: '0xf23250dac154d05bb671cb0d0ebef3c635c79ce2',
  USAR: '0xd917b029c761d264c6a312bbbcda868658ef86a6',
  USO: '0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344',
  GLD: '0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e',
  QQQ: '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68',
  SGOV: '0x92fd66527192e3e61d4ddd13322aa222de86f9b5',
  SLV: '0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f',
  SPY: '0x117cc2133c37b721f49de2a7a74833232b3b4c0c',
  XLK: '0x15cd20759ce7f3285c29a319de2d1a2e098c6f43',
};

let lastCheckAt = null;
let knownCount = 0;

// ---- State ------------------------------------------------------------

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { lastBlock: parsed.lastBlock, numeraires: new Set(parsed.numeraires) };
  } catch {
    return null;
  }
}

function saveState(lastBlock, numeraires) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastBlock, numeraires: [...numeraires] }, null, 2));
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

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', lastCheckAt, knownNumeraires: knownCount }));
  });
  server.listen(PORT, () => console.log(`Health check server listening on :${PORT}`));
}

// ---- Chain helpers ------------------------------------------------------------

async function getCreatedEvents(contract, fromBlock, toBlock) {
  const events = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
    const end = Math.min(start + LOG_CHUNK_SIZE - 1, toBlock);
    const chunk = await contract.queryFilter(contract.filters.Created(), start, end);
    events.push(...chunk);
  }
  return events;
}

async function resolveNumeraire(contract, assetAddress) {
  const data = await contract.getAssetData(assetAddress);
  return data.numeraire;
}

async function resolveSymbol(provider, tokenAddress) {
  if (tokenAddress.toLowerCase() === NATIVE_ETH) return 'ETH';
  try {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return await token.symbol();
  } catch {
    return null;
  }
}

// ---- Main loop ------------------------------------------------------------

async function bootstrap(provider) {
  const latestBlock = await provider.getBlockNumber();
  console.log(`[init] Seeding baseline from ${Object.keys(SEED_NUMERAIRES).length + 1} known tickers (including ETH)...`);

  const numeraires = new Set([NATIVE_ETH]);
  const mismatches = [];

  for (const [ticker, address] of Object.entries(SEED_NUMERAIRES)) {
    const addr = address.toLowerCase();
    numeraires.add(addr);
    const onChainSymbol = await resolveSymbol(provider, address);
    if (onChainSymbol === null) {
      mismatches.push(`${ticker}: could not read symbol() at ${address}`);
    } else if (onChainSymbol.toUpperCase() !== ticker.replace(/x\d+L$/i, '').toUpperCase() && onChainSymbol.toUpperCase() !== ticker.toUpperCase()) {
      mismatches.push(`${ticker}: address ${address} returns symbol "${onChainSymbol}" on-chain — check this one`);
    }
  }

  if (mismatches.length > 0) {
    console.warn(`[warn] ${mismatches.length} seed address issue(s):\n  - ${mismatches.join('\n  - ')}`);
  } else {
    console.log(`[init] All seed addresses verified on-chain — symbols match tickers.`);
  }

  knownCount = numeraires.size;
  console.log(`[init] Baseline ready: ${numeraires.size} known numeraires, starting from block ${latestBlock}.`);
  saveState(latestBlock, numeraires);
  return { lastBlock: latestBlock, numeraires };
}

async function tick(provider, contract, state) {
  let latestBlock;
  try {
    latestBlock = await provider.getBlockNumber();
  } catch (err) {
    console.error('[error] fetching latest block:', err.message);
    return;
  }

  lastCheckAt = new Date();

  if (latestBlock <= state.lastBlock) {
    console.log(`[${lastCheckAt.toISOString()}] No new blocks (tip: ${latestBlock}).`);
    return;
  }

  const fromBlock = state.lastBlock + 1;
  let events;
  try {
    events = await getCreatedEvents(contract, fromBlock, latestBlock);
  } catch (err) {
    console.error('[error] fetching Created events:', err.message);
    return;
  }

  let newStockCount = 0;
  for (const ev of events) {
    let numeraire;
    try {
      numeraire = (await resolveNumeraire(contract, ev.args.asset)).toLowerCase();
    } catch (err) {
      console.warn(`[warn] could not resolve numeraire for ${ev.args.asset}:`, err.message);
      continue;
    }

    // Log every launch we see, not just new-stock ones — lets you cross-check
    // against app.long.xyz's own recent-launches feed to confirm we're
    // reading the right contract/events.
    console.log(
      `  [launch][longxyz:airlock=${AIRLOCK_ADDRESS}] "${ev.args.name}" asset=${ev.args.asset} creator=${ev.args.creator} ` +
      `numeraire=${numeraire} tx=${ev.transactionHash} ` +
      `verify: https://robinhoodchain.blockscout.com/tx/${ev.transactionHash}`
    );

    if (state.numeraires.has(numeraire)) continue;

    state.numeraires.add(numeraire);
    knownCount = state.numeraires.size;
    newStockCount++;

    const symbol = await resolveSymbol(provider, numeraire);
    console.log(`[${lastCheckAt.toISOString()}] NEW STOCK PAIR: ${symbol || '(unknown symbol)'} — ${numeraire}`);

    const text = [
      `🆕 *Long.xyz added a new stock pair!*`,
      symbol ? `Ticker: *${symbol}*` : null,
      `Numeraire address: \`${numeraire}\``,
      `First seen via launch: *${ev.args.name}* (\`${ev.args.asset}\`)`,
      `Verify: https://robinhoodchain.blockscout.com/tx/${ev.transactionHash}`,
    ].filter(Boolean).join('\n');

    await sendTelegramMessage(text);
  }

  console.log(`[${lastCheckAt.toISOString()}] Checked blocks ${fromBlock}-${latestBlock}: ${events.length} launch(es), ${newStockCount} new stock(s), ${knownCount} known total.`);

  state.lastBlock = latestBlock;
  saveState(state.lastBlock, state.numeraires);
}

async function main() {
  console.log('Long.xyz new-stock-pair watcher (blockchain-based) starting...');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Polling every ${POLL_INTERVAL_MS / 1000}s`);

  startHealthServer();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(AIRLOCK_ADDRESS, AIRLOCK_ABI, provider);

  let state = loadState();
  if (!state) {
    state = await bootstrap(provider);
    await sendTelegramMessage(`👋 Long.xyz new-stock-pair watcher started (blockchain mode). Baseline: ${state.numeraires.size} known tickers.`);
  } else {
    knownCount = state.numeraires.size;
    console.log(`[init] Resuming from block ${state.lastBlock} with ${state.numeraires.size} known numeraires.`);
    await sendTelegramMessage(`👋 Watcher restarted, resuming from block ${state.lastBlock} with ${state.numeraires.size} known tickers.`);
  }

  await tick(provider, contract, state);
  setInterval(() => tick(provider, contract, state), POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
