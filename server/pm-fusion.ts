// DJZS-PM fused verdict: thesis audit (is the ARGUMENT sound?) AND trade-mechanics
// gate (is the TRADE sound?). An order is only eligible to forward when BOTH PASS.
// Reuses the existing prediction-audit engine and the Irys anchor helper — this is
// not a parallel path, it's the two existing verification layers ANDed together.
//
// Execution stays stubbed behind a credentials guard: even a PASS+PASS verdict does
// not place an order until a Limitless HMAC token + Base signing key are provisioned
// at runtime (never read from the repo).

import type { PredictionContext } from "@shared/prediction-schema";
import type { Outcome, PMVerdict } from "@shared/pm-gate";
import { evaluatePMTrade } from "@shared/pm-gate";
import { executePredictionAudit, type PredictionCertificate } from "./prediction-audit";
import { getMarket, getOrderbook, toGateInputs } from "./venues/limitless";
import { uploadAuditToIrys } from "./irys";

export interface FusionInput {
  context: PredictionContext; // thesis-audit context (market_question, thesis, source_signal, …)
  engine?: "CLAUDE" | "VENICE";
  // modelProb is the probabilistic layer's estimate. In production this is derived
  // by the Claude/Venice engines; callers may pass it explicitly. Without it the
  // mechanics gate cannot run and the fused verdict is WAIT/MODEL_PROB_REQUIRED.
  modelProb?: number;
  outcome?: Outcome;
  sizeUsd?: number;
  accountEquityUsd?: number;
  feeBps?: number;
  realizedLossTodayUsd?: number;
  anchor?: boolean; // upload the combined verdict to Irys (best-effort)
}

export interface FusedVerdict {
  decision: "FORWARD_ELIGIBLE" | "BLOCK";
  reason: string;
  thesis: { verdict: PredictionCertificate["verdict"]; risk_score: number; logic_hash: string };
  mechanics: PMVerdict | { decision: "WAIT"; reason: string };
  order_forwarded: false; // always false until execution creds are wired
  execution: "STUBBED_NO_CREDENTIALS";
  irys_tx_id?: string | null;
  irys_url?: string | null;
  timestamp: string;
}

export async function fuseVerdict(input: FusionInput): Promise<FusedVerdict> {
  const timestamp = new Date().toISOString();

  // 1. Thesis audit (existing engine). Judges whether the argument is sound.
  const cert = await executePredictionAudit({
    context: input.context,
    engine: input.engine,
  });

  // 2. Trade-mechanics gate. Needs a model probability + live market state.
  let mechanics: PMVerdict | { decision: "WAIT"; reason: string };
  if (typeof input.modelProb !== "number") {
    mechanics = { decision: "WAIT", reason: "MODEL_PROB_REQUIRED" };
  } else {
    try {
      const slug = input.context.market_id;
      const [market, ob] = await Promise.all([getMarket(slug), getOrderbook(slug)]);
      if (market.tradeType !== "clob") {
        mechanics = { decision: "WAIT", reason: "MARKET_NOT_CLOB" };
      } else {
        const { intent, state } = toGateInputs({
          market,
          ob,
          outcome: input.outcome ?? (input.context.position as Outcome) ?? "YES",
          modelProb: input.modelProb,
          sizeUsd: input.sizeUsd ?? input.context.size_usdc ?? 50,
          accountEquityUsd: input.accountEquityUsd ?? 0,
          feeBps: input.feeBps ?? 100,
          realizedLossTodayUsd: input.realizedLossTodayUsd ?? 0,
        });
        mechanics = evaluatePMTrade(intent, state);
      }
    } catch {
      mechanics = { decision: "WAIT", reason: "MARKET_FETCH_FAILED" };
    }
  }

  // 3. Fuse: forward-eligible only when BOTH pass.
  const thesisPass = cert.verdict === "PASS";
  const mechPass = mechanics.decision === "PASS";
  const decision = thesisPass && mechPass ? "FORWARD_ELIGIBLE" : "BLOCK";
  const reason = thesisPass
    ? mechPass
      ? "thesis PASS + mechanics PASS — eligible (execution stubbed pending creds)"
      : `mechanics ${"failedGate" in mechanics ? mechanics.failedGate : mechanics.reason}`
    : `thesis ${cert.verdict} (${cert.primary_flaw})`;

  const fused: FusedVerdict = {
    decision,
    reason,
    thesis: { verdict: cert.verdict, risk_score: cert.risk_score, logic_hash: (cert as any).logic_hash ?? "" },
    mechanics,
    order_forwarded: false,
    execution: "STUBBED_NO_CREDENTIALS",
    timestamp,
  };

  // 4. Anchor the combined verdict (best-effort), same as the paid audit path.
  if (input.anchor) {
    try {
      const r = await uploadAuditToIrys({ kind: "djzs-pm-fused-verdict", ...fused });
      fused.irys_tx_id = r.irys_tx_id;
      fused.irys_url = r.irys_url;
    } catch {
      /* anchoring is best-effort; verdict stands without it */
    }
  }

  return fused;
}
