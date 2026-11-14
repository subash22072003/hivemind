/**
 * Deploys the stablecoin-enabled market contract (v2) to market2.<master>.
 *
 * Unlike the original deploy.js, the contract account's key is PERSISTED to
 * .env (CONTRACT_PRIVATE_KEY) so the contract stays upgradable.
 *
 *   node src/deploy-v2.js
 */
const fs = require('fs');
const path = require('path');
const { KeyPair, utils } = require('near-api-js');
const { connectAccount } = require('./market-near');
const { cfg } = require('./config');

async function main() {
  if (!cfg.master.accountId) throw new Error('Set MASTER_ACCOUNT_ID / MASTER_PRIVATE_KEY in .env');
  const contractId = process.env.NEW_CONTRACT_ID || cfg.contractId;
  if (!contractId) throw new Error('Set CONTRACT_ID in .env');

  const wasmPath = path.join(__dirname, '..', '..', 'contract', 'target', 'wasm32-unknown-unknown', 'release', 'hivemind_market.wasm');
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`Wasm not found at ${wasmPath} — run cargo build --target wasm32-unknown-unknown --release in contract/ first`);
  }

  // Persistent contract key: reuse the one in .env on redeploys, otherwise
  // generate and SAVE it (the v1 deploy lost its key — never again).
  let keyPair;
  if (process.env.CONTRACT_PRIVATE_KEY) {
    keyPair = KeyPair.fromString(process.env.CONTRACT_PRIVATE_KEY);
    console.log('• reusing CONTRACT_PRIVATE_KEY from .env');
  } else {
    keyPair = KeyPair.fromRandom('ed25519');
    fs.appendFileSync(
      path.join(__dirname, '..', '.env'),
      `\n# ---- market contract account key (persisted so the contract stays upgradable) ----\nCONTRACT_PRIVATE_KEY=${keyPair.toString()}\n`
    );
    console.log('✓ contract account key persisted to .env');
  }

  const master = await connectAccount(cfg, cfg.master.accountId, cfg.master.privateKey);
  const bal = await master.getAccountBalance();
  console.log(`master ${cfg.master.accountId} balance: ${utils.format.formatNearAmount(bal.total, 2)} NEAR`);

  try {
    await master.createAccount(contractId, keyPair.getPublicKey().toString(), utils.format.parseNearAmount('6.5'));
    console.log(`✓ created ${contractId} with 6.5 NEAR`);
  } catch (e) {
    console.log(`• ${contractId} may already exist (${String(e.message).split('\n')[0]}) — continuing`);
  }

  const nearAPI = require('near-api-js');
  const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
  await keyStore.setKey(cfg.networkId, contractId, keyPair);
  const near = await nearAPI.connect({ networkId: cfg.networkId, nodeUrl: cfg.nodeUrl, deps: { keyStore } });
  const contractAccount = await near.account(contractId);

  await contractAccount.deployContract(fs.readFileSync(wasmPath));
  console.log('✓ contract deployed');

  try {
    await contractAccount.functionCall({ contractId, methodName: 'new', args: {}, gas: '30000000000000' });
    console.log('✓ contract initialized (new)');
  } catch (e) {
    console.log(`• init skipped (${String(e.message).split('\n')[0].slice(0, 120)})`);
  }

  const stats = await contractAccount.viewFunction({ contractId, methodName: 'get_stats', args: {} });
  console.log('✓ on-chain stats:', JSON.stringify(stats));
  console.log(`\nDone. Explorer: https://testnet.nearblocks.io/address/${contractId}`);
}

main().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
