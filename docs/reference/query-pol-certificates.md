# `query_pol_certificates`

Read ProofOfLogic certificates from the Irys mainnet index.

| | |
|---|---|
| **Price** | **free** — `withX402` gates only `verify_pm_trade` (`djzs-trust-mcp/src/index.ts:94`) |
| **Registration** | `djzs-trust-mcp/src/index.ts:101-178` |
| **Index queried** | `https://uploader.irys.xyz/graphql` (`index.ts:12`) |
| **Retrieval** | `https://gateway.irys.xyz/<irys_id>` |

Registered description, verbatim (`index.ts:103`):

> Query immutable ProofOfLogic certificates stored on Irys Datachain by DJZS Protocol. USE THIS TOOL
> when you need to verify audit history for an agent or project before delegating work, check FAIL
> verdicts, or retrieve certificates by Irys tx ID. DO NOT use for on-chain trust scores — use
> `query_agent_trust` for those.

---

## Input

| Field | Type | Default | Effect |
|---|---|---|---|
| `targetSystem` | `string?` | — | Filters on the `Target-System` tag. Set by `verify_pm_trade`'s optional `target_system` input. |
| `verdict` | `"PASS" \| "FAIL"?` | — | Filters on the `verdict` tag. **No `"WAIT"` option** — see below. |
| `tier` | `"micro" \| "founder" \| "treasury"?` | — | Filters on the `tier` tag. Every `verify_pm_trade` cert is tagged `micro` (`pol-certificate.ts:125`). |
| `limit` | `number` 1–100 | `20` | Result count. |
| `from_ms` | `int?` | auto-narrowing | Window start, epoch ms. |
| `to_ms` | `int?` | `now + 1h` | Window end, epoch ms. |

Two filters are always applied and cannot be turned off (`index.ts:113-116`):

```
Protocol       = ProofOfLogic
application-id = DJZS-Oracle
```

### The time window is not optional

The Irys mainnet GraphQL index scans by timestamp, and an over-wide window **times out**. Measured
live: 7d ≈ 0.3s, 30d ≈ 1.4s, 60d+ times out. The write side is unaffected.

The default path **auto-narrows** (`index.ts:126-150`): it tries a 14-day window, and on failure falls
back to 3 days, so the tool self-heals as the dataset grows rather than erroring. An explicit `from_ms`
is the caller's choice and is used **as-is**, with no fallback — the escape hatch for older
certificates, and also how you can hang the query.

If every window fails you get `isError: true` and a message naming the failure.

---

## Output

```json
{
  "total_returned": 1,
  "pass_count": 0,
  "fail_count": 1,
  "window": { "from_ms": 1750000000000, "to_ms": 1750086400000,
              "note": "certs outside this window need an explicit from_ms" },
  "certificates": [
    {
      "irys_id": "…",
      "irys_url": "https://gateway.irys.xyz/…",
      "timestamp": 1750000000000,
      "verdict": "FAIL",
      "tier": "micro",
      "target_system": "unknown",
      "audit_id": "…uuid…"
    }
  ]
}
```

Per-certificate fields are read off tags; anything missing reports the literal string `"unknown"`
(`index.ts:155-167`). `window.from_ms` reports **which** window actually succeeded.

### Two counters, three verdicts

`pass_count` and `fail_count` are computed by string comparison against `"PASS"` and `"FAIL"`
(`index.ts:171-172`), and the `verdict` input enum offers no `"WAIT"` filter (`:106`). WAIT
certificates *are* anchored — the builder accepts any verdict carrying a `verdict_hash`
(`pol-certificate.ts:83-90`) — so:

```
total_returned  >=  pass_count + fail_count
```

**Do not compute a fail rate from these two counters.** For aggregate posture use
[`query_agent_trust`](query-agent-trust.md), which reads on-chain tallies.

This is a real doctrinal gap, not a rounding detail: WAIT is a first-class verdict the certificate
registry cannot surface by filter. Recorded in the [roadmap](../roadmap.md).

---

## What is in a certificate

Fetch `irys_url` to get the payload (`pol-certificate.ts:92-115`):

```json
{
  "pol_schema": "DJZS-PoL-1",
  "tool": "verify_pm_trade",
  "schema_version": "DJZS-ENGINE-V2",
  "taxonomy": { "…the six-key hash block, verbatim from the response…" },
  "verdict": "FAIL",
  "action": "FAIL",
  "risk_score": 40,
  "flags": [ /* full flag objects */ ],
  "unknown_fields": [],
  "verdict_hash": "0x…",
  "intent_sha256": "0x…",
  "extraction": { "n": 3, "disagreements": [], "failsafe": false },
  "issued_at_ms": 1750000000000,
  "issuer": { "name": "djzs-trust-mcp", "version": "1.0.0" },
  "audit_id": "…uuid…"
}
```

**`intent_sha256`, not the intent.** The certificate commits to *what* was audited without publishing
the thesis (`pol-certificate.ts:105-106`). Computed after the verdict exists, so it cannot reach the
hash preimage. If you hold the original intent text you can prove the match; nobody else can read it
off the chain.

**`verdict_hash` is the engine-v2 sha256 artifact**, never the v1 keccak trace hash
(`pol-certificate.ts:103`). See [verdict_hash](../concepts/verdict-hash.md).

Tags emitted (`pol-certificate.ts:121-131`): `Protocol`, `application-id`, `verdict`, `tier`,
`audit-id`, `verdict-hash`, `pol-schema`, `Content-Type`, plus `Target-System` when supplied. The tag
contract is load-bearing — the query side filters and reads on exactly these names, so emitting less
would make a certificate invisible to this tool.

---

## Two lineages in the index

The index holds certificates from before Architecture C. They share the `Protocol` and
`application-id` tags, so this tool returns both. Distinguish by `pol_schema`:

| Marker | Lineage |
|---|---|
| `"pol_schema": "DJZS-PoL-1"` and `"tool": "verify_pm_trade"` | current engine-v2 output |
| absent `pol_schema` | prior-architecture lineage — the older detector path, not this engine |

Do not read a pre-Architecture-C certificate as an engine-v2 verdict.

---

## Determinism note

The engine is deterministic, so **identical theses produce identical payloads.** Without a uniqueness
anchor two identical uploads could collapse to one DataItem id, so every upload carries a 32-char
random anchor (`pol-certificate.ts:142-148`). Consequence: the same thesis audited twice yields **two
certificates with different `irys_id` values and the same `verdict_hash`.** One hash, many attestations
of it. `audit_id` is per-instance; `verdict_hash` is per-verdict.
