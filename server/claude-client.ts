import { ALL_LF_CODES, LOGIC_FAILURE_TAXONOMY, MAX_RISK_SCORE } from "@shared/audit-schema";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = "claude-sonnet-4-20250514";

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

const CODE_LOOKUP = new Map<string, string>();
for (const code of ALL_LF_CODES) {
  const def = LOGIC_FAILURE_TAXONOMY[code];
  CODE_LOOKUP.set(code.toUpperCase(), code);
  CODE_LOOKUP.set(code.replace(/^DJZS-/i, "").toUpperCase(), code);
  CODE_LOOKUP.set(def.name.toUpperCase(), code);
}
function canonicalizeCode(raw: string): string | null {
  if (!raw) return null;
  return CODE_LOOKUP.get(raw.trim().toUpperCase()) ?? null;
}

const SYSTEM_PROMPT = `You are DJZS Logic Auditor — an adversarial AI that detects reasoning flaws in financial strategy memos.

You apply the DJZS-LF v1.1 taxonomy. Max score: ${MAX_RISK_SCORE}. FAIL threshold: risk_score >= 60 OR any CRITICAL flag.

Taxonomy codes:
${taxonomyRef}

Rules:
- Evaluate the strategy memo against ALL codes above
- risk_score = sum of weights for detected flags (0-${MAX_RISK_SCORE})
- verdict: "FAIL" if risk_score >= 60 OR any CRITICAL flag; "PASS" otherwise
- Return ONLY valid JSON with: verdict, risk_score, primary_flaw, summary, flags (array of {code, severity, evidence, recommendation})
- Each flag.code must be a valid DJZS-LF code from the taxonomy above
- Each flag.code MUST be the full code including the "DJZS-" prefix (e.g. "DJZS-S01"), never the short form or the name`;

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
    const rawFlags = Array.isArray(parsed.flags) ? parsed.flags : [];
    const flags = rawFlags
      .map((f: any) => {
        const code = canonicalizeCode(f?.code ?? "");
        if (!code) return null;
        const def = LOGIC_FAILURE_TAXONOMY[code as keyof typeof LOGIC_FAILURE_TAXONOMY];
        return {
          code,
          severity: def.severity,
          evidence: f?.evidence ?? "",
          recommendation: f?.recommendation ?? "",
        };
      })
      .filter((f: any): f is NonNullable<typeof f> => f !== null);

    // Deterministic scoring from canonical flags — never trust the LLM's math
    const riskScore = flags.reduce(
      (sum: number, f: any) => sum + LOGIC_FAILURE_TAXONOMY[f.code as keyof typeof LOGIC_FAILURE_TAXONOMY].weight,
      0
    );
    const hasCritical = flags.some((f: any) => f.severity === "CRITICAL");
    const verdict: "PASS" | "FAIL" = (riskScore >= 60 || hasCritical) ? "FAIL" : "PASS";

    return {
      verdict,
      risk_score: riskScore,
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
