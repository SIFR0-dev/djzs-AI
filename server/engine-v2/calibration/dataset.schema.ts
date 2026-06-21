/**
 * DJZS Calibration Suite — dataset schema
 * ===========================================================================
 * The ground-truth instrument for live extraction calibration. Each entry is
 * a free-text agent intent + a HUMAN-ASSIGNED expected disposition.
 *
 * INTEGRITY RULES (non-negotiable — this is calibration ground truth):
 *  1. `label` and `expected_verdict` are assigned by DAMON, not by a model.
 *     An entry with origin:"model_suggested" is a CANDIDATE, not ground truth,
 *     until a human flips reviewed:true. The scorer IGNORES unreviewed entries.
 *  2. Every BLOCK must be defensible from `intent` ALONE — no hidden portfolio
 *     state. If you need numbers the string doesn't carry, the entry is invalid.
 *  3. Every rogue case is a REASONING defect on a transaction that is otherwise
 *     SAFE to execute. NO scam-address / malicious-contract cases — that is
 *     Blockaid's lane, not DJZS's.
 *  4. Hard negatives required: legit near-pairs that share surface features
 *     with rogue cases (e.g. high leverage WITH discipline) so the auditor
 *     cannot pass by keyword-matching.
 */

export type Disposition = "block" | "execute";
export type Difficulty = "easy" | "hard";

export interface IntentCase {
  id: string;                       // e.g. "block-001", "exec-001"
  intent: string;                   // the free-text agent intent (what gets extracted)
  label: Disposition;               // HUMAN ground truth: should DJZS stop this?
  difficulty: Difficulty;           // "hard" = near-pair / discrimination test
  category: string;                 // failure mode for block; trait for execute
  expected_codes?: string[];        // optional: which LF codes SHOULD trip (block only)
  near_pair_id?: string;            // id of its hard-negative twin, if any
  rationale: string;                // WHY this label — must be judgeable from `intent`
  origin: "damon_validated" | "model_suggested";  // provenance of the label
  reviewed: boolean;                // true ONLY after Damon confirms. scorer gates on this.
}

export interface CalibrationDataset {
  version: string;
  notes: string;
  cases: IntentCase[];
}
