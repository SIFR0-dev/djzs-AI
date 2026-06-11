import type { ToolCall, Detection } from "../types";
import { matchesAny, matchesRegex } from "../utils/analysis";

function thesisText(call: ToolCall): string {
  return `${call.reasoning || ""} ${JSON.stringify(call.params)}`;
}

const QUANTIFIED_CLAIM = [
  /\b\d+(?:\.\d+)?\s*%/,
  /\b\d+(?:\.\d+)?\s*(?:bps|x|ms|s|sec|seconds?|minutes?|hours?|days?|weeks?|months?|usd|usdc|eth|btc|points?)\b/i,
  /[<>]=?\s*\d/,
  /\bp\s*[<=]\s*0?\.\d+/i,
  /\bby\s+(?:at least\s+)?\d/i,
];

const DIRECTIONAL_VERB = [
  "will", "expect", "expects", "projected", "project", "target", "targets",
  "reduce", "reduces", "increase", "increases", "decrease", "decreases",
  "improve", "improves", "outperform", "reach", "achieve", "deliver",
];

const FALSIFICATION = [
  /\bfalsif/i,
  /\binvalidat/i,
  /\bdisprov/i,
  /\bwould be wrong\b/i,
  /\bfails? if\b/i,
  /\bwrong if\b/i,
  /\bbreaks? if\b/i,
  /\bstop(?:ped)? if\b/i,
  /\bthesis (?:breaks|fails|is wrong)\b/i,
  /\bexit if\b/i,
];

function hasQuantifiedClaim(text: string): boolean {
  return matchesRegex(text, QUANTIFIED_CLAIM).length > 0;
}

function hasDirectionalClaim(text: string): boolean {
  return (
    matchesAny(text, DIRECTIONAL_VERB).length > 0 && hasQuantifiedClaim(text)
  );
}

function hasFalsification(text: string): boolean {
  return matchesRegex(text, FALSIFICATION).length > 0;
}

export function detectA01(call: ToolCall): Detection {
  const code = "A01" as const;
  const label = "MISSING_FALSIFIABLE_THESIS";
  const text = thesisText(call);

  const testable = hasDirectionalClaim(text) || hasFalsification(text);

  if (!testable) {
    return {
      code,
      label,
      fired: true,
      confidence: 1,
      evidence:
        "No falsifiable thesis: reasoning contains neither a quantified directional claim nor an explicit falsification condition",
    };
  }

  return { code, label, fired: false, confidence: 1, evidence: "Falsifiable thesis present" };
}

const METRIC_INTENT = [
  "success", "metric", "metrics", "kpi", "measure", "measured", "outcome",
  "goal", "objective", "performance", "results", "track", "benchmark",
];

export function detectA02(call: ToolCall): Detection {
  const code = "A02" as const;
  const label = "UNTESTABLE_METRICS";
  const text = thesisText(call);

  const intentHits = matchesAny(text, METRIC_INTENT);

  if (intentHits.length === 0) {
    return { code, label, fired: false, confidence: 1, evidence: "No success-metric language to evaluate" };
  }

  if (!hasQuantifiedClaim(text)) {
    return {
      code,
      label,
      fired: true,
      confidence: 1,
      evidence: `Success metric referenced (${intentHits.join(", ")}) but no quantifiable target, threshold, or unit provided`,
    };
  }

  return { code, label, fired: false, confidence: 1, evidence: "Metrics are quantified" };
}

const FORWARD_COMMITMENT = [
  /\b(?:long[- ]?term|ongoing|continuous(?:ly)?|indefinite(?:ly)?|going forward)\b/i,
  /\bwill (?:hold|keep|maintain|continue|run|persist)\b/i,
  /\b(?:always|permanently|set and forget|autonomous(?:ly)?)\b/i,
];

const UPDATE_SIGNAL = [
  /\bupdate/i,
  /\bre-?(?:evaluat|assess|audit|check|visit|view)/i,
  /\bmonitor/i,
  /\bif new (?:data|evidence|information)/i,
  /\bon new (?:data|evidence|signal)/i,
  /\bthreshold (?:triggers?|breach)/i,
  /\badjust(?:s|ed)? if\b/i,
  /\breview (?:when|if|on)\b/i,
  /\bfeedback loop\b/i,
  /\bevidence[- ]responsive\b/i,
];

export function detectA03(call: ToolCall): Detection {
  const code = "A03" as const;
  const label = "STATIC_REASONING";
  const text = thesisText(call);

  const hasCommitment = matchesRegex(text, FORWARD_COMMITMENT).length > 0;
  if (!hasCommitment) {
    return { code, label, fired: false, confidence: 1, evidence: "No forward-looking commitment to evaluate" };
  }

  const hasUpdate = matchesRegex(text, UPDATE_SIGNAL).length > 0;
  if (!hasUpdate) {
    return {
      code,
      label,
      fired: true,
      confidence: 1,
      evidence:
        "Forward/ongoing commitment with no plan to update on new evidence (no monitor, re-evaluation, or threshold trigger)",
    };
  }

  return { code, label, fired: false, confidence: 1, evidence: "Reasoning plans to update on evidence" };
}

const CONSTRAINED_DOMAIN = [
  "regulated", "regulatory", "compliance", "compliant", "soc2", "soc 2",
  "hipaa", "gdpr", "kyc", "aml", "audit trail", "system of record",
  "data residency", "legal", "tax code", "credit score", "custodial",
  "smart contract", "on-chain", "onchain", "production database", "switching cost",
];

const CONSTRAINT_HANDLING = [
  "comply", "complies", "compliant", "within", "constraint", "constraints",
  "permission", "permissioned", "authorized", "authorization", "guardrail",
  "bounded", "respects", "respect", "governance", "policy", "approval",
  "sandbox", "limit", "limits", "scoped", "whitelist", "allowlist", "audit",
];

export function detectA04(call: ToolCall): Detection {
  const code = "A04" as const;
  const label = "IGNORES_CONSTRAINTS";
  const text = `${thesisText(call)} ${call.name}`.toLowerCase();

  const domainHits = matchesAny(text, CONSTRAINED_DOMAIN);
  if (domainHits.length === 0) {
    return { code, label, fired: false, confidence: 1, evidence: "No constrained/regulated environment referenced" };
  }

  const handlingHits = matchesAny(text, CONSTRAINT_HANDLING);
  if (handlingHits.length === 0) {
    return {
      code,
      label,
      fired: true,
      confidence: 1,
      evidence: `Operates in a constrained environment (${domainHits.join(", ")}) without acknowledging any regulatory/compliance/data-gravity constraint handling`,
    };
  }

  return { code, label, fired: false, confidence: 1, evidence: "Environment constraints acknowledged" };
}

const REPLACEMENT_LANGUAGE = [
  /\breplace (?:the )?(?:ui|interface|seat|seats|dashboard|frontend|front[- ]end)\b/i,
  /\beliminat(?:e|es|ing) (?:the )?(?:seat|seats|ui|interface)\b/i,
  /\bremove (?:the )?(?:interface|ui|dashboard)\b/i,
  /\bcut (?:head ?count|seats)\b/i,
  /\bautomate(?:s)? away\b/i,
  /\bdeprecate (?:the )?(?:ui|interface|dashboard)\b/i,
  /\bredundant (?:ui|interface|seat)\b/i,
  /\bno (?:longer )?need (?:for )?the (?:ui|interface|dashboard)\b/i,
  /\bdisplac(?:e|es|ing) (?:seats|workers|the interface)\b/i,
];

const OUTCOME_IMPROVEMENT = [
  "accuracy", "better outcome", "reduce risk", "data quality", "predictive",
  "compliance", "lower error", "faster detection", "improve", "improves",
  "verifiable", "switching cost", "data gravity", "audit trail", "retention",
];

export function detectA05(call: ToolCall): Detection {
  const code = "A05" as const;
  const label = "INTERFACE_EROSION_ONLY";
  const text = thesisText(call);

  const replacement = matchesRegex(text, REPLACEMENT_LANGUAGE).length > 0;
  if (!replacement) {
    return { code, label, fired: false, confidence: 1, evidence: "No interface-replacement-only value claim" };
  }

  const outcome = matchesAny(text.toLowerCase(), OUTCOME_IMPROVEMENT);
  if (outcome.length === 0) {
    return {
      code,
      label,
      fired: true,
      confidence: 1,
      evidence:
        "Value proposition relies solely on replacing UI/seats with no claim of improved data value or outcome predictability",
    };
  }

  return { code, label, fired: false, confidence: 1, evidence: "Replacement paired with an outcome/data improvement claim" };
}
