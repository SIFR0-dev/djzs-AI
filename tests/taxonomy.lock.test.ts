import { describe, it, expect } from "vitest";
import {
  LOGIC_FAILURE_TAXONOMY,
  MAX_RISK_SCORE,
  ALL_LF_CODES,
  DJZS_LF_VERSION,
  SCHEMA_VERSION,
  WEIGHTS_HASH,
  TAXONOMY_HASH,
  type LFCode,
} from "../shared/audit-schema";

// GOLDEN MAP — canonical, frozen DJZS-LF v1.1 taxonomy.
// Editing this map WITHOUT bumping DJZS_LF_VERSION is a bug.
// Editing it WITH a version bump is a deliberate, governed change.
const GOLDEN_V1_1 = {
  version: "1.1",
  max_risk_score: 200,
  codes: {
    "DJZS-S01": { name: "CIRCULAR_LOGIC",       category: "Structural", weight: 30, severity: "CRITICAL" },
    "DJZS-S02": { name: "LAYER_INVERSION",      category: "Structural", weight: 25, severity: "HIGH"     },
    "DJZS-S03": { name: "DEPENDENCY_GHOST",     category: "Structural", weight: 18, severity: "MEDIUM"   },
    "DJZS-E01": { name: "ORACLE_UNVERIFIED",    category: "Epistemic",  weight: 25, severity: "HIGH"     },
    "DJZS-E02": { name: "CONFIDENCE_INFLATION", category: "Epistemic",  weight: 18, severity: "MEDIUM"   },
    "DJZS-I01": { name: "FOMO_LOOP",            category: "Incentive",  weight: 16, severity: "MEDIUM"   },
    "DJZS-I02": { name: "MISALIGNED_REWARD",    category: "Incentive",  weight: 16, severity: "MEDIUM"   },
    "DJZS-I03": { name: "DATA_UNVERIFIED",      category: "Incentive",  weight: 16, severity: "MEDIUM"   },
    "DJZS-X01": { name: "EXECUTION_UNBOUND",    category: "Execution",  weight: 15, severity: "CRITICAL" },
    "DJZS-X02": { name: "RACE_CONDITION",       category: "Execution",  weight:  9, severity: "HIGH"     },
    "DJZS-T01": { name: "STALE_REFERENCE",      category: "Temporal",   weight: 12, severity: "LOW"      },
  },
} as const;

describe("DJZS-LF taxonomy lock — v1.1", () => {
  it("version constants are consistent", () => {
    expect(DJZS_LF_VERSION).toBe(GOLDEN_V1_1.version);
    expect(SCHEMA_VERSION).toBe(`DJZS-LF-v${GOLDEN_V1_1.version}`);
  });

  it("MAX_RISK_SCORE equals 200 (governance-locked)", () => {
    expect(MAX_RISK_SCORE).toBe(GOLDEN_V1_1.max_risk_score);
  });

  it("code set is exactly the locked v1.1 set", () => {
    expect([...ALL_LF_CODES].sort()).toEqual(Object.keys(GOLDEN_V1_1.codes).sort());
  });

  it.each(Object.entries(GOLDEN_V1_1.codes))(
    "code %s is locked: name + category + weight + severity",
    (code, golden) => {
      const live = LOGIC_FAILURE_TAXONOMY[code as LFCode];
      expect(live, `${code} missing`).toBeDefined();
      expect(live.name,     `${code} name drift`).toBe(golden.name);
      expect(live.category, `${code} category drift`).toBe(golden.category);
      expect(live.weight,   `${code} weight drift`).toBe(golden.weight);
      expect(live.severity, `${code} severity drift`).toBe(golden.severity);
    }
  );

  it("weights sum to MAX_RISK_SCORE", () => {
    const sum = Object.values(LOGIC_FAILURE_TAXONOMY).reduce((s, d) => s + d.weight, 0);
    expect(sum).toBe(MAX_RISK_SCORE);
  });

  it("WEIGHTS_HASH is pinned to the canonical v1.1 value", () => {
    expect(WEIGHTS_HASH).toBe(
      "0x7faf01a7533f3a149a014ede5ba5c06188132311b7e32c59796ce285cceae826"
    );
  });

  it("TAXONOMY_HASH is pinned to the canonical v1.1 value", () => {
    expect(TAXONOMY_HASH).toBe(
      "0x011ce858f2aa7c03482f082b60862a74434ae0489c68d030cfcae5c2490ec765"
    );
  });

  it("prints hashes for pinning", () => {
    console.log("WEIGHTS_HASH =", WEIGHTS_HASH);
    console.log("TAXONOMY_HASH =", TAXONOMY_HASH);
    expect(true).toBe(true);
  });
});
