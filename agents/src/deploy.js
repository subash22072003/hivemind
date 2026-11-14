/**
 * One-shot deploy helper: creates market.<master> sub-account, deploys the
 * compiled wasm, and initializes the contract.
 *
 *   node src/deploy.js
 */
const fs = require('fs');
const path = require('path');
const { KeyPair, utils } = require('near-api-js');
const { connectAccount } = require('./market-near');
const { cfg } = require('./config');

async function main() {
  if (!cfg.master.accountId) throw new Error('Set MASTER_ACCOUNT_ID / MASTER_PRIVATE_KEY in .env');
  if (!cfg.contractId) throw new Error('Set CONTRACT_ID in .env');

  const wasmPath = path.join(__dirname, '..', '..', 'contract', 'target', 'wasm32-unknown-unknown', 'release', 'hivemind_market.wasm');
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`Wasm not found at ${wasmPath} — run \`cargo build --target wasm32-unknown-unknown --release\` in contract/ first`);
  }

  const master = await connectAccount(cfg, cfg.master.accountId, cfg.master.privateKey);
  const bal = await master.getAccountBalance();
  console.log(`master ${cfg.master.accountId} balance: ${utils.format.formatNearAmount(bal.total, 2)} NEAR`);

  // 1. Create the contract account (idempotent-ish)
  const contractKey = KeyPair.fromRandom('ed25519');
  try {
    await master.createAccount(cfg.contractId, contractKey.getPublicKey().toString(), utils.format.parseNearAmount('6'));
    console.log(`✓ created ${cfg.contractId} with 6 NEAR`);
  } catch (e) {
    console.log(`• ${cfg.contractId} may already exist (${String(e.message).split('\n')[0]}) — continuing`);
  }

  // 2. Deploy wasm from the contract account itself
  const contractAccount = await (async () => {
    const nearAPI = require('near-api-js');
    const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
    await keyStore.setKey(cfg.networkId, cfg.contractId, contractKey);
    const near = await nearAPI.connect({ networkId: cfg.networkId, nodeUrl: cfg.nodeUrl, deps: { keyStore } });
    return near.account(cfg.contractId);
  })();

  try {
    await contractAccount.deployContract(fs.readFileSync(wasmPath));
    console.log('✓ contract deployed');
  } catch (e) {
    // If the account was created earlier without this exact key, deploy via master is not possible;
    // surface a clear message.
    throw new Error(`deploy failed: ${String(e.message).split('\n')[0]}`);
  }

  // 3. Initialize
  try {
    await contractAccount.functionCall({ contractId: cfg.contractId, methodName: 'new', args: {}, gas: '30000000000000' });
    console.log('✓ contract initialized (new)');
  } catch (e) {
    console.log(`• init skipped (${String(e.message).split('\n')[0].slice(0, 120)})`);
  }

  const stats = await contractAccount.viewFunction({ contractId: cfg.contractId, methodName: 'get_stats', args: {} });
  console.log('✓ on-chain stats:', JSON.stringify(stats));
  console.log(`\nDone. Explorer: https://testnet.nearblocks.io/address/${cfg.contractId}`);
}

main().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
