/**
 * One-time stablecoin setup for the v2 market contract:
 *   1. Registers storage on the USDC.e token for the market, poster and
 *      every worker (NEP-145 — required before any of them can hold USDC.e).
 *   2. Mints test USDC.e to the poster account (public faucet method on the
 *      near-examples fake token; harmless to re-run).
 *   3. Prints resulting balances.
 *
 *   node src/setup-stable.js
 */
const { utils } = require('near-api-js');
const { connectAccount } = require('./market-near');
const { cfg } = require('./config');

const USDC = process.env.USDC_TOKEN_ID || 'usdc.fakes.testnet';
const MINT_AMOUNT_USDC = '1000'; // 1,000 USDC — plenty of demo bounties
const STORAGE_DEPOSIT = '0.00125';

async function main() {
  const master = await connectAccount(cfg, cfg.master.accountId, cfg.master.privateKey);
  const targets = [cfg.contractId, cfg.poster.accountId, ...cfg.workers.map((w) => w.accountId)];

  console.log(`token: ${USDC}`);
  // 1. Storage registration (anyone may pay for anyone — master funds it).
  for (const t of targets) {
    try {
      await master.functionCall({
        contractId: USDC,
        methodName: 'storage_deposit',
        args: { account_id: t },
        gas: '30000000000000',
        attachedDeposit: utils.format.parseNearAmount(STORAGE_DEPOSIT),
      });
      console.log(`✓ storage registered: ${t}`);
    } catch (e) {
      console.log(`• storage_deposit(${t}): ${String(e.message).split('\n')[0].slice(0, 140)}`);
    }
  }

  // 2. Mint test USDC.e to the poster.
  const poster = await connectAccount(cfg, cfg.poster.accountId, cfg.poster.privateKey);
  const amount = BigInt(MINT_AMOUNT_USDC) * 10n ** 6n;
  try {
    await poster.functionCall({
      contractId: USDC,
      methodName: 'mint',
      args: { account_id: cfg.poster.accountId, amount: amount.toString() },
      gas: '30000000000000',
    });
    console.log(`✓ minted ${MINT_AMOUNT_USDC} USDC.e to ${cfg.poster.accountId}`);
  } catch (e) {
    console.log(`✖ ft_mint failed: ${String(e.message).split('\n')[0].slice(0, 200)}`);
    console.log('  → If the fake token cannot be minted, deploy the mock FT in contract-ft/ and set USDC_TOKEN_ID.');
  }

  // 3. Balances.
  for (const t of targets) {
    try {
      const bal = await master.viewFunction({ contractId: USDC, methodName: 'ft_balance_of', args: { account_id: t } });
      console.log(`   balance ${t}: ${Number(bal) / 1e6} USDC.e`);
    } catch (e) {
      console.log(`   balance ${t}: <error ${String(e.message).split('\n')[0].slice(0, 80)}>`);
    }
  }
}

main().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
