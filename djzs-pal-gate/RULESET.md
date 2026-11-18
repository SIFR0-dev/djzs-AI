# PALGATE-TRANSFER-v0.1

The whole decision this gate makes, in one page. The code is `src/ruleset.ts`, one pure function.
If this page and the code disagree, the code is right and this page is wrong: fix it.

The name is provisional. Whether this ruleset joins the DJZS taxonomy, and under what name, is an
open ruling (README, R1).

## What is being decided

A conversational agent asks to move USDC by calling a tool. It supplies four things:

| Field | What it is |
|---|---|
| `recipient` | the wallet address to pay |
| `amount_usdc` | how much |
| `reference` | a claim code: the stated basis for the payout |
| `reason` | why, in the caller's words |

The gate does not judge how convincing the request is. It looks up the **claim** the reference
points at and checks the request against it, field for field.

A claim is a payout the operator issued in advance: **one address, one exact amount, usable once**,
with an optional expiry.

## The three verdicts

| Verdict | Meaning | What happens |
|---|---|---|
| **FAIL** | A defect. The stated basis is false, or the request is malformed. | Nothing is reserved. Never executes. |
| **WAIT** | Not a defect, but not executable now. | Depends on the cause, below. |
| **PASS** | Every record check holds and the amount is inside the operator's limits. | The claim is reserved. Execution waits for the end of the call. |

WAIT has three causes, and each has its own disposition:

| Disposition | Cause | What happens |
|---|---|---|
| `NEEDS_INFO` | A field the gate needs was not given. | Nothing is reserved. The caller is told exactly what is missing. |
| `HOLD_FOR_HUMAN` | The request is valid but beyond what the gate releases alone. | The claim is reserved until a person approves or denies. |
| `CLOSED` | The operator has the gate shut. | Nothing is looked up, reserved or executed. |

## The flags

Sixteen flags, in canonical order. A decision lists its flags in this order.

| Flag | Class | Raised when |
|---|---|---|
| `GATE_CLOSED` | closed | `GATE_MODE` is anything other than exactly `open` |
| `RECIPIENT_INVALID` | defect | the recipient is not a well-formed, non-zero `0x` address |
| `AMOUNT_INVALID` | defect | the amount is not a positive decimal with at most 6 places |
| `REFERENCE_UNKNOWN` | defect | something was cited and no claim matches it |
| `REFERENCE_VOID` | defect | the claim was cancelled |
| `REFERENCE_REDEEMED` | defect | the claim has already been paid out |
| `REFERENCE_IN_USE` | defect | the claim is reserved by another request |
| `REFERENCE_EXPIRED` | defect | the claim's expiry has passed |
| `RECIPIENT_MISMATCH` | defect | the claim pays a different address |
| `AMOUNT_MISMATCH` | defect | the amount is not exactly the claim's amount |
| `RECIPIENT_ABSENT` | incomplete | no recipient was given |
| `AMOUNT_ABSENT` | incomplete | no amount was given |
| `REFERENCE_ABSENT` | incomplete | no claim code was given |
| `REASON_ABSENT` | incomplete | no reason was given |
| `OVER_AUTO_LIMIT` | hold | the amount is above `AUTO_LIMIT_MICRO` |
| `BUDGET_EXHAUSTED` | hold | the amount is above what is left of `DAILY_BUDGET_MICRO` today (UTC) |

## The procedure

1. **Closed gate.** If the gate is not open, the decision is `WAIT / CLOSED` with `GATE_CLOSED`
   alone. Nothing about the request is examined.
2. **Collect every defect and every missing field.** All of them, not just the first.
3. **Classify.** Any defect: `FAIL`. Otherwise any missing field: `WAIT / NEEDS_INFO`.
4. **Limits, last.** Only a request with no flag at all is compared with the limits. Over either
   limit: `WAIT / HOLD_FOR_HUMAN`. Otherwise `PASS`.

Three properties follow, and the tests hold each one over every input state:

- **Nothing cited is incomplete; something false is a defect.** A caller who gives no claim code is
  asked for one. A caller who gives a wrong one is refused.
- **A limit is not a reason.** The two limit flags can only turn a PASS into a hold. They never
  appear beside a defect or a missing field, and lifting the limits never changes a FAIL.
- **The amount must match exactly.** A claim is spent by its first payout. If a smaller amount
  were accepted, anyone who learned a code could spend it on one cent and leave the person it was
  issued to with nothing. With an exact match, the only thing a claim can ever do, whoever cites
  it, is pay its own address its own amount. A claim code is a reference, not a secret.

## What the reason is for

The reason is required, hashed, and never read. The gate records that a reason was given
(`reason_sha256`, and its length) and nothing about what it said. No wording of the reason can
change the decision, because the decision does not take the reason as an input. That is the
point: the part of the request a person can be persuasive in is the part the gate does not weigh.

## The decision is checked again when it is written

The ruleset decides from a read of the records. Between that read and the write, another request
can take the same claim or the last of the day's budget. So an approval is written in one D1
transaction that repeats the record checks in SQL (`src/store.ts`): reserve the claim only if it
is still open, approve only if the claim is now reserved for this decision, still names this
recipient and this amount, and both limits still have room; otherwise release and decide again.
The ruleset is the decision. The SQL is the guarantee that the decision was still true at the
moment it was recorded.

## The two hashes

Every decision carries two sha256 hashes over single-line preimages. The ledger publishes the
preimages beside the hashes, so anyone can recompute both with `sha256sum`.

```text
palgate.intent.v1|action=transfer|asset=USDC|chain_id=8453|recipient=<0x..>|amount_micro=<n>|reference_sha256=<hex>|reason_sha256=<hex>
palgate.decision.v1|intent_sha256=<hex>|verdict=<V>|disposition=<D>|flags=<A,B>|ruleset=PALGATE-TRANSFER-v0.1
```

- A field that was not given renders empty. A field that was given and is unusable renders `!`.
- The claim code and the reason enter as their own sha256, never as text.
- `intent_sha256` identifies what was asked. `decision_sha256` identifies this answer to it.
- The records at that moment (was the claim open, what was left of the budget) are **not** in the
  preimage. The same intent can rightly get a different decision later. The hash proves what the
  gate answered, not that the answer could be re-derived from the request alone.

These are not the DJZS EIP-712 `intent_hash`, and v0.1 writes no on-chain attestation
(README, R1).

## The pin

`test/ruleset-exhaustive.test.mjs` enumerates 29,120 input states (gate, recipient, amount, claim
state, expiry, claim size, reason, budget), checks each against an oracle written independently of
the engine, and pins the result:

| | Count |
|---|---|
| PASS | 5 |
| WAIT, `HOLD_FOR_HUMAN` | 11 |
| WAIT, `NEEDS_INFO` | 400 |
| WAIT, `CLOSED` | 14,560 |
| FAIL | 14,144 |

and a sha256 over every (input, decision) pair. Each count was derived by hand before it was
pinned; the derivation is in the test.

**Changing the ruleset moves the pin. Moving the pin is a ruling: bump the version with it.**
A decision recorded under `PALGATE-TRANSFER-v0.1` must mean the same thing forever.

## What this ruleset does not do

- It does not verify an EIP-55 checksum. Addresses are compared in lowercase.
- It does not know whether the recipient is the person speaking. A claim pays its address whoever
  cites it, which is the safe direction: the worst a stranger can do with someone else's claim is
  cause that person to be paid what they were owed.
- It does not rate-limit. That is an edge rule, not a ruleset rule (README, open items).
- It does not move money. `src/executor.ts` ships one executor, and it is a dry run.
