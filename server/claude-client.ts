import { ALL_LF_CODES, LOGIC_FAILURE_TAXONOMY, MAX_RISK_SCORE } from "@shared/audit-schema";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = "claude-sonnet-4-6";

export function shouldUseClaude(): boolean {
  return !!ANTHROPIC_API_KEY;
}

export interface ClaudeAuditResult {
  verdict: "PASS" | "FAIL";
  risk_score: number;
  primary_flaw: string;
  summary: string;
  flags: {
    code: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
    evidence: string;
    recommendation: string;
  }[];
  model_used: string;
}

export interface ClaudeAuditClient {
  audit(strategyMemo: string, tier: string): Promise<ClaudeAuditResult>;
}

const taxonomyRef = ALL_LF_CODES.map(code => {
  const def = LOGIC_FAILURE_TAXONOMY[code];
  return `${code} (${def.name}, weight=${def.weight}, severity=${def.severity}): ${def.description}`;
}).join("\n");

const SYSTEM_PROMPT = `You are DJZS Logic Auditor — an adversarial AI that detects reasoning flaws in financial strategy memos.

You apply the DJZS-LF v1.1 taxonomy. FAIL threshold: risk_score >= 60 OR any CRITICAL flag.

Taxonomy codes:
${taxonomyRef}

FIRING DISCIPLINE — this is the most important instruction:
- Fire a flag ONLY when the memo contains specific, quotable evidence for that exact failure. If you are inferring, speculating, or the evidence is weak, DO NOT fire it.
- Every flag's "evidence" field MUST quote the specific phrase from the memo that triggers it. No quotable phrase means no flag.
- Prefer the FEWEST flags that capture the real failures — typically 1 to 3. Do not enumerate every conceivable flaw. A long flag list is a FAILURE of precision, not thoroughness.
- A well-constructed memo with bounded risk should fire ZERO or very few flags.

DO NOT over-fire these common false positives:
- A normal market price reference (e.g. "ETH at $3,200") is NOT by itself ORACLE_UNVERIFIED, STALE_REFERENCE, or DATA_UNVERIFIED.
- HOWEVER, you MUST fire ORACLE_UNVERIFIED / DATA_UNVERIFIED when the memo's thesis relies on a data source it admits is unsourced, unverified, or lacking provenance (e.g. "a dashboard I found", "no source link or timestamp"). You MUST fire DEPENDENCY_GHOST when the memo depends on a system/signal it admits is unreachable, unavailable, or has no fallback (e.g. "AlphaOracle is not reachable, no fallback"). An admitted bad/missing data dependency is a REAL failure, not a false positive.
- Leverage alone is NOT EXECUTION_UNBOUND if the memo defines a stop-loss or invalidation condition.
- A standard technical indicator reference is not a flaw unless the reasoning misuses it.

Rules:
- Evaluate the memo against all codes, but apply the firing discipline above strictly.
- Return ONLY valid JSON with: verdict, primary_flaw, summary, flags (array of {code, severity, evidence, recommendation}).
- Each flag.code MUST be the full code including the "DJZS-" prefix (e.g. "DJZS-S01"), never the short form or the name.
- DO NOT state, estimate, or mention any numeric risk score anywhere in the summary or evidence text. The server computes the authoritative score from your flags. Your job is to detect flags with evidence, not to do arithmetic.
- The summary should describe the key failures in plain prose, naming the most important flaw first.`;

class ClaudeClient implements ClaudeAuditClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async audit(strategyMemo: string, tier: string): Promise<ClaudeAuditResult> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `<strategy_memo>\n${strategyMemo}\n</strategy_memo>\n\nTier: ${tier}. Analyze this strategy memo for logic failures. Return JSON only.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Claude did not return valid JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validCodes = new Set(ALL_LF_CODES as string[]);
    const flags = Array.isArray(parsed.flags)
      ? parsed.flags.filter((f: { code?: string }) => f.code && validCodes.has(f.code))
      : [];

    // DETERMINISTIC SCORING — the server decides, never the LLM.
    // Recompute risk_score and verdict from the canonical flag weights.
    // The LLM's self-reported risk_score and verdict are intentionally ignored.
    const riskScore = flags.reduce((sum: number, f: { code: string }) => {
      const def = LOGIC_FAILURE_TAXONOMY[f.code as keyof typeof LOGIC_FAILURE_TAXONOMY];
      return sum + (def?.weight ?? 0);
    }, 0);
    const hasCritical = flags.some((f: { code: string }) =>
      LOGIC_FAILURE_TAXONOMY[f.code as keyof typeof LOGIC_FAILURE_TAXONOMY]?.severity === "CRITICAL"
    );
    const verdict: "PASS" | "FAIL" = (riskScore >= 60 || hasCritical) ? "FAIL" : "PASS";

    return {
      verdict,
      risk_score: Math.min(riskScore, MAX_RISK_SCORE),
      primary_flaw: parsed.primary_flaw || (flags[0]?.code ?? "None"),
      summary: parsed.summary || "",
      flags,
      model_used: CLAUDE_MODEL,
    };
  }
}

let cachedClient: ClaudeAuditClient | null = null;

export function getClaudeAuditClient(): ClaudeAuditClient {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  if (!cachedClient) {
    cachedClient = new ClaudeClient(ANTHROPIC_API_KEY);
  }
  return cachedClient;
}


export async function callClaudeText(prompt: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Claude API error ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  return data.content?.[0]?.text ?? "";
}
