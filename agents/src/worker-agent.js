/**
 * Standalone worker agent loop. Polls the market, bids on open tasks,
 * and delivers work when hired. Run one per personality:
 *
 *   WORKER_INDEX=0 npm run worker
 *
 * This is what runs on stage in the demo video while the dashboard updates.
 */
const { makeNearMarket } = require('./market-near');
const { makeLlm } = require('./llm');
const { paint, sleep } = require('./engine');
const { cfg, PERSONALITIES } = require('./config');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const POLL_MS = 5000;

async function main() {
  const idx = Number(process.env.WORKER_INDEX || 0);
  const worker = cfg.workers[idx];
  if (!worker) throw new Error(`WORKER${idx + 1}_ACCOUNT_ID/_PRIVATE_KEY missing in .env`);
  const personality = PERSONALITIES[idx % PERSONALITIES.length];

  const market = await makeNearMarket(cfg, { poster: cfg.poster, workers: [worker] });
  const llm = makeLlm(cfg, console.log);
  console.log(paint('yellow', `\n🤖 ${personality.name} online as ${worker.accountId} — watching ${cfg.contractId}\n`));

  const handled = new Set();

  for (;;) {
    try {
      // 1) Bid on open tasks we haven't bid on.
      const open = await market.getOpenTasks();
      for (const task of open) {
        const key = `bid-${task.id}`;
        if (handled.has(key)) continue;
        const existing = await market.getBids(task.id);
        if (existing.some((b) => b.agent === worker.accountId)) {
          handled.add(key);
          continue;
        }
        const budget = market.yoctoToNear(task.budget);
        const bid = await llm.decideBid({ title: task.title, spec: task.spec }, personality, budget);
        await market.placeBid({
          agent: worker.accountId,
          taskId: task.id,
          priceNEAR: bid.priceNEAR,
          pitch: bid.pitch,
          etaSec: bid.etaSec,
        });
        handled.add(key);
        console.log(`📨 bid on task #${task.id}: ${bid.priceNEAR} NEAR — "${bid.pitch.slice(0, 60)}"`);
      }

      // 2) Do work for tasks assigned to us.
      const all = await market.getOpenTasks(); // refresh; then scan all tasks
      const count = all.length;
      for (let id = 1; id <= 50; id++) {
        const key = `work-${id}`;
        if (handled.has(key)) continue;
        const t = await market.getTask(id);
        if (t && t.status === 'Assigned' && t.assignee === worker.accountId) {
          console.log(`⚙️  hired for task #${id} — working…`);
          const result = await llm.doWork({ title: t.title, spec: t.spec }, personality);
          const hash = crypto.createHash('sha256').update(result).digest('hex');
          const outDir = path.join(__dirname, '..', 'results');
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, `task-${id}.md`), result);
          await market.submitResult({
            agent: worker.accountId,
            taskId: id,
            resultHash: `sha256:${hash}`,
            resultUri: `results/task-${id}.md`,
          });
          handled.add(key);
          console.log(`✅ submitted deliverable for task #${id} (sha256:${hash.slice(0, 12)}…)`);
        }
      }
    } catch (e) {
      console.log(paint('red', `poll error: ${e.message.split('\n')[0]}`));
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
