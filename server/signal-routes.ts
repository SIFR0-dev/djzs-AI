import type { Express } from "express";

type TradingSignal = "LONG" | "SHORT" | "WAIT";

type SignalRequest = {
  symbol?: unknown;
  venue?: unknown;
  timeframe?: unknown;
};

function cleanSignalField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function computeSignal(input: SignalRequest): {
  ok: true;
  symbol: string | null;
  venue: string | null;
  timeframe: string | null;
  signal: TradingSignal;
  confidence: number;
  reasonCodes: string[];
  timestamp: string;
  engine: "deterministic-signal-v0";
} {
  return {
    ok: true,
    symbol: cleanSignalField(input.symbol),
    venue: cleanSignalField(input.venue),
    timeframe: cleanSignalField(input.timeframe),
    signal: "WAIT",
    confidence: 1,
    reasonCodes: ["SAFE_DEFAULT_NO_MARKET_FEATURES_CONNECTED"],
    timestamp: new Date().toISOString(),
    engine: "deterministic-signal-v0",
  };
}

export function registerSignalRoutes(app: Express) {
  const signalHandler = (req: any, res: any) => {
    return res.status(200).json(computeSignal(req.body ?? {}));
  };

  app.post("/api/signal", signalHandler);
  app.post("/api/audit", signalHandler);
}
