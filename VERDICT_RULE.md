# The verdict rule on chain (DJZS-VR-v1.0)

Written 2026-09-27. Status: built and tested, not deployed. Nothing in production changes until the
deploy order below runs; until then every receipt lands under EAS schema v2 exactly as before.

## What it is

The deterministic engine ends with one rule: given the fired codes, the count of scored fields the
extraction left unknown, and whether the bet or position was bounded (LF: and stated a thesis),
derive the risk score and the verdict. That rule now exists in three places and is held together
by one fixture:

| Copy | Where | Held by |
| --- | --- | --- |
| The engine, inline | `server/engine-v2/deterministic-engine.ts` (now also emits `tally`) | the exhaustive sweeps in CI |
| The rule alone, TypeScript | `server/engine-v2/verdict-rule.ts` (`verdictFromTally`) | `tests/verdict-rule-fixtures.ts`: every input of both sweeps, 59,157, must derive the engine's verdict and risk |
| The rule on Base | `contracts/DJZSVerdictRule.sol` (`score`) | `test/DJZSVerdictRule.test.cjs`: replays `tests/fixtures/verdict-rule.json`, the 267 distinct tallies the engine produces, plus hand-pinned cases and refusals |

The rule: FAIL when any fired code is CRITICAL or the weights reach the ruleset threshold
(DJZS-PM-v1.0: 25, DJZS-LF-v1.2: 50); otherwise PASS when no code fired and the intent is bounded
(LF: and a thesis is present); otherwise WAIT when any scored field is unknown; otherwise PASS.
Weights and severities are the frozen taxonomies; the contract's constructor refuses to deploy if
they do not sum to 100 and 200. An unknown ruleset, an unknown code, or a duplicate code reverts:
a tally the rule cannot read is refused, never scored as zero.

`contracts/DJZSVerdictResolver.sol` is an EAS schema resolver. Schema v3 is the v2 schema plus the
rest of the tally:

```
bytes32 intentHash,string verdict,uint8 riskScore,string[] flags,string rulesetVersion,
uint8 unknownCount,bool bounded,bool thesisPresent
```

EAS calls the resolver on every attestation under the schema. The resolver derives the verdict from
the tally with `DJZSVerdictRule` and returns false when the stated verdict or risk score differs, and
EAS then reverts the attestation. It does not care who the attester is: the public record cannot
hold a verdict its own facts contradict, from DJZS or from anyone else who attests under the schema.
`check(bytes)` is a free view returning the same derivation, and djzs.ai/verify calls it from the
reader's browser once `DJZS_RESOLVER` is filled in.

## What it does not do

The model still detects. The rule constrains what a verdict can be given the flags, the unknown
count and the bounded state; it cannot make those true. A dishonest validator could still attest
false flags. What it can no longer do is attest a PASS over flags that say FAIL, a WAIT where
nothing is unknown and nothing fired, or a risk score that is not the sum of the weights. That is
the whole claim, and the ruleset page says so in the same words.

## Deploy order (DJ's terminal; keys never leave hardhat.config.cjs's environment)

The resolver's address is part of the schema UID, so the order is fixed: rule, resolver, schema,
then the Worker.

```sh
cd ~/djzs-om
npx hardhat test test/DJZSVerdictRule.test.cjs test/DJZSVerdictResolver.test.cjs   # 13 passing
npx tsx tests/verdict-rule-fixtures.ts --check                                       # fixture current
npx hardhat run scripts/deploy-verdict-rule.cjs --network base                       # dry: deploys rule + resolver, prints the UID, registers nothing
```

Read the printed addresses and the UID. Then register the schema and switch the Worker:

```sh
RULE_ADDRESS=0x<rule> REGISTER_SCHEMA=1 npx hardhat run scripts/deploy-verdict-rule.cjs --network base
```

That deploys a second resolver bound to the existing rule and registers schema v3 with it. (Rerun
without REGISTER_SCHEMA to deploy nothing new but print again.) Then:

1. `djzs-trust-mcp/wrangler.toml`: set `EAS_RESOLVER_ADDRESS = "0x<resolver>"` under `[vars]`, and
   `npx wrangler deploy` from `djzs-trust-mcp/`. From that version every verdict is attested under v3;
   a response's `eas_schema` is the v3 UID. Roll back by removing the var and redeploying.
2. `site/verify.html`: set `DJZS_RESOLVER` to the resolver address, lower case, and deploy the site.
   The verifier then accepts both schemas, decodes the tally, and adds a "Rule on chain" row that
   calls `check` on the resolver.
3. `site/ruleset.html`: the DJZS-VR rung goes from BUILT to LIVE with the addresses and the schema UID.
4. Record here: rule address, resolver address, schema v3 UID, registration tx, first v3 attestation.

| Item | Value |
| --- | --- |
| DJZSVerdictRule | (fill in) |
| DJZSVerdictResolver | (fill in) |
| Schema v3 UID | (fill in; `scripts/deploy-verdict-rule.cjs` prints it) |
| Registration tx | (fill in) |
| First v3 attestation | (fill in) |

## Cost

One `attest` under v3 pays the resolver call: decoding eight fields, a keccak per code, and one
external call into the rule. Expect the attestation to cost a few tens of thousands of gas more
than v2; measure on the first v3 attestation and record it above. The attester is the same
wallet, 0xfB0e11471D41f88D1eE43A1bA38d885fb6b77824.

## Verification in CI

- `npx tsx tests/verdict-rule-fixtures.ts --check` (engine-integrity job): the rule agrees with the
  engine on every input, and the committed fixture is what the sweep renders.
- `npx hardhat test test/DJZSVerdictRule.test.cjs test/DJZSVerdictResolver.test.cjs`
  (verdict-rule-contracts job): the contract replays the fixture; the resolver accepts consistent
  attestations and refuses inconsistent ones through a mock EAS caller.
- `npx tsx test/attest-v3.test.mjs` (worker-builds job): the Worker attests under v2 with no
  resolver and under v3 with one, never silently under v2 when a resolver is set, and the engine's
  tally, once attested, derives the attested verdict.
