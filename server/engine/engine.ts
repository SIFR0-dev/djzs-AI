import type {
  ToolCall,
  Detection,
  DetectionResult,
  EngineConfig,
  LFCode,
} from "./types";
import { DEFAULT_CONFIG } from "./types";
import { DJZS_WEIGHTS, UNIVERSAL_WEIGHTS, AGENCY_WEIGHTS, LF_LABELS } from "./weights";

import { detectS01, detectS02, detectS03 } from "./detectors/structural";
import { detectE01, detectE02 } from "./detectors/execution";
import { detectI01, detectI02, detectI03 } from "./detectors/incentive";
import { detectX01, detectX02 } from "./detectors/extended";
import { detectT01 } from "./detectors/temporal";

import {
  detectUnauthorizedScope,
  detectParameterOverflow,
  detectDestructiveUnguarded,
  detectNoRollbackPath,
  detectChainUnverified,
} from "./detectors/universal";

import {
  detectA01,
  detectA02,
  detectA03,
  detectA04,
  detectA05,
} from "./detectors/agency";

import { createHash } from "crypto";

export class DJZSEngine {
  private config: EngineConfig;

  constructor(config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  evaluate(call: ToolCall): DetectionResult {
    const detections: Detection[] = [];
    const domain = call.domain || "financial";

    if (
      this.config.codeSets.includes("djzs") &&
      domain === "financial"
    ) {
      detections.push(
        detectS01(call),
        detectS02(call),
        detectS03(call),
        detectE01(call),
        detectE02(call),
        detectI01(call),
        detectI02(call),
        detectI03(call),
        detectX01(call),
        detectX02(call),
        detectT01(call),
      );
    }

    if (this.config.codeSets.includes("universal")) {
      detections.push(
        detectUnauthorizedScope(call, this.config),
        detectParameterOverflow(call),
        detectDestructiveUnguarded(call, this.config),
        detectNoRollbackPath(call),
        detectChainUnverified(call),
      );
    }

    if (this.config.codeSets.includes("agency")) {
      detections.push(
        detectA01(call),
        detectA02(call),
        detectA03(call),
        detectA04(call),
        detectA05(call),
      );
    }

    const firedCodes: LFCode[] = detections
      .filter((d) => d.fired)
      .map((d) => d.code);

    const allWeights = { ...DJZS_WEIGHTS, ...UNIVERSAL_WEIGHTS, ...AGENCY_WEIGHTS };
    const totalPenalty = firedCodes.reduce(
      (sum, code) => sum + (allWeights[code] || 0),
      0
    );

    let maxPenalty = 0;
    if (this.config.codeSets.includes("djzs") && domain === "financial") {
      maxPenalty += 200;
    }
    if (this.config.codeSets.includes("universal")) {
      maxPenalty += 100;
    }
    if (this.config.codeSets.includes("agency")) {
      maxPenalty += 100;
    }

    const riskScore = maxPenalty > 0
      ? Math.round((totalPenalty / maxPenalty) * 100)
      : 0;

    let verdict: "PASS" | "FAIL" | "WARN";
    if (riskScore >= this.config.failThreshold) {
      verdict = "FAIL";
    } else if (riskScore >= this.config.warnThreshold) {
      verdict = "WARN";
    } else {
      verdict = "PASS";
    }

    return {
      detections,
      firedCodes,
      totalPenalty,
      maxPenalty,
      riskScore,
      verdict,
      deterministic: true,
      evaluatedAt: new Date().toISOString(),
    };
  }

  computeVerdictHash(result: DetectionResult): string {
    const hashInput = {
      firedCodes: result.firedCodes.sort(),
      totalPenalty: result.totalPenalty,
      riskScore: result.riskScore,
      verdict: result.verdict,
      deterministic: result.deterministic,
    };
    return createHash("sha256")
      .update(JSON.stringify(hashInput))
      .digest("hex");
  }

  audit(call: ToolCall): DetectionResult & { verdictHash: string } {
    const result = this.evaluate(call);
    const verdictHash = this.computeVerdictHash(result);
    return { ...result, verdictHash };
  }
}
