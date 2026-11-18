# Blind labels for the reading step

**Status: kit only. No reader has labeled anything and no score exists.** This file is the protocol; it was written before any label, and the reading in section 7 may be amended by the operator before the first sheet comes back, not after.

## 1. What this measures

The gate is two steps. A model reads a thesis and reports three facts as present, absent or unknown. Fixed rules turn those facts into PASS, WAIT or FAIL. The second step is proven over its whole input space (`tests/pm-engine-integrity.ts`). The first has been measured for one thing only: whether it repeats itself on the same text (Q2), and soon on reworded text (`tests/q2-reword-stability.ts`).

Repeating is not being right. Nothing in the repository yet says whether the model's reading of a real thesis is the reading a careful person would give. This kit measures that: two people read the same text the gate reads and answer the same questions, blind, and the gate's answers are compared with theirs.

It does not measure whether a verdict predicts an outcome. That is the Q3 study. It does not use the founder-labeled bench in `server/engine-v2/calibration/`, and it never edits or relabels a bench case.

## 2. The four questions

A reader answers four questions about each text, using exactly these words.

| column | question | answers |
|---|---|---|
| `falsifier` | Does the author name something that could be observed before the market resolves and that would make them wrong or make them exit? | `present` · `absent` · `cannot-tell` |
| `resolution` | Does the argument deal with what this market actually resolves on: its date or window, its threshold or definition, or the source that settles it? `absent` means it argues something next to the market instead: the headline, another date, another number, another authority. | `present` · `absent` · `cannot-tell` |
| `probability` | Where the author states a probability, a certainty, or an edge over the market's odds: is each one backed by something named in the text that a reader could check (data, an official source, a worked derivation)? `unsourced` means at least one rests only on rumor, "everyone knows", someone's track record, conviction, or nothing. | `sourced` · `none-asserted` · `unsourced` · `cannot-tell` |
| `edge` | Does the author give a reason of their own why the market's price is wrong, or only repeat what the market or everyone already believes? | `own-reason` · `consensus-only` · `cannot-tell` |

`cannot-tell` is a real answer and is never a failure to answer. An empty cell is a failure to answer and the sheet is refused.

The first three are the facts that decide a verdict. The fourth is advisory: it is printed on a receipt and never changes a verdict. For scoring, `sourced` and `none-asserted` both count as present, because that is how the gate's own contract counts a thesis that asserts no probability; they are kept apart in the sheet so the share of each can be reported.

## 3. Who labels

- Two readers for every item, working apart. Neither is the operator, neither wrote the extraction prompt, and neither is a model.
- Readers are named `reader-01`, `reader-02`, and so on. This repository is public: no name, handle or address is ever written into a tracked file.
- A model may fill a sheet as an extra column of evidence. It is reported apart and never forms the reference.

## 4. What a reader sees

Exactly the text the gate is given, line for line: the market's title, the side and the argument, and on a few early records the stake and a quoted basis. Nothing else. Not the gate's answers, not the verdict, not the price, not how the market resolved, not where the text was published. Each reader's sheet lists the items in its own shuffled order.

## 5. Where the items come from

Items are real texts that argue one side of a real market. Nobody writes one, shortens one or tidies one.

**Already here.** The six distinct texts sealed in the Q3 book (`tests/q3/records`) are the first six items. They are public, and each reproduces its sealed `intent_sha256`.

**Collected in batches of 25, to 100.** A batch is drawn on one UTC day, by rule:

1. Take each venue's 25 highest-volume open markets in the scan's categories, skipping any market whose venue event already supplied one.
2. For each market, in rank order, search the public web with two fixed queries: the market's title in quotes, and the title followed by `forecast OR prediction OR odds`. Read results in the order returned, ten per query.
3. The item is the first result that was published in the fourteen days before the batch day, argues for one side of that market, and holds at least forty consecutive words of the author's own argument. Every result passed over is logged with one reason: `too-old`, `no-side`, `too-short`, `not-this-market`, `unreadable`.
4. The text is one unbroken passage of at most 250 words, copied exactly, starting at the first sentence of the argument.
5. A market with no qualifying result supplies no item. That is logged and is not replaced.

The collector does not run the gate on an item, or look at any gate output for it, until the batch's hashes are committed. Collect, hash, commit, then predict.

## 6. The reference label

For one item and one question, the reference is the answer both readers gave. Where they differ there is no reference for that question on that item, and the item is left out of that question's score. Nobody breaks ties and no third reader is brought in.

How far the readers agree is reported for every question three ways: the plain share of items they answered alike, Gwet's AC1, and Fleiss' kappa. The reading in section 7 uses AC1. Kappa is the familiar number and is printed beside it, but it fails in exactly the case expected here: when nearly every text gets the same answer (most public arguments name no falsifier), kappa treats the lopsidedness as chance and drops to zero or below at 90% raw agreement. AC1 does not. Both are worked by hand in the kit's self-test, including that case.

## 7. What is computed, and how it is read

For each of the three deciding questions, over the items that have a reference:

- **wrong-call rate**: of items where the readers agree on present or absent, the share where the gate says the opposite.
- **abstain rate**: of the same items, the share where the gate says unknown.
- the full three-by-three table, and for the gate's `absent` calls (the ones that refuse an order) how often the readers agree, and how many of the readers' absents the gate found.

Then the engine is run on the readers' own answers, and the verdict it gives is compared with the verdict the gate gave from its own reading. Every item where the gate passed and the readers' answers fail is listed by id.

The reading for each question, fixed now:

| reading | condition |
|---|---|
| `INSUFFICIENT` | fewer than 50 items where both readers agree on present or absent |
| `NOT READABLE BY PEOPLE` | AC1 between the readers below 0.60: two careful readers do not agree on the question, so nothing is claimed about the gate |
| `UNRELIABLE` | wrong-call rate above 15% |
| `SILENT` | wrong-call rate at or below 15%, abstain rate above 50% |
| `ONE-SIDED` | fewer than 10 of the agreed answers are present, or fewer than 10 are absent: the set cannot say how the gate does on the rarer answer, so it is not called sound |
| `SOUND` | wrong-call rate at or below 5%, abstain rate at or below 25% |
| `MIXED` | anything else; the numbers are reported and no word is put on them |

Checked in that order; the first that applies is the reading. `NOT READABLE BY PEOPLE` is a result about the question, and a useful one: a check that two people cannot apply the same way is not a check a model can be graded on.

## 8. Held out, and kept that way

The labeled set is never used to change the prompt. If an item's text or labels are read while an extraction contract is being edited, the item is moved to `retired` in `items.json` with the date and the reason, and is never scored again. A set that has been tuned on measures memory.

## 9. Files and commands

| file | tracked | holds |
|---|---|---|
| `items.json` | yes | one entry per item: id, origin, source URL, capture time, the hash of the exact text, its length. No text. |
| `texts.local.json` | **no** | the collected texts, by item id |
| `sheets/` | **no** | one CSV per reader, generated |
| `returned/` | **no** | the CSVs as the readers sent them back |
| `labels.json` | yes | every answer, by item and reader. Answers only. |
| `predictions/` | yes | the gate's reading of every item, with the contract version and commit that produced it |
| `scores/` | yes | each score, as printed |

Collected texts are other people's writing, so they stay off the public repository. What is public is enough to check the work: the URL, the capture time, and the hash of the passage.

```
npx tsx tests/labels/kit.ts --self-test          offline, no key: proves the counting
npx tsx tests/labels/kit.ts check                every item resolves to a text that matches its hash
npx tsx tests/labels/kit.ts sheets reader-01 reader-02
npx tsx tests/labels/kit.ts ingest               returned/*.csv into labels.json; refuses to change an answer already recorded
npx tsx tests/labels/kit.ts predict              operator shell only: runs the gate once per item, as a caller would
npx tsx tests/labels/kit.ts score tests/labels/predictions/<file>.json
```

`predict` needs `ANTHROPIC_API_KEY` and is the operator's. Everything else runs anywhere.
