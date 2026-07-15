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

Step 1: Irys PoL certificate write. DISCHARGED 2026-07-12 at e95bb49 (A7).
  Hash-parity gate held byte-identical through the change.
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

A7. 2026-07-12: Step 1 DISCHARGED at e95bb49. The PoL write lives in
    djzs-trust-mcp/src/pol-certificate.ts behind an injectable UploadFn seam
    (the ModelFn pattern): certificate assembled strictly after
    runDeterministicAudit, in_scope results only, FAIL OPEN in the handler
    (pol_certificate status disabled/error/anchored annotates the response,
    never blocks or mutates the verdict). Optional target_system tool input
    feeds only the Target-System tag; extraction input and hash preimage
    untouched. Dependency: @irys/bundles exact 0.0.5; the web build signs via
    pure-JS keccak/secp256k1 browser-field fallbacks under workerd. Worker
    bundle 656.76 KiB gzipped per wrangler.
    Milestone instruments, live on devnet: certs
    2Pcm477mDzZtRzF4PaX2YHkpUgCJ1s9LC54ReCpsKanv
    (audit_id c2ec3eb1-e691-4c2d-9fcb-88eaec461035) and
    3mavvyxEQDQYJvh8Dj5mifgnehp8dAzGx3kZpkQXZx71
    (audit_id f92f0c70-8c5a-48d3-aee8-03171784850a), each retrieved by id
    (gateway.irys.xyz 200) and by bounded-tag GraphQL on devnet;
    intent_sha256 verified byte-identical by independent recomputation;
    anchor gate exit 0 byte-identical throughout, including runs carrying
    stop_loss and data_sources extraction divergence. NOTE: devnet retains
    data roughly 60 days; these artifacts are ephemeral by design until the
    mainnet cutover (Step 3/4).
    Live findings: devnet accepts small uploads at zero balance (the price
    endpoint quotes nonzero regardless); gateway.irys.xyz serves devnet
    items; the deployed query side still times out on unbounded GraphQL
    (timestamp-bounds patch owed, separate commit).
    Step 1 reading of the grep gates: createAuthHeaders 0 holds; the
    "x402.org/facilitator >= 1" expectation activates at Step 2 when x402
    enters the Worker.
    Production note: the deployed Worker predates e95bb49; anchoring goes
    live only after `wrangler secret put IRYS_UPLOAD_KEY` plus deploy. The
    addenda-7 deploy parity gate is now scripted:
    harness/pol-live-call.ts --url <worker>/mcp replays pm-block-008 and
    expects 0x8591..4937 anchored.

A8. 2026-07-12 (late): STEP 2 ARCHITECTURE DEVIATION, DJ-ruled. Path B
    ships: withX402 wraps the EXISTING per-request McpServer (@hono/mcp
    transport unchanged); verify_pm_trade re-registers via paidTool at
    0.25 USDC; the registry tools stay free. The "Architecture decision"
    section above (McpAgent, DO binding, SQLite migration) is SUPERSEDED
    for Step 2. Instrument: the installed agents@0.17.3 artifact;
    dist/mcp/x402.js imports only @x402/core and the EVM scheme registrars,
    zero DurableObject/partyserver/McpAgent references; payment rides
    in-band via MCP _meta. Tool-level gating, the original Path 1 rationale,
    is delivered without the migration. McpAgent stays available if a later
    step needs stateful agents; the installed dep set already threads its
    pins (wrangler 4.107.0 exact, MCP SDK 1.29.0 exact, agents 0.17.3,
    @x402/core+evm 2.18.0, zod 4.4.3 top-level).
    Falsifier for Path B, stated before the rehearsal: GATE U (unpaid call
    refused with the payment-required shape) and GATE P (paid call settles
    via the facilitator and returns the anchored audit), both in
    harness/pol-paid-call.ts. Either red: revert to spec Path A, deps
    already in place, nothing wasted.
    RULINGS RECORDED: price 0.25 USDC per audit, rehearsal included;
    recipient is a committed source constant so the compliance grep sees
    the money path (sepolia burner = the Irys throwaway address,
    receive-only role; TREASURY replaces the constant in the signed mainnet
    diff and stays out of source until then). Payer-side note: the client
    default maxPaymentValue is 0.10 USDC, below this price; payer clients
    must raise it (the harness pins exactly 250000 atomic).
    Zod posture, instrumented: two zod copies by path in the wrangler
    dry-run bundle (worker 4.4.3 for the MCP/x402 layer, root 3.25.x for
    the engine parser; 88/8 path-comment counts pre-code). NO zod alias or
    dedupe, ever: forcing one copy would move the frozen engine's parser to
    v4, which is the hash risk. Instrument coverage splits exactly along
    the copies: the local anchor covers the root copy, the paid live call
    covers the worker copy. The zod-4 type-level compat of both tool
    schemas was discharged pre-code (tsc exit 0 on the old code against the
    new tree).
    Rehearsal finding (2026-07-12, GATE U green / GATE P crash): the agents
    x402 CLIENT wrapper encodes the payment payload with bare btoa
    (instrument: agents dist/mcp/x402.js, `btoa(JSON.stringify(
    paymentPayload))`), which throws "Invalid character" on any code point
    above 0xFF. The paid tool's description rides inside the payment
    resource; ours carried U+2192 arrows and crashed the payer. RULED as a
    class: paid-tool descriptions are ASCII-only. @x402/core itself uses a
    safe TextEncoder path; upstream bug candidate against the agents repo.

A9. 2026-07-13: MAINNET CUTOVER FAILED AND WAS ROLLED BACK. Commit 33e6433
    (network base, recipient treasury 0xc192..eCCA, IRYS_NODE_URL ->
    uploader.irys.xyz) was deployed (2783f2bc, then 3246e03f) and took the
    public tool DOWN. Reverted in the deploy plane by rolling back to
    5f021c66 (100% traffic); production verified alive afterwards by
    pol-live-call (anchored A1ixD662viuJmh9dPpGaGqiWYEFnYRm1UK4Uwmx8EBku,
    verdict_hash 0x8591..4937, both retrieval legs green, exit 0).
    Failure was CLOSED, not open: no audit served free, no signature taken,
    no funds moved.

    ROOT CAUSE, with the instrument that would have caught it in one call:
    GET https://x402.org/facilitator/supported lists the facilitator's
    supported kinds. Every EVM entry is eip155:84532 (base-sepolia) across
    exact/upto/batch-settlement, plus the v1 "base-sepolia" alias.
    eip155:8453 (Base MAINNET) is ABSENT. The public facilitator is
    TESTNET-ONLY. A resource server on network "base" pointed at it cannot
    even build payment requirements: live production returned
    {"x402Version":2,"error":"PRICE_COMPUTE_FAILED"} to every caller, paid
    and unpaid. Mainnet payment is therefore BLOCKED on a facilitator that
    settles eip155:8453, not on any DJZS code.

    RULING OWED (do not decide by drift; this is the whole compliance
    posture): the mainnet-capable path is Coinbase's CDP facilitator, whose
    auth is an API key id + secret — i.e. the custodial auth-header
    mechanism this spec's acceptance criterion bans, and whose grep gate
    pins the public facilitator URL. An attempt to satisfy it by quietly
    putting CDP_API_KEY_ID/SECRET as Worker secrets was aborted before any
    value was entered (secret store verified: ANTHROPIC_API_KEY and
    IRYS_UPLOAD_KEY only). Honest framing for the re-ruling: CDP-facilitated
    settlement keeps flow-of-funds non-custodial (payer -> treasury via
    EIP-3009, facilitator submits and pays gas), so the ban may be
    over-broad — but changing it is a spec amendment with evidence, never a
    secret paste. Alternatives to price first: any other facilitator whose
    /supported advertises eip155:8453 (verify against ITS endpoint, never
    from memory); or hold the pilot on base-sepolia.

    SECOND LANDMINE in the same commit, independent of payment: IRYS_NODE_URL
    -> uploader.irys.xyz while IRYS_UPLOAD_KEY is the zero-balance devnet
    throwaway. Free-at-zero-balance is a DEVNET property (live-observed, A7);
    mainnet Irys will refuse. Anchoring would fail-open and paying callers
    would receive pol_certificate {status:"error"} — precisely the "charging
    for a bare hash that anchors no certificate" weak offer this spec opens
    by rejecting. Mainnet anchoring requires a FUNDED mainnet upload key,
    ruled and funded before any mainnet deploy.

    DEPLOY DOCTRINE (new, ratified): a deploy is not done when wrangler says
    "Deployed". It is done when the DEPLOYED VERSION is probed live and
    answers correctly. Green local rehearsal against wrangler dev proves the
    code, not the deployment: the config that broke production (mainnet
    network + testnet facilitator) was never exercised locally, because the
    local rehearsal ran the sepolia config. Every deploy carries an
    immediate live probe (pol-live-call --url, or pol-paid-call --url once
    payment is live) and a named rollback target BEFORE the deploy, not
    after the outage.

A10. 2026-07-14: FACILITATOR RULED — CDP. DJ ruled the CDP (Coinbase
    Developer Platform) facilitator after a four-candidate brief
    (FACILITATOR_RULING_BRIEF.md), each probed against its OWN /supported
    endpoint. Standings: x402.org testnet-only (no eip155:8453); xpay and
    0xArchive advertise eip155:8453 with NO auth; CDP advertises Base,
    Base Sepolia, Polygon, Arbitrum, World, Solana and requires an API key.

    THE COMPLIANCE RE-RULING, explicit: the former "No createAuthHeaders"
    ban (and the grep gate pinning x402.org/facilitator) are RETIRED. They
    were written as proxies for CUSTODY, but auth headers do not create
    custody — an EIP-3009 authorization binds the recipient INSIDE the
    payer's signature, so no facilitator can redirect, skim, or custody at
    any point. Flow of funds is IDENTICAL under every candidate (payer ->
    treasury, facilitator submits + pays gas). What CDP actually adds is a
    Coinbase ACCOUNT RELATIONSHIP, accepted deliberately in exchange for
    OFAC/KYT screening and a battle-tested settler. The KYB flow-of-funds
    diagram (Model A, Scenario 1) is UNCHANGED; Scenario 2 (self-hosted
    facilitator) remains out of scope.

    BUILDABILITY, instrumented pre-code (not from memory): @coinbase/x402
    2.1.0 exports createFacilitatorConfig(id, secret) returning the
    FacilitatorConfig shape @x402/core expects, url
    https://api.cdp.coinbase.com/platform/v2/x402. It bundles under workerd
    conditions; the JWT is signed via jose on WebCrypto (no node crypto);
    axios enters only through cdp-sdk's auth hook and TREE-SHAKES to zero
    refs in the output (44 KB auth-only bundle). A throwaway Ed25519 key
    produced a real Bearer JWT with verify/settle/supported/list headers.

    IMPLEMENTATION (this commit): facilitator built via
    createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET) —
    keys are wrangler SECRETS read REQUEST-SCOPED from env, never
    module-scope process.env (same seam as buildAnthropicModelFn; sidesteps
    the 10021 dead-code detonator class). Absent keys => the paid tool
    cannot settle and errors BEFORE the handler runs; no free audit is ever
    served (fail-closed); free registry tools unaffected. New route
    GET /health/x402 is the deploy-gate boot assertion: it builds the same
    CDP config, calls getSupported() (signing a real CDP JWT, so a 200 also
    proves auth end to end), and reports whether the configured network is
    advertised — the one probe that would have caught the A9 outage.

    NEW COMPLIANCE GATES (replace the retired two), all green pre-commit:
    - grep process.env in src/ -> 0 CALLS (comments describing its avoidance
      are allowed; the three hits are all such comments).
    - CDP keys read only from the env binding (env.CDP_API_KEY_*), never
      module scope.
    - recipient is the single committed payee constant; no settlement or
      intermediary address anywhere (grep 0).
    - createFacilitatorConfig present as the authorized CDP auth path.
    Old gates are RETIRED with reason: createAuthHeaders==0 and
    x402.org/facilitator>=1 both encoded the public-facilitator design A10
    supersedes.

    NETWORK for this commit stays base-sepolia: CDP settles testnet too, so
    the ENTIRE CDP path (JWT auth, verify, settle) is provable with faucet
    USDC and zero financial exposure before any mainnet variable moves. The
    rehearsal instrument is unchanged (harness/pol-paid-call.ts); the payer
    side is agnostic to the server's facilitator choice.

    KEY POSTURE (DJ): create a CDP SECRET API key in the djzs.ai project
    with NO Coinbase App scopes (View/Trade/Transfer/Receive all OFF); it
    authenticates JWT requests to the x402 platform API and needs none of
    them. Two Worker secrets: CDP_API_KEY_ID, CDP_API_KEY_SECRET.

    STILL OWED before mainnet (unchanged from A9, do not skip): a FUNDED
    mainnet Irys upload key (free-at-zero-balance is devnet-only), the
    treasury address as a committed constant, the network flip to "base",
    each in a separate signed diff, each behind the /health/x402 probe and a
    named rollback target.

A11. 2026-07-14: MAINNET PATH, staged to make the A9 outage un-repeatable by
    isolating each real-money variable and proving it before the next.
    Rulings: dedicated new mainnet Irys key (kept separate from the devnet
    throwaway as IRYS_MAINNET_KEY, funded with real Base ETH); treasury
    address DJ-provided at the payment-flip stage.

    STAGE 1 DONE: dedicated mainnet key generated (address
    0xcF2d8Ef4Dea0Ef8957b0F4D4a6fBFC2AEAf990cD), funded via
    harness/pol-irys-fund.ts (generalized devnet+mainnet; supersedes
    pol-devnet-fund.ts). Live mainnet Irys facts: base-eth deposit address
    0x32Ed3Dc90CD5AE7b875A0ee7A86CA6D2fc72c635, price ~1.25e11 wei / 2 KB
    (~$0.0004). Harness fix (2026-07-14): mainnet notify returns 200
    {"confirmed":true}, not devnet's 202; the success check accepts both
    (an earlier version false-reported "no 202" while the deposit had in
    fact credited — the anchor upload immediately after proved it).

    STAGE 2 DISCHARGED: mainnet Irys anchoring proven in PURE ISOLATION
    (harness/pol-mainnet-anchor.ts) — a real PoL cert uploaded to
    uploader.irys.xyz, NO payment, NO Worker, only the funded key under
    test. Permanent cert 747n8SZqVcU9RsNxE1mDHdnG2GiyDXAc1SYJpRiLm25i,
    retrieved by id (gateway 200) AND by the MAINNET GraphQL index that
    query_pol_certificates reads — the first real DJZS cert that index has
    ever held. Cost: one sub-cent upload. Mainnet anchoring is no longer a
    blocker.

    STAGE 3A DISCHARGED 2026-07-14 (local full-mainnet rehearsal, in source
    uncommitted->committed this diff): X402_NETWORK "base", X402_RECIPIENT
    the treasury 0xc1923748669dFC3a79497d0403A90a275161eCCA (EIP-55 verified
    live), IRYS_NODE_URL -> uploader.irys.xyz. Against local wrangler with
    the funded mainnet key as IRYS_UPLOAD_KEY, pol-paid-call --network base
    proved the WHOLE mainnet path with ONE real payment: /health/x402
    network base / eip155:8453 / supported true; unpaid refused; a REAL
    0.25 USDC settled through CDP payer 0xA060..3B91 -> treasury on Base
    mainnet; audit verdict_hash 0x8591..4937; permanent mainnet cert
    5J411hkUP8Y6RRcan82stZE9J8EYD6gUsvw6QZBG7G8o retrievable by id (gateway
    200) AND by the mainnet GraphQL index query_pol_certificates reads.
    Two harness truths surfaced and handled: pol-paid-call hardcoded
    DEVNET_NODE for retrieval (fixed to read pol.node, so it follows the
    cert's actual network); and MAINNET INDEXING LAGS past the 60s leg-2
    window (the by-tags check may transiently read RED on a fresh mainnet
    cert, then succeed minutes later — confirmed live via a bounded query).
    Corollary for the query side: mainnet Irys GraphQL REQUIRES timestamp
    bounds or it times out (ab9c1d1 note, re-confirmed 2026-07-14).

    STAGE 3B DISCHARGED 2026-07-15: PRODUCTION IS LIVE ON MAINNET, and it
    did NOT repeat A9 because the deployed version was probed before trust.
    Sequence that worked: deploy the mainnet HEAD (version 1afad40e), THEN
    set the three secrets (the first attempt failed with "latest version not
    deployed" because production was rollback-pinned to 5f021c66; a plain
    deploy cleared that, then the puts succeeded), THEN probe the DEPLOYED
    version. Live probes green: /health/x402 network base / eip155:8453 /
    supported true; unpaid refused (PAYMENT_REQUIRED); a REAL 0.25 USDC
    settled through CDP payer 0xA060..3B91 -> treasury on Base mainnet (asset
    0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 = canonical Base USDC);
    verdict_hash 0x8591..4937; permanent cert
    EybaSQYzSfHqZKEjxSnojB6nsKsofCD3rpda8hFqrhfm anchored, by-id AND by-tags
    green. Rollback target 5f021c66 named before deploy, unused.
    The full Phase 2 offer (pay via x402 -> anchored PoL certificate) is LIVE
    on Base mainnet. Reserved items (price, treasury) are discharged.

A12. 2026-07-15: QUERY-SIDE BOUNDS, forced live by the cutover. With
    anchoring on mainnet, query_pol_certificates (unbounded GraphQL) TIMED
    OUT immediately — the addenda-8 hazard, proven the moment real data
    landed (instrument: external mcp call).
    FIRST ATTEMPT OVERCLAIMED (59c2121): added a timestamp window but with a
    trailing 180-DAY default, and the deployed tool STILL timed out — the
    commit's "must return certs" was not met, corrected here. Root cause,
    measured live against the mainnet index (single-tag app-id query):
    7d ~0.3s, 30d ~1.4s, 60d ~10s TIMEOUT, 180d TIMEOUT. The index scans by
    timestamp, so cost grows with window AND with mainnet's total size over
    time — a fixed wide default is fragile by construction.
    ACTUAL FIX: default path AUTO-NARROWS (14d then 3d) so the tool
    self-heals instead of erroring; an explicit from_ms/to_ms is honored
    as-is (caller owns that width); the response reports the window used.
    Write side never touched (pol-offline 26/26, tsc 0). Deploy is a plain
    wrangler deploy (secrets persist); DISCHARGED only when the DEPLOYED tool
    returns certs, verified by external mcp call (A9 deploy doctrine: the
    instrument is the deployed version, not the local edit).
