import type { Express } from "express";
import type { Outcome } from "@shared/pm-gate";
import { evaluatePMTrade } from "@shared/pm-gate";
import { getMarket, getOrderbook, toGateInputs } from "./venues/limitless";

// deterministic-signal.trading surface.
// POST /api/signal runs a live Limitless market through the DJZS-PM trade-mechanics
// gate and returns a real LONG/WAIT verdict + reason codes. With no marketSlug it
// preserves the original safe default (WAIT, no market features connected).

type TradingSignal = "LONG" | "SHORT" | "WAIT";

interface SignalRequest {
  marketSlug?: unknown;
  outcome?: unknown; // "YES" | "NO" — which side to buy
  modelProb?: unknown; // probabilistic layer's estimate, 0..1 (the only non-deterministic input)
  sizeUsd?: unknown;
  accountEquityUsd?: unknown;
  feeBps?: unknown;
  realizedLossTodayUsd?: unknown;
  // legacy fields kept for back-compat with the old stub callers
  symbol?: unknown;
  venue?: unknown;
  timeframe?: unknown;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function safeDefault(input: SignalRequest, reason: string) {
  return {
    ok: true as const,
    signal: "WAIT" as TradingSignal,
    confidence: 1,
    reasonCodes: [reason],
    venue: str(input.venue) ?? "LIMITLESS",
    symbol: str(input.symbol) ?? str(input.marketSlug),
    timeframe: str(input.timeframe),
    timestamp: new Date().toISOString(),
    engine: "djzs-pm-gate-v1",
  };
}

async function computeSignal(input: SignalRequest) {
  const marketSlug = str(input.marketSlug);
  const modelProb = typeof input.modelProb === "number" ? input.modelProb : null;

  // No market connected — preserve original safe behavior.
  if (!marketSlug) return safeDefault(input, "SAFE_DEFAULT_NO_MARKET_FEATURES_CONNECTED");
  if (modelProb === null) return safeDefault(input, "MODEL_PROB_REQUIRED");

  const outcome: Outcome = input.outcome === "NO" ? "NO" : "YES";

  let market, ob;
  try {
    [market, ob] = await Promise.all([getMarket(marketSlug), getOrderbook(marketSlug)]);
  } catch (e) {
    return safeDefault(input, "MARKET_FETCH_FAILED");
  }
  if (market.tradeType !== "clob") return safeDefault(input, "MARKET_NOT_CLOB");

  const { intent, state } = toGateInputs({
    market,
    ob,
    outcome,
    modelProb,
    sizeUsd: num(input.sizeUsd, 50),
    accountEquityUsd: num(input.accountEquityUsd, 0),
    feeBps: num(input.feeBps, 100),
    realizedLossTodayUsd: num(input.realizedLossTodayUsd, 0),
  });

  const verdict = evaluatePMTrade(intent, state);

  return {
    ok: true as const,
    signal: (verdict.decision === "PASS" ? "LONG" : "WAIT") as TradingSignal,
    confidence: 1,
    reasonCodes:
      verdict.decision === "PASS"
        ? ["PASS", `EDGE_${((verdict.edge ?? 0) * 100).toFixed(1)}PTS`]
        : [verdict.failedGate ?? "REJECT"],
    verdict,
    market: { slug: market.slug, title: market.title, outcome, priceProb: intent.priceProb },
    venue: "LIMITLESS",
    symbol: marketSlug,
    timeframe: str(input.timeframe),
    timestamp: new Date().toISOString(),
    engine: "djzs-pm-gate-v1",
  };
}

export function registerSignalRoutes(app: Express) {
  app.post("/api/signal", async (req: any, res: any) => {
    try {
      return res.status(200).json(await computeSignal(req.body ?? {}));
    } catch (e: any) {
      return res.status(200).json(safeDefault(req.body ?? {}, "ENGINE_ERROR"));
    }
  });

  // Fused verdict: thesis audit AND trade-mechanics gate. Forward-eligible only if
  // both PASS. Execution stays stubbed pending creds. Body: { context, modelProb?,
  // engine?, outcome?, sizeUsd?, accountEquityUsd?, feeBps?, anchor? }.
  app.post("/api/signal/verify", async (req: any, res: any) => {
    try {
      const { fuseVerdict } = await import("./pm-fusion");
      const body = req.body ?? {};
      if (!body.context || typeof body.context !== "object") {
        return res.status(400).json({ ok: false, error: "context (PredictionContext) required" });
      }
      return res.status(200).json({ ok: true, ...(await fuseVerdict(body)) });
    } catch (e: any) {
      return res.status(200).json({ ok: false, decision: "BLOCK", reason: "ENGINE_ERROR", detail: String(e?.message ?? e) });
    }
  });

  // NOTE: removed the old `/api/audit` alias here — it shadowed the paid audit
  // endpoint registered in routes.ts. The signal surface owns /api/signal* only.
}
