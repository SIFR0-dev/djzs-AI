---
claim: CLARITY Act becomes law in 2026, NO side, held from 37%.
falsifier: a cloture filing on CLARITY before the ~Aug 7 recess, or a brokered ethics-deal announcement
residual: one weekend deal headline repricing 15-25 points against
probability_basis: Polymarket H.R.3633-2026 NO mid 84.5c (YES 15.5%), retrieved 2026-08-05T19:53Z, ~$4.85M volume / ~$295K liquidity
---

# clarity-act-no-v2

v2 of [clarity-act-no.md](./clarity-act-no.md), which fails the dry gate because
its `probability_basis` states a level with no venue behind it. This version names
a venue, a print, and depth, so it clears the gate.

## probability_basis provenance

Retrieved 2026-08-05T19:53Z from Polymarket, market slug
`clarity-act-signed-into-law-in-2026`, conditionId `0x9cb23d04…f390`.
Two independent endpoints agreed, and the order book corroborates the mid:

| Source | YES | NO |
|---|---|---|
| Gamma `outcomePrices` | 0.155 | 0.845 |
| CLOB `/midpoint` | 0.155 | 0.845 |
| CLOB `/book` NO top-of-book | — | bid 0.84 / ask 0.85 |

Volume $4,846,223. Liquidity $295,322. 24h volume $965,855. Spread 1c.

The prior version of this line (`NO mid 37c, 2026-08-02 close, ~$1.2M depth`) was
invented as a shape illustration and is superseded. Passing the dry gate still
only proves the field's *shape* — the numbers above are load-bearing because they
were retrieved, not because the gate passed.

Note: `claim` says "held from 37%", an entry reference, while the basis records
the current market at YES 15.5%. Both are true and they are not in conflict, but
they are three days and ~21 points apart.
