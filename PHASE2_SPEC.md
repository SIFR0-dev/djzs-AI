# DJZS Phase 2: PoL Certificate Write + x402 Payments

Status: Step 0 DISCHARGED 2026-07-12. Steps 1-5 pending.
Prime invariant: verdict is computed, not improvised. Nothing in Phase 2 may alter `verdict_hash`.

## Scope

Phase 2 ships two capabilities as one offer: pay via x402, receive a ProofOfLogic
certificate anchored on Irys. Coupled, because charging for a bare hash that anchors
no certificate is a weak offer.

## Hard compliance constraint (acceptance criterion)

Non-custodial, matching the KYB flow-of-funds diagram (Model A, Scenario 1).
The complete `X402Config`:

    { network, recipient: TREASURY, facilitator: { url: "https://x402.org/facilitator" } }

plus a price on the tool. Nothing else. No `createAuthHeaders`. No intermediary or
settlement address. Funds move payer wallet to treasury directly via the payer's
EIP-3009 signature; the facilitator submits `transferWithAuthorization` and pays gas
(verified on-chain in Step 0: the payer's sent-transaction count stayed zero).

Self-hosting a facilitator (Scenario 2) is OUT OF SCOPE. Different product, heavier
compliance weight.

Grep gates, run before any Phase 2 commit touching the Worker:

    grep -Rc "createAuthHeaders" <worker src>      # expect 0
    grep -Rc "x402.org/facilitator" <worker src>   # expect >= 1

## Architecture decision

Cloudflare Agents SDK: `withX402` + `paidTool` on an `McpAgent` (Path 1). PROVEN end
to end in Step 0 on base-sepolia: 402 issued, EIP-3009 signed, facilitator verified
and settled, gated result returned, transfer confirmed on-chain between distinct
payer and recipient.

Requires migrating djzs-trust-mcp from `@hono/mcp` + `McpServer` to `McpAgent`.
Scoped CONTAINED: the `verify_pm_trade` tool body (`runVerifyPmTrade`,
`buildAnthropicModelFn`, `VERIFY_PM_TRADE_INPUT` in `verify-pm-trade.ts`) ports
UNCHANGED; roughly 40-60 lines of server scaffolding change, plus a Durable Object
binding and SQLite migration in wrangler.

Fallback if the migration fights: `x402-hono` middleware. Lower risk, but it gates
routes rather than tools, which is architecturally worse for one paid tool among
free ones.

## Dependency constraints (from Step 0, verified against live npm 2026-07-12)

These bite at Step 2, the moment `agents` enters the Worker's dependency tree.

1. `wrangler` pinned EXACTLY `4.107.0`. wrangler >= 4.108.0 peers on
   `@cloudflare/workers-types` v5; `partyserver@0.5.8` (transitive via
   `agents@0.17.3`) peers on v4. `npm install` hard-fails ERESOLVE with both.
   Do not use `--force` or `--legacy-peer-deps`. Unpin when partyserver ships
   workers-types v5 support.
2. `@x402/core` must be an explicit dependency. It is a peer of `agents`,
   `agents/x402` imports it at runtime, and `tsc --noEmit` fails without it.
3. `@modelcontextprotocol/sdk` pinned EXACTLY to the version `agents` pins
   (1.29.0 at spike time; re-check `npm view agents dependencies` at migration).
   Two SDK copies in one bundle break MCP class identity.
4. `agents` pinned. It is 0.x; any minor is a potential break.
5. `StreamableHTTPEdgeClientTransport` (agents/mcp) is deprecated. Payer-side code
   uses `StreamableHTTPClientTransport` from
   `@modelcontextprotocol/sdk/client/streamableHttp.js`.
6. Never hardcode the USDC asset or hand-roll the 402 payload. `withX402` resolves
   the asset from the network identifier and speaks x402 v2: scheme `exact`,
   atomic string amounts. A contaminated spike draft hand-rolled this and got the
   asset address, protocol version, scheme name, and units all wrong.

## Invariant: verdict_hash unchanged

`verdict_hash` is computed inside `runDeterministicAudit` from
`{verdict, risk_score, flags, unknown_fields}` only. The PoL certificate is
assembled after the hash. The Irys write must not feed anything back into the
hash inputs.

Gate: re-run the pm-block-008 anchor after Step 1 and after Step 3. Expected,
byte-identical:

    0x85918814b3dffa31b00d6892c2e00b2001efd35f7e0044b4cd3789fe1df14937

## Sequence

Step 0: base-sepolia spike. DISCHARGED 2026-07-12.
  All three checks passed: free tool worked unpaid; paid tool refused unpaid
  (PAYMENT_REQUIRED, isError true); full 402 -> pay -> retry loop returned the
  gated result. Settlement verified on-chain: 0.01 USDC, payer to distinct
  recipient, block 44061586, facilitator-submitted. Spike deleted, nothing
  deployed, burner key destroyed with the folder.

Step 1: Irys PoL certificate write. Hash-parity gate after.
Step 2: McpAgent migration + `paidTool` on `verify_pm_trade`. Dependency
  constraints above apply HERE.
Step 3: couple payment to certificate (pay -> audit -> anchored PoL in the
  response). Hash-parity gate after.
Step 4: sepolia dress rehearsal on the real tool, then mainnet cutover.
Step 5: payer quickstart.

## Payer side

`withX402Client` (MCP-native): PROVEN in Step 0. Note the callback-first
`callTool` signature on the wrapped client.

Coinbase AgentKit `make_http_request_with_x402`: HTTP-framed while the tool is
MCP-over-HTTP. OPEN SEAM: verify on sepolia against the `/mcp` endpoint before
documenting it in the quickstart. AgentKit spend permissions (capped, revocable)
reinforce non-custodial and are a selling point.

## Reserved for DJ

The price for `verify_pm_trade`. Confirming the treasury receiving address before
any mainnet step.

## Amendments: 2026-07-12 ground-truth pass (pre-commit)

Verified against the committed tree and the Worker manifest, not memory.

A1. Live closure proven viem-free. djzs-trust-mcp typechecks from its own
    package (tsc exit 0) with viem absent from the root manifest. Closure:
    src/* -> server/engine-v2/* -> server/claude-client.ts. No file in that
    closure imports viem.

A2. verdict_hash is sha256Hex over canonicalized inputs
    (server/engine-v2/hash; call sites deterministic-engine.ts:217,281).
    The viem keccak256 at server/adversarial-audit.ts:273 is the v1 TRACE
    hash over the strategy memo, a different artifact. Never conflate them.

A3. Worker manifest deltas required at Step 2 (from djzs-trust-mcp/
    package.json as committed):
    - zod ^3.25.0 -> ^4. agents peers on zod ^4; zod 4 is a breaking major.
      VERIFY_PM_TRADE_INPUT is a zod schema, so "ports UNCHANGED" carries a
      zod-v4 compatibility check.
    - @modelcontextprotocol/sdk ^1.28.0 (caret) -> EXACT pin matching agents.
    - wrangler ^4.107.0 (caret) -> EXACT 4.107.0. The caret floats to 4.110
      today and only works because agents/partyserver is not yet in the tree.
    - viem re-enters transitively via @x402/evm at Step 2. Do not add it as
      a direct Worker dependency; the resource server needs no signer.

A4. CORRECTED pre-commit (an earlier draft of this amendment claimed no
    instrument was located; a string-level grep found it): the anchor case is
    calibration-dataset.json id "pm-block-008"
    (server/engine-v2/calibration/calibration-dataset.json:541); runners are
    smoke-live.ts and run-live.ts in the same directory. Both import the
    extraction layer, so an anchor run needs a live Anthropic key.
    OPEN instead: parity STATUS. CLAUDE.md:91 records the first external
    audit (FAIL, M03+M04, risk 40, verdict_hash 0x8591...4937) with hash
    parity PENDING: calibration key 401-dead, re-mint owed, live hash stands
    as record. A later status report asserts parity PROVEN byte-identical.
    The records conflict; ruling reserved for DJ. If PENDING is current, key
    re-mint plus anchor run is a Step 1 PRECONDITION and this spec's parity
    gate inherits that baseline. Whichever way it lands, CLAUDE.md:91 is
    updated to match in the same pass.

A5. Casualties of 16a2097 at root: scripts/self-audit and
    scripts/detection-test import server/audit-agent (v1), whose hash chain
    reaches viem. They no longer resolve from the root manifest. The
    self-audit harness is the instrument behind the open SCHEMA_VERSION
    v1.0-vs-v1.1 ruling. Disposition reserved for DJ: restore viem as a root
    devDependency, or hold the harnesses broken until the schema ruling
    lands and delete v1 with them. Neither blocks Phase 2.

A6. 2026-07-12: A4's open parity status DISCHARGED. anchor-pm-block-008.ts
    (this commit) reproduced 0x8591...4937 byte-identical from live N=3
    extraction into the frozen engine, exit 0. Extraction disagreed on
    stop_loss (record: []); the field is outside the PM hash preimage and
    the hash held, demonstrating the determinism boundary under live noise.
    Step 1 precondition met. Residual: the public site still carries the
    hash-parity-pending honesty line from 246f12e; separate site edit and
    deploy owed.
