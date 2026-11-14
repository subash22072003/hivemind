/**
 * Demo engine server — drives one full live market cycle on NEAR testnet
 * from the dashboard's "Live demo" panel.
 *
 *   npm run demo:server     →  http://localhost:8791
 *
 * Endpoints:
 *   GET /api/status      →  JSON: config check, accounts, NEAR + USDC balances
 *   GET /api/run-cycle   →  Server-Sent Events stream of one full cycle:
 *                           post → 3 agents bid → hire → work+submit → approve & pay
 *                           Query params (all optional):
 *                             title, spec  — custom task (judges can post their own)
 *                             budget       — bounty in the chosen currency
 *                             currency     — 'near' (default) or 'usdc' (stablecoin escrow)
 *                             job          — index into the preset JOBS list
 *
 * Private keys are read from .env and never leave this process.
 * The dashboard talks to this server over plain HTTP + CORS(*), so it works
 * both standalone (web/index.html) and embedded in the Mainframe shell.
 */
const http = require('http');
const { makeNearMarket } = require('./market-near');
const { makeLlm } = require('./llm');
const { runMarketCycle, printLeaderboard, paint } = require('./engine');
const { quoteCrossChainPayout } = require('./intents-quote');
const { cfg, PERSONALITIES, JOBS } = require('./config');

const PORT = Number(process.env.DEMO_PORT || 8791);
const EXPLORER = 'https://testnet.nearblocks.io/txns/';
const NEAR_BUDGET = { min: 0.05, max: 0.5, def: 0.3 }; // keep NEAR bounties cheap
const USDC_BUDGET = { min: 1, max: 50, def: 10 }; // stablecoin bounties in USDC.e

const stripAnsi = (s) => String(s).replace(/[[0-9;]*m/g, '');

let busy = false;
let runCount = 0;

function checkConfig() {
  const missing = [];
  if (!cfg.contractId) missing.push('CONTRACT_ID');
  if (!cfg.poster.accountId || !cfg.poster.privateKey) missing.push('POSTER_ACCOUNT_ID/POSTER_PRIVATE_KEY');
  if (cfg.workers.length === 0) missing.push('WORKER1..3_ACCOUNT_ID/_PRIVATE_KEY');
  return missing;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Status is on the dashboard's first paint, so it must NEVER be slow, even
// while a cycle is hammering the public RPC: balances are cached for 30s and
// rebuilt in the background (stale-while-revalidate). A status call always
// answers instantly with the last known values.
let statusCache = null; // { at, payload }
let statusBuilding = null; // Promise | null

function refreshStatusCache() {
  if (statusBuilding) return statusBuilding;
  statusBuilding = buildStatus()
    .then((out) => { if (out.ok) statusCache = { at: Date.now(), payload: out }; })
    .catch(() => { /* keep serving the old cache */ })
    .finally(() => { statusBuilding = null; });
  return statusBuilding;
}

async function handleStatus(res) {
  if (statusCache) {
    if (Date.now() - statusCache.at > 30000) refreshStatusCache(); // async, non-blocking
    return json(res, 200, statusCache.payload);
  }
  await refreshStatusCache(); // cold start: build once, then instant forever
  if (statusCache) return json(res, 200, statusCache.payload);
  json(res, 200, await buildStatus()); // config missing / RPC down — report honestly
}

async function buildStatus() {
  const missing = checkConfig();
  const out = {
    ok: missing.length === 0,
    missing,
    network: cfg.networkId,
    contractId: cfg.contractId || null,
    stable: { tokenId: cfg.stable.tokenId, symbol: cfg.stable.symbol, decimals: cfg.stable.decimals },
    brains: cfg.nearAi.apiKey ? `NEAR AI Cloud (${cfg.nearAi.model})` : 'mock mode (deterministic)',
    poster: null,
    workers: [],
    jobs: JOBS.map((j) => ({ title: j.title, budgetNEAR: j.budgetNEAR })),
  };
  if (!out.ok) return out;

  try {
    const workers = cfg.workers.map((w, i) => ({ ...w, personality: PERSONALITIES[i % PERSONALITIES.length] }));
    const market = await makeNearMarket(cfg, { poster: cfg.poster, workers });
    out.poster = {
      accountId: cfg.poster.accountId,
      balanceNEAR: await market.getBalanceNEAR(cfg.poster.accountId),
      balanceUSDC: market.fromTokenUnits(await market.getTokenBalance(cfg.poster.accountId)),
    };
    out.workers = await Promise.all(
      workers.map(async (w) => ({
        accountId: w.accountId,
        name: w.personality.name,
        style: w.personality.style,
        balanceNEAR: await market.getBalanceNEAR(w.accountId),
        balanceUSDC: market.fromTokenUnits(await market.getTokenBalance(w.accountId)),
      }))
    );
  } catch (e) {
    out.ok = false;
    out.missing = [`RPC/connect error: ${e.message.split('\n')[0]}`];
  }
  return out;
}

async function handleRunCycle(url, res) {
  cors(res);
  if (busy) {
    return json(res, 409, { error: 'A market cycle is already running — wait for it to finish.' });
  }
  const missing = checkConfig();
  if (missing.length) {
    return json(res, 400, { error: `Demo engine not configured. Missing in .env: ${missing.join(', ')}` });
  }

  // ---- Build the job: custom (from the dashboard) or preset rotation ----
  const q = url.searchParams;
  const currency = (q.get('currency') || 'near').toLowerCase() === 'usdc' ? 'USDC' : 'NEAR';
  const clamp = currency === 'USDC' ? USDC_BUDGET : NEAR_BUDGET;
  let job;
  const customTitle = (q.get('title') || '').trim().slice(0, 120);
  const customSpec = (q.get('spec') || '').trim().slice(0, 600);
  const budget = Math.min(clamp.max, Math.max(clamp.min, Number(q.get('budget')) || clamp.def));
  if (customTitle) {
    job = {
      title: customTitle,
      spec: customSpec || customTitle,
      deadlineSec: 3600,
    };
  } else {
    const idx = q.has('job') ? Number(q.get('job')) || 0 : runCount;
    job = { ...JOBS[idx % JOBS.length] };
    delete job.budgetNEAR; // re-set below in the chosen currency
  }
  if (currency === 'USDC') {
    job.currency = 'USDC';
    job.budgetUSDC = String(Number(budget.toFixed(2)));
  } else {
    job.budgetNEAR = String(Number(budget.toFixed(3)));
  }

  // ---- SSE stream ----
  busy = true;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client left */ }
  };
  const log = (line) => {
    const clean = stripAnsi(line);
    if (clean.trim()) send('log', { line: clean });
  };
  const events = { phase: (phase, detail = {}) => send('phase', { phase, ...detail }) };

  try {
    const workers = cfg.workers.map((w, i) => ({ ...w, personality: PERSONALITIES[i % PERSONALITIES.length] }));
    const market = await makeNearMarket(cfg, { poster: cfg.poster, workers }, {
      onTx: ({ methodName, accountId, hash, attachedNEAR }) =>
        send('tx', { method: methodName, accountId, hash, attachedNEAR, explorer: EXPLORER + hash }),
      onRetry: ({ waitMs, attempt, what }) =>
        send('log', { line: `   ⏳ RPC rate-limited on ${what} — retry ${attempt} in ${(waitMs / 1000).toFixed(1)}s (public testnet node)` }),
      onLog: (line) => send('log', { line }),
    });

    // Guard: poster must cover the bounty (plus gas headroom for NEAR).
    if (currency === 'USDC') {
      const bal = BigInt(await market.getTokenBalance(cfg.poster.accountId));
      const need = BigInt(market.toTokenUnits(job.budgetUSDC));
      if (bal < need) {
        send('error', { message: `Poster stablecoin balance too low (${market.fromTokenUnits(bal)} ${cfg.stable.symbol}) for a ${job.budgetUSDC} ${cfg.stable.symbol} bounty. Run: node src/setup-stable.js` });
        res.end();
        return;
      }
    } else {
      const posterBal = Number(await market.getBalanceNEAR(cfg.poster.accountId));
      if (posterBal < Number(job.budgetNEAR) + 0.1) {
        send('error', { message: `Poster balance too low (${posterBal} NEAR) for a ${job.budgetNEAR} NEAR bounty. Top up ${cfg.poster.accountId} from a testnet faucet.` });
        res.end();
        return;
      }
    }

    send('phase', {
      phase: 'start', title: job.title, currency,
      budget: currency === 'USDC' ? job.budgetUSDC : job.budgetNEAR,
      budgetNEAR: job.budgetNEAR || null, budgetUSDC: job.budgetUSDC || null,
      symbol: cfg.stable.symbol, poster: cfg.poster.accountId,
    });
    const llm = makeLlm(cfg, log);
    const { taskId, winner, rating } = await runMarketCycle(
      market, llm, { poster: cfg.poster, workers }, job, log, events
    );
    runCount++;

    // Closer: the winning agent could settle its earnings cross-chain in one intent.
    if (currency === 'NEAR') {
      const quote = await quoteCrossChainPayout(winner.priceNEAR, winner.agent, log);
      if (quote) {
        const out = quote.amountOutFormatted ?? quote.amountOut;
        send('phase', { phase: 'settle', priceNEAR: winner.priceNEAR, usdcOut: String(out) });
      }
    }

    await printLeaderboard(market, log);
    if (statusCache) statusCache.at = 0; // balances changed — serve stale, rebuild async
    refreshStatusCache();
    send('done', {
      taskId, winner: winner.agent, winnerName: winner.personality.name, rating,
      price: winner.priceNEAR, priceNEAR: winner.priceNEAR, currency,
    });
  } catch (e) {
    send('error', { message: e.message.split('\n')[0] });
  } finally {
    busy = false;
    res.end();
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && url.pathname === '/api/status') return void handleStatus(res);
  if (req.method === 'GET' && url.pathname === '/api/run-cycle') return void handleRunCycle(url, res);
  json(res, 404, { error: 'not found', routes: ['/api/status', '/api/run-cycle'] });
});

server.listen(PORT, () => {
  const missing = checkConfig();
  console.log(paint('bold', `\n🐝 HIVEMIND demo engine`));
  console.log(`   listening:  http://localhost:${PORT}`);
  console.log(`   contract:   ${cfg.contractId || paint('red', '(unset — set CONTRACT_ID in .env)')}`);
  console.log(`   stablecoin: ${cfg.stable.symbol} (${cfg.stable.tokenId})`);
  console.log(`   poster:     ${cfg.poster.accountId || paint('red', '(unset)')}`);
  console.log(`   workers:    ${cfg.workers.map((w) => w.accountId).join(', ') || paint('red', '(unset)')}`);
  console.log(`   brains:     ${cfg.nearAi.apiKey ? `NEAR AI Cloud (${cfg.nearAi.model})` : 'mock mode (set NEAR_AI_API_KEY for live LLM)'}`);
  if (missing.length) console.log(paint('red', `   ⚠ missing config: ${missing.join(', ')}`));
  console.log(paint('dim', `\n   Open the dashboard and press ▶ Run live market cycle.\n`));
});
