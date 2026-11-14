/**
 * Poster agent: posts a job (from the built-in list or CLI args), waits for
 * bids, hires the best value, verifies the work and rates the agent.
 *
 *   npm run post                       → posts the next built-in job
 *   npm run post -- "Title" "Spec" 1.5 → custom job with 1.5 NEAR bounty
 */
const { makeNearMarket } = require('./market-near');
const { makeLlm } = require('./llm');
const { paint, sleep } = require('./engine');
const { quoteCrossChainPayout } = require('./intents-quote');
const { cfg, PERSONALITIES, JOBS } = require('./config');

const POLL_MS = 5000;
const MAX_WAIT_MS = 10 * 60 * 1000;

async function main() {
  if (!cfg.contractId) throw new Error('Set CONTRACT_ID in .env');
  const [titleArg, specArg, budgetArg] = process.argv.slice(2);
  const job = titleArg
    ? {
        title: titleArg,
        spec: specArg || titleArg,
        budgetNEAR: budgetArg || '1',
        deadlineSec: 3600,
      }
    : JOBS[0];

  const market = await makeNearMarket(cfg, { poster: cfg.poster, workers: cfg.workers });
  const llm = makeLlm(cfg, console.log);

  console.log(paint('cyan', `\n📋 posting: "${job.title}" — bounty ${job.budgetNEAR} NEAR\n`));
  const taskId = await market.postTask({
    poster: cfg.poster.accountId,
    title: job.title,
    spec: job.spec,
    budgetNEAR: job.budgetNEAR,
    deadlineSec: job.deadlineSec,
  });
  console.log(paint('green', `✓ task #${taskId} live, escrow locked\n`));

  const started = Date.now();
  let assigned = null;

  while (Date.now() - started < MAX_WAIT_MS) {
    const task = await market.getTask(taskId);
    if (task.status === 'Submitted') {
      console.log('📥 deliverable submitted — verifying…');
      const bids = await market.getBids(taskId);
      const winnerBid = bids.find((b) => b.agent === task.assignee);
      const personality =
        PERSONALITIES[cfg.workers.findIndex((w) => w.accountId === task.assignee)] || null;
      const fs = require('fs');
      const path = require('path');
      const resultPath = path.join(__dirname, '..', 'results', `task-${taskId}.md`);
      const result = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : task.spec;
      const rating = await llm.gradeWork({ title: task.title, spec: task.spec }, result, personality);
      await market.approveAndRate({ poster: cfg.poster.accountId, taskId, rating });
      console.log(paint('green', `💸 approved, rated ${rating}/5 — escrow paid ${task.assignee}`));
      await quoteCrossChainPayout(
        market.yoctoToNear(task.agreed_price),
        task.assignee,
        console.log
      );
      return;
    }
    if (task.status === 'Open') {
      const bids = await market.getBids(taskId);
      if (bids.length >= cfg.workers.length || (bids.length > 0 && Date.now() - started > 60000)) {
        const reputations = {};
        for (const b of bids) {
          const rep = await market.getReputation(b.agent);
          reputations[b.agent] = rep
            ? {
                ratingAvg: rep.rating_count ? rep.rating_sum / rep.rating_count : 0,
                jobs: rep.jobs_completed,
              }
            : { ratingAvg: 0, jobs: 0 };
        }
        const normalized = bids.map((b) => ({
          agent: b.agent,
          priceNEAR: market.yoctoToNear(b.price),
          pitch: b.pitch,
          etaSec: b.eta_seconds,
        }));
        const winner = await llm.chooseBid({ title: task.title }, normalized, reputations);
        await market.acceptBid({ poster: cfg.poster.accountId, taskId, agent: winner });
        console.log(paint('green', `🤝 hired ${winner}`));
        assigned = winner;
      }
    }
    await sleep(POLL_MS);
  }
  throw new Error(assigned ? 'Agent never delivered' : 'No bids arrived in time');
}

main().catch((e) => {
  console.error(paint('red', `✖ ${e.message}`));
  process.exit(1);
});
