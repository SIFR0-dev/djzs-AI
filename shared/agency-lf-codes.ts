import type { AgencyLFCode, Detection } from "../server/engine/types";
import { AGENCY_WEIGHTS, LF_LABELS } from "../server/engine/weights";
import { createHash } from "crypto";

export { AGENCY_WEIGHTS, LF_LABELS };
export type { AgencyLFCode };

export const AGENCY_LF_CODES: AgencyLFCode[] = [
  "A01",
  "A02",
  "A03",
  "A04",
  "A05",
];

export interface AgencyCodeDefinition {
  code: AgencyLFCode;
  label: string;
  principle:
    | "Falsifiability"
    | "Evidence-Responsiveness"
    | "Determined-Systems";
  weight: number;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  description: string;
}

export const AGENCY_CODE_DEFINITIONS: Record<AgencyLFCode, AgencyCodeDefinition> = {
  A01: {
    code: "A01",
    label: "MISSING_FALSIFIABLE_THESIS",
    principle: "Falsifiability",
    weight: AGENCY_WEIGHTS.A01,
    severity: "CRITICAL",
    description:
      "No explicit, testable claim: reasoning lacks a quantified directional prediction and any explicit falsification condition.",
  },
  A02: {
    code: "A02",
    label: "UNTESTABLE_METRICS",
    principle: "Falsifiability",
    weight: AGENCY_WEIGHTS.A02,
    severity: "HIGH",
    description:
      "Success is referenced but the metrics are vague or non-quantifiable (no target, threshold, or unit).",
  },
  A03: {
    code: "A03",
    label: "STATIC_REASONING",
    principle: "Evidence-Responsiveness",
    weight: AGENCY_WEIGHTS.A03,
    severity: "HIGH",
    description:
      "Forward/ongoing commitment with no plan to update on new evidence (no monitoring, re-evaluation, or threshold trigger).",
  },
  A04: {
    code: "A04",
    label: "IGNORES_CONSTRAINTS",
    principle: "Determined-Systems",
    weight: AGENCY_WEIGHTS.A04,
    severity: "CRITICAL",
    description:
      "Operates inside a constrained/regulated environment (compliance, data gravity, switching costs) without acknowledging those constraints.",
  },
  A05: {
    code: "A05",
    label: "INTERFACE_EROSION_ONLY",
    principle: "Determined-Systems",
    weight: AGENCY_WEIGHTS.A05,
    severity: "MEDIUM",
    description:
      "Value proposition relies solely on replacing UI/seats without improving underlying data value or outcome predictability.",
  },
};

export const AGENCY_MAX_SCORE = Object.values(AGENCY_WEIGHTS).reduce((a, b) => a + b, 0);

export function computeAgencyScore(firedCodes: AgencyLFCode[]): number {
  return firedCodes.reduce((sum, code) => sum + (AGENCY_WEIGHTS[code] ?? 0), 0);
}

export function computeAgencyVerdict(
  firedCodes: AgencyLFCode[],
  failThreshold: number = 40
): "PASS" | "FAIL" {
  const score = computeAgencyScore(firedCodes);
  if (score >= failThreshold) return "FAIL";

  const hasCritical = firedCodes.some(
    (code) => AGENCY_CODE_DEFINITIONS[code]?.severity === "CRITICAL"
  );
  if (hasCritical) return "FAIL";

  return "PASS";
}

export function computeAgencyHash(firedDetections: Detection[]): string {
  const hashInput = {
    codes: AGENCY_LF_CODES,
    weights: AGENCY_WEIGHTS,
    fired: firedDetections
      .filter((d) => d.fired)
      .map((d) => ({ code: d.code, evidence: d.evidence })),
  };

  return createHash("sha256").update(JSON.stringify(hashInput)).digest("hex");
}
