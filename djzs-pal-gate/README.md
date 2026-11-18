# djzs-pal-gate

A deterministic gate between a conversational agent and one money action.

A Tavus PAL (a video agent) is given exactly one way to move money: a tool called
`request_transfer`. That tool does not move anything. It asks this Worker. The Worker checks the
request against a record, answers PASS, WAIT or FAIL in a sentence the PAL speaks word for word,
and writes the decision to a public ledger with the hashes to recompute it.

The model proposes. TypeScript decides. Every decision is recorded.

You can talk the PAL into saying anything. You cannot talk the gate into paying.

## Status: v0.1

| | |
|---|---|
| Ships | **closed** (`GATE_MODE = "closed"`) and in **dry run** (`EXECUTOR = "dry_run"`) |
| Moves funds | **No.** There is no wallet, no key and no transaction code in this Worker. The bundle test checks that. |
| Deployed | **Nowhere.** No database exists, no secret is set, no hostname is chosen. |
| Tavus | **Never called.** The Tavus side is built from the Tavus docs as read on 2026-11-17 and tested against a stub. See "Not yet verified against a live Tavus account". |
| Receipts | Two sha256 hashes per decision, with published preimages. **No on-chain attestation.** |

## The four rules the Tavus tool contract forces

Tavus delivers a tool call as an HTTPS request and has fixed rules for what it does with the
answer. Four design rules follow, and each one is held by a test.

1. **A refusal is a successful response.** Tavus speaks a tool's result only when the endpoint
   answers 2xx. On any other status the model improvises a failure message of its own. So PASS,
   WAIT and FAIL all answer `200 text/plain`, and the body is the sentence. The tool is registered
   with `on_resolve: "response_in_result"`, so that sentence is spoken word for word.
2. **No human approval inside the call.** A tool call may take 60 seconds at most. A request that
   needs a person is held and answered at once; the person approves or denies it later.
3. **Nothing irreversible during the conversation.** A PASS reserves the claim and stops.
   Execution happens when Tavus fires the post-call action, after the conversation has ended.
4. **The PAL only has gated tools.** The Worker cannot enforce this; it is a property of the PAL.
   `pal/register.mjs` reports everything else the PAL can call.

## How one request flows

1. The caller asks the PAL for a payout. The PAL calls `request_transfer` with what the caller
   said: an address, an amount, a claim code, a reason.
2. Tavus signs the call (HMAC-SHA256 over the exact body) and posts it here.
3. The Worker verifies the signature on the raw bytes before it parses anything.
4. It opens one decision row for that call. A retry or a replay of the same call lands on the same
   row and gets the same answer.
5. It reads the arguments strictly, looks up the claim the code points at, and decides
   ([RULESET.md](RULESET.md)).
6. It writes the decision. An approval is written together with the claim reservation, in one
   transaction that re-checks the records. Two requests for one claim cannot both be approved.
7. It answers with one sentence. The PAL speaks it.
8. When the conversation ends, Tavus fires `settle_after_call`. The Worker executes that
   conversation's approvals, once each. In v0.1 "execute" records what would have moved.

## What it decides

One page: [RULESET.md](RULESET.md). In short: a **claim** is a payout the operator issued in
advance, to one address, for one exact amount, usable once. A request is checked against the claim
it cites. Citing nothing is incomplete (WAIT). Citing something false is a defect (FAIL). The
operator's limits can only turn a PASS into a hold for a person. The caller's reason is required,
hashed and never read, so no wording of it can change the answer.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /health` | anyone | What is configured. Booleans and public settings only. |
| `POST /tavus/tool/request_transfer` | Tavus (HMAC) | The gated tool. `200 text/plain` is the sentence to speak. `?format=json` returns the decision. |
| `POST /tavus/post-call/settle` | Tavus (HMAC) | The post-call action. Executes this conversation's approvals. |
| `GET /ledger`, `GET /ledger/:id` | anyone | The public record. |
| `POST /operator/claims` | operator | Issue a claim: `{ "recipient", "amount_usdc", "expires_at"?, "id"? }` |
| `POST /operator/claims/:id/void` | operator | Cancel an open claim. |
| `GET /operator/holds` | operator | Requests waiting for a person. |
| `GET /operator/unsettled` | operator | Approved or mid-execution, not finished. |
| `POST /operator/decisions/:id/resolve` | operator | `{ "action": "approve" }` a hold, or `{ "action": "deny" }` anything not yet executed. |
| `POST /operator/conversations/:id/settle` | operator | Run the post-call door by hand. |

Operator routes take `Authorization: Bearer <OPERATOR_KEY>`.

Every error is a fixed code from a closed list (`src/faults.ts`), never an exception message.

## Fail closed

| Missing or wrong | Answer |
|---|---|
| `TAVUS_TOOL_SECRET` not set | `503 gate_not_configured` |
| Signature wrong or absent | `401 bad_signature`, nothing parsed, nothing written |
| D1 not bound | `503 store_unavailable`: an approval that cannot be recorded is not an approval |
| `GATE_MODE` anything but exactly `open` | Tool calls answer WAIT. A typo closes the gate; it cannot open it. |
| `EXECUTOR` not a name this version ships | `503 executor_unavailable` on every route that would execute |
| A limit that is not a plain number | Reads as zero: every valid request is held for a person |

**`GATE_MODE` is the kill switch.** While the gate is closed, no route calls an executor: the
post-call action, the operator's settle and the operator's approve all answer `409 gate_closed`
and change nothing. Reading, issuing, voiding and denying still work.

## The record

`GET /ledger` lists every decision, newest first. Each row carries the verdict, the disposition,
the flags, the ruleset version, the recipient, the amount, and two hashes with their preimages:

```sh
cd ~/djzs-om/djzs-pal-gate
curl -s "$PAL_GATE_URL/ledger?limit=1"
printf %s 'PASTE THE intent_preimage HERE' | shasum -a 256
```

The second line prints `intent_sha256`. The same works for `decision_preimage` and
`decision_sha256`.

**Published:** recipient address, amount, verdict, flags, state, a 12-character tag that groups
the rows of one conversation, and the hashes.

**Never published, and not stored as text:** the caller's reason (only its sha256 and length are
kept). **Stored and never returned by a public route:** the claim code, the Tavus conversation id
and the tool call id. **Not stored at all:** IP addresses. There is no column for one.

Anyone who tries the gate should be told before they start that the address and amount they give
are published. Put that line on the page that hosts the PAL.

## What the operator does

A claim is issued before anyone asks for it:

```sh
cd ~/djzs-om/djzs-pal-gate
curl -s -X POST "$PAL_GATE_URL/operator/claims" -H "authorization: Bearer $OPERATOR_KEY" -H "content-type: application/json" -d '{"recipient":"0xPASTE_THE_ADDRESS","amount_usdc":"1.00"}'
```

The answer carries the claim code, for example `PG-7K2M-9QX4-B1CD-E5FG`. Give it to the person the
claim is for. Take the recipient address from that person, in writing. Never copy it from a
transaction list or a block explorer (repo rule, CLAUDE.md section 14).

A claim code is a reference, not a secret. A claim pays only its own address and only its own
exact amount, so the worst a stranger can do with someone else's code is cause that person to be
paid what they were owed. Generated codes are 80 random bits; you may also pass your own `id`.

Holds, and approvals whose post-call action never arrived:

```sh
cd ~/djzs-om/djzs-pal-gate
curl -s "$PAL_GATE_URL/operator/holds" -H "authorization: Bearer $OPERATOR_KEY"
curl -s "$PAL_GATE_URL/operator/unsettled" -H "authorization: Bearer $OPERATOR_KEY"
```

Approve or deny by decision id; settle by conversation id (both are in those answers):

```sh
cd ~/djzs-om/djzs-pal-gate
curl -s -X POST "$PAL_GATE_URL/operator/decisions/PASTE_DECISION_ID/resolve" -H "authorization: Bearer $OPERATOR_KEY" -H "content-type: application/json" -d '{"action":"deny"}'
curl -s -X POST "$PAL_GATE_URL/operator/conversations/PASTE_CONVERSATION_ID/settle" -H "authorization: Bearer $OPERATOR_KEY"
```

An approval by a person does not count against the gate's own daily budget.

## Setup (the operator's shell only)

Nothing below can be done from a remote container, by design: it needs the Cloudflare login, the
Tavus API key and the two secrets. Each block is bare commands, one per line, and opens with its
`cd`.

**1. Database.** Create it, then put the id it prints into the `[[d1_databases]]` block at the
bottom of `wrangler.toml` (uncomment the block). That edit is a commit to `main` like any other.

```sh
cd ~/djzs-om/djzs-pal-gate
npm install
npx wrangler d1 create djzs-pal-gate
```

**2. Deploy.** The predeploy guard refuses a dirty tree, a HEAD that is not `origin/main`, or red
types. This is the first deploy, so there is no earlier version to roll back to; the fallback is
that the gate ships closed and without secrets, and refuses everything.

```sh
cd ~/djzs-om/djzs-pal-gate
npm run deploy
```

**3. Secrets.** Generate both in the shell, send them to the Worker, and store them where you keep
the other Worker secrets before you close the shell. The Worker never shows them again.

```sh
cd ~/djzs-om/djzs-pal-gate
export TAVUS_TOOL_SECRET="$(openssl rand -hex 32)"
export OPERATOR_KEY="$(openssl rand -hex 32)"
printf %s "$TAVUS_TOOL_SECRET" | npx wrangler secret put TAVUS_TOOL_SECRET
printf %s "$OPERATOR_KEY" | npx wrangler secret put OPERATOR_KEY
```

**4. Probe the deployed version.** A deploy is done when the deployed version answers correctly,
not when wrangler prints "Deployed".

```sh
cd ~/djzs-om/djzs-pal-gate
export PAL_GATE_URL=https://PASTE_THE_WORKERS_DEV_HOST
curl -s "$PAL_GATE_URL/health"
```

Expect `gate_mode` `closed`, `executor` `dry_run`, `moves_funds` `false`, and `store_bound`,
`tavus_secret_set` and `operator_key_set` all `true`.

**5. Register the two tools with Tavus.** The first command is a dry run: it prints what would be
sent, with the secret masked, and sends nothing. The second prompts for the Tavus API key without
echoing it. The third sends.

```sh
cd ~/djzs-om/djzs-pal-gate
node pal/register.mjs
read -rs 'TAVUS_API_KEY?Tavus API key (hidden, then Return): ' && export TAVUS_API_KEY && echo
export TAVUS_PAL_ID=PASTE_THE_PAL_ID
node pal/register.mjs --send
unset TAVUS_API_KEY
```

`--send` first proves the secret in this shell is the Worker's secret (a signed probe the Worker
must refuse as `wrong_tool`), then creates the tools, attaches them, and prints the rule 4 report.
Paste `pal/system-prompt.md` into the PAL's system prompt.

**6. Try it closed.** Issue a claim, talk to the PAL, ask for the payout. The PAL should say the
gate is closed, and `GET /ledger` should show a `WAIT / CLOSED` row. That one conversation proves
the whole path: Tavus signing, the Worker verifying, the sentence being spoken, the row landing.

**7. Open it.** Change `GATE_MODE = "closed"` to `GATE_MODE = "open"` in `wrangler.toml`, commit
to `main`, deploy, probe `/health` again. To close it, reverse that. Name the rollback target
before any later deploy:

```sh
cd ~/djzs-om/djzs-pal-gate
npx wrangler deployments list
```

## Rule 4: what else can the PAL call

The gate only gates what goes through it. A PAL with a second tool that moves value is not gated,
whatever this Worker does. Four places hold a PAL's capabilities, and `pal/register.mjs --send`
reads all four:

| Where | What should be there |
|---|---|
| Attached tools (`GET /v2/pals/{pal_id}/tools`) | `request_transfer` and `settle_after_call`, nothing else |
| Legacy inline tools (`layers.llm.tools` on the PAL) | none |
| MCP connectors (`layers.mcp`) | none that can move value |
| Skills (`GET /v2/pals/{pal_id}/skills`) | none that can move value |

`end_call` is built into every Tavus conversation and cannot be removed.

`settle_after_call` must stay a `post_call` tool. Tavus does not show post-call tools to the model
during a call. Registered as an ordinary tool it could be called mid-conversation, which is rule 3
broken by configuration.

## What v0.1 does not do

- **It does not move money.** The only executor is a dry run. A real one is ruling R2.
- **It does not attest on chain.** No EIP-712 `intent_hash`, no EAS attestation. Ruling R1.
- **It does not rate-limit.** Tool calls must carry a Tavus signature, so only Tavus can cause a
  write, but `GET /ledger` is open. Add a Cloudflare rate rule before the hostname is public.
- **It does not sweep.** An approval whose post-call action never arrives stays approved, holding
  its claim, until the operator settles or denies it. It is visible in `/operator/unsettled`.
- **It has no reconcile route.** A decision can be left in `executing` (the Worker stopped between
  two writes) or `execution_uncertain` (the executor could not say what happened). Both are shown
  in `/operator/unsettled`, both keep their claim, and neither has an exit in v0.1. With a dry-run
  executor nothing moved either way. The route that resolves them belongs with the real executor,
  because resolving them means reading the chain.
- **It does not check an EIP-55 checksum.** Addresses are compared in lowercase.
- **It does not control what the PAL says.** The tool's result is spoken word for word. Anything
  the PAL says after that is the model talking. The ledger is the record of what happened.
- **Spoken addresses are unreliable.** Forty hex characters do not survive speech-to-text. The
  page that hosts the PAL should let the caller paste the address and the code as text.
- **Expiry is checked when the gate decides.** An approval made before a claim expired is still
  executed after the call ends.

## Not yet verified against a live Tavus account

No request has been sent to Tavus from this work. Everything on the Tavus side follows the docs as
read on 2026-11-17. These are the points to check on the first real conversation, in order:

1. **The post-call request in hmac mode.** The docs describe the signed envelope for tool
   delivery and say a post-call action uses the same `delivery` field, but they show a post-call
   request only with `body_template`. The Worker therefore requires only `name` and
   `conversation_id` from the post-call body. To see what Tavus really sent, read the
   `application.post_call_action_executed` event (the conversation's `callback_url`, or the
   `events` field of the verbose GET conversation response): it carries `request`, `response` and
   `status`. If the envelope is different, approvals stay in `/operator/unsettled` and nothing
   is lost; settle by hand and fix the parser.
2. **One id across a retry.** Tavus retries once on a 5xx or a connection error. Its docs call
   the envelope's `tool_call_id` "unique per invocation" and the `{tavus_tool_call_id}`
   placeholder "stable across retries". The Worker treats them as the same id. If a retry ever
   arrived under a new id it would be decided as a new call; it could not be approved twice,
   because the first decision already holds the claim.
3. **A post-call tool whose only parameter is a `const`.** The docs show `const` for fixed
   post-call parameters; whether a tool with nothing but fixed parameters is accepted is untested.
4. **The response shapes `pal/register.mjs` reads for the rule 4 report.** If it cannot read one
   it says INCOMPLETE and exits non-zero. It never reports a clean PAL from an answer it did not
   understand.

## Open rulings

These are the operator's. Nothing in v0.1 presumes an answer.

- **R1. Receipts.** How a transfer maps onto the `DJZSIntent` EIP-712 struct, and whether pal-gate
  decisions are attested under the DJZS EAS schema and attester. `transfer` is already an action
  class in `djzs-trust-mcp/src/djzs-intent.ts`. The risk to weigh: demo traffic in the same
  attestation stream that `query_agent_trust` reads.
- **R2. The executor.** Which wallet signs, where its key lives, how a transfer is confirmed, and
  the reconcile route that comes with it. Until this is ruled, `EXECUTOR` has one valid value.
- **R3. The name.** `PALGATE-TRANSFER-v0.1` is provisional.
- **R4. The hostname.** `workers.dev` only until one is named.
- **R5. A public challenge.** Whether a real payout is ever attached, and on what terms.

## Tests

Everything runs offline, with no key and no network.

```sh
cd ~/djzs-om/djzs-pal-gate
npm install
npm run typecheck
npm test
```

| File | What it holds |
|---|---|
| `test/money.test.mjs` | Amounts are integers end to end. No float is parsed, produced or compared. |
| `test/ruleset-exhaustive.test.mjs` | All 29,120 input states against an independent oracle and eight invariants, pinned by tally and hash. |
| `test/say.test.mjs` | Every sentence the PAL can be made to say, pinned. No flag code, address or claim code is ever spoken. |
| `test/tavus-hmac.test.mjs` | The signature is checked on raw bytes. The envelope and the model's arguments are read strictly. |
| `test/gate-flow.test.mjs` | The routes against a real D1: fail closed, the three verdicts, races, holds, the kill switch, the post-call door, the record. |
| `test/pal-register.test.mjs` | The tool definitions carry no endpoint and no secret. The registration script on a stubbed network. The rule 4 report. |
| `test/bundle.test.mjs` | The built bundle in workerd: signatures, hashes, a concurrent race, zero egress, no transaction code. |

The bundle test exists because the source tests run under Node and what ships is a bundle running
in workerd. It has already earned its place: it caught a named export on the entry module that
stopped workerd from starting the Worker at all, which every source test passed.
