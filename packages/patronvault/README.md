# PatronVault v1.2

One deposit, many creators. A member parks USDC once. The vault lends it through one ERC-4626 yield source and streams only the interest to the creators the member routes it to, at an amount per 30 days the member sets. The deposit comes back whenever the member asks.

The promise, word for word:

> We never spend your deposit. Only the interest it earns is paid out. Withdraw the deposit any time.

Built 2026-10-15 for DJZS AI, LLC; cold-reviewed and hardened 2026-10-21 (`docs/review-2026-10-21.md`). Solidity 0.8.28, Foundry (forge-std 1.17.0 vendored under `lib/`). No other dependencies. MIT. Design record: the DJZS Patron Vault handoff doc and the "PatronVault: pilot to product" doc (internal, Claude Docs).

```
cd packages/patronvault
forge test
```

## How a month works

1. A member approves USDC and calls `join(amount, termsHash)`. The transaction quotes the hash of the exact terms text; that is the consent record. The vault deposits the USDC into the yield source and books the shares to that member alone.
2. The member calls `setRoute(creator, amountPerPeriod)` for each creator they support. Up to 16 routes. A creator can publish a floor with `setCreatorMin`; the member decides the amount.
3. `settle(member)` accrues every route to the second, then pays creators out of the member's yield shares only, pro rata if the yield is short. The shares that back the principal are never burned by a payout. The member may settle themselves at any time; anyone else once per `settleInterval` (a day for a 30-day period). The keeper in `worker/` settles each member once per period, on their own anniversary.
4. `isPatron(creator, member)` is true while the member routes to that creator and the yield available right now covers what all their routes are owed right now (95% or better), computed live. Creators gate on that, or on `isPatronAtLeast(creator, member, floor)` with their own floor.
5. The deposit itself: `withdraw(amount)` or `leave()`, any time, no lock, no fee. What happens to interest the member did not route depends on the mode the vault was deployed in (next section).

## Two modes, one constructor argument

| | `yieldSink = 0` (members keep yield) | `yieldSink` set (principal-only) |
| --- | --- | --- |
| Unrouted interest | the member's: `claimYield(amount)` any time | stays in the position as a buffer for the member's routes; `claimYield` reverts |
| A thin month | creators get less, member flagged unfunded | the buffer tops it up first |
| On leave | member gets deposit plus unrouted interest | member gets the deposit first; the buffer goes to the member's routes pro rata to their amounts, or to `yieldSink` when there are none; what the source cannot pay that day, or a recipient refuses, is parked for the sink (`forwardSink()`) |
| Who can be a creator | any address | only addresses the vault's `creatorRegistry` lists (the pilot: `FixedCreators([the Scan Room payee])`); without a registry a member could route to their own second wallet |
| Member ever receives interest | yes | never, beyond sub-share rounding dust on withdrawals and exit, disclosed in the terms |
| Legal posture | the member earns a return through the vault; counsel question | matches the pilot's standing ruling: principal back, never yield |

The pilot runs principal-only (`yieldSink` = the Scan Room payee, which is also the only route), because the handoff doc's disclosures already say "what you get back: your deposit, never yield". Which mode the general product ships in is open ruling R8. The terms text in `terms/` is written for principal-only; a members-keep-yield deployment needs its own clause 2.

## What the code enforces

| # | Rule | Where |
| --- | --- | --- |
| 1 | No owner, no pause, no upgrade. Every parameter is a constructor argument. | whole contract |
| 2 | Every member's position is isolated: own shares, own principal, own yield. | `Member` struct, `_settle` |
| 3 | A payout only ever burns shares above `previewWithdraw(principal)`, the shares it takes to redeem the principal rounded up. | `_yieldShares`, `_fromYield` |
| 4 | Nothing is owed against principal. Yield that cannot cover a route is forgiven and the member is flagged unfunded. `isPatron` does not trust the flag: it recomputes coverage live, so a member cannot reset it by juggling routes, and a creator's gate is as fresh as the block it reads. | `_distribute`, `_isPatron` |
| 5 | Only the member's own transaction creates, changes or removes a route. | `setRoute` |
| 6 | Unrouted yield belongs to the member. | `claimYield` |
| 7 | Accrual is exact. `carry` keeps the sub-unit remainder, so settling every block pays a creator the same as settling once a month. Each settle does cost the member up to one source share per route to the source's own rounding, so a third party may settle a member only once per `settleInterval` (`period / 30`); the member themselves at any time. | `_accrue`, `settle` |
| 8 | A source that cannot pay today (illiquid) holds everything the yield covered; it is paid at the next settle, not forgiven. The pro-rata floors fall on the forgiven side only when yield is short. A route cannot be removed while the source still owes on it. A held amount survives only while yield keeps covering it: a later shortfall settle forgives it with the rest. A source whose `maxWithdraw` view reverts is treated as illiquid, never as a trap. | `_distribute`, `setRoute`, `_liquid` |
| 9 | A creator address the token refuses (a Circle freeze) never traps the member: the payment is held, every member action still works, and the route is removable with the held amount forgiven. On leave, every amount a route was still owed is reported as `CreatorForgiven`. | `_pay`, `setRoute`, `_leave` |
| 10 | Optional pilot limits: a cap on total principal and a join deadline. 0 disables each. | `_checkCap`, `join` |
| 11 | Principal-only mode (`yieldSink` set): members cannot claim yield; on leave the buffer is forwarded to their routes, with the same one-share-per-recipient rounding guard, after the member's own deposit has been given room in the source's liquidity. What cannot go out that day, or a recipient refuses, is parked as `sinkShares`; `forwardSink()` delivers it to the sink later, anyone may call it. Nothing parked ever reaches the member, and no exit can be trapped. | `_forwardYield`, `_forwardTo`, `forwardSink` |
| 12 | Protocol fee: `feeBps` of every creator payment, fixed at deployment, hard-capped at `MAX_FEE_BPS` (10%). Taken only on what is actually paid, never from principal, never on the exit buffer in principal-only mode. The fee's worth of shares moves into a pool; `collectFees()` is permissionless. | `_pay`, `collectFees` |
| 13 | One-transaction join: `joinWithPermit` takes a USDC permit (ERC-7597 bytes signature, EOA or smart wallet) and routes. A front-run permit does not break it: the allowance is there either way. | `joinWithPermit` |
| 14 | Batch: `joinAndRoute`, `setRoutes` (one settle, all or nothing), `settleMany` for the keeper (skips non-members and the recently settled instead of reverting). | `_applyRoutes`, `settleMany` |
| 15 | A payment can fail only by being refused, never by being starved of gas. Every source call that is caught on failure gets exactly `PAYOUT_GAS` (1.5M) and the caller must hold that much first, or the whole call reverts `InsufficientGas`; a call that consumed the whole stipend reverts `SourceOutOfGas`. Without this, `eth_estimateGas` finds the cheapest "success": the source call out of gas, caught, the creator silently unpaid (seen on a Base fork, `docs/review-2026-10-21.md` F14), and a member could forgive a creator with a gas-tuned removal (B's L1). A source that needs more than 1.5M gas per withdraw cannot be used. | `_pay`, `_forwardTo`, `_requirePayoutGas`, `_requireNotStarved` |
| 16 | The vault, the source and the token are never recipients: not as a creator, a sink or a fee recipient. USDC sent there could never leave again. | `_setRoute`, constructor |
| 17 | Optional creator registry: when set, routes may only go to addresses it lists; removal never consults it. `FixedCreators` is an immutable list with no owner. | `_requireCreator`, `src/FixedCreators.sol` |

What the code cannot promise: the yield source. If the source loses money, every share holder loses pro rata, this vault included, and each member's loss is their own (`withdraw` and `leave` are pro rata in a shortfall; `settle` pays nothing). The source is chosen once, at deployment, against the screening rules in the handoff doc, and cannot be changed afterwards. A deprecated source means members leave and join a new vault; there is no migration function because there is no admin.

## Exactness and rounding

ERC-4626 rounds every deposit against the depositor by at most one share. That is the only way a healthy position can read below its principal, and it is bounded by one share per deposit: about 0.000001 USDC on Aave's wrapper (one share is about 1.15 units there), far less on Morpho vaults (18-decimal shares). The vault's own accounting is exact: `test/PatronVault.invariants.t.sol` proves `shares + deposits >= previewWithdraw(principal)` for every member after any sequence of actions, as long as the source has not lost money.

What that rounding looks like from outside, all of it disclosed in the terms: a position reads a unit or two below its deposit for the first seconds after a join (`inShortfall` is true until interest covers one share); a partial `withdraw` can deliver up to one share plus one unit less than asked while principal is debited in full, the difference staying in the position; a member in principal-only mode can end up with a few units of sub-share dust after withdrawals and on exit; a creator's payment carries up to one share of rounding per settle, borne by the member. None of it is a payment of interest, and none of it is ever a share that backs principal.

The source must satisfy `previewRedeem(previewWithdraw(x)) >= x`. OpenZeppelin ERC-4626, Morpho MetaMorpho and Aave's StataTokenV2 all do. `script/Screen.s.sol` checks it on a fork before you deploy against anything; `docs/screen-2026-10-21.md` is the run against the Aave wrapper, and `test/fork/PatronVault.aave.t.sol` runs a whole pilot month against it on a fork.

Rewards that a source's incentive programmes (Aave Merit, Morpho URD) pay to the vault's address are unclaimable: there is no sweep because there is no admin. Size on the base rate only. A fee recipient that Circle freezes strands the fee pool, members unaffected; choose it accordingly.

## Contract surface

| Call | Who | Does |
| --- | --- | --- |
| `join(amount, terms)` | member | first deposit, at least `minDeposit`; `terms` must equal `termsHash` |
| `joinAndRoute(amount, terms, routes[])` | member | join and set routes in one transaction |
| `joinWithPermit(amount, terms, deadline, signature, routes[])` | member | the same with a USDC permit instead of a prior approve |
| `deposit(amount)` | member | top up (settles first) |
| `withdraw(amount)` | member | part of the deposit back; remainder is 0 or at least `minDeposit`; yield stays |
| `claimYield(amount)` | member | unrouted yield out (settles first); reverts in principal-only mode |
| `leave()` | member | settle, redeem everything, clear routes |
| `setRoute(creator, amountPerPeriod)` | member | add, change, or remove with 0 (settles first) |
| `setRoutes(routes[])` | member | several of the above, settled once, all or nothing |
| `setCreatorMin(amountPerPeriod)` | creator | floor for new or changed routes; removal is always allowed |
| `settle(member)` | the member any time; anyone else once per `settleInterval` | accrue and pay that member's routes from yield; `SettleTooSoon` otherwise |
| `settleMany(members[])` | anyone, usually the keeper | the same over a batch; non-members and the recently settled are skipped |
| `collectFees()` | anyone | redeem the fee pool to `feeRecipient` |
| `isPatron(creator, member)` | view | routed, and the yield available now covers what is owed now (live) |
| `isPatronAtLeast(creator, member, min)` | view | the same, with the route at least `min` per period (a gate's own floor) |
| `forwardSink()` | anyone | deliver parked exit buffers to `yieldSink`, as much as the source can pay today |
| `previewSettle(member)` | view | owed, how much yield covers, how much the source can pay today; the same reserve `settle` uses, fee or not |
| `claimableYield(member)` | view | a lower bound that `claimYield` will accept, fee or not, liquidity cap or not (fuzzed) |
| `positionValue`, `inShortfall`, `memberOf`, `routesOf`, `creatorPaid`, `totalPrincipal`, `memberCount`, `feeShares`, `sinkShares`, `creatorRegistry` | view | state |

Constructor: `(source, minDeposit, period, termsHash, maxTotalPrincipal, joinDeadline, yieldSink, feeBps, feeRecipient, creatorRegistry)`. The asset is read from `source.asset()`. `feeBps` above 1,000 reverts; a nonzero fee needs a recipient; neither the sink nor the fee recipient may be the vault, the source or the token; `creatorRegistry` 0 means any address may be a creator. `settleInterval` is `period / 30`.

Every settle emits `Settled(member, owed, fromYield, paid, funded)` where `paid` is what actually reached creators in that settle, and `CreatorPaid` / `CreatorUnpaid` per route.

## Pilot parameters (Scan Room patron tier)

From the handoff doc, open rulings R2, R3 and R7 pending DJ's confirmation:

| Parameter | Value | Why |
| --- | --- | --- |
| source | Aave v3 Base USDC wrapper `0xC768c589647798a6EE01A91FdE98EF2ed046DBD6`, or the higher-ranked source that passes the screen | R2 |
| asset | native USDC on Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | rule 1 |
| minDeposit | 3,500 USDC | 10 USDC per 30 days stays funded (95% line) down to a 3.31% base rate and fully funded from 3.48%, on a 365-day year; 3,000 only clears the 95% line above 3.86%. The Aave wrapper paid 3.74% over the forked month of 2026-10-21 |
| period | 30 days | matches the cash rail |
| route | 10 USDC per 30 days to the Scan Room payee, which sets `creatorMin` to the same | like for like with the cash rail |
| maxTotalPrincipal | 49,000 USDC (14 memberships at the minimum) | R3, inside the $50,000 line counting deposits |
| joinDeadline | day 60 of the pilot | R4 |
| yieldSink | a cold DJZS address, not the payee (principal-only mode; parked buffers go there if the payee is ever refused) | R8, review B I3 |
| creatorRegistry | `FixedCreators([the Scan Room payee])`, deployed by the same script (`CREATORS=<payee>`) | review B M1 |
| feeBps, feeRecipient | 0 for the pilot; the product vault 500 (5%) to a DJZS fee address, with `terms/member-terms-v1.1.md` | R9, ruled 2026-10-21 |

## Tests

```
forge test                                   # 82 unit and fuzz tests (46 core, 17 product, 19 review); 8 invariants in each mode plus I9 in principal-only; two walks
forge test -vv                               # shows the walks' totals: creators paid, sink paid, fees, members claimed, gains, losses
FORK_RPC_URL=https://mainnet.base.org forge test --match-path test/fork/PatronVault.aave.t.sol -vv   # a pilot month against the real Aave wrapper
```

The invariants run 128 sequences of 80 random actions over 4 members, 3 creators, an outside depositor, gains, losses and liquidity caps that deplete like a real market's, with `fail_on_revert` on, so the handler never papers over a revert. They run twice, once per mode, both with a 5% fee on so the fee path sits under every property:

| ID | Holds after every sequence |
| --- | --- |
| I1 | Every source share the vault holds belongs to exactly one member, the fee pool, or the parked sink buffer |
| I2 | The vault never holds USDC itself |
| I3 | `totalPrincipal` and `memberCount` are exact sums |
| I4 | With no source loss on record, every member's shares back their principal within one share per deposit |
| I5 | Everything paid to creators or the sink, set aside or collected as fee, parked for the sink, or claimed came out of source gains (plus other depositors' sub-share rounding dust) |
| I6 | A member who left holds nothing: no principal, no shares, no routes |
| I7 | A current member's principal is never below the minimum |
| I8 | A member in shortfall cannot pay anyone: settle and claim would both move nothing |
| I9 | (principal-only mode) No member's USDC in hand ever exceeds what they started with, beyond rounding dust on exit |

Plus, inside the handler after every settle, claim, route change and top-up: if the position was healthy before, it is healthy after.

Runs of record: `docs/test-run-2026-10-21.txt` (this version), `docs/test-run-2026-10-15-v1.1.txt`, `docs/test-run-2026-10-15.txt`. The cold review and what it changed: `docs/review-2026-10-21.md`. Slither: `docs/slither-triage-2026-10-16.md`.

## Deploy

The step-by-step for the pilot, from the operator's Mac, is `docs/pilot-runbook.md`. The shape:

No keys in a shell line, ever. Use a hardware signer or a keystore account with `forge script`.

1. Screen the source on a fork: `SOURCE=0x... USDC=0x8335...2913 forge script script/Screen.s.sol --rpc-url $RPC`. The asset and round-trip checks print true; for a wrapper like Aave's the liquidity figure is the pool's, read by hand (`docs/screen-2026-10-21.md`).
2. Print the terms hash: `forge script script/TermsHash.s.sol`. The number is `keccak256` of `terms/member-terms-v1.md`, byte for byte, final newline included. The patron page serves that file unchanged and `worker/` checks the hash against the contract on every health probe. A product vault with a fee uses `TERMS_FILE=terms/member-terms-v1.1.md`; the deploy script refuses a fee with the v1 text.
3. Dry run: `SOURCE=0x... MIN_DEPOSIT=3500000000 MAX_TOTAL_PRINCIPAL=49000000000 JOIN_DEADLINE=<unix> YIELD_SINK=<cold DJZS address> CREATORS=<payee> FEE_BPS=0 EXPECT_ASSET=0x8335...2913 forge script script/Deploy.s.sol --rpc-url $RPC`. `CREATORS` deploys the `FixedCreators` registry in the same run. A product vault adds `FEE_BPS=500 FEE_RECIPIENT=<fee address> TERMS_FILE=terms/member-terms-v1.1.md` and its own registry.
4. Broadcast the same line with `--broadcast` and your signer flag. Verify on BaseScan. Confirm the verified code has no owner or admin function (there is none to find).
5. Publish the address, the source, the terms hash and the terms text together. Then the smoke test from a DJ wallet, excluded from every count: join, setRoute, settle, withdraw, leave (`claimYield` reverts in principal-only mode, by design).

## Creator side

Gate on `isPatronAtLeast(creator, member, yourFloor)`: it is computed live from the yield available and the amounts owed, so it is as fresh as the block, and the floor is yours regardless of when the member's route was set. Run a keeper that settles each patron once per period so creators are actually paid; the gate does not depend on it:

```ts
import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

const abi = parseAbi([
  "function isPatronAtLeast(address creator, address member, uint256 minAmountPerPeriod) view returns (bool)",
  "function previewSettle(address member) view returns (uint256 owed, uint256 fromYield, uint256 pay)",
  "function settle(address member)",
]);
const client = createPublicClient({ chain: base, transport: http() });

export const isPatron = (vault: `0x${string}`, creator: `0x${string}`, member: `0x${string}`, floor: bigint) =>
  client.readContract({ address: vault, abi, functionName: "isPatronAtLeast", args: [creator, member, floor] });
```

A paid `settle(member)` with one route costs about 333k gas against the Aave wrapper (measured on a fork); the mock source makes it look like 110k. Give it a fixed gas limit, never the node's estimate (rule 15 makes an under-estimated call revert `InsufficientGas` rather than silently hold the payment; the keeper in `worker/` budgets 2M plus 600k per member). On Base that is a fraction of a cent per call. The keeper holds no vault keys; `settle` is permissionless once per `settleInterval`.

The pilot's keeper, status API, exact-bytes terms route and member page are one Cloudflare Worker in `worker/` (`scan.djzs.ai/patron*`): `worker/README.md`.

## Layout

```
src/PatronVault.sol            the contract
src/FixedCreators.sol           an immutable creator registry (the pilot's: one entry)
src/interfaces/                 the ERC-20, ERC-20 permit (ERC-7597), ERC-4626 and creator-registry interfaces it uses
test/PatronVault.t.sol          unit and fuzz tests, the core
test/PatronVault.product.t.sol  fee, permit join, batch routes, settleMany, claimableYield under the fee
test/PatronVault.review.t.sol   regressions pinned by the 2026-10-21 cold review
test/PatronVault.invariants.t.sol
test/handlers/PatronHandler.sol
test/mocks/                     MockUSDC (with a Circle-style freeze) and MockERC4626 (gain, loss, depleting liquidity cap)
test/fork/PatronVault.aave.t.sol   a pilot month against the real Aave wrapper (needs FORK_RPC_URL; skipped otherwise)
script/Screen.s.sol             fork checks on a candidate source
script/TermsHash.s.sol          prints the terms hash (TERMS_FILE selects the text)
script/Deploy.s.sol             deploys from env vars and the terms file
terms/member-terms-v1.md        the pilot's member terms (no fee); its keccak256 is the constructor's termsHash
terms/member-terms-v1.1.md      the product's member terms (5% fee clause)
worker/                         the pilot surface: keeper cron, status API, exact-bytes terms, member page (Cloudflare Worker)
docs/                           runs of record, the screen, the review, the runbook
```
