# Pilot runbook: PatronVault on Base mainnet, from the operator's Mac

Everything record-bearing here runs from your shell: the deploy, the payee's floor, the Worker's secret and deploy. The container that wrote this cannot and must not do any of it. Paste blocks carry bare commands, one per line, each block opening with its `cd`; nothing here puts a key on a command line.

What you need before step 1:

| Thing | Where it comes from |
| --- | --- |
| Foundry 1.5.x (`forge`, `cast`) | `foundryup` |
| A Base RPC URL in `$RPC` | `export RPC=https://mainnet.base.org` (public) or your own |
| A deploy signer | a keystore account (`cast wallet import deployer --interactive`) or a Ledger (`--ledger`); funded with a little ETH on Base (the deploy is about 5.3M gas, under 0.0001 ETH at Base prices) |
| The payee address | the Scan Room's payee wallet: the one creator the vault will route to; it must be able to send one transaction (`setCreatorMin`) |
| The sink address | a cold DJZS address that is NOT the payee: parked exit buffers go there if the payee is ever refused |
| The keeper key | a fresh key that will only ever hold gas (product doc R15); funded with 0.01 ETH on Base after the Worker is deployed |
| Cloudflare | `wrangler login` done; the `djzs.ai` zone on the account |

## 1. Pull, build, prove

```
cd ~/djzs-AI
git checkout main
git pull --ff-only origin main
cd ~/djzs-AI/packages/patronvault
forge test
FORK_RPC_URL=$RPC forge test --match-path test/fork/PatronVault.aave.t.sol -vv
```

Expect 102 passed offline and 3 passed on the fork, the fork log showing a month of real interest paying the payee 10.000000 USDC. Anything else: stop.

## 2. Screen the source, day of

```
cd ~/djzs-AI/packages/patronvault
SOURCE=0xC768c589647798a6EE01A91FdE98EF2ed046DBD6 USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 forge script script/Screen.s.sol --rpc-url $RPC
cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "balanceOf(address)(uint256)" 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB --rpc-url $RPC
cast call 0xC768c589647798a6EE01A91FdE98EF2ed046DBD6 "maxDeposit(address)(uint256)" 0x0000000000000000000000000000000000000001 --rpc-url $RPC
cast call 0xC768c589647798a6EE01A91FdE98EF2ed046DBD6 "paused()(bool)" --rpc-url $RPC
```

Expect `asset ok: true`, `round trip ok: true`, the pool's available USDC (second line) at least 490,000,000,000 units (10x the 49,000 cap), `maxDeposit` above 49,000,000,000, `paused` false. The script's own "liquidity >= 10x" line reads the wrapper's `totalAssets`, the wrong figure for a wrapper, and prints false; ignore that one line, the second command is the real figure (`docs/screen-2026-10-21.md`). Then the hand checks the screen cannot make: on BaseScan, the wrapper's proxy admin `0xc85b1e333aecc99340b2320493fe2d22b8734795` is Aave's ProxyAdmin under the governance executor; the reserve is not frozen; note the day's supply rate. Write the readings into a dated file next to the screen record.

## 3. The terms and their hash

```
cd ~/djzs-AI/packages/patronvault
forge script script/TermsHash.s.sol
```

Expect `0x8a5957a726916602b62f775a8b2c9e84efe3bcb3268a01980c1477625e50c8e0` for `terms/member-terms-v1.md` (3,759 bytes). That text is what the Worker serves at `/patron/terms`, byte for byte, and what the page hashes into every join. Do not touch the file after this step; a changed byte is a changed hash and every join would revert `BadTerms` until the Worker is redeployed.

## 4. Deploy: dry run, then for real

Set the parameters once in the shell (no key among them):

```
cd ~/djzs-AI/packages/patronvault
export SOURCE=0xC768c589647798a6EE01A91FdE98EF2ed046DBD6
export EXPECT_ASSET=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
export MIN_DEPOSIT=3500000000
export MAX_TOTAL_PRINCIPAL=49000000000
export JOIN_DEADLINE=<unix seconds of day 60 of the pilot>
export YIELD_SINK=<the cold DJZS sink address>
export CREATORS=<the Scan Room payee address>
export FEE_BPS=0
forge script script/Deploy.s.sol --rpc-url $RPC
```

The dry run prints every parameter back, the registry it will deploy with the payee as its one entry, the terms hash, and the gas. Read each line against the table in README "Pilot parameters". The script refuses a deadline in the past and a fee with the v1 terms.

Then the same with a signer, one of:

```
cd ~/djzs-AI/packages/patronvault
forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --account deployer
```

```
cd ~/djzs-AI/packages/patronvault
forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --ledger
```

Record from the output: the PatronVault address, the FixedCreators address, and the deploy block (`forge script` prints the transactions; `cast receipt <tx> blockNumber --rpc-url $RPC` gives the block). Verify both contracts on BaseScan (`forge verify-contract` with a BaseScan key in your environment, or the site's upload form) and confirm, reading the verified source, that there is no owner, pause or upgrade function. There is none to find.

## 5. The payee's floor, before any announcement

From the payee wallet (keystore or Ledger), once:

```
cd ~/djzs-AI/packages/patronvault
cast send <PatronVault address> "setCreatorMin(uint96)" 10000000 --rpc-url $RPC --account payee
```

A route that lands before the floor is grandfathered forever, so this goes before the address is public. The gate reads `isPatronAtLeast(payee, member, 10000000)` regardless.

## 6. The Worker: keeper, status API, exact-bytes terms, member page

The Worker ships the working tree at `origin/main`, nothing else (the predeploy guard refuses a dirty tree or any other HEAD), so the vault's addresses go into `wrangler.toml` through a pull request first.

```
cd ~/djzs-AI/packages/patronvault/worker
npm install
npx wrangler kv namespace create KEEPER_KV
```

Edit `wrangler.toml` on a branch: paste the namespace id into `[[kv_namespaces]]`; set `VAULT_ADDRESS`, `DEPLOY_BLOCK` and `PAYEE_ADDRESS` under `[vars]`; leave `DRY_RUN = "true"`. Open the PR, merge it, then:

```
cd ~/djzs-AI
git checkout main
git pull --ff-only origin main
cd ~/djzs-AI/packages/patronvault/worker
npm run check
npm test
npm run dry
npx wrangler secret put KEEPER_KEY
npm run deploy
```

`wrangler secret put` prompts for the value; paste the keeper key there, never on the command line. Then fund the keeper address with 0.01 ETH on Base (the address is in `/patron/health` as `lastRun.keeper` after the first cron, or derive it with `cast wallet address --account keeper` if it is a keystore account).

Probe, in this order, before trusting the route:

```
curl -s https://patronvault.<your account>.workers.dev/patron/health
curl -s https://scan.djzs.ai/patron/health
curl -sI https://scan.djzs.ai/patron/terms
```

`ok: true` and `termsMatch: true` on both hosts. The canonical hostname can lag the workers.dev alias by an edge-cache window (seen before on mcp.djzs.ai): a 404 on the canonical host with a 200 on the alias is not a rollback condition, it clears on its own. A `termsMatch: false` is: the served text does not hash to the vault's `termsHash`, and every join from the page would revert.

Turn the keeper on only when the first real member has joined: flip `DRY_RUN` to `"false"` in `wrangler.toml` through the same branch, merge, pull, `npm run deploy`. Until then every cron run records what it would have done in `/patron/health` under `lastRun` and sends nothing. The keeper settles each member once their period has elapsed, with a fixed gas budget (2M plus 600k per member; never the node's estimate), and forwards parked exit buffers to the sink when there are any.

Rollback for the Worker is `npx wrangler rollback <previous version id>` from this folder; name the previous version before deploying (`npx wrangler deployments list`). The contract has no rollback: a wrong deployment is abandoned, members leave, and a new one is deployed.

## 7. Smoke test from a DJ wallet

From a wallet excluded from every count, on the page at `https://scan.djzs.ai/patron/`: connect, approve and join 3,500 USDC, set the 10 USDC route, press settle (the member may settle themselves at any time), try to withdraw 1 USDC (the page refuses before signing: below the minimum, by design), leave. The deposit comes back to the unit or two of the source's rounding; the yield buffer, a few cents after minutes, goes to the payee. Read `/patron/health` afterwards: `memberCount` back to 0, `sinkShares` 0.

## 8. Publish

Together, in one place, before the first invitation: the vault address, the registry address, the source address, the terms hash, a link to `/patron/terms`, and the pilot parameters table. Then the pledge page, then the day-one checklist in the pilot handoff doc, all ten boxes.

## What can go wrong, and the honest answer

| Symptom | Meaning | Action |
| --- | --- | --- |
| `/patron/health` `termsMatch: false` | the Worker serves a text that is not the one the vault was deployed with | redeploy the Worker from the commit the vault was deployed from; nothing on chain changes |
| `lastRun.lowBalance: true` | the keeper is under 0.002 ETH | send gas to the keeper address |
| `lastRun.skipped` with `InsufficientGas` or `SourceOutOfGas` | the budget is too low for this source, or the source needs more than 1.5M per withdraw | raise `GAS_PER_MEMBER` in `src/run.ts` for the first; the second means the source cannot be used and payments stop loudly, never silently |
| a member reads `inShortfall: true` seconds after joining | the source's one-share deposit rounding | nothing; interest covers it within minutes |
| `CreatorUnpaid` events with the payee not blacklisted and the source liquid | should not happen since v1.2: a starved call reverts instead | read the transaction; file it |
| Aave pauses the reserve | `maxWithdraw` reads 0: every payment held, no exits, parked buffers wait | nothing to do but wait; terms clause 4 and 8 say so |
