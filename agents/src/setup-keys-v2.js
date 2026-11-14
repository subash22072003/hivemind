/**
 * Sandboxes the worker agent keys for the v2 contract — this is the security
 * story judges can verify on-chain:
 *
 *   each agent's key may ONLY call place_bid / submit_result on the market
 *   contract, with a capped allowance. It cannot transfer funds, cannot call
 *   any other contract, cannot touch escrow.
 *
 * Adds a new FUNCTION-CALL key to every worker account (signed with the
 * worker's current full-access key) and prints ready-to-paste .env lines.
 * The old full-access keys are left in place; retire them with
 * `node src/retire-worker-fa-keys.js` once a live cycle has passed on the
 * sandboxed keys.
 *
 *   node src/setup-keys-v2.js
 */
const { KeyPair, utils } = require('near-api-js');
const { connectAccount } = require('./market-near');
const { cfg } = require('./config');

const KEY_ALLOWANCE = '0.25'; // NEAR — hundreds of bids/deliveries, nothing more
const METHODS = ['place_bid', 'submit_result'];

async function main() {
  const envLines = [];
  for (let i = 0; i < cfg.workers.length; i++) {
    const w = cfg.workers[i];
    const account = await connectAccount(cfg, w.accountId, w.privateKey);
    const keyPair = KeyPair.fromRandom('ed25519');

    await account.addKey(
      keyPair.getPublicKey().toString(),
      cfg.contractId,
      METHODS,
      utils.format.parseNearAmount(KEY_ALLOWANCE)
    );
    console.log(`✓ ${w.accountId}: sandboxed key added → only [${METHODS.join(', ')}] on ${cfg.contractId}`);

    // Verify on-chain.
    const keys = await account.getAccessKeys();
    const fc = keys.find(
      (k) => k.public_key === keyPair.getPublicKey().toString()
    );
    console.log(`  on-chain permission: ${JSON.stringify(fc && fc.access_key.permission)}`);

    envLines.push([`WORKER${i + 1}_PRIVATE_KEY`, keyPair.toString()]);
  }

  // Write the new keys into .env in place (dotenv keeps the FIRST occurrence,
  // so appending would silently keep the old keys).
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env');
  let envText = fs.readFileSync(envPath, 'utf8');
  for (const [k, v] of envLines) {
    envText = envText.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`);
  }
  fs.writeFileSync(envPath, envText);
  console.log('\n✓ agents/.env updated with the sandboxed worker keys (old FA keys remain on-chain until retired)');
}

main().catch((e) => {
  console.error(`✖ ${String(e.message).split('\n')[0]}`);
  process.exit(1);
});
