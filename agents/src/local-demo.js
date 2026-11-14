/**
 * Zero-setup demo: the full agent economy against an in-memory market.
 *
 *   npm run demo:local
 *
 * No keys, no RPC, no LLM key needed. Two job rounds so you can watch
 * reputation from round 1 change the hiring decision in round 2.
 */
const { makeLocalMarket } = require('./market-local');
const { makeLlm } = require('./llm');
const { runMarketCycle, printLeaderboard, paint } = require('./engine');
const { cfg, PERSONALITIES, JOBS } = require('./config');

async function main() {
  console.log(paint('bold', '\n🐝 HIVEMIND — local simulation (in-memory market)\n'));

  const market = makeLocalMarket();
  const poster = { accountId: 'poster.hivemind.testnet' };
  const workers = PERSONALITIES.map((p, i) => ({
    accountId: `${p.name.toLowerCase()}.hivemind.testnet`,
    personality: p,
  }));

  market.fund(poster.accountId, 10);
  workers.forEach((w) => market.fund(w.accountId, 1));

  const llm = makeLlm(cfg, console.log);
  const actors = { poster, workers };

  for (let round = 0; round < 2; round++) {
    const job = JOBS[round % JOBS.length];
    console.log(paint('bold', `\n━━ ROUND ${round + 1} ${round > 0 ? '(reputation now in play)' : ''} ━━`));
    await runMarketCycle(market, llm, actors, job);
  }

  await printLeaderboard(market);

  console.log('');
  console.log(paint('dim', 'Balances after the market ran:'));
  console.log(`   poster: ${await market.getBalanceNEAR(poster.accountId)} NEAR`);
  for (const w of workers) {
    console.log(`   ${w.personality.name}: ${await market.getBalanceNEAR(w.accountId)} NEAR`);
  }
  console.log(paint('green', '\n✔ Simulation complete. Run `npm run demo` for the real testnet market.\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
