import { z } from "zod";

export const SIGNAL_SOURCES = [
  "INDEPENDENT_RESEARCH",
  "AGGREGATED_CONSENSUS",
  "SOCIAL_SIGNAL",
  "PAID_SIGNAL_GROUP",
  "WHALE_TRACKING",
  "COUNTER_CONSENSUS",
  "MODEL_OUTPUT",
  "UNDISCLOSED",
] as const;

export type SignalSource = typeof SIGNAL_SOURCES[number];

export const POSITION_SIDE = ["YES", "NO"] as const;

export type PositionSide = typeof POSITION_SIDE[number];

export const MARKET_CATEGORIES = [
  "POLITICS",
  "CRYPTO",
  "SPORTS",
  "SCIENCE",
  "CULTURE",
  "ECONOMICS",
  "CLIMATE",
  "OTHER",
] as const;

export type MarketCategory = typeof MARKET_CATEGORIES[number];

export const DETECTION_ENGINES = ["CLAUDE", "VENICE"] as const;

export type DetectionEngine = typeof DETECTION_ENGINES[number];

export const PredictionContextSchema = z.object({
  market_question: z
    .string()
    .min(10)
    .max(200),

  market_id: z
    .string()
    .min(1),

  category: z.enum(MARKET_CATEGORIES),

  position: z.enum(POSITION_SIDE),

  entry_price: z
    .number()
    .min(0.01)
    .max(0.99),

  size_usdc: z
    .number()
    .positive(),

  thesis: z
    .string()
    .min(50, "A thesis under 50 characters is not a thesis. It's a guess.")
    .max(800),

  source_signal: z.enum(SIGNAL_SOURCES),

  evidence_urls: z
    .array(z.string().url())
    .max(3)
    .optional(),
});

export type PredictionContext = z.infer<typeof PredictionContextSchema>;

export const LFDetectionResultSchema = z.object({
  S01: z.object({ detected: z.boolean(), evidence: z.string() }),
  S02: z.object({ detected: z.boolean(), evidence: z.string() }),
  E01: z.object({ detected: z.boolean(), evidence: z.string() }),
  E02: z.object({ detected: z.boolean(), evidence: z.string() }),
  I01: z.object({ detected: z.boolean(), evidence: z.string() }),
  I02: z.object({ detected: z.boolean(), evidence: z.string() }),
  I03: z.object({ detected: z.boolean(), evidence: z.string() }),
  X01: z.object({ detected: z.boolean(), evidence: z.string() }),
  X02: z.object({ detected: z.boolean(), evidence: z.string() }),
  T01: z.object({ detected: z.boolean(), evidence: z.string() }),
});

export type LFDetectionResult = z.infer<typeof LFDetectionResultSchema>;

export const PredictionAuditRequestSchema = z.object({
  domain: z.literal("PREDICTION"),
  engine: z.enum(DETECTION_ENGINES).default("CLAUDE"),
  context: PredictionContextSchema,
  agent_id: z.string().optional(),
});

export type PredictionAuditRequest = z.infer<typeof PredictionAuditRequestSchema>;

export const VENUES = ["LIMITLESS", "POLYMARKET"] as const;
export type VenueId = typeof VENUES[number];

// Per-venue connection shape. LIMITLESS is the only wired venue; POLYMARKET is
// kept for config back-compat but is not a live trade venue (geoblocks US persons).
export interface VenueConfig {
  host: string;
  chain_id: number;
  enabled: boolean;
}

export const VENUE_DEFAULTS: Record<VenueId, VenueConfig> = {
  LIMITLESS: { host: "https://api.limitless.exchange", chain_id: 8453, enabled: true },
  POLYMARKET: { host: "https://clob.polymarket.com", chain_id: 137, enabled: false },
};

export interface PredictionProxyConfig {
  djzs_endpoint: string;
  polymarket_host: string;
  polymarket_chain_id: number;
  payment: {
    chain: "base-mainnet";
    amount_usdc: 0.10;
    deferred: true;
  };
  risk_ceiling: number;
  // Generalized venue map. Existing polymarket_* fields above stay for back-compat.
  venue?: VenueId;
  venues?: Partial<Record<VenueId, VenueConfig>>;
}

export interface PredictionAuditResult {
  verdict: "PASS" | "FAIL" | "INDETERMINATE";
  risk_score: number;
  lf_codes: Array<{
    code: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    evidence: string;
  }>;
  order_forwarded: boolean;
  polymarket_order_id?: string;
  irys_tx_id?: string;
  logic_hash: string;
  payment_tx?: string;
}
