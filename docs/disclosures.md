# Disclosures and corrections

Things that went wrong, were measured to be weaker than first stated, or are built but not live. Each entry was
first published on djzs.ai/ruleset and moved here on 2026-11-21 with its wording kept. Current numbers are in
[What is measured](measured.md); this page is the history behind them.

## Extraction stability: the measurement history

**Extraction reliability, measured.** 2026-09-01: 15 theses spanning the verdict space, 5 replays each, N=3
consensus, Sonnet 4.6 at temperature 0. Under contract v1.0: verdict reproduced 98.7%, 14/15 theses identical.
Under **v1.1**: **100%**, 15/15 identical, 0 failsafes in 75 runs, designed-class match 15/15. Pre-registered
threshold ≥95%.

**Re-measured 2026-09-08**, same corpus +1 thesis: v1.1 scored **97.5%**, 14/16 identical, class match 16/16, so
the 100% was the top of a band, and the layer's stability is reported as one.

A candidate contract (X-v1.2, adding a perp-side `thesis_statement` field for DJZS-LF S01) was run the same day
in three variants: 96.3% / 96.3% / 95.0% (inside the band), but class match fell to 13–14/16, with one definite
no-invalidation thesis drifting from FAIL to WAIT under every variant.

**Acceptance for extraction changes is two-dimensional**: designed-class match not worse (primary), and verdict
stability inside the measured band for an identical contract, which three same-prompt runs put at 1.000 / 0.975
/ 0.950, so ≥95%.

**That bar was revised after the fact, and the deploy it graded missed the earlier one.** The bar first written
here was stability within 0.02 of 0.975 with class match 16/16. The 2026-09-08 deploy (Worker `697a014a`)
measured **0.950** with class match 16/16 (2.5 points below the 0.975 reference, 0.5 below the band floor) and
shipped; the bar was then rewritten to "class match primary, ≥95%" in the same message that disclosed the miss.
Recorded as a **breach with the bar revised afterward**, not as a re-measurement: the revision is defensible on
its merits, but a bar that moves once the number is known measures nothing, and the sequence was number first.
No caller got a wrong class: class match was 16/16 and the harness’s own gate (mean ≥ 0.95) passed. What the
episode cost is the meaning of the word "passed", which is why it is written here rather than quietly fixed. The
rule it produced: an extraction-contract change pre-registers its threshold in the commit that introduces it,
before any harness run; a miss gets a published deviation note, never a redefinition; and re-measuring the noise
band is a separate commit on the unchanged contract, done before the next change rather than after a
disappointing number. Full note in `tests/q3/SCAN_SPEC.md` §11.

Resolved by splitting the contract by tool rather than sharing one prompt: `verify_pm_trade` runs X-v1.1
byte-verbatim; `verify_perp_trade` runs **X-LF-v1.2**. Perp harness, 2026-09-08, 14 theses × 5 replays:
stability **97.1%**, 13/14 identical, class match 13/14; every FAIL class lands (S01 on a thesis-less position,
X01 on an unbounded one, both on the position with neither); the one split is the designed boundary case ("feels
right": reason or not).

Getting there took three bugs out of the layer between model and engine, none visible to the exhaustive engine
sweeps: consensus demanded unanimity on objective numbers (one dissenting sample zeroed a stated leverage), the
parser coerced bare values to unknown, and the harness did not record the two fields that gate S01/X01. All
three are regression tests in CI now.

Note: at temperature 0 the three consensus samples are near-identical draws, so this measures production
determinism more than independent agreement.

**Scope of every number above:** short first-person theses written for the test, 54 to 586 characters as
rendered. Published third-party prose is a harder input. Of the eight sealed Q3 study records that carry a
published thesis (191 to 1,569 characters, six distinct texts), seven had a scored fact demoted to `unknown`
because the three samples disagreed, and six of those seven came back WAIT. Eight records is an observation, not
a measurement, and it is stated here so the band above is not read as covering text it was never run on. Harness
and raw runs in `tests/`.

## The extraction rule removed in `DJZS-X-v1.1`

Extraction contract DJZS-X-v1.1 (2026-09-01): a rule in the extraction layer had been demoting a
correctly-detected unsourced claim to `unknown` unless the intent contained probability vocabulary (%, odds,
chance, likely, probably), so "gut feel" and "everyone knows" produced WAIT, not M03. Found by measurement (Q2),
reproduced from raw samples, removed as a versioned contract change with before/after evidence in `tests/out/`.
Every response now states its extraction contract as `taxonomy.extraction`.

## The verdict rule on chain: built, not deployed

**The verdict rule on chain (DJZS-VR-v1.0). Written and tested, not yet deployed.** Until now the attestation
stated a verdict and the flags behind it, and a reader who wanted to know whether the verdict followed from the
flags had to run the published engine. `contracts/DJZSVerdictRule.sol` is the last step of that engine as
bytecode: given the fired codes, how many scored fields were unknown, and whether the bet was bounded, it
derives the risk score and the verdict, and it refuses a code or a ruleset it does not know rather than scoring
it as zero. `contracts/DJZSVerdictResolver.sol` is an EAS schema resolver for a v3 schema (the v2 fields plus
that tally): EAS accepts an attestation under it only when the stated verdict is the one the rule derives,
whoever the attester is, so **the public record cannot hold a verdict its own facts contradict.** The rule
exists in three places, the engine, a TypeScript function over the tally, and the contract, and they are held
together by one fixture: every distinct tally the engine produces over its full input space (59,157 inputs, 267
tallies) scores identically in all three, in CI. What this does not do: the model still detects. The rule
constrains what a verdict can be given the flags; it cannot make the flags true. Deployment on Base, schema
registration, and the Worker switch are one runbook (`VERDICT_RULE.md`) and are pending; until they run,
receipts keep landing under schema v2 exactly as before, and this rung reads BUILT rather than LIVE.

## WAIT is counted wrongly by the subgraph

**WAIT is an abstention, and one of the two places that record it still gets that wrong.** A `WAIT` is the
engine declining to rule. It says something about the thesis, not about the agent, so `query_agent_trust`
excludes it from both sides of the fail rate and reports it separately as `wait_count`. **Anyone reading the
subgraph directly, rather than through the tool, gets a different answer.** The indexed mapping increments
`failCount` on an else-branch (`verdict == "PASS"` / else), so a WAIT lands in `failCount` and inflates the rate
for any agent that ever received one. The Worker recomputes from per-audit verdicts, so the tool is right; the
indexed counters are not, and they stay that way until the mapping is corrected and re-indexed. Both are
returned side by side, labelled, so the discrepancy is visible rather than discovered. Tracked as a follow-up
rather than folded into the read-layer fix, because a mapping change needs a subgraph redeploy and a re-index.

## Correction Record 001

**Correction Record 001: a certificate names a company that was never involved.** Irys
`7tNyZtffqCerZ9CdoQJTFMcrdjbRi3B9KbstAGe3G1br` (audit `a3a5ad8f-0418-4d63-ae7b-85b39973a25b`, 2026-08-18)
carries `target_system: "Coinbase"`. It was operator-entered free text during testing; **Coinbase had no
involvement in that audit and no relationship to it.** A certificate is immutable by design, so it cannot be
edited or withdrawn, only corrected forward by a separate, separately-anchored record, which is what Correction
Record 001 is. Found by a read-only audit of the first 100 mainnet certificates on 2026-09-13, which also found
94 of 100 carrying `target_system: unknown`. **The canonical anchor for a correction is the one this register
names AND the DJZS Irys signer `0xcf2d8ef4…f990cd` signed; any other copy is not ours**: tags on an Irys item
are strings anyone can write, the signature is not, and one item does exist carrying this correction's text and
tags signed by a public test key (`8Kqfic6P…1Fvk`, created 2026-09-13 while testing the anchoring harness, named
in the register rather than left for a reader to trip over; Irys does not permit deletion). **The rule that
followed:** from 2026-09-13 `target_system` is written only from a claim signed by the subject address, and is
otherwise null. Every value predating the rule is unsigned by construction and now renders as
`unverified:<value>` on every surface, a prefix that says the certificate records someone's assertion, not a
verified relationship. A signature proves who authored a claim; it never proves the signer is who the name says.
That part stays the reader's judgement.
