# For agents

Written for the caller, not the operator. If you are an autonomous agent wired to DJZS, this page is
your contract.

**Audit before act.**

---

## The invariant

No capital-deploying action executes until DJZS returns `action: "PROCEED"`.

Gate on `action` (`djzs-trust-mcp/src/verify-pm-trade.ts:89-90`). Not on `verdict`, not on
`risk_score`, and **not** on `flags.length`:

```
action = "PROCEED"  ->  proceed
action = "HALT"     ->  stop, clarify, re-audit
action = "FAIL"     ->  stop, report
```

Three ways to get this wrong, each with a real cost:

| Mistake | Consequence |
|---|---|
| Treating `flags.length > 0` as a block | You halt on a solo DJZS-M04, which the engine deliberately passes as an advisory (`verify-pm-trade.ts:107`). |
| Re-deriving the verdict from `risk_score` | You miss that **any CRITICAL forces FAIL regardless of score** — DJZS-X01 weighs 15 against a threshold of 50 and still condemns. |
| Treating WAIT as a soft PASS | You execute on a thesis the auditor could not read. WAIT is a stop. |

Never soften or re-frame a HALT into a partial position. A half-size trade on an unaudited thesis is an
unaudited trade.

---

## The HALT loop

WAIT is not a failure — it is a **request for information**, and it is the rung the architecture exists
to make available.

```
   +-> 1. audit
   |       action == "PROCEED" -> exit, execute
   |       action == "FAIL"    -> exit, report, do not execute
   |       action == "HALT"    -> continue
   |
   |   2. read unknown_fields + halt_reason
   |        which scored facts could the engine not resolve?
   |
   |   3. cross-check disagreements
   |        field in BOTH               -> the model read your thesis unstably: that is ambiguity
   |        field in unknown only        -> your thesis is silent on it: that is a gap
   |        field in disagreements only  -> outside the scored set, ignore it
   |
   |   4. RESTATE the thesis — add the missing fact, do not rewrite the trade
   |
   +-- 5. re-audit
```

`halt_reason` names the fields directly (`verify-pm-trade.ts:114-118`):

```
WAIT: 2 field(s) unresolvable from intent — [resolution_engagement, probability_basis]. Clarify intent and re-audit.
```

A worked instance of both branches is in the
[`verify_pm_trade` reference](reference/verify-pm-trade.md#d--wait-with-disagreements).

### What each unknown is asking for

Only three fields are WAIT-eligible on the PM path
(`server/engine-v2/audit-input-schema.ts:88`):

| `unknown_fields` entry | The question | Add to the thesis |
|---|---|---|
| `invalidation_condition` | What would prove you wrong **before** resolution? | An observable pre-resolution condition: "I'm wrong if the poll average drops below 45% by Oct 1." |
| `resolution_engagement` | Does your reasoning engage **the market's own** criteria? | Name the market's resolution source, threshold, definition, or window — and argue through it, not near it. |
| `probability_basis` | Where does your number come from? | The checkable basis: a filing, an official schedule, market pricing history, or your shown derivation. Or assert no probability at all — that is vacuously fine. |

### Restate, do not invent

**Add facts you actually have. Never manufacture one to clear a gate.**

A thesis with no falsification, no engagement, no basis — that absence *is* the signal. Fabricating an
invalidation condition to convert a FAIL into a PASS defeats the gate and produces a signed, hashed,
permanently anchored certificate attesting to a thesis you do not hold. The certificate commits to
`intent_sha256` (`djzs-trust-mcp/src/pol-certificate.ts:106`), so the fabrication is what gets
notarized.

If you cannot supply the missing fact, the correct outcome is: **do not trade.** Report the HALT.

### Bound the loop

- **Each audit costs 2.00 USDC.** An unbounded retry loop spends real money. Cap re-audits — two or
  three — and escalate to a human rather than iterating.
- **`extraction_failsafe: true`** means all three samples produced unparseable output and every fact
  fell back to unknown (`server/engine-v2/extraction-layer.ts:569`). That WAIT tells you nothing about
  your thesis. Re-run once; do not start editing the thesis in response to it.

If a field stays unknown across two clarifications, the thesis is probably genuinely ambiguous on that
point. Say so and stop.

---

## Read `disagreements` before you edit anything

Extraction telemetry, not an error (`extraction-layer.ts:450-458`). Two forms, two diagnoses:

| Entry | Diagnosis | Fix |
|---|---|---|
| `probability_basis` | **state** split — samples disagreed present/absent/unknown | Your thesis is ambiguous about whether a basis exists. State it. |
| `probability_basis(evidence)` | **evidence** split — all three said absent but quoted **different text** | Your thesis has *multiple* unsourced assertions. The samples condemned different ones. Source them, or drop them. |

**A field in `disagreements` but not in `unknown_fields` did not affect your verdict.** It is outside
the scored set and outside the hash preimage. The canonical case is a `stop_loss` disagreement on a PM
audit: prediction markets have no stop-loss, `stop_loss` is not in `PM_AUDIT_FIELDS`, and the
`verdict_hash` holds byte-identical regardless (`CLAUDE.md:91`).

---

## Scope: prediction markets only

`audit_context !== "prediction_market"` — **including undetermined** — returns `in_scope: false` with
`verdict: null` (`verify-pm-trade.ts:77-86`).

Check `in_scope` **first**. On `false` there are no verdict fields, and there is no fallback audit:
DJZS will not run a 3-of-11 perpetuals audit and present it as coverage.

An intent qualifies when at least 2 of the 3 extraction samples say so
(`extraction-layer.ts:519-522`) — it needs a prediction-market venue, a YES/NO outcome, a resolution
date, or an event probability.

**Out-of-scope calls still cost 2.00 USDC.** Payment clears before the handler; scope is determined
after extraction. Pre-filter for prediction-market theses on your side rather than routing arbitrary
trade intents here.

---

## The MetaMask audit-gate pattern

The pattern generalizes to any execution surface: **DJZS is the upstream gate; the wallet's own
pipeline is the downstream one.** Two independent gates on two different axes.

```
user intent
    |
    v
[ DJZS  -- "should this position be taken at all?" ]      <- reasoning
    |  action != PROCEED  ->  STOP. report. do not execute.
    |  action == PROCEED
    v
[ wallet -- "is this transaction safe to sign?" ]         <- transaction
    simulation -> threat scan -> policy (allowlist, outflow limits) -> submit
    |
    v
executed
```

Rules that make this work:

1. **The gate fires on capital-deploying actions only** — a swap, bridge, perpetual open/modify,
   prediction-market order, or a value transfer. Read-only intents do not need the gate.
2. **Capture the intent as stated.** Action, chain, assets, size, direction/leverage, the thesis, the
   exit plan. A trade with no articulated thesis or no stated exit **is itself the signal**. Pass it
   through as stated; never invent an exit the user did not give.
3. **`PROCEED` is necessary, not sufficient.** The downstream pipeline may still pause or reject. A
   wallet-side 2FA hold is a normal pending state, not a DJZS failure.
4. **DJZS does not replace policy.** Policy is who / where / how much. DJZS audits *why*.
5. **Carry the proof.** Attach `verdict_hash` and the certificate `gateway_url` to the action record.

> The `djzs-audit-gate` skill packaging this flow for the MetaMask Agent Wallet lives **outside this
> repository**. Its "dry-run (unpaid signal)" path does **not** exist on `verify_pm_trade`: the payment
> gate is fail-closed and no audit is ever served free (`djzs-trust-mcp/src/index.ts:90-96`). Treat
> every gate call as a paid call.

---

## Payments

**`verify_pm_trade` is a paid tool. Live and metered today.**

| | |
|---|---|
| Price | **2.00 USDC** per audit — `VERIFY_PM_TRADE_PRICE_USD = 2.00` (`djzs-trust-mcp/src/index.ts:58`), repriced from 0.25 on 2026-07-16 (`:43`) |
| Gate | `withX402(new McpServer(...), {...})` (`:95`) — wraps only the paid tool (`:94`) |
| In-band notice | the description agents receive carries `Paid tool: 2 USDC per audit via x402.` (`:250`) |
| Network | Base **mainnet** |
| Facilitator | **CDP**, via `createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)` (`:98`) |
| `query_pol_certificates` | free |
| `query_agent_trust` | free |

**Facilitator: CDP, not x402.org.** A10 ruling, 2026-07-14 (`:24-28`). The reason is on record: the
public x402.org facilitator settles **testnet only**, so it cannot settle Base mainnet.

**Settlement depends on Worker env.** The CDP keys are request-scoped secrets. Absent them the paid
tool cannot settle and errors before the handler runs — fail-closed, so no audit is ever served free.
`GET /health/x402` (`:370`) reports `facilitator_configured`, whether the configured network is
actually advertised, and the full advertised list.

**Non-custodial** (`:29-33`). Your EIP-3009 signature moves USDC from your wallet to the DJZS treasury,
`0xc1923748669dFC3a79497d0403A90a275161eCCA` (`:57`). That address is a deliberate source constant —
EIP-55 verified 2026-07-14, distinct from the operator wallet, and public by design: it appears as
`payTo` in every 402 challenge you receive. The recipient is bound **inside your signature**, so no
facilitator can redirect, skim, or custody it. CDP submits the transfer and pays gas — your wallet
needs USDC only, no ETH.

Three operational rules:

- **Raise `maxPaymentValue` to `2000000n`.** The client library default caps at 0.10 USDC and refuses
  the price before signing anything. Payers sign exact amounts, so a stale cap fails loudly rather than
  silently overpaying.
- **`callTool` on the wrapped client is callback-first** — confirmation callback first, tool call
  second.
- **Fund the payer above the price before you call.** The facilitator's verify step *simulates* the
  transfer; an underfunded wallet fails as `INVALID_PAYMENT`, which does not read like a balance
  problem.

Full recipe: [quickstart](quickstart.md#the-proven-payer-recipe). Only the `withX402Client` path is
documented, because it is the only one replayed against production by the deploy-parity gate.

---

## A compact caller

```js
const res = await paid.callTool(async () => true, {
  name: "verify_pm_trade",
  arguments: { intent: thesis, agent_address: MY_WALLET },
})
const r = JSON.parse(res.content[0].text)

if (r.in_scope === false)           return stop("not a prediction-market thesis", r.reason)
if (r.extraction_failsafe === true) return retryOnce("extraction failsafe — audit told us nothing")

switch (r.action) {
  case "PROCEED":
    // flags may be non-empty: a solo DJZS-M04 is an advisory riding a PASS.
    record({ verdict_hash: r.verdict_hash, cert: r.pol_certificate?.gateway_url, flags: r.flags })
    return execute()

  case "HALT":
    // r.halt_reason names the fields; r.disagreements says whether it is ambiguity or silence.
    return clarify(r.unknown_fields, r.disagreements, r.halt_reason)

  case "FAIL":
    return stop(`FAIL risk ${r.risk_score}`, r.flags.map(f => `${f.code} ${f.name}`))
}
```

Note what is **not** in that switch: no threshold arithmetic, no severity inspection, no flag counting.
The engine already did that work, deterministically, and hashed the result.

**Verdict is computed, not improvised.**
