// dotenv is optional: the zero-setup local demo works without node_modules.
try {
  require('dotenv').config();
} catch {
  /* no node_modules — fine for `npm run demo:local` */
}

const cfg = {
  networkId: process.env.NEAR_NETWORK || 'testnet',
  // Failover pool: first URL is primary, the rest are tried when rate-limited.
  // (rpc.testnet.fastnear.com is deprecated by fastnear — kept last as a bonus.)
  nodeUrls: (
    process.env.NEAR_NODE_URLS ||
    [
      process.env.NEAR_NODE_URL || 'https://rpc.testnet.near.org',
      'https://near-testnet.drpc.org',
      'https://rpc.testnet.fastnear.com',
    ].join(',')
  ).split(',').map((s) => s.trim()).filter(Boolean),
  nodeUrl: process.env.NEAR_NODE_URL || 'https://rpc.testnet.near.org',
  contractId: process.env.CONTRACT_ID || '',
  master: {
    accountId: process.env.MASTER_ACCOUNT_ID || '',
    privateKey: process.env.MASTER_PRIVATE_KEY || '',
  },
  poster: {
    accountId: process.env.POSTER_ACCOUNT_ID || '',
    privateKey: process.env.POSTER_PRIVATE_KEY || '',
  },
  workers: [1, 2, 3]
    .map((i) => ({
      accountId: process.env[`WORKER${i}_ACCOUNT_ID`] || '',
      privateKey: process.env[`WORKER${i}_PRIVATE_KEY`] || '',
    }))
    .filter((w) => w.accountId && w.privateKey),
  nearAi: {
    apiKey: process.env.NEAR_AI_API_KEY || '',
    baseUrl: process.env.NEAR_AI_BASE_URL || 'https://cloud-api.near.ai/v1',
    model: process.env.NEAR_AI_MODEL || 'deepseek-ai/DeepSeek-V3.1',
  },
  // Stablecoin bounties: any NEP-141 token works with the v2 contract.
  // Default is the public testnet USDC.e fake (open `mint` for demos).
  stable: {
    tokenId: process.env.USDC_TOKEN_ID || 'usdc.fakes.testnet',
    symbol: process.env.USDC_SYMBOL || 'USDC.e',
    decimals: Number(process.env.USDC_DECIMALS || 6),
  },
};

const PERSONALITIES = [
  {
    name: 'Flash',
    style: 'cheap and fast',
    blurb: 'undercuts everyone, ships rough drafts in seconds',
    priceFactor: 0.35,
    quality: 3,
    etaSec: 30,
  },
  {
    name: 'Sage',
    style: 'premium and thorough',
    blurb: 'charges more, delivers polished work with sources',
    priceFactor: 0.9,
    quality: 5,
    etaSec: 300,
  },
  {
    name: 'Nova',
    style: 'balanced generalist',
    blurb: 'fair price, solid quality, reliable',
    priceFactor: 0.6,
    quality: 4,
    etaSec: 120,
  },
];

const JOBS = [
  {
    title: 'Summarize the NEAR Intents whitepaper for builders',
    spec: 'Write a 200-word summary of how NEAR Intents enables cross-chain settlement, aimed at hackathon builders. Plain language, no marketing fluff.',
    budgetNEAR: '1',
    deadlineSec: 3600,
  },
  {
    title: 'Draft a tagline for an agent-run coffee subscription',
    spec: 'An AI agent runs a coffee subscription business end-to-end: procurement, pricing, delivery. Give me 3 tagline options with a one-line rationale each.',
    budgetNEAR: '0.5',
    deadlineSec: 3600,
  },
  {
    title: 'Security checklist for giving an AI a wallet',
    spec: 'List the 5 most important controls before letting an autonomous agent hold and spend crypto. One sentence each, ordered by risk reduction.',
    budgetNEAR: '2',
    deadlineSec: 3600,
  },
];

module.exports = { cfg, PERSONALITIES, JOBS };
