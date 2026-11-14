/**
 * One full market cycle, shared by the local demo and the live testnet run:
 *
 *   post task → agents bid → poster hires → agent works →
 *   poster verifies & rates → escrow pays → reputation updates
 *
 * Currency: NEAR (native escrow) or USDC (NEP-141 stablecoin escrow via
 * ft_transfer_call). Set job.currency = 'USDC' and job.budgetUSDC.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const C = {
  reset: '[0m', dim: '[2m', bold: '[1m',
  cyan: '[36m', green: '[32m', yellow: '[33m', magenta: '[35m', red: '[31m',
};
const paint = (c, s) => `${C[c]}${s}${C.reset}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param market  MarketNear or LocalMarket (same interface)
 * @param llm     from makeLlm()
 * @param actors  { poster: {accountId}, workers: [{accountId, personality}] }
 * @param job     { title, spec, deadlineSec, budgetNEAR } or
 *                { title, spec, deadlineSec, currency: 'USDC', budgetUSDC }
 * @param events  optional { phase(name, detail) } — used by demo-server for live UI streaming
 */
async function runMarketCycle(market, llm, actors, job, log = console.log, events = null) {
  const { poster, workers } = actors;
  const line = () => log(paint('dim', '─'.repeat(64)));

  const isStable = job.currency === 'USDC';
  const unit = isStable ? market.stableSymbol || 'USDC.e' : 'NEAR';
  const budgetLabel = isStable ? job.budgetUSDC : job.budgetNEAR;
  const budgetNum = Number(budgetLabel);

  line();
  log(paint('cyan', `📋 JOB POSTED  "${job.title}"`));
  log(
    paint(
      'dim',
      `   budget ${budgetLabel} ${unit} locked in ${isStable ? 'stablecoin ' : ''}escrow · poster: ${poster.accountId}`
    )
  );
  let taskId;
  if (isStable) {
    taskId = await market.postStableTask({
      poster: poster.accountId,
      title: job.title,
      spec: job.spec,
      budgetUnits: market.toTokenUnits(job.budgetUSDC),
      deadlineSec: job.deadlineSec,
    });
  } else {
    taskId = await market.postTask({
      poster: poster.accountId,
      title: job.title,
      spec: job.spec,
      budgetNEAR: job.budgetNEAR,
      deadlineSec: job.deadlineSec,
    });
  }
  log(paint('green', `   ✓ escrow locked on-chain · task #${taskId}`));
  events && events.phase && events.phase('post', { taskId, currency: unit });
  await sleep(400);

  // ---- Agents evaluate and bid -------------------------------------------
  log('');
  log(paint('cyan', `🤖 AGENTS BIDDING (${workers.length} online)`));
  const bids = [];
  for (const w of workers) {
    const bid = await llm.decideBid(
      { title: job.title, spec: job.spec },
      w.personality,
      budgetNum
    );
    await market.placeBid({
      agent: w.accountId,
      taskId,
      priceNEAR: bid.priceNEAR,
      priceUnits: isStable ? market.toTokenUnits(String(bid.priceNEAR)) : undefined,
      pitch: bid.pitch,
      etaSec: bid.etaSec,
    });
    bids.push({ agent: w.accountId, personality: w.personality, ...bid });
    log(
      `   ${paint('yellow', w.personality.name.padEnd(6))} bids ${paint('bold', String(bid.priceNEAR).padStart(6))} ${unit} · ETA ${bid.etaSec}s · "${bid.pitch.slice(0, 70)}"`
    );
    events && events.phase && events.phase('bid', {
      agent: w.accountId, name: w.personality.name,
      price: bid.priceNEAR, priceNEAR: bid.priceNEAR, currency: unit,
      etaSec: bid.etaSec, pitch: bid.pitch,
    });
    await sleep(300);
  }

  // ---- Poster hires --------------------------------------------------------
  log('');
  log(paint('cyan', '🧮 HIRING DECISION'));
  const reputations = {};
  for (const b of bids) {
    const rep = await market.getReputation(b.agent);
    reputations[b.agent] = rep
      ? {
          ratingAvg: rep.rating_avg ?? (rep.rating_count ? rep.rating_sum / rep.rating_count : 0),
          jobs: rep.jobs_completed ?? rep.jobs ?? 0,
        }
      : { ratingAvg: 0, jobs: 0 };
  }
  const winnerId = await llm.chooseBid({ title: job.title }, bids, reputations);
  const winner = bids.find((b) => b.agent === winnerId);
  await market.acceptBid({ poster: poster.accountId, taskId, agent: winnerId });
  log(
    paint('green', `   ✓ hired ${winner.personality.name} (${winnerId}) for ${winner.priceNEAR} ${unit} — price locked in escrow`)
  );
  events && events.phase && events.phase('hire', {
    agent: winnerId, name: winner.personality.name,
    price: winner.priceNEAR, priceNEAR: winner.priceNEAR, currency: unit,
  });
  await sleep(400);

  // ---- Agent works ---------------------------------------------------------
  log('');
  log(paint('cyan', `⚙️  ${winner.personality.name.toUpperCase()} WORKING…`));
  const result = await llm.doWork({ title: job.title, spec: job.spec }, winner.personality);
  const hash = crypto.createHash('sha256').update(result).digest('hex');

  const outDir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `task-${taskId}.md`);
  fs.writeFileSync(outFile, result);

  await market.submitResult({
    agent: winnerId,
    taskId,
    resultHash: `sha256:${hash}`,
    resultUri: `results/task-${taskId}.md`,
  });
  log(paint('green', `   ✓ deliverable submitted · sha256:${hash.slice(0, 16)}…`));
  log(paint('dim', `   saved locally: ${outFile}`));
  events && events.phase && events.phase('submit', { hash: `sha256:${hash}`, resultFile: outFile });
  await sleep(400);

  // ---- Poster verifies, escrow pays ----------------------------------------
  log('');
  log(paint('cyan', '💸 VERIFICATION & PAYOUT'));
  const rating = await llm.gradeWork({ title: job.title, spec: job.spec }, result, winner.personality);
  const winnerBefore = isStable
    ? market.fromTokenUnits(await market.getTokenBalance(winnerId))
    : await market.getBalanceNEAR(winnerId);
  await market.approveAndRate({ poster: poster.accountId, taskId, rating });
  const winnerAfter = isStable
    ? market.fromTokenUnits(await market.getTokenBalance(winnerId))
    : await market.getBalanceNEAR(winnerId);
  log(paint('green', `   ✓ client rated ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} — escrow released`));
  log(
    `   ${winner.personality.name}: ${winnerBefore} → ${paint('bold', String(winnerAfter))} ${unit} ` +
      paint('dim', `(+${winner.priceNEAR} earned, remainder refunded to poster)`)
  );
  events && events.phase && events.phase('pay', {
    rating, agent: winnerId, name: winner.personality.name,
    price: winner.priceNEAR, priceNEAR: winner.priceNEAR, currency: unit,
    balanceBefore: winnerBefore, balanceAfter: winnerAfter,
  });

  return { taskId, winner, rating, resultFile: outFile, currency: unit };
}

async function printLeaderboard(market, log = console.log) {
  const board = await market.getLeaderboard();
  log('');
  log(paint('magenta', '🏆 ON-CHAIN REPUTATION LEADERBOARD'));
  if (!board.length) {
    log(paint('dim', '   (no completed jobs yet)'));
    return;
  }
  for (const [i, e] of board.entries()) {
    const stars = (e.avg_rating_x100 / 100).toFixed(1);
    const earned = e.reputation.total_earned;
    const earnedStr = typeof earned === 'string' && earned.length > 10
      ? market.yoctoToNear(earned)
      : Number(earned).toFixed(3);
    log(
      `   ${i + 1}. ${e.agent}  ${paint('yellow', '★' + stars)}  ` +
        `${e.reputation.jobs_completed} jobs · ${earnedStr} NEAR earned`
    );
  }
  // Stablecoin payouts are tracked per-token, not mixed into NEAR earnings.
  if (market.getStablePaid) {
    try {
      const paid = await market.getStablePaid();
      if (paid && paid !== '0') {
        log(paint('dim', `   + ${market.fromTokenUnits(paid)} ${market.stableSymbol || 'USDC.e'} paid out in stablecoin bounties`));
      }
    } catch { /* view unavailable on older contracts — ignore */ }
  }
}

module.exports = { runMarketCycle, printLeaderboard, paint, sleep };
