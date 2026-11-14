/**
 * NEAR Intents (1Click API) — dry-run a cross-chain payout.
 *
 * After an agent earns NEAR on the market, this shows it could settle its
 * earnings into USDC on another chain (e.g. Base) in one intent — no bridge
 * UX, no CEX. Quotes are fetched with `dry: true`: no funds move, no JWT
 * needed. Tokens are discovered live from the API, nothing hardcoded.
 *
 *   npm run quote            → standalone demo (0.5 NEAR → USDC on Base)
 */
const API = 'https://1click.chaindefuser.com/v0';

async function quoteCrossChainPayout(amountNEAR, recipientLabel = 'the agent', log = console.log) {
  try {
    const tokens = await (await fetch(`${API}/tokens`)).json();
    const origin = tokens.find(
      (t) => t.blockchain === 'near' && ['wNEAR', 'NEAR'].includes(t.symbol)
    );
    const dest = tokens.find((t) => t.blockchain === 'base' && t.symbol === 'USDC');
    if (!origin || !dest) throw new Error('could not find wNEAR/USDC-Base in token list');

    const amount = BigInt(Math.round(Number(amountNEAR) * 1e24)).toString();
    const body = {
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: origin.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: dest.assetId,
      recipientType: 'DESTINATION_CHAIN',
      // Demo EVM payout address (dry quote only — no funds ever move).
      // In production this is the agent's own chain-abstracted address.
      recipient: process.env.INTENTS_DEMO_EVM_ADDRESS || '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      refundTo: 'hivemind.near',
      refundType: 'ORIGIN_CHAIN',
      deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      amount,
    };
    const res = await fetch(`${API}/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`quote API ${res.status}`);
    const data = await res.json();
    const out = data.quote?.amountOutFormatted ?? data.quote?.amountOut;
    log(
      `   🌐 NEAR Intents (dry quote): ${amountNEAR} NEAR → ${out} USDC on Base — ` +
        `${recipientLabel} can cash out cross-chain in one intent, no bridge UX`
    );
    return data.quote;
  } catch (e) {
    log(`   ⚠️  Intents dry quote skipped (${e.message})`);
    return null;
  }
}

if (require.main === module) {
  quoteCrossChainPayout('0.5', 'demo agent').then(() => process.exit(0));
}

module.exports = { quoteCrossChainPayout };
