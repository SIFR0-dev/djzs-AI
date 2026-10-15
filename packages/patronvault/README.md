# PatronVault v1

One deposit, many creators. A member parks USDC once. The vault lends it through one ERC-4626 yield source and streams only the interest to the creators the member routes it to, at an amount per 30 days the member sets. The deposit comes back whenever the member asks.

The promise, word for word:

> We never spend your deposit. Only the interest it earns is paid out. Withdraw the deposit any time.

Built 2026-10-15 for DJZS AI, LLC. Solidity 0.8.28, Foundry (forge-std 1.17.0 vendored under `lib/`). No other dependencies. MIT. Design record: the DJZS Patron Vault handoff doc (internal, Claude Docs), sections "PatronVault v1 contract" and "Open rulings".

```
cd packages/patronvault
forge test
```

## How a month works

1. A member approves USDC and calls `join(amount, termsHash)`. The transaction quotes the hash of the exact terms text; that is the consent record. The vault deposits the USDC into the yield source and books the shares to that member alone.
2. The member calls `setRoute(creator, amountPerPeriod)` for each creator they support. Up to 16 routes. A creator can publish a floor with `setCreatorMin`; the member decides the amount.
3. Anyone calls `settle(member)` whenever they like, usually a keeper run by the creator. Settle accrues every route to the second, then pays creators out of the member's yield shares only, pro rata if the yield is short. The shares that back the principal are never burned by a payout.
4. `isPatron(creator, member)` is true while the member routes to that creator and the last settle was covered by yield (95% or better). Creators gate on that.
5. Unrouted interest stays with the member: `claimYield(amount)`. The deposit itself: `withdraw(amount)` or `leave()`, any time, no lock, no fee.

## What the code enforces

| # | Rule | Where |
| --- | --- | --- |
| 1 | No owner, no pause, no upgrade. Every parameter is a constructor argument. | whole contract |
| 2 | Every member's position is isolated: own shares, own principal, own yield. | `Member` struct, `_settle` |
| 3 | A payout only ever burns shares above `previewWithdraw(principal)`, the shares it takes to redeem the principal rounded up. | `_yieldShares`, `_fromYield` |
| 4 | Nothing is owed against principal. Yield that cannot cover a route is forgiven and the member is flagged unfunded. | `_distribute`, `funded` |
| 5 | Only the member's own transaction creates, changes or removes a route. | `setRoute` |
| 6 | Unrouted yield belongs to the member. | `claimYield` |
| 7 | Accrual is exact. `carry` keeps the sub-unit remainder, so settling every block pays a creator the same as settling once a month. | `_accrue` |
| 8 | A source that cannot pay today (illiquid) holds the amount; it is paid at the next settle, not forgiven. A route cannot be removed while the source still owes on it. | `_distribute`, `setRoute` |
| 9 | A creator address the token refuses (a Circle freeze) never traps the member: the payment is held, every member action still works, and the route is removable with the held amount forgiven. | `_pay`, `setRoute` |
| 10 | Optional pilot limits: a cap on total principal and a join deadline. 0 disables each. | `_checkCap`, `join` |

What the code cannot promise: the yield source. If the source loses money, every share holder loses pro rata, this vault included, and each member's loss is their own (`withdraw` and `leave` are pro rata in a shortfall; `settle` pays nothing). The source is chosen once, at deployment, against the screening rules in the handoff doc, and cannot be changed afterwards. A deprecated source means members leave and join a new vault; there is no migration function because there is no admin.

## Exactness and rounding

ERC-4626 rounds every deposit against the depositor by at most one share. That is the only way a healthy position can read below its principal, and it is bounded by one share per deposit: about 0.000001 USDC on Aave's wrapper, far less on Morpho vaults (18-decimal shares). The vault's own accounting is exact: `test/PatronVault.invariants.t.sol` proves `shares + deposits >= previewWithdraw(principal)` for every member after any sequence of actions, as long as the source has not lost money.

The source must satisfy `previewRedeem(previewWithdraw(x)) >= x`. OpenZeppelin ERC-4626, Morpho MetaMorpho and Aave's StataTokenV2 all do. `script/Screen.s.sol` checks it on a fork before you deploy against anything.

## Contract surface

| Call | Who | Does |
| --- | --- | --- |
| `join(amount, terms)` | member | first deposit, at least `minDeposit`; `terms` must equal `termsHash` |
| `deposit(amount)` | member | top up (settles first) |
| `withdraw(amount)` | member | part of the deposit back; remainder is 0 or at least `minDeposit`; yield stays |
| `claimYield(amount)` | member | unrouted yield out (settles first) |
| `leave()` | member | settle, redeem everything, clear routes |
| `setRoute(creator, amountPerPeriod)` | member | add, change, or remove with 0 (settles first) |
| `setCreatorMin(amountPerPeriod)` | creator | floor for new or changed routes; removal is always allowed |
| `settle(member)` | anyone | accrue and pay that member's routes from yield |
| `isPatron(creator, member)` | view | routed and funded at the last settle |
| `previewSettle(member)` | view | owed, how much yield covers, how much the source can pay today |
| `claimableYield(member)` | view | a lower bound that `claimYield` will accept |
| `positionValue`, `inShortfall`, `memberOf`, `routesOf`, `creatorPaid`, `totalPrincipal`, `memberCount` | view | state |

Constructor: `(source, minDeposit, period, termsHash, maxTotalPrincipal, joinDeadline)`. The asset is read from `source.asset()`.

## Pilot parameters (Scan Room patron tier)

From the handoff doc, open rulings R2, R3 and R7 pending DJ's confirmation:

| Parameter | Value | Why |
| --- | --- | --- |
| source | Aave v3 Base USDC wrapper `0xC768c589647798a6EE01A91FdE98EF2ed046DBD6`, or the higher-ranked source that passes the screen | R2 |
| asset | native USDC on Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | rule 1 |
| minDeposit | 3,500 USDC | 10 USDC per 30 days stays funded (95% line) down to a 3.30% base rate and fully funded from 3.48%; 3,000 only clears the 95% line above 3.85% |
| period | 30 days | matches the cash rail |
| route | 10 USDC per 30 days to the Scan Room payee, which sets `creatorMin` to the same | like for like with the cash rail |
| maxTotalPrincipal | 49,000 USDC (14 memberships at the minimum) | R3, inside the $50,000 line counting deposits |
| joinDeadline | day 60 of the pilot | R4 |

## Tests

```
forge test            # 40 unit and fuzz tests, 8 invariants, one non-vacuity walk
forge test -vv        # shows the walk's totals: creators paid, members claimed, gains, losses
```

The invariants run 128 sequences of 80 random actions over 4 members, 3 creators, an outside depositor, gains, losses and liquidity caps, with `fail_on_revert` on, so the handler never papers over a revert:

| ID | Holds after every sequence |
| --- | --- |
| I1 | Every source share the vault holds belongs to exactly one member |
| I2 | The vault never holds USDC itself |
| I3 | `totalPrincipal` and `memberCount` are exact sums |
| I4 | With no source loss on record, every member's shares back their principal within one share per deposit |
| I5 | Everything paid to creators or claimed came out of source gains (plus other depositors' sub-share rounding dust) |
| I6 | A member who left holds nothing: no principal, no shares, no routes |
| I7 | A current member's principal is never below the minimum |
| I8 | A member in shortfall cannot pay anyone: settle and claim would both move nothing |

Plus, inside the handler after every settle, claim, route change and top-up: if the position was healthy before, it is healthy after.

Run of record: `docs/test-run-2026-10-15.txt`.

## Deploy

No keys in a shell line, ever. Use a hardware signer or a keystore account with `forge script`.

1. Screen the source on a fork: `SOURCE=0x... USDC=0x8335...2913 forge script script/Screen.s.sol --rpc-url $RPC`. All three checks print true.
2. Print the terms hash: `forge script script/TermsHash.s.sol`. The number is `keccak256` of `terms/member-terms-v1.md`, byte for byte, final newline included. The patron page must serve that file unchanged and hash the same bytes.
3. Dry run: `SOURCE=0x... MIN_DEPOSIT=3500000000 MAX_TOTAL_PRINCIPAL=49000000000 JOIN_DEADLINE=<unix> EXPECT_ASSET=0x8335...2913 forge script script/Deploy.s.sol --rpc-url $RPC`.
4. Broadcast the same line with `--broadcast` and your signer flag. Verify on BaseScan. Confirm the verified code has no owner or admin function (there is none to find).
5. Publish the address, the source, the terms hash and the terms text together. Then the smoke test from a DJ wallet, excluded from every count: join, setRoute, settle, claimYield, leave.

## Creator side

Gate on `isPatron`, and run a keeper that settles each patron on a schedule, because `funded` is only as fresh as the last settle:

```ts
import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

const abi = parseAbi([
  "function isPatron(address creator, address member) view returns (bool)",
  "function previewSettle(address member) view returns (uint256 owed, uint256 fromYield, uint256 pay)",
  "function settle(address member)",
]);
const client = createPublicClient({ chain: base, transport: http() });

export const isPatron = (vault: `0x${string}`, creator: `0x${string}`, member: `0x${string}`) =>
  client.readContract({ address: vault, abi, functionName: "isPatron", args: [creator, member] });
```

A `settle(member)` costs about 110k gas with one route against the mock source (`forge test --gas-report`); a real source adds its own withdraw cost. On Base that is a fraction of a cent per call. The keeper holds no vault keys; `settle` is permissionless.

## Layout

```
src/PatronVault.sol            the contract
src/interfaces/                 the ERC-20 and ERC-4626 subsets it uses
test/PatronVault.t.sol          unit and fuzz tests
test/PatronVault.invariants.t.sol
test/handlers/PatronHandler.sol
test/mocks/                     MockUSDC (with a Circle-style freeze) and MockERC4626 (gain, loss, liquidity levers)
script/Screen.s.sol             fork checks on a candidate source
script/TermsHash.s.sol          prints the terms hash
script/Deploy.s.sol             deploys from env vars and the terms file
terms/member-terms-v1.md        the member terms; its keccak256 is the constructor's termsHash
docs/                           run of record
```
