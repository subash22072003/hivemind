/**
 * Live testnet demo: poster + 3 worker agents run two full job cycles
 * against the deployed HiveMind contract.
 *
 *   npm run demo
 *
 * Requires .env (see .env.example) with CONTRACT_ID, POSTER_* and WORKER*_*.
 */
const { makeNearMarket } = require('./market-near');
const { makeLlm } = require('./llm');
const { runMarketCycle, printLeaderboard, paint } = require('./engine');
const { quoteCrossChainPayout } = require('./intents-quote');
const { cfg, PERSONALITIES, JOBS } = require('./config');

async function main() {
  if (!cfg.contractId) throw new Error('Set CONTRACT_ID in .env (deploy the contract first)');
  if (!cfg.poster.accountId) throw new Error('Set POSTER_ACCOUNT_ID / POSTER_PRIVATE_KEY in .env');
  if (cfg.workers.length === 0) throw new Error('Set WORKER1..3_ACCOUNT_ID / _PRIVATE_KEY in .env');

  console.log(paint('bold', `\n🐝 HIVEMIND — live on NEAR ${cfg.networkId}`));
  console.log(paint('dim', `   market contract: ${cfg.contractId}\n`));

  const workers = cfg.workers.map((w, i) => ({
    ...w,
    personality: PERSONALITIES[i % PERSONALITIES.length],
  }));
  const market = await makeNearMarket(cfg, { poster: cfg.poster, workers });
  const llm = makeLlm(cfg, console.log);
  const actors = { poster: cfg.poster, workers };

  for (let round = 0; round < 2; round++) {
    const job = JOBS[round % JOBS.length];
    console.log(paint('bold', `\n━━ ROUND ${round + 1} ${round > 0 ? '(reputation now in play)' : ''} ━━`));
    const { winner } = await runMarketCycle(market, llm, actors, job);

    // Show how the winning agent could cash out cross-chain via NEAR Intents.
    await quoteCrossChainPayout(winner.priceNEAR, winner.agent, console.log);
  }

  await printLeaderboard(market);
  console.log(paint('green', `\n✔ Live run complete. Watch it on the dashboard: web/index.html (set CONTRACT_ID inside).\n`));
}

main().catch((e) => {
  console.error(paint('red', `\n✖ ${e.message}\n`));
  process.exit(1);
});
