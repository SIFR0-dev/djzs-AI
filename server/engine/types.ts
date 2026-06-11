export interface ToolCall {
  name: string;
  params: Record<string, unknown>;
  schema?: ToolSchema;
  reasoning?: string;
  context?: ContextEntry[];
  domain?: "financial" | "general";
}

export interface ToolSchema {
  name: string;
  description?: string;
  parameters?: {
    type: "object";
    properties?: Record<string, SchemaProperty>;
    required?: string[];
  };
}

export interface SchemaProperty {
  type: string;
  description?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  pattern?: string;
}

export interface ContextEntry {
  role: "user" | "assistant" | "tool_result";
  content: string;
  toolName?: string;
  timestamp?: number;
}

export type DJZSLFCode =
  | "S01"
  | "S02"
  | "S03"
  | "E01"
  | "E02"
  | "I01"
  | "I02"
  | "I03"
  | "X01"
  | "X02"
  | "T01";

export type UniversalLFCode =
  | "UNAUTHORIZED_SCOPE"
  | "PARAMETER_OVERFLOW"
  | "DESTRUCTIVE_UNGUARDED"
  | "NO_ROLLBACK_PATH"
  | "CHAIN_UNVERIFIED";

export type AgencyLFCode =
  | "A01"
  | "A02"
  | "A03"
  | "A04"
  | "A05";

export type LFCode = DJZSLFCode | UniversalLFCode | AgencyLFCode;

export interface Detection {
  code: LFCode;
  label: string;
  fired: boolean;
  confidence: number;
  evidence: string;
}

export interface DetectionResult {
  detections: Detection[];
  firedCodes: LFCode[];
  totalPenalty: number;
  maxPenalty: number;
  riskScore: number;
  verdict: "PASS" | "FAIL" | "WARN";
  deterministic: true;
  evaluatedAt: string;
}

export interface EngineConfig {
  failThreshold: number;
  warnThreshold: number;
  codeSets: ("djzs" | "universal" | "agency")[];
  destructiveOps?: string[];
  privilegedScopes?: string[];
}

export const DEFAULT_CONFIG: EngineConfig = {
  failThreshold: 25,
  warnThreshold: 10,
  codeSets: ["djzs", "universal"],
  destructiveOps: [
    "delete", "drop", "remove", "destroy", "purge", "revoke",
    "transfer_all", "drain", "burn", "liquidate", "nuke",
  ],
  privilegedScopes: [
    "admin", "root", "sudo", "owner", "withdraw", "transfer",
    "approve_unlimited", "set_operator", "upgrade_contract",
    "change_owner", "pause", "unpause", "migrate",
  ],
};
