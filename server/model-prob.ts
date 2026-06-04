// Venice-backed probabilistic layer for the DJZS-PM gate.
// Produces the single non-deterministic input (modelProb) the deterministic
// PM gate consumes. Venice = zero prompt logging + x402/USDC-on-Base native.

const VENICE_BASE_URL = process.env.VENICE_BASE_URL || "https://api.venice.ai/api/v1";
const VENICE_MODEL = process.env.VENICE_MODEL_MODELPROB || "llama-3.3-70b";
const VENICE_TIMEOUT_MS = Number(process.env.VENICE_TIMEOUT_MS || "60000");

export interface ModelProbResult {
  prob: number;
  confidence: "low" | "medium" | "high";
  reasoning: string;
  model: string;
  raw: string;
}

const SYSTEM_PROMPT =
  'You are a calibrated probability estimator for binary prediction markets. ' +
  'Given a market question and any context, estimate the probability the YES outcome resolves true. ' +
  'Be well-calibrated: if uncertain, stay near the market-implied price; only diverge with a concrete reason. ' +
  'Output ONLY valid JSON, no prose, no markdown: ' +
  '{"prob": <number 0..1>, "confidence": "low|medium|high", "reasoning": "<one sentence>"}';

export async function estimateModelProb(args: {
  title: string;
  outcome?: "YES" | "NO";
  marketPriceProb?: number;
  hoursToResolution?: number;
  context?: string;
  apiKey?: string;
}): Promise<ModelProbResult> {
  const key = args.apiKey || process.env.VENICE_API_KEY;
  if (!key) throw new Error("VENICE_API_KEY not set");

  const lines = [`Market: "${args.title}"`];
  if (args.marketPriceProb != null) lines.push(`Current market-implied YES price: ${(args.marketPriceProb * 100).toFixed(1)}%.`);
  if (args.hoursToResolution != null) lines.push(`Time to resolution: ${args.hoursToResolution.toFixed(1)}h.`);
  if (args.context) lines.push(`Context: ${args.context}`);
  lines.push("Estimate the probability this market resolves YES.");
  const user = lines.join(" ");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VENICE_TIMEOUT_MS);
  try {
    const r = await fetch(`${VENICE_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: VENICE_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        max_tokens: 200,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Venice ${r.status}: ${await r.text()}`);
    const d: any = await r.json();
    const raw: string = d.choices?.[0]?.message?.content ?? "";
    const cleaned = raw.trim().replace(/^```json/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned);
    let prob = Number(parsed.prob);
    if (!Number.isFinite(prob)) throw new Error(`Venice returned non-numeric prob: ${raw}`);
    prob = Math.min(0.99, Math.max(0.01, prob));
    const confidence = ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "low";
    return { prob, confidence, reasoning: String(parsed.reasoning ?? "").slice(0, 240), model: d.model || VENICE_MODEL, raw };
  } finally {
    clearTimeout(timer);
  }
}
