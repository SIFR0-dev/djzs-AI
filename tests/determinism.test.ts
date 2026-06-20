import { describe, it, expect } from "vitest";
import {
  computeVerdict,
  computeVerdictHash,
  calculateRiskScore,
  determineVerdict,
  LOGIC_FAILURE_TAXONOMY,
  ALL_LF_CODES,
  MAX_RISK_SCORE,
  WEIGHTS_HASH,
  SCHEMA_VERSION,
  type DetectionResult,
  type DetectionFlag,
  type LFCode,
  type VerdictInput,
} from "../shared/audit-schema";


function makeFlags(presentCodes: LFCode[]): DetectionResult {
  const flags: Partial<DetectionResult> = {};
  for (const code of ALL_LF_CODES) {
    flags[code] = {
      present: presentCodes.includes(code),
      evidence: presentCodes.includes(code)
        ? `Evidence for ${code} — run ${Math.random()}`  // intentionally randomized
        : null,
    };
  }
  return flags as DetectionResult;
}

function makeInput(presentCodes: LFCode[], threshold = 60): VerdictInput {
  return {
    flags: makeFlags(presentCodes),
    threshold,
    thresholdBlock: 29847261,
    auditId: "test-determinism",
  };
}

// Generate 50 distinct flag combinations
function generateTestCases(): { label: string; codes: LFCode[] }[] {
  const cases: { label: string; codes: LFCode[] }[] = [];

  // Case 0: no flags
  cases.push({ label: "empty — no flags", codes: [] });

  // Cases 1-11: each individual code
  for (const code of ALL_LF_CODES) {
    cases.push({ label: `single — ${code}`, codes: [code] });
  }

  // Cases 12-16: category groups
  const categories: Record<string, LFCode[]> = {};
  for (const [code, def] of Object.entries(LOGIC_FAILURE_TAXONOMY)) {
    if (!categories[def.category]) categories[def.category] = [];
    categories[def.category].push(code as LFCode);
  }
  for (const [cat, codes] of Object.entries(categories)) {
    cases.push({ label: `category — all ${cat}`, codes });
  }

  // Case 17: all flags
  cases.push({ label: "all flags present", codes: [...ALL_LF_CODES] });

  // Cases 18-30: random pairs
  for (let i = 0; i < 13; i++) {
    const a = ALL_LF_CODES[i % ALL_LF_CODES.length];
    const b = ALL_LF_CODES[(i + 3) % ALL_LF_CODES.length];
    if (a !== b) {
      cases.push({ label: `pair — ${a} + ${b}`, codes: [a, b] });
    }
  }

  // Cases 31-40: random triples
  for (let i = 0; i < 10; i++) {
    const a = ALL_LF_CODES[i % ALL_LF_CODES.length];
    const b = ALL_LF_CODES[(i + 2) % ALL_LF_CODES.length];
    const c = ALL_LF_CODES[(i + 5) % ALL_LF_CODES.length];
    const unique = [...new Set([a, b, c])];
    cases.push({ label: `triple — ${unique.join(" + ")}`, codes: unique });
  }

  // Cases 41-45: severity-based groups
  const bySeverity: Record<string, LFCode[]> = {};
  for (const [code, def] of Object.entries(LOGIC_FAILURE_TAXONOMY)) {
    if (!bySeverity[def.severity]) bySeverity[def.severity] = [];
    bySeverity[def.severity].push(code as LFCode);
  }
  for (const [sev, codes] of Object.entries(bySeverity)) {
    cases.push({ label: `severity — all ${sev}`, codes });
  }

  // Cases 46-49: threshold edge cases
  cases.push({ label: "just-under-threshold combo", codes: ["DJZS-T01", "DJZS-I01"] }); // 12+16=28 < 60
  cases.push({ label: "execution-pair combo", codes: ["DJZS-X02", "DJZS-X01"] }); // 9+15=24
  cases.push({ label: "just-over-threshold combo", codes: ["DJZS-S01", "DJZS-S02", "DJZS-T01"] }); // 30+25+12=67
  cases.push({ label: "max-minus-one code", codes: ALL_LF_CODES.slice(0, -1) });

  // Pad to exactly 50
  while (cases.length < 50) {
    const idx = cases.length;
    const c1 = ALL_LF_CODES[idx % ALL_LF_CODES.length];
    const c2 = ALL_LF_CODES[(idx * 3) % ALL_LF_CODES.length];
    cases.push({ label: `filler-${idx}`, codes: [...new Set([c1, c2])] });
  }

  return cases.slice(0, 50);
}


describe("DJZS-LF Taxonomy Invariants", () => {
  it("weights sum to exactly 200", () => {
    expect(MAX_RISK_SCORE).toBe(200);
  });

  it("all 11 codes are defined", () => {
    expect(ALL_LF_CODES.length).toBe(11);
  });

  it("WEIGHTS_HASH is stable", () => {
    const hash1 = WEIGHTS_HASH;
    const hash2 = WEIGHTS_HASH;
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("schema version is DJZS-LF-v1.1", () => {
    expect(SCHEMA_VERSION).toBe("DJZS-LF-v1.1");
  });

  it("every code has weight > 0", () => {
    for (const def of Object.values(LOGIC_FAILURE_TAXONOMY)) {
      expect(def.weight).toBeGreaterThan(0);
    }
  });

  it("category totals — Structural is heaviest", () => {
    const catTotals: Record<string, number> = {};
    for (const def of Object.values(LOGIC_FAILURE_TAXONOMY)) {
      catTotals[def.category] = (catTotals[def.category] || 0) + def.weight;
    }
    const sorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
    expect(sorted[0][0]).toBe("Structural"); // 73
    expect(sorted[sorted.length - 1][0]).toBe("Temporal"); // 12
  });
});


describe("calculateRiskScore — pure", () => {
  it("returns 0 for no flags", () => {
    expect(calculateRiskScore(makeFlags([]))).toBe(0);
  });

  it("returns max for all flags", () => {
    expect(calculateRiskScore(makeFlags([...ALL_LF_CODES]))).toBe(200);
  });

  it("returns correct weight for single code", () => {
    for (const code of ALL_LF_CODES) {
      expect(calculateRiskScore(makeFlags([code]))).toBe(
        LOGIC_FAILURE_TAXONOMY[code].weight
      );
    }
  });

  it("is additive", () => {
    const a = calculateRiskScore(makeFlags(["DJZS-S01"]));
    const b = calculateRiskScore(makeFlags(["DJZS-E01"]));
    const ab = calculateRiskScore(makeFlags(["DJZS-S01", "DJZS-E01"]));
    expect(ab).toBe(a + b);
  });
});

describe("determineVerdict — pure", () => {
  it("PASS when below threshold", () => {
    expect(determineVerdict(0, 60)).toBe("PASS");
    expect(determineVerdict(59, 60)).toBe("PASS");
  });

  it("FAIL when at or above threshold", () => {
    expect(determineVerdict(60, 60)).toBe("FAIL");
    expect(determineVerdict(200, 60)).toBe("FAIL");
  });
});


describe("computeVerdict — determinism across runs", () => {
  const testCases = generateTestCases();
  const RUNS = 10;

  it(`generated exactly 50 test cases`, () => {
    expect(testCases.length).toBe(50);
  });

  for (const tc of testCases) {
    it(`deterministic: ${tc.label}`, () => {
      const results: string[] = [];

      for (let run = 0; run < RUNS; run++) {
        const input = makeInput(tc.codes);
        const cert = computeVerdict(input);
        const fingerprint = JSON.stringify({
          verdict: cert.audit_verdict,
          score: cert.risk_score,
          flags: cert.failure_flags,
          hash: cert.logic_hash,
          weights_hash: cert.weights_hash,
        });
        results.push(fingerprint);
      }

      const unique = new Set(results);
      expect(unique.size).toBe(1);
    });
  }
});


describe("computeVerdictHash — evidence excluded", () => {
  it("same flags with different evidence produce same hash", () => {
    const flags1 = makeFlags(["DJZS-S01", "DJZS-X01"]);
    const flags2 = makeFlags(["DJZS-S01", "DJZS-X01"]);

    flags1["DJZS-S01"].evidence = "Evidence version A";
    flags2["DJZS-S01"].evidence = "Completely different evidence B";

    const score = calculateRiskScore(flags1);
    const hash1 = computeVerdictHash(flags1, score);
    const hash2 = computeVerdictHash(flags2, score);

    expect(hash1).toBe(hash2);
  });

  it("different flags produce different hashes", () => {
    const flags1 = makeFlags(["DJZS-S01"]);
    const flags2 = makeFlags(["DJZS-E01"]);

    const hash1 = computeVerdictHash(flags1, calculateRiskScore(flags1));
    const hash2 = computeVerdictHash(flags2, calculateRiskScore(flags2));

    expect(hash1).not.toBe(hash2);
  });

  it("hash format is 0x + 64 hex chars", () => {
    const flags = makeFlags(["DJZS-S01"]);
    const hash = computeVerdictHash(flags, calculateRiskScore(flags));
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});


describe("computeVerdict — certificate fields", () => {
  it("includes all provenance fields", () => {
    const cert = computeVerdict(makeInput(["DJZS-S01"]));

    expect(cert.audit_schema_version).toBe("DJZS-LF-v1.1");
    expect(cert.weights_hash).toMatch(/^0x/);
    expect(cert.logic_hash).toMatch(/^0x/);
    expect(cert.threshold_block).toBe(29847261);
    expect(cert.detection_model).toBe("venice/llama-3.3-70b@temp=0");
    expect(cert.scoring_engine).toBe("typescript/pure-function");
    expect(cert.anchor_target).toBe("irys-datachain");
    expect(cert.settlement_chain).toBe("base-mainnet");
    expect(cert.max_possible).toBe(200);
  });

  it("failure_flags are sorted by code order", () => {
    const cert = computeVerdict(makeInput([...ALL_LF_CODES]));
    const sorted = [...cert.failure_flags].sort();
    expect(cert.failure_flags).toEqual(sorted);
  });
});
