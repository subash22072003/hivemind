/**
 * Market interface backed by the real HiveMind contract on NEAR testnet.
 *
 * Supports two bounty currencies:
 *   NEAR  — post_task with attached deposit (native escrow)
 *   USDC  — ft_transfer_call on the NEP-141 token (stablecoin escrow)
 */
const nearAPI = require('near-api-js');
const { connect, keyStores, KeyPair, utils } = nearAPI;

const GAS = '30000000000000'; // 30 Tgas — plenty for market calls
const GAS_PAYOUT = '60000000000000'; // 60 Tgas — approve/dispute/cancel/expire may fire two ft_transfers
const FT_CALL_GAS = '100000000000000'; // 100 Tgas — ft_transfer_call runs receiver logic + resolve

/**
 * Free public RPCs are flaky: rate limits (HTTP 429) and transient node
 * errors ("Temporary internal error", code 19) are routine. A live demo
 * cannot die mid-cycle, so chain calls retry with exponential backoff and
 * rotate across the configured endpoint pool on each attempt.
 *
 * IMPORTANT: a transient failure can mean "the tx landed but the response
 * was lost". Contract rejections (FunctionCallError / panics) never match
 * this predicate, so retrying is safe only when paired with the verify
 * functions below — see callContract.
 */
function isTransient(e) {
  const m = String((e && e.message) || e).toLowerCase();
  return (
    m.includes('-429') || m.includes('429') || m.includes('rate limit') ||
    m.includes('temporary internal error') || m.includes('internal error') ||
    m.includes('timeout') || m.includes('timed out') ||
    m.includes('fetch failed') || m.includes('econnreset') || m.includes('etimedout') ||
    m.includes('socket hangup') || m.includes('502') || m.includes('503') || m.includes('504')
  );
}
async function withRetry(fn, what, hooks = {}, attempt = 0) {
  try {
    return await fn(attempt);
  } catch (e) {
    if (!isTransient(e) || attempt >= 5) throw e;
    const waitMs = 1200 * 2 ** attempt; // 1.2s, 2.4s, 4.8s, 9.6s, 19.2s
    if (hooks.onRetry) {
      try { hooks.onRetry({ waitMs, attempt: attempt + 1, what }); } catch { /* never break a run */ }
    }
    await new Promise((r) => setTimeout(r, waitMs));
    return withRetry(fn, what, hooks, attempt + 1);
  }
}

/** Decimal-safe token unit conversion (BigInt only, no floats). */
function toTokenUnits(amount, decimals) {
  const neg = String(amount).startsWith('-');
  const [whole, frac = ''] = String(amount).replace('-', '').split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const v = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
  return (neg ? -v : v).toString();
}
function fromTokenUnits(units, decimals) {
  const s = String(units).padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals) || '0';
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

async function connectAccount(cfg, accountId, privateKey, nodeUrl = cfg.nodeUrl) {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(cfg.networkId, accountId, KeyPair.fromString(privateKey));
  const near = await connect({
    networkId: cfg.networkId,
    nodeUrl,
    deps: { keyStore },
  });
  return near.account(accountId);
}

async function makeNearMarket(cfg, identities, hooks = {}) {
  // identities: { poster: {accountId, privateKey}, workers: [{accountId, privateKey, name}] }
  // hooks.onTx({ methodName, accountId, hash, attachedNEAR }) fires after every confirmed tx.
  // One account map per RPC endpoint; retries rotate across the pool.
  const urls = (cfg.nodeUrls && cfg.nodeUrls.length ? cfg.nodeUrls : [cfg.nodeUrl]);
  const ids = [identities.poster, ...identities.workers];
  const pools = [];
  for (const url of urls) {
    const accounts = new Map();
    for (const id of ids) {
      accounts.set(id.accountId, await connectAccount(cfg, id.accountId, id.privateKey, url));
    }
    pools.push(accounts);
  }
  const accountFor = (accountId, attempt = 0) => pools[attempt % pools.length].get(accountId);
  const anyAccount = (attempt = 0) => pools[attempt % pools.length].values().next().value;

  async function callContract(accountId, contractId, methodName, args, opts = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= 5; attempt++) {
      try {
        const account = accountFor(accountId, attempt);
        if (!account) throw new Error(`No key loaded for ${accountId}`);
        const res = await account.functionCall({
          contractId,
          methodName,
          args,
          gas: opts.gas || GAS,
          attachedDeposit:
            opts.attachedYocto !== undefined
              ? opts.attachedYocto
              : opts.attachedNEAR
                ? utils.format.parseNearAmount(String(opts.attachedNEAR))
                : undefined,
        });
        const hash = res && res.transaction && res.transaction.hash;
        if (hash && hooks.onTx) {
          try { hooks.onTx({ methodName, accountId, hash, attachedNEAR: opts.attachedNEAR || null }); } catch { /* hook must never break a run */ }
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (!isTransient(e) || attempt >= 5) break;
        // A transient error can mean "tx landed, response lost". Re-sending
        // would double-post escrow (seen live: two tasks from one click), so
        // ask the contract whether the goal state was reached first.
        if (opts.verify) {
          try {
            if (await opts.verify()) {
              if (hooks.onLog) {
                try { hooks.onLog(`   ↺ ${methodName} had in fact landed — recovered from lost response, continuing`); } catch { /* noop */ }
              }
              return { recovered: true };
            }
          } catch { /* verification is best-effort; fall through to retry */ }
        }
        const waitMs = 1200 * 2 ** attempt;
        if (hooks.onRetry) {
          try { hooks.onRetry({ waitMs, attempt: attempt + 1, what: methodName }); } catch { /* never break a run */ }
        }
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastErr;
  }
  const call = (accountId, methodName, args, attachedNEAR, opts = {}) =>
    callContract(accountId, cfg.contractId, methodName, args, { ...opts, attachedNEAR });

  async function viewOn(contractId, methodName, args = {}) {
    return withRetry(
      (attempt) => anyAccount(attempt).viewFunction({ contractId, methodName, args }),
      methodName,
      hooks
    );
  }
  const view = (methodName, args = {}) => viewOn(cfg.contractId, methodName, args);

  const stable = cfg.stable || { tokenId: 'usdc.fakes.testnet', symbol: 'USDC.e', decimals: 6 };

  return {
    kind: 'near-testnet',
    contractId: cfg.contractId,
    stableSymbol: stable.symbol,

    async postTask({ poster, title, spec, budgetNEAR, deadlineSec }) {
      const before = Number(await view('get_task_count'));
      await call(
        poster,
        'post_task',
        { title, spec, deadline_seconds: deadlineSec },
        budgetNEAR,
        { verify: async () => Number(await view('get_task_count')) > before }
      );
      return Number(await view('get_task_count'));
    },

    /**
     * Post a task with a stablecoin bounty. The tokens move to the market
     * contract in the same transaction via ft_transfer_call and become the
     * escrow. budgetUnits is the raw base-unit string (see toTokenUnits).
     */
    async postStableTask({ poster, title, spec, budgetUnits, deadlineSec }) {
      const before = Number(await view('get_task_count'));
      await callContract(
        poster,
        stable.tokenId,
        'ft_transfer_call',
        {
          receiver_id: cfg.contractId,
          amount: String(budgetUnits),
          msg: JSON.stringify({ action: 'post_task', title, spec, deadline_seconds: deadlineSec }),
        },
        {
          attachedYocto: '1',
          gas: FT_CALL_GAS,
          verify: async () => Number(await view('get_task_count')) > before,
        }
      );
      return Number(await view('get_task_count'));
    },

    async placeBid({ agent, taskId, priceNEAR, priceUnits, pitch, etaSec }) {
      await call(agent, 'place_bid', {
        task_id: taskId,
        // NEAR tasks: yoctoNEAR via parseNearAmount. Stable tasks: raw token units.
        price: priceUnits !== undefined ? String(priceUnits) : utils.format.parseNearAmount(String(priceNEAR)),
        pitch,
        eta_seconds: etaSec,
      }, undefined, {
        verify: async () => (await view('get_bids', { task_id: taskId })).some((b) => b.agent === agent),
      });
    },

    async acceptBid({ poster, taskId, agent }) {
      await call(poster, 'accept_bid', { task_id: taskId, agent }, undefined, {
        verify: async () => {
          const t = await view('get_task', { task_id: taskId });
          return t && t.status === 'Assigned' && t.assignee === agent;
        },
      });
    },

    async submitResult({ agent, taskId, resultHash, resultUri }) {
      await call(agent, 'submit_result', {
        task_id: taskId,
        result_hash: resultHash,
        result_uri: resultUri,
      }, undefined, {
        verify: async () => {
          const t = await view('get_task', { task_id: taskId });
          return t && (t.status === 'Submitted' || t.status === 'Completed');
        },
      });
    },

    async approveAndRate({ poster, taskId, rating }) {
      await call(poster, 'approve_and_rate', { task_id: taskId, rating }, undefined, {
        gas: GAS_PAYOUT, // stable tasks fire two ft_transfers (payout + refund)
        verify: async () => {
          const t = await view('get_task', { task_id: taskId });
          return t && t.status === 'Completed';
        },
      });
    },

    async getOpenTasks() {
      const tasks = await view('get_tasks', { from_index: 0, limit: 100 });
      return tasks.filter((t) => t.status === 'Open');
    },

    async getTask(taskId) {
      return view('get_task', { task_id: taskId });
    },

    async getBids(taskId) {
      return view('get_bids', { task_id: taskId });
    },

    async getReputation(accountId) {
      return view('get_reputation', { agent: accountId });
    },

    async getLeaderboard() {
      return view('get_leaderboard', { from_index: 0, limit: 50 });
    },

    /** task_id → token account for every stablecoin-escrowed task. */
    async getPayments() {
      return view('get_payments', { from_index: 0, limit: 200 });
    },

    /** Total paid out to agents in the configured stable token (base units). */
    async getStablePaid() {
      return view('get_stable_paid', { token: stable.tokenId });
    },

    /** Raw stable-token balance (base units, string). */
    async getTokenBalance(accountId) {
      const bal = await viewOn(stable.tokenId, 'ft_balance_of', { account_id: accountId });
      return String(bal);
    },

    async getBalanceNEAR(accountId) {
      const bal = await withRetry(
        (attempt) => {
          const account = accountFor(accountId, attempt);
          if (!account) return null;
          return account.getAccountBalance();
        },
        'balance',
        hooks
      );
      if (!bal) return '?';
      return Number(utils.format.formatNearAmount(bal.total, 4));
    },

    nearToYocto: (n) => utils.format.parseNearAmount(String(n)),
    yoctoToNear: (y) => Number(utils.format.formatNearAmount(String(y), 4)),
    toTokenUnits: (n) => toTokenUnits(n, stable.decimals),
    fromTokenUnits: (u) => fromTokenUnits(u, stable.decimals),
  };
}

module.exports = { makeNearMarket, connectAccount, toTokenUnits, fromTokenUnits };
