# Submission checklist (deadline: 2026-11-14 23:59 UTC)

Do these in order. The human performs steps 2, 4 and 5.

- [ ] 1. `git init && git add -A && git commit` locally (repo can stay private while building). `.gitignore` already excludes `.env`, `agents/.faucet-key.json`, key files and build artifacts — run `git status --ignored` and confirm no secrets are staged before pushing.
- [ ] 2. **Human:** push to GitHub and make the repository PUBLIC
- [ ] 3. Record the demo video per `docs/DEMO-SCRIPT.md`
- [ ] 4. **Human:** post the demo on X — text says it was built at NEAR HACKATHON, tags `@NEARProtocol` and `#NEARHackathon`, video attached, repo + dashboard linked
- [ ] 5. **Human:** submit via https://nearhackathon.com/#apply (or the API) — one submission only; fixes go through https://nearhackathon.com/request-changes

## Submission payload fields to collect from the human

| Field | Notes |
|---|---|
| projectName | `HiveMind` (2–80 chars) |
| leadName | team lead's name |
| email | max 160 chars; at most 2 submissions per email |
| size | one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+` |
| tracks | `["swarms","agents","security","business","open"]` |
| nearAddress | mainnet payout account, e.g. `team.near` — create in any NEAR wallet; never invent one |
| projectUrl | public repo URL |
| demoUrl | public X post URL |
| idea | 20–2000 chars — draft below |
| consent | human must agree to the contact notice verbatim |

## Draft `idea` text (edit before sending)

> Freelance markets assume humans on both sides. HiveMind is a labor market where AI agents are the workforce: anyone posts a task with a bounty locked in smart-contract escrow — NEAR or USDC.e stablecoins via NEP-141 `ft_transfer_call` — autonomous agents bid with price/pitch/ETA, the poster hires weighing on-chain reputation, and escrow pays out on verified delivery. Agents run on NEAR sub-accounts with function-call keys restricted to bid/submit — they can earn but never touch escrowed funds. Reputation is portable on-chain state any market can read. Live on NEAR testnet (`market2.hivemind-4qpeae.testnet`) with completed USDC.e and NEAR payout cycles; cross-chain cash-out is shown via NEAR Intents dry quotes (NEAR → USDC on Base); agent reasoning runs on NEAR AI Cloud. Includes a Rust contract (near-sdk 5), a Node agent swarm, and a live dashboard.

## requestId

Generate once, keep it for retries: `node -e "console.log(crypto.randomUUID())"`. Do not commit the payload anywhere.
