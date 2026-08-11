---
claim: CLARITY Act becomes law in 2026, NO side, held from 37%.
falsifier: a cloture filing on CLARITY before the ~Aug 7 recess, or a brokered ethics-deal announcement
residual: one weekend deal headline repricing 15-25 points against
probability_basis: held from 37%
---

# clarity-act-no

The stamp run's thesis, in the frontmatter format. It is checked in AS IT WAS,
defect included: `probability_basis` states a level with no venue behind it.

    node agent/refusal-agent.mjs --intent agent/intents/clarity-act-no.md --mode dry

fails the field gate and costs nothing. The same intent, sent unchecked on
2026-08-02, cost 2.00 USDC to be told the same thing by the engine (entry 001:
WAIT, `unknown_fields: ["probability_basis"]`, risk 0, no flags).

To make it payable, name where 37 came from, e.g.

    probability_basis: Polymarket NO mid 37c, 2026-08-02 close, ~$1.2M book depth

Everything below the `---` fence is ignored and never reaches the wire string.
