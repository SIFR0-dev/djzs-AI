import crypto from "crypto";
import { DJZSEngine, type ToolCall, type Detection, type DetectionResult, type LFCode } from "./engine";
import {
  type AdversarialPersona,
  type IntelligenceContext,
} from "./venice";
import { type AuditTier, SCHEMA_VERSION, WEIGHTS_HASH, TAXONOMY_HASH, DJZS_LF_VERSION, MAX_RISK_SCORE, ALL_LF_CODES, LOGIC_FAILURE_TAXONOMY } from "@shared/audit-schema";
import { shouldUseClaude, getClaudeAuditClient } from "./claude-client";

export interface AuditResult {
  verdict: "PASS" | "FAIL";
  risk_score: number;
  primary_flaw: string;
  summary: string;
  flags: {
    code: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
    evidence: string;
    recommendation: string;
    description?: string;
  }[];
  confidence?: number;
  primary_bias_detected?: string;
  logic_flaws?: string[];
  scenarios?: {
    name: string;
    outcome: string;
    estimated_impact: string;
  }[];
  structural_recommendations?: string[];
  action_items?: string[];
  model_used: string;
  persona_used: AdversarialPersona;
}

const djzsEngine = new DJZSEngine({
  codeSets: ["djzs"],
  failThreshold: 30,
  warnThreshold: 15,
});

const ENGINE_CODE_TO_DJZS: Record<string, string> = {
  S01: "DJZS-S01",
  S02: "DJZS-S02",
  S03: "DJZS-S03",
  E01: "DJZS-E01",
  E02: "DJZS-E02",
  I01: "DJZS-I01",
  I02: "DJZS-I02",
  I03: "DJZS-I03",
  X01: "DJZS-X01",
  X02: "DJZS-X02",
  T01: "DJZS-T01",
};

function mapEngineResultToAuditResult(
  engineResult: DetectionResult,
  persona: AdversarialPersona
): AuditResult {
  const firedDetections = engineResult.detections.filter(d => d.fired);

  const flags = firedDetections.map(d => {
    const djzsCode = ENGINE_CODE_TO_DJZS[d.code] || d.code;
    const taxonomy = LOGIC_FAILURE_TAXONOMY[djzsCode as keyof typeof LOGIC_FAILURE_TAXONOMY];
    return {
      code: djzsCode,
      severity: (taxonomy?.severity || "MEDIUM") as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO",
      evidence: d.evidence,
      recommendation: `Review and address ${d.label} detection`,
      description: d.evidence,
    };
  });

  const riskScore = engineResult.totalPenalty;

  const verdict: "PASS" | "FAIL" =
    riskScore >= 60 || flags.some(f => f.severity === "CRITICAL")
      ? "FAIL"
      : "PASS";

  const primaryFlaw = firedDetections.length > 0
    ? firedDetections[0].label
    : "None";

  const summary = verdict === "PASS"
    ? firedDetections.length === 0
      ? "No logic failures detected. Strategy is structurally sound."
      : `Minor observations detected (${firedDetections.length} code${firedDetections.length > 1 ? "s" : ""}). Strategy passes with observations.`
    : `${firedDetections.length} logic failure${firedDetections.length > 1 ? "s" : ""} detected (risk_score=${riskScore}). Strategy fails audit.`;

  return {
    verdict,
    risk_score: riskScore,
    primary_flaw: primaryFlaw,
    summary,
    flags,
    model_used: "djzs-trust/rule-engine@v1.0",
    persona_used: persona,
    logic_flaws: firedDetections.map(d => `${ENGINE_CODE_TO_DJZS[d.code] || d.code}: ${d.evidence}`),
    structural_recommendations: firedDetections.map(d => `Review and address ${d.label} detection`),
  };
}
import { writeTrustScore, type ChainWriterResult } from "./chainWriter";
import {
  verifyTraceHash,
  computeTraceHash,
  mapToLegacyFormat,
  shouldAbort as shouldAbortResult,
  formatResultForLog,
  getAbortTriggers,
  type EscrowContext,
  type AdversarialAuditResult,
} from "./adversarial-audit";
import { readAuditPendingEvent } from "./escrow-contract";

export interface AuditInput {
  strategy_memo: string;
  audit_type?: "treasury" | "founder_drift" | "strategy" | "general";
  target_system?: string;
  tier?: AuditTier;
  persona?: AdversarialPersona;
  intelligence_context?: string | IntelligenceContext;
  trade_params?: Record<string, unknown>;
  agent_id?: string;
  escrow_id?: number;
  escrow_context?: EscrowContext;
  execution_trace_hash?: `0x${string}`;
  escrow_tx_hash?: string;
}

export interface ProofOfLogicCertificate extends AuditResult {
  audit_id: string;
  timestamp: string;
  tier: AuditTier;
  cryptographic_hash: string;
  keccak256_hash?: string;

  audit_schema_version?: string;
  weights_hash?: string;
  taxonomy_hash?: string;
  taxonomy_version?: string;
  logic_hash?: string;
  max_possible?: number;
  pass_threshold?: number;
  detection_model?: string;
  scoring_engine?: string;
  anchor_target?: string;
  settlement_chain?: string;

  provenance_provider?: "IRYS_DATACHAIN";
  irys_tx_id?: string;
  irys_url?: string;
  
  should_abort?: boolean;
  abort_reasons?: string[];
  on_chain_hash_verified?: boolean;
}

const TIER_CONFIG: Record<AuditTier, {
  price_usd: number;
  memo_limit: number;
  default_persona: AdversarialPersona;
}> = {
  micro: {
    price_usd: 0.10,
    memo_limit: 1000,
    default_persona: "general",
  },
  founder: {
    price_usd: 1.00,
    memo_limit: 5000,
    default_persona: "logic_auditor",
  },
  treasury: {
    price_usd: 10.00,
    memo_limit: Infinity,
    default_persona: "risk_hunter",
  },
};

export async function executeAudit(
  input: AuditInput
): Promise<ProofOfLogicCertificate> {
  const {
    strategy_memo,
    audit_type = "general",
    target_system = "Unknown",
    tier = "micro",
    persona,
    intelligence_context,
    trade_params,
    escrow_id,
    escrow_context,
    execution_trace_hash,
    escrow_tx_hash,
  } = input;

  const tierConfig = TIER_CONFIG[tier];
  if (strategy_memo.length > tierConfig.memo_limit) {
    throw new Error(
      `Strategy memo exceeds ${tier} tier limit of ${tierConfig.memo_limit} characters`
    );
  }

  const audit_id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  let onChainHashVerified = false;
  let resolvedEscrowContext = escrow_context;

  if (escrow_tx_hash) {
    console.log(`[Audit ${audit_id}] Reading AuditPending event from tx ${escrow_tx_hash}`);
    const eventData = await readAuditPendingEvent(escrow_tx_hash);

    if (escrow_id !== undefined && Number(eventData.escrowId) !== escrow_id) {
      throw new Error(
        `Escrow ID mismatch — request escrow_id ${escrow_id} does not match ` +
        `on-chain event escrowId ${eventData.escrowId} from tx ${escrow_tx_hash}`
      );
    }

    const hashValid = verifyTraceHash(strategy_memo, eventData.executionTraceHash);
    if (!hashValid) {
      const computedHash = computeTraceHash(strategy_memo);
      throw new Error(
        `Hash mismatch — strategy memo has been tampered. ` +
        `On-chain: ${eventData.executionTraceHash}, computed: ${computedHash}`
      );
    }
    onChainHashVerified = true;
    console.log(`[Audit ${audit_id}] On-chain hash verification passed (escrow ${eventData.escrowId})`);

    if (!resolvedEscrowContext) {
      resolvedEscrowContext = {
        escrow_id: Number(eventData.escrowId),
        amount: Number(eventData.amount) / 1e6,
        tier,
        creator: eventData.creator,
        recipient: eventData.recipient,
      };
    }
  } else if (execution_trace_hash) {
    const hashValid = verifyTraceHash(strategy_memo, execution_trace_hash);
    if (!hashValid) {
      throw new Error("Hash mismatch — strategy memo has been tampered");
    }
    onChainHashVerified = true;
    console.log(`[Audit ${audit_id}] Hash verification passed`);
  }

  if (!resolvedEscrowContext && escrow_id) {
    resolvedEscrowContext = {
      escrow_id,
      amount: 0,
      tier,
    };
  }

  const selectedPersona = persona || tierConfig.default_persona;

  const cryptographic_hash = crypto
    .createHash("sha256")
    .update(strategy_memo)
    .digest("hex");

  const keccak256_hash = computeTraceHash(strategy_memo);

  const startTime = Date.now();

  let result: AuditResult;

  if (tier === "treasury" && shouldUseClaude()) {
    try {
      console.log(`[Audit ${audit_id}] Treasury tier — routing to Claude`);
      const claudeClient = getClaudeAuditClient();
      const claudeResult = await claudeClient.audit(strategy_memo, tier);
      result = {
        ...claudeResult,
        persona_used: selectedPersona,
        confidence: undefined,
        primary_bias_detected: undefined,
        logic_flaws: claudeResult.flags.map(f => f.code),
        scenarios: undefined,
        structural_recommendations: undefined,
        action_items: undefined,
      };
    } catch (claudeError) {
      console.error(`[Audit ${audit_id}] Claude fallback — ${(claudeError as Error).message}`);
      const toolCall: ToolCall = {
        name: audit_type || "general",
        params: trade_params || {},
        reasoning: strategy_memo,
        domain: "financial",
      };
      const engineResult = djzsEngine.audit(toolCall);
      result = mapEngineResultToAuditResult(engineResult, selectedPersona);
    }
  } else {
    const toolCall: ToolCall = {
      name: audit_type || "general",
      params: trade_params || {},
      reasoning: strategy_memo,
      domain: "financial",
    };
    const engineResult = djzsEngine.audit(toolCall);
    result = mapEngineResultToAuditResult(engineResult, selectedPersona);
  }

  const duration_ms = Date.now() - startTime;

  console.log(`[Audit ${audit_id}] ${formatResultForLog(result)}`);
  console.log(JSON.stringify({
    event: "audit_complete",
    audit_id,
    verdict: result.verdict,
    risk_score: result.risk_score,
    flag_count: result.flags.length,
    duration_ms,
    tier,
    persona: selectedPersona,
    model: result.model_used,
  }));

  const abortTriggers = getAbortTriggers(result);
  const abort = shouldAbortResult(result);
  const abortReasons = abortTriggers.map(f => `${f.code} (${f.severity}): ${f.evidence}`);

  const detectedCodes = new Set(result.flags.map(f => f.code));
  const flagVector: Record<string, boolean> = {};
  for (const code of ALL_LF_CODES) {
    flagVector[code] = detectedCodes.has(code);
  }
  const hashObj = { schema_version: SCHEMA_VERSION, flags: flagVector, risk_score: result.risk_score };
  const logicHashInput = JSON.stringify(hashObj, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
  const logic_hash = "0x" + crypto.createHash("sha256").update(logicHashInput).digest("hex");

  const certificate: ProofOfLogicCertificate = {
    audit_id,
    timestamp,
    tier,
    cryptographic_hash,
    keccak256_hash,
    audit_schema_version: SCHEMA_VERSION,
    weights_hash: WEIGHTS_HASH,
    taxonomy_hash: TAXONOMY_HASH,
    taxonomy_version: DJZS_LF_VERSION,
    logic_hash,
    max_possible: MAX_RISK_SCORE,
    pass_threshold: 60,
    detection_model: "djzs-trust/rule-engine@v1.0",
    scoring_engine: "typescript/pure-function",
    anchor_target: "irys-datachain",
    settlement_chain: "base-mainnet",
    should_abort: abort,
    abort_reasons: abortReasons.length > 0 ? abortReasons : undefined,
    on_chain_hash_verified: onChainHashVerified || undefined,
    ...result,
  };

  return certificate;
}

export type MessagePrefix = "Thinking:" | "Journal:" | "Audit:" | "Risk:";

export function parseAndRoute(rawMessage: string): {
  content: string;
  persona: AdversarialPersona;
} {
  if (rawMessage.startsWith("Risk:")) {
    return {
      content: rawMessage.slice(5).trim(),
      persona: "risk_hunter",
    };
  }
  
  if (rawMessage.startsWith("Backtest:")) {
    return {
      content: rawMessage.slice(9).trim(),
      persona: "backtest_skeptic",
    };
  }
  
  if (rawMessage.startsWith("Regime:")) {
    return {
      content: rawMessage.slice(7).trim(),
      persona: "regime_detector",
    };
  }
  
  if (rawMessage.startsWith("Logic:")) {
    return {
      content: rawMessage.slice(6).trim(),
      persona: "logic_auditor",
    };
  }

  for (const prefix of ["Thinking:", "Audit:"]) {
    if (rawMessage.startsWith(prefix)) {
      return {
        content: rawMessage.slice(prefix.length).trim(),
        persona: "general",
      };
    }
  }

  return {
    content: rawMessage.trim(),
    persona: "general",
  };
}

export async function handleXMTPMessage(
  rawMessage: string
): Promise<string> {
  const { content, persona } = parseAndRoute(rawMessage);
  
  const certificate = await executeAudit({
    strategy_memo: content,
    tier: "micro",
    persona,
  });

  return JSON.stringify(certificate, null, 2);
}

export function shouldAutoAbort(cert: ProofOfLogicCertificate): boolean {
  if (cert.should_abort) return true;
  return shouldAbortResult(cert);
}

export interface LegacyAuditLog {
  auditId: string;
  tier: AuditTier;
  verdict: string;
  riskScore: number;
  strategyMemo?: string;
  auditType: string;
  primaryBiasDetected: string;
  flags: { code: string; severity: string; message: string }[];
  logicFlaws: { flaw_type: string; severity: string; explanation: string }[];
  structuralRecommendations: string[];
  cryptographicHash: string;
  walletAddress?: string | null;
  irysTxId?: string | null;
}

export function mapToLegacyAuditLog(
  cert: Omit<ProofOfLogicCertificate, "verdict"> & { verdict: string },
  extras?: { strategyMemo?: string; auditType?: string; walletAddress?: string | null; irysTxId?: string | null }
): LegacyAuditLog {
  const legacyInput: AdversarialAuditResult = {
    verdict: cert.verdict === "PASS" ? "PASS" : "FAIL",
    risk_score: cert.risk_score,
    primary_flaw: cert.primary_flaw,
    summary: cert.summary,
    flags: cert.flags,
  };
  const legacy = mapToLegacyFormat(legacyInput);

  return {
    auditId: cert.audit_id,
    tier: cert.tier,
    verdict: cert.verdict,
    riskScore: cert.risk_score,
    strategyMemo: extras?.strategyMemo,
    auditType: extras?.auditType || "general",
    primaryBiasDetected: cert.primary_bias_detected || legacy.primaryBiasDetected || cert.primary_flaw || "None",
    flags: cert.flags.map(f => ({ code: f.code, severity: f.severity, message: f.description || f.evidence || "" })),
    logicFlaws: (cert.logic_flaws || legacy.logicFlaws).map(f =>
      typeof f === "string" ? { flaw_type: "detected", severity: "medium", explanation: f } : f as any
    ),
    structuralRecommendations: cert.structural_recommendations || legacy.structuralRecommendations,
    cryptographicHash: cert.cryptographic_hash,
    walletAddress: extras?.walletAddress,
    irysTxId: extras?.irysTxId,
  };
}

export async function runLogicAuditAgent(
  request: { strategy_memo: string; audit_type?: string; intelligence_context?: string | IntelligenceContext; trade_params?: Record<string, unknown>; agent_id?: string },
  tier: AuditTier = "micro",
  _apiKeyOverride?: string
): Promise<ProofOfLogicCertificate> {
  return executeAudit({
    strategy_memo: request.strategy_memo,
    audit_type: (request.audit_type as AuditInput["audit_type"]) || "general",
    tier,
    intelligence_context: request.intelligence_context,
    trade_params: request.trade_params,
    agent_id: request.agent_id,
  });
}

export async function postAuditChainWrite(
  audit: { verdict: string; risk_score: number; flags: Array<{ code: string; severity: string; [k: string]: unknown }> },
  agentAddress: string | undefined,
  irysTxId: string | null
): Promise<ChainWriterResult> {
  if (!irysTxId || !agentAddress || !process.env.TRUST_SCORE_CONTRACT_ADDRESS) {
    return { trust_score_tx_hash: null };
  }
  const flagCodes = Array.isArray(audit.flags)
    ? audit.flags.map((f: any) => f.code || "").filter(Boolean)
    : [];
  return writeTrustScore({
    agentAddress,
    verdict: audit.verdict,
    riskScore: audit.risk_score,
    flags: flagCodes,
    irysTxId,
  });
}

export { TIER_CONFIG as AUDIT_TIER_CONFIG };
