import type { Address, Hex, WalletClient } from "viem";

/* ----------------------------- ZoneRef ----------------------------- */
export type ZoneRef =
  | { kind: "journal"; id: string; title?: string }
  | { kind: "research"; id: string; title?: string }
  | { kind: "url"; url: string; title?: string }
  | { kind: "file"; filename: string; sha256?: string; title?: string };

/* ----------------------------- Domain objects ----------------------------- */
export interface TradeThesis {
  id: string;
  asset: string;
  side: "BUY" | "SELL";
  timeframe: "SHORT" | "MEDIUM" | "LONG";
  conviction: number;
  positionSizePct: number;
  entry: { type: "MARKET" | "LIMIT"; limitPrice?: number };
  exits?: { takeProfitPct?: number; stopLossPct?: number; invalidation?: string };
  marketConditions?: {
    currentPrice?: number;
    sentiment?: "FEAR" | "NEUTRAL" | "GREED";
    catalysts?: string[];
  };
  notes?: string;
  createdAt: number;
}

export interface StressTestReport {
  approved: boolean;
  reasons: string[];
  counterArguments: string[];
  missingInfo: string[];
  suggestedMemoryPins?: Array<{ title: string; content: string }>;
}

export interface RiskParameters {
  maxPositionSizePct: number;
  maxDailyLossPct: number;
  maxAssetExposurePct?: number;
  maxSectorExposurePct?: number;
}

export interface PortfolioSnapshot {
  timestamp: number;
  totalValueUsd: number;
  realizedPnlTodayUsd: number;
  positions: Array<{ asset: string; valueUsd: number; sector?: string }>;
}

export interface RiskSummary {
  withinLimits: boolean;
  violations: string[];
  computed: {
    proposedPositionSizePct: number;
    dailyLossPct: number;
    estWorstCaseLossPct: number;
  };
  params: RiskParameters;
  portfolio?: Pick<PortfolioSnapshot, "timestamp" | "totalValueUsd" | "realizedPnlTodayUsd">;
}

/* ----------------------------- TradeArtifact ----------------------------- */
export interface TradeArtifactV1 {
  schema: "djzs.tradeArtifact.v1";
  createdAt: number;

  thesis: TradeThesis;
  evidence: ZoneRef[];
  stressTest: StressTestReport;
  risk: RiskSummary;

  hash: Hex;
  author: {
    address?: Address;
    signature?: Hex;
    signatureType?: "eip191";
  };

  memo?: string;
}

/* ----------------------------- Dexie row ----------------------------- */
export type TradeArtifactRow = TradeArtifactV1 & {
  id?: number;
  thesisAsset: string;
  thesisSide: TradeThesis["side"];
  thesisTimeframe: TradeThesis["timeframe"];
  linkedJournalEntryIds: string[];
  linkedResearchDossierIds: string[];
};

/* ----------------------------- Stable stringify + sha256 ----------------------------- */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const body = keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",");
    return `{${body}}`;
  }
  return JSON.stringify(String(value));
}

function bytesToHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out as Hex;
}

export async function sha256HexUtf8(utf8: string): Promise<Hex> {
  const data = new TextEncoder().encode(utf8);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

/* ----------------------------- Risk (deterministic) ----------------------------- */
export function computeRiskSummary(args: {
  thesis: TradeThesis;
  params: RiskParameters;
  portfolio?: PortfolioSnapshot;
}): RiskSummary {
  const { thesis, params, portfolio } = args;

  const proposedPositionSizePct = thesis.positionSizePct;
  const dailyLossPct =
    portfolio && portfolio.totalValueUsd > 0
      ? (Math.max(0, -portfolio.realizedPnlTodayUsd) / portfolio.totalValueUsd) * 100
      : 0;

  const estWorstCaseLossPct =
    typeof thesis.exits?.stopLossPct === "number" ? thesis.exits.stopLossPct : proposedPositionSizePct;

  const violations: string[] = [];
  if (proposedPositionSizePct > params.maxPositionSizePct) violations.push("Position size exceeds maxPositionSizePct");
  if (dailyLossPct > params.maxDailyLossPct) violations.push("Daily loss exceeds maxDailyLossPct");

  return {
    withinLimits: violations.length === 0,
    violations,
    computed: { proposedPositionSizePct, dailyLossPct, estWorstCaseLossPct },
    params,
    portfolio: portfolio
      ? {
          timestamp: portfolio.timestamp,
          totalValueUsd: portfolio.totalValueUsd,
          realizedPnlTodayUsd: portfolio.realizedPnlTodayUsd
        }
      : undefined
  };
}

/* ----------------------------- Evidence -> linked IDs ----------------------------- */
export function extractLinkedIds(evidence: ZoneRef[]): {
  linkedJournalEntryIds: string[];
  linkedResearchDossierIds: string[];
} {
  const j = new Set<string>();
  const r = new Set<string>();
  for (const ref of evidence) {
    if (ref.kind === "journal") j.add(ref.id);
    if (ref.kind === "research") r.add(ref.id);
  }
  return { linkedJournalEntryIds: [...j], linkedResearchDossierIds: [...r] };
}

/* ----------------------------- Artifact creation ----------------------------- */
function resolveAddress(walletClient?: WalletClient, explicit?: Address): Address | undefined {
  return explicit ?? (walletClient?.account?.address as Address | undefined);
}

export async function createTradeArtifactV1(args: {
  thesis: TradeThesis;
  evidence: ZoneRef[];
  stressTest: StressTestReport;
  risk: RiskSummary;
  memo?: string;

  walletClient?: WalletClient;
  account?: Address;
}): Promise<TradeArtifactV1> {
  const createdAt = Date.now();

  const payloadForHash = {
    schema: "djzs.tradeArtifact.v1",
    thesis: args.thesis,
    evidence: args.evidence,
    stressTest: args.stressTest,
    risk: args.risk,
    memo: args.memo ?? undefined
  };

  const hash = await sha256HexUtf8(stableStringify(payloadForHash));

  const address = resolveAddress(args.walletClient, args.account);

  let signature: Hex | undefined;
  if (args.walletClient && address) {
    signature = await args.walletClient.signMessage({
      account: address,
      message: { raw: hash }
    });
  }

  return {
    schema: "djzs.tradeArtifact.v1",
    createdAt,
    thesis: args.thesis,
    evidence: args.evidence,
    stressTest: args.stressTest,
    risk: args.risk,
    hash,
    author: {
      address,
      signature,
      signatureType: signature ? "eip191" : undefined
    },
    memo: args.memo
  };
}

export function toTradeArtifactRow(artifact: TradeArtifactV1): TradeArtifactRow {
  const links = extractLinkedIds(artifact.evidence);
  return {
    ...artifact,
    thesisAsset: artifact.thesis.asset,
    thesisSide: artifact.thesis.side,
    thesisTimeframe: artifact.thesis.timeframe,
    linkedJournalEntryIds: links.linkedJournalEntryIds,
    linkedResearchDossierIds: links.linkedResearchDossierIds
  };
}
