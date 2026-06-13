import { z } from "zod";

export type LFCode =
  | "DJZS-S01" | "DJZS-S02" | "DJZS-S03"
  | "DJZS-E01" | "DJZS-E02"
  | "DJZS-I01" | "DJZS-I02" | "DJZS-I03"
  | "DJZS-X01" | "DJZS-X02"
  | "DJZS-T01";

export type LogicFailureCode = LFCode;

export type LFCategory = "Structural" | "Epistemic" | "Incentive" | "Execution" | "Temporal";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type AuditVerdict = "PASS" | "FAIL";

export interface LFDefinition {
  code: LFCode;
  name: string;
  category: LFCategory;
  weight: number;
  severity: Severity;
  description: string;
}

export interface DetectionFlag {
  present: boolean;
  evidence: string | null;
}

export type DetectionResult = Record<LFCode, DetectionFlag>;

export interface AuditCertificate {
  audit_id: string;
  audit_verdict: AuditVerdict;
  risk_score: number;
  max_possible: number;
  pass_threshold: number;
  failure_flags: LFCode[];
  logic_hash: string;
  weights_hash: string;
  taxonomy_hash: string;
  taxonomy_version: string;
  audit_schema_version: string;
  threshold_block: number;
  detection_model: string;
  scoring_engine: string;
  anchor_target: string;
  settlement_chain: string;
  timestamp: string;
}


export const LOGIC_FAILURE_TAXONOMY: Record<LFCode, LFDefinition> = {
  // STRUCTURAL — total: 73
  "DJZS-S01": {
    code: "DJZS-S01",
    name: "CIRCULAR_LOGIC",
    category: "Structural",
    weight: 30,
    severity: "CRITICAL",
    description: "Reasoning chain references its own conclusion as premise",
  },
  "DJZS-S02": {
    code: "DJZS-S02",
    name: "LAYER_INVERSION",
    category: "Structural",
    weight: 25,
    severity: "HIGH",
    description: "Verification layer depends on unverified upstream data",
  },
  "DJZS-S03": {
    code: "DJZS-S03",
    name: "DEPENDENCY_GHOST",
    category: "Structural",
    weight: 18,
    severity: "MEDIUM",
    description: "References external dependency that cannot be resolved",
  },

  // EPISTEMIC — total: 43
  "DJZS-E01": {
    code: "DJZS-E01",
    name: "ORACLE_UNVERIFIED",
    category: "Epistemic",
    weight: 25,
    severity: "HIGH",
    description: "External data source cited without provenance verification",
  },
  "DJZS-E02": {
    code: "DJZS-E02",
    name: "CONFIDENCE_INFLATION",
    category: "Epistemic",
    weight: 18,
    severity: "MEDIUM",
    description: "Stated certainty exceeds evidential basis",
  },

  // INCENTIVE — total: 48
  "DJZS-I01": {
    code: "DJZS-I01",
    name: "FOMO_LOOP",
    category: "Incentive",
    weight: 16,
    severity: "MEDIUM",
    description: "Decision driven by social signal rather than verified data",
  },
  "DJZS-I02": {
    code: "DJZS-I02",
    name: "MISALIGNED_REWARD",
    category: "Incentive",
    weight: 16,
    severity: "MEDIUM",
    description: "Optimization target diverges from stated objective",
  },
  "DJZS-I03": {
    code: "DJZS-I03",
    name: "DATA_UNVERIFIED",
    category: "Incentive",
    weight: 16,
    severity: "MEDIUM",
    description: "Numerical claims lack verifiable source attribution",
  },

  // EXECUTION — total: 24
  "DJZS-X01": {
    code: "DJZS-X01",
    name: "EXECUTION_UNBOUND",
    category: "Execution",
    weight: 15,
    severity: "CRITICAL",
    description: "No halt condition or resource ceiling defined",
  },
  "DJZS-X02": {
    code: "DJZS-X02",
    name: "RACE_CONDITION",
    category: "Execution",
    weight: 9,
    severity: "HIGH",
    description: "Temporal dependency creates non-deterministic outcome",
  },

  // TEMPORAL — total: 12
  "DJZS-T01": {
    code: "DJZS-T01",
    name: "STALE_REFERENCE",
    category: "Temporal",
    weight: 12,
    severity: "LOW",
    description: "Data reference exceeds freshness threshold",
  },
} as const;


export const MAX_RISK_SCORE = Object.values(LOGIC_FAILURE_TAXONOMY)
  .reduce((sum, def) => sum + def.weight, 0); // = 200 — DO NOT CHANGE without governance

export const ALL_LF_CODES = Object.keys(LOGIC_FAILURE_TAXONOMY) as LFCode[];

export const VALID_FAILURE_CODES = ALL_LF_CODES;

export const DJZS_LF_VERSION = "1.1" as const;
export const SCHEMA_VERSION = `DJZS-LF-v${DJZS_LF_VERSION}` as const;

if (MAX_RISK_SCORE !== 200) {
  throw new Error(
    `[DJZS FATAL] Taxonomy weights sum to ${MAX_RISK_SCORE}, expected 200. ` +
    `Weight table integrity compromised.`
  );
}


function sha256(input: string): string {
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const rr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen, false);
  let [h0, h1, h2, h3, h4, h5, h6, h7] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  for (let off = 0; off < padded.length; off += 64) {
    const w = new Array<number>(64);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i-15],7) ^ rr(w[i-15],18) ^ (w[i-15]>>>3);
      const s1 = rr(w[i-2],17) ^ rr(w[i-2],19) ^ (w[i-2]>>>10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e,6) ^ rr(e,11) ^ rr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rr(a,2) ^ rr(a,13) ^ rr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0+a)|0; h1 = (h1+b)|0; h2 = (h2+c)|0; h3 = (h3+d)|0;
    h4 = (h4+e)|0; h5 = (h5+f)|0; h6 = (h6+g)|0; h7 = (h7+h)|0;
  }
  const hex = [h0,h1,h2,h3,h4,h5,h6,h7].map(v => (v>>>0).toString(16).padStart(8,"0")).join("");
  return "0x" + hex;
}

function canonicalize(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

export const WEIGHTS_HASH: string = sha256(
  canonicalize({
    taxonomy_version: DJZS_LF_VERSION,
    weights: Object.fromEntries(
      Object.entries(LOGIC_FAILURE_TAXONOMY).map(([k, v]) => [k, v.weight])
    ),
  })
);

export const TAXONOMY_HASH: string = sha256(
  canonicalize({
    taxonomy_version: DJZS_LF_VERSION,
    taxonomy: Object.fromEntries(
      Object.entries(LOGIC_FAILURE_TAXONOMY).map(([k, v]) => [k, {
        code: v.code,
        name: v.name,
        category: v.category,
        weight: v.weight,
        severity: v.severity,
        description: v.description,
      }])
    ),
  })
);


export function calculateRiskScore(flags: DetectionResult): number {
  return Object.entries(flags)
    .filter(([_, v]) => (v as DetectionFlag).present)
    .reduce((sum, [code]) => {
      const def = LOGIC_FAILURE_TAXONOMY[code as LFCode];
      return sum + (def?.weight ?? 0);
    }, 0);
}

export function determineVerdict(riskScore: number, threshold: number): AuditVerdict {
  return riskScore < threshold ? "PASS" : "FAIL";
}

export function computeVerdictHash(
  flags: DetectionResult,
  riskScore: number
): string {
  const booleanOnly: Record<string, boolean> = {};
  for (const code of ALL_LF_CODES) {
    booleanOnly[code] = flags[code]?.present ?? false;
  }

  const hashInput = canonicalize({
    schema_version: SCHEMA_VERSION,
    flags: booleanOnly,
    risk_score: riskScore,
  });

  return sha256(hashInput);
}


export interface VerdictInput {
  flags: DetectionResult;
  threshold: number;
  thresholdBlock: number;
  auditId: string;
}

export function computeVerdict(input: VerdictInput): AuditCertificate {
  const { flags, threshold, thresholdBlock, auditId } = input;

  const riskScore = calculateRiskScore(flags);
  const verdict = determineVerdict(riskScore, threshold);
  const logicHash = computeVerdictHash(flags, riskScore);

  const failureFlags = ALL_LF_CODES.filter((code) => flags[code]?.present).sort();

  return {
    audit_id: auditId,
    audit_verdict: verdict,
    risk_score: riskScore,
    max_possible: MAX_RISK_SCORE,
    pass_threshold: threshold,
    failure_flags: failureFlags,
    logic_hash: logicHash,
    weights_hash: WEIGHTS_HASH,
    taxonomy_hash: TAXONOMY_HASH,
    taxonomy_version: DJZS_LF_VERSION,
    audit_schema_version: SCHEMA_VERSION,
    threshold_block: thresholdBlock,
    detection_model: "venice/llama-3.3-70b@temp=0",
    scoring_engine: "typescript/pure-function",
    anchor_target: "irys-datachain",
    settlement_chain: "base-mainnet",
    timestamp: new Date().toISOString(),
  };
}


export const detectionFlagSchema = z.object({
  present: z.boolean(),
  evidence: z.string().nullable(),
});

export const detectionResultSchema = z.record(
  z.enum(ALL_LF_CODES as [string, ...string[]]),
  detectionFlagSchema
);

export const auditCertificateSchema = z.object({
  audit_id: z.string(),
  audit_verdict: z.enum(["PASS", "FAIL"]),
  risk_score: z.number().min(0).max(200),
  max_possible: z.literal(200),
  pass_threshold: z.number().min(0).max(200),
  failure_flags: z.array(z.string()),
  logic_hash: z.string(),
  weights_hash: z.string(),
  taxonomy_hash: z.string(),
  taxonomy_version: z.literal(DJZS_LF_VERSION),
  audit_schema_version: z.literal(SCHEMA_VERSION),
  threshold_block: z.number(),
  detection_model: z.string(),
  scoring_engine: z.string(),
  anchor_target: z.string(),
  settlement_chain: z.string(),
  timestamp: z.string(),
});


export const auditTierSchema = z.enum(["micro", "founder", "treasury"]);
export type AuditTier = z.infer<typeof auditTierSchema>;

export const TIER_CONFIG = {
  micro: {
    name: "The Micro-Zone",
    price: "$0.10",
    maxMemoLength: 2000,
    description: "High-frequency operational ledger and sanity check. Binary risk scoring.",
    endpoint: "/api/audit/micro",
  },
  founder: {
    name: "The Founder Zone",
    price: "$1.00",
    maxMemoLength: 5000,
    description: "Strategic roadmap diligence. Detects narrative drift and confirmation bias.",
    endpoint: "/api/audit/founder",
  },
  treasury: {
    name: "The Treasury Zone",
    price: "$10.00",
    maxMemoLength: Infinity,
    description: "Exhaustive adversarial stress-test for capital deployment proposals.",
    endpoint: "/api/audit/treasury",
  },
} as const;


export const tradeParamsSchema = z.object({
  protocol: z.string().optional(),
  pair: z.string().optional(),
  direction: z.enum(["long", "short", "neutral"]).optional(),
  leverage: z.number().min(1).max(200).optional(),
  notional_usd: z.number().min(0).optional(),
  stop_loss_pct: z.number().min(0).max(100).optional(),
  take_profit_pct: z.number().min(0).max(1000).optional(),
  entry_price: z.number().min(0).optional(),
  timeframe: z.string().optional(),
});
export type TradeParams = z.infer<typeof tradeParamsSchema>;

export const escrowContextSchema = z.object({
  escrow_id: z.number().int().positive(),
  amount: z.number(),
  tier: z.string(),
  creator: z.string().optional(),
  recipient: z.string().optional(),
});

export const auditRequestSchema = z.object({
  strategy_memo: z.string().min(20, "Strategy memo must be at least 20 characters"),
  audit_type: z.enum(["treasury", "founder_drift", "strategy", "general"]).default("general"),
  intelligence_context: z.string().optional(),
  trade_params: tradeParamsSchema.optional(),
  agent_id: z.string().optional(),
  escrow_id: z.number().int().positive().optional(),
  escrow_context: escrowContextSchema.optional(),
});

export type AuditRequest = z.infer<typeof auditRequestSchema>;

export function createTieredRequestSchema(tier: AuditTier) {
  const config = TIER_CONFIG[tier];
  const base = z.object({
    strategy_memo: z.string().min(20, "Strategy memo must be at least 20 characters"),
    audit_type: z.enum(["treasury", "founder_drift", "strategy", "general"]).default("general"),
    intelligence_context: z.string().optional(),
    trade_params: tradeParamsSchema.optional(),
    agent_id: z.string().optional(),
    escrow_id: z.number().int().positive().optional(),
    escrow_context: escrowContextSchema.optional(),
  });

  if (config.maxMemoLength !== Infinity) {
    return base.extend({
      strategy_memo: z.string()
        .min(20, "Strategy memo must be at least 20 characters")
        .max(config.maxMemoLength, `${config.name} memo limit: ${config.maxMemoLength} characters`),
    });
  }

  return base;
}

export const escrowAuditRequestSchema = z.object({
  escrow_id: z.number().int().positive(),
  escrow_tx_hash: z.string().regex(/^0x[0-9a-fA-F]+$/, "Must be a valid hex string"),
  strategy_memo: z.string().min(20, "Strategy memo must be at least 20 characters"),
  audit_type: z.enum(["treasury", "founder_drift", "strategy", "general"]).default("general").optional(),
  intelligence_context: z.string().optional(),
  trade_params: tradeParamsSchema.optional(),
  agent_id: z.string().optional(),
});

export type EscrowAuditRequest = z.infer<typeof escrowAuditRequestSchema>;

export function validateMemoLength(memo: string, tier: AuditTier): boolean {
  const config = TIER_CONFIG[tier];
  if (config.maxMemoLength === Infinity) return true;
  return memo.length <= config.maxMemoLength;
}


export const auditFlagSeveritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL", "INFO"]);
export type AuditFlagSeverity = z.infer<typeof auditFlagSeveritySchema>;

export const auditFlagSchema = z.object({
  code: z.string(),
  severity: auditFlagSeveritySchema,
  message: z.string().optional(),
  evidence: z.string().optional(),
  recommendation: z.string().optional(),
  description: z.string().optional(),
});
export type AuditFlag = z.infer<typeof auditFlagSchema>;

export const verdictSchema = z.enum(["PASS", "FAIL"]);

export const auditResultSchema = z.object({
  verdict: verdictSchema,
  risk_score: z.number().min(0).max(200),
  flags: z.array(auditFlagSchema),
  primary_flaw: z.string(),
  summary: z.string(),
});

export const djzsLogicAuditSchema = z.object({
  audit_id: z.string().uuid(),
  timestamp: z.string().datetime(),
  tier: auditTierSchema,
  risk_score: z.number().min(0).max(200),
  verdict: verdictSchema,
  primary_bias_detected: z.enum([
    "FOMO",
    "Sunk_Cost",
    "Narrative_Reaction",
    "Authority_Bias",
    "Confirmation_Bias",
    "Recency_Bias",
    "None",
  ]).optional(),
  primary_flaw: z.string().optional(),
  summary: z.string().optional(),
  flags: z.array(auditFlagSchema).default([]),
  logic_flaws: z.array(z.object({
    flaw_type: z.string(),
    severity: z.enum(["low", "medium", "high", "critical"]),
    explanation: z.string(),
  })).optional(),
  structural_recommendations: z.array(z.string()).optional(),
  cryptographic_hash: z.string(),
});

export type DJZSLogicAudit = z.infer<typeof djzsLogicAuditSchema>;
