/**
 * In-memory market with the exact same interface as the on-chain one.
 * Lets anyone run the full agent economy with zero keys and zero setup:
 *
 *   npm run demo:local
 *
 * It mirrors the contract's rules: escrow on post, one bid per agent,
 * payout + remainder refund on approval, reputation on completion.
 */
function makeLocalMarket() {
  const balances = new Map(); // accountId -> NEAR (number)
  const tasks = [];
  const bids = new Map(); // taskId -> [bid]
  const reputation = new Map(); // accountId -> {jobs, disputes, earned, ratingSum, ratingCount}
  let nextId = 1;

  function fund(accountId, amount) {
    balances.set(accountId, (balances.get(accountId) || 0) + amount);
  }

  function rep(id) {
    if (!reputation.has(id)) {
      reputation.set(id, { jobs: 0, disputes: 0, earned: 0, ratingSum: 0, ratingCount: 0 });
    }
    return reputation.get(id);
  }

  return {
    kind: 'local-simulation',
    fund,

    async postTask({ poster, title, spec, budgetNEAR, deadlineSec }) {
      const budget = Number(budgetNEAR);
      if ((balances.get(poster) || 0) < budget) throw new Error('insufficient funds');
      balances.set(poster, balances.get(poster) - budget); // escrow lock
      const id = nextId++;
      tasks.push({
        id,
        poster,
        title,
        spec,
        budget,
        deadlineSec,
        status: 'Open',
        assignee: null,
        agreedPrice: null,
        resultHash: null,
      });
      return id;
    },

    async placeBid({ agent, taskId, priceNEAR, pitch, etaSec }) {
      const t = tasks.find((x) => x.id === taskId);
      if (!t || t.status !== 'Open') throw new Error('task not open');
      if (Number(priceNEAR) > t.budget) throw new Error('price exceeds budget');
      const list = bids.get(taskId) || [];
      if (list.some((b) => b.agent === agent)) throw new Error('one bid per agent');
      list.push({ agent, priceNEAR: Number(priceNEAR), pitch, etaSec });
      bids.set(taskId, list);
    },

    async acceptBid({ poster, taskId, agent }) {
      const t = tasks.find((x) => x.id === taskId);
      if (!t || t.poster !== poster || t.status !== 'Open') throw new Error('cannot accept');
      const bid = (bids.get(taskId) || []).find((b) => b.agent === agent);
      if (!bid) throw new Error('no such bid');
      t.status = 'Assigned';
      t.assignee = agent;
      t.agreedPrice = bid.priceNEAR;
    },

    async submitResult({ agent, taskId, resultHash, resultUri }) {
      const t = tasks.find((x) => x.id === taskId);
      if (!t || t.assignee !== agent || t.status !== 'Assigned') throw new Error('cannot submit');
      t.status = 'Submitted';
      t.resultHash = resultHash;
      t.resultUri = resultUri;
    },

    async approveAndRate({ poster, taskId, rating }) {
      const t = tasks.find((x) => x.id === taskId);
      if (!t || t.poster !== poster || t.status !== 'Submitted') throw new Error('cannot approve');
      t.status = 'Completed';
      const r = rep(t.assignee);
      r.jobs += 1;
      r.earned += t.agreedPrice;
      r.ratingSum += rating;
      r.ratingCount += 1;
      balances.set(t.assignee, (balances.get(t.assignee) || 0) + t.agreedPrice); // payout
      balances.set(poster, (balances.get(poster) || 0) + (t.budget - t.agreedPrice)); // refund
    },

    async getOpenTasks() {
      return tasks.filter((t) => t.status === 'Open');
    },
    async getTask(taskId) {
      return tasks.find((t) => t.id === taskId);
    },
    async getBids(taskId) {
      return bids.get(taskId) || [];
    },
    async getReputation(accountId) {
      const r = reputation.get(accountId);
      if (!r) return null;
      return {
        jobs_completed: r.jobs,
        jobs_disputed: r.disputes,
        total_earned: r.earned,
        rating_avg: r.ratingCount ? r.ratingSum / r.ratingCount : 0,
      };
    },
    async getLeaderboard() {
      return [...reputation.entries()]
        .map(([agent, r]) => ({
          agent,
          reputation: {
            jobs_completed: r.jobs,
            total_earned: r.earned,
          },
          avg_rating_x100: r.ratingCount ? Math.round((r.ratingSum / r.ratingCount) * 100) : 0,
        }))
        .sort((a, b) => b.avg_rating_x100 - a.avg_rating_x100);
    },
    async getBalanceNEAR(accountId) {
      return Number((balances.get(accountId) || 0).toFixed(4));
    },
  };
}

module.exports = { makeLocalMarket };
