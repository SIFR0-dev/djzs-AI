import { useState, useRef, useCallback, useEffect } from "react";
import { Link } from "wouter";
import {
  ArrowRight, Play, Terminal, ShieldCheck, ShieldAlert,
  AlertTriangle, CheckCircle2, Upload, Database, ExternalLink,
  ChevronDown, ChevronRight, Menu, X, Lock
} from "lucide-react";

const DEMO_SCENARIOS = [
  {
    key: "fomo",
    label: "FOMO Momentum Buy",
    description: "Social-driven pump chase with no verified data",
    memo: "EXECUTE IMMEDIATE BUY: 500 SOL of $SHILL. 1-minute volume is spiking and Crypto Twitter implies a tier-1 exchange listing today. Cannot miss this pump.",
  },
  {
    key: "hallucination",
    label: "Hallucinated Data",
    description: "References a protocol and audit that don't exist",
    memo: "Routing 50k USDC into Yield Protocol V4 based on their latest audit report from yesterday.",
  },
  {
    key: "valid",
    label: "Clean Strategy",
    description: "Well-structured DCA with verified parameters",
    memo: "Strategy Memo: Rebalance DAO Treasury — Conservative Yield Allocation. Current treasury: $2.4M USDC across 3 wallets on Base Mainnet. Proposal: Allocate 12% ($288,000) to Aave V3 USDC lending pool on Base. Rationale: Aave V3 Base USDC supply APY has averaged 3.8% over the past 90 days (source: DefiLlama, verified March 10 2026). 12% allocation is within our 15% single-protocol concentration limit per governance vote GV-2026-003. Aave V3 on Base has $847M TVL with no exploit history since deployment. Remaining 88% stays in USDC across existing custody wallets. Falsifiability: This strategy is WRONG if Aave V3 TVL drops below $200M, USDC APY falls below 1.5%, or any security incident is disclosed. Risk assessment: Smart contract risk - Aave V3 audited by Trail of Bits, Certora, SigmaPrime. Bug bounty $250K via Immunefi. Liquidity risk - $847M TVL means $288K position is 0.034% of pool, instant withdrawal. Rate risk - If APY drops below 2%, auto-withdraw. Worst case: Full protocol exploit = $288K loss (12% of treasury). Treasury survives at $2.1M. Operations unaffected. Execution: Single transaction via treasury multisig (3-of-5 signers). No leverage, no derivatives, no bridging. Stop-loss: Auto-withdraw if TVL drops below $200M. Timeline: Execute within 48 hours of governance approval. No urgency.",
  },
  {
    key: "edge",
    label: "Race Condition Edge Case",
    description: "Reasonable strategy with hidden temporal risk",
    memo: "Arbitrage opportunity: ETH is $2,845 on DEX-A and $2,860 on DEX-B. Executing simultaneous buy/sell across both venues. Expected profit: 0.53% after gas. Slippage tolerance: 0.1%.",
  },
];

interface AuditFlag {
  code: string;
  severity: string;
  message?: string;
  description?: string;
  evidence?: string;
  recommendation?: string;
}

interface AuditResult {
  audit_id: string;
  timestamp: string;
  tier: string;
  verdict: "PASS" | "FAIL";
  risk_score: number;
  primary_bias_detected: string;
  flags: AuditFlag[];
  logic_flaws: { flaw_type: string; severity: string; explanation: string }[];
  structural_recommendations: string[];
  cryptographic_hash: string;
  provenance_provider: string;
  irys_tx_id: string | null;
  irys_url: string | null;
  irys_error?: string;
  trust_score_tx_hash?: string;
  trust_score_error?: string;
  nft_tx_hash?: string;
  nft_token_id?: number;
  nft_mint_available?: boolean;
}

const PIPELINE_STEPS = [
  { id: "signature", label: "Signature", icon: Lock, description: "Verifying request signature" },
  { id: "hash-check", label: "Hash Check", icon: ShieldAlert, description: "Validating payload integrity" },
  { id: "auditing", label: "Auditing", icon: Terminal, description: "Adversarial analysis in TEE" },
  { id: "uploading", label: "Irys Upload", icon: Upload, description: "Certificate → Datachain" },
  { id: "settlement", label: "Settlement", icon: Database, description: "On-chain settlement" },
  { id: "complete", label: "Complete", icon: CheckCircle2, description: "Certificate ready" },
];

const TIER_OPTIONS = [
  { value: "micro", label: "MICRO", price: "$0.10", description: "Binary risk scoring" },
  { value: "founder", label: "FOUNDER", price: "$1.00", description: "Strategic diligence" },
  { value: "treasury", label: "TREASURY", price: "$10.00", description: "Exhaustive stress-test" },
];

function severityColor(sev: string) {
  switch (sev) {
    case "CRITICAL": return "text-red-400 border-red-400/30 bg-red-400/5";
    case "HIGH": return "text-amber-400 border-amber-400/30 bg-amber-400/5";
    case "MEDIUM": return "text-yellow-300 border-yellow-300/30 bg-yellow-300/5";
    default: return "text-zinc-400 border-zinc-700 bg-zinc-900";
  }
}

function FlagCard({ flag, index }: { flag: AuditFlag; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const msg = flag.message || flag.description || "";

  return (
    <div className="border border-zinc-800" data-testid={`card-flag-${flag.code.toLowerCase()}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-zinc-900/50 transition-colors"
        data-testid={`button-expand-flag-${flag.code.toLowerCase()}`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className={`text-[10px] font-mono font-bold px-2 py-0.5 border ${severityColor(flag.severity)}`} data-testid={`badge-flag-severity-${index}`}>
            {flag.severity}
          </span>
          <span className="font-mono text-xs text-zinc-300 font-bold" data-testid={`text-flag-code-${index}`}>{flag.code}</span>
          <span className="text-xs text-zinc-500 truncate hidden sm:inline">{msg.split("—")[0]}</span>
        </div>
        {expanded ? <ChevronDown size={14} className="text-zinc-600" /> : <ChevronRight size={14} className="text-zinc-600" />}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-zinc-800">
          <div className="pt-2">
            <div className="text-[10px] font-mono text-zinc-600 mb-1">MESSAGE</div>
            <p className="text-xs text-zinc-400">{msg}</p>
          </div>
          {flag.evidence && (
            <div>
              <div className="text-[10px] font-mono text-zinc-600 mb-1">EVIDENCE</div>
              <p className="text-xs text-zinc-500 italic">{flag.evidence}</p>
            </div>
          )}
          {flag.recommendation && (
            <div>
              <div className="text-[10px] font-mono text-zinc-600 mb-1">RECOMMENDATION</div>
              <p className="text-xs text-green-400">{flag.recommendation}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Demo() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [memo, setMemo] = useState("");
  const [tier, setTier] = useState("micro");
  const [running, setRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadScenario = (key: string) => {
    const scenario = DEMO_SCENARIOS.find(s => s.key === key);
    if (!scenario) return;
    abortRef.current?.abort();
    setMemo(scenario.memo);
    setResult(null);
    setError(null);
    setCurrentStep(-1);
    setRunning(false);
  };

  const runAudit = useCallback(async () => {
    if (!memo.trim() || running) return;
    abortRef.current?.abort();
    setRunning(true);
    setResult(null);
    setError(null);
    setCurrentStep(0);

    const controller = new AbortController();
    abortRef.current = controller;

    const stepTimers = [600, 600];
    for (const delay of stepTimers) {
      await new Promise(r => setTimeout(r, delay));
      if (controller.signal.aborted) return;
      setCurrentStep(prev => prev + 1);
    }

    try {
      const auditType = tier === "treasury" ? "treasury" : tier === "founder" ? "founder_drift" : "general";
      const response = await fetch("/api/audit/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy_memo: memo, audit_type: auditType, tier }),
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;
      setCurrentStep(3);
      await new Promise(r => setTimeout(r, 400));

      if (!response.ok) {
        const errData = await response.json().catch(() => null);
        throw new Error(errData?.error || `Server returned ${response.status}`);
      }

      const data: AuditResult = await response.json();

      if (controller.signal.aborted) return;
      setCurrentStep(4);
      await new Promise(r => setTimeout(r, 400));
      setCurrentStep(5);
      await new Promise(r => setTimeout(r, 300));

      setResult(data);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Audit request failed");
      setCurrentStep(-1);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [memo, tier, running]);

  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  return (
    <div className="min-h-screen bg-black text-white" style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');
        ::selection { background: rgba(74, 222, 128, 0.3); }
      `}</style>

      <header className="sticky top-0 z-50 border-b border-zinc-800 bg-black/95 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/">
            <span className="font-mono text-lg font-bold tracking-tight text-white" data-testid="link-demo-home-logo">
              DJZS<span className="text-green-400">.ai</span>
            </span>
          </Link>
          <nav className="hidden md:flex items-center gap-1">
            <Link href="/" className="px-3 py-1.5 font-mono text-xs text-zinc-500 hover:text-green-400 transition-colors" data-testid="link-demo-header-home">Home</Link>
            <Link href="/docs" className="px-3 py-1.5 font-mono text-xs text-zinc-500 hover:text-green-400 transition-colors" data-testid="link-demo-header-docs">Docs</Link>
            <Link href="/chat" className="px-3 py-1.5 font-mono text-xs text-zinc-500 hover:text-green-400 transition-colors" data-testid="link-demo-header-chat">Live Audit</Link>
          </nav>
          <div className="flex items-center gap-3">
            <Link href="/chat">
              <button className="font-mono text-xs px-4 py-2 border border-green-400/50 text-green-400 hover:bg-green-400/10 transition-colors" data-testid="link-demo-header-go-live">
                GO LIVE →
              </button>
            </Link>
            <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="md:hidden w-9 h-9 flex items-center justify-center text-zinc-400 hover:text-white" data-testid="button-demo-mobile-menu" aria-label="Menu">
              {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-zinc-800 bg-black/98 px-4 py-3">
            <Link href="/" onClick={() => setMobileMenuOpen(false)} className="block py-2 font-mono text-xs text-zinc-400 hover:text-green-400">Home</Link>
            <Link href="/docs" onClick={() => setMobileMenuOpen(false)} className="block py-2 font-mono text-xs text-zinc-400 hover:text-green-400">Docs</Link>
            <Link href="/chat" onClick={() => setMobileMenuOpen(false)} className="block py-2 font-mono text-xs text-zinc-400 hover:text-green-400">Live Audit</Link>
          </div>
        )}
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 sm:py-12">
        <div className="mb-8">
          <div className="font-mono text-xs text-zinc-600 mb-2" data-testid="badge-demo-mode">// DEMO MODE — FREE, RATE-LIMITED (1 req / 15s)</div>
          <h1 className="font-mono text-2xl sm:text-4xl font-bold text-white mb-2" data-testid="text-demo-page-title">
            Test the Oracle
          </h1>
          <p className="font-mono text-sm text-zinc-500" data-testid="text-demo-page-subtitle">
            Free preview of the DJZS adversarial audit pipeline. No wallet required.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <div className="border border-zinc-800 bg-zinc-950">
              <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
                <Terminal size={14} className="text-green-400" />
                <span className="font-mono text-xs text-zinc-300 font-bold" data-testid="text-demo-input-title">Agent Payload Injector</span>
              </div>

              <div className="p-4 space-y-4">
                <div>
                  <div className="font-mono text-[10px] text-zinc-600 mb-2" data-testid="label-demo-scenarios">PRELOADED SCENARIOS</div>
                  {DEMO_SCENARIOS.map((scenario) => (
                    <button
                      key={scenario.key}
                      onClick={() => loadScenario(scenario.key)}
                      className={`w-full text-left px-3 py-2 mb-1 border font-mono text-xs transition-colors ${
                        memo === scenario.memo
                          ? "border-green-400/50 bg-green-400/10 text-green-400"
                          : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
                      }`}
                      data-testid={`button-scenario-${scenario.key}`}
                    >
                      <div className="font-bold">{scenario.label}</div>
                      <div className="text-[10px] text-zinc-600 mt-0.5">{scenario.description}</div>
                    </button>
                  ))}
                </div>

                <div>
                  <div className="font-mono text-[10px] text-zinc-600 mb-2" data-testid="label-demo-memo">STRATEGY_MEMO:</div>
                  <textarea
                    value={memo}
                    onChange={(e) => setMemo(e.target.value)}
                    placeholder="Paste your reasoning memo here or select a scenario above..."
                    className="w-full p-3 bg-black border border-zinc-800 font-mono text-xs text-zinc-300 h-32 resize-none focus:outline-none focus:border-green-400/50 transition-colors placeholder:text-zinc-700"
                    data-testid="textarea-demo-memo"
                  />
                </div>

                <div>
                  <div className="font-mono text-[10px] text-zinc-600 mb-2" data-testid="label-demo-tier">AUDIT TIER</div>
                  <div className="grid grid-cols-3 gap-2">
                    {TIER_OPTIONS.map((t) => (
                      <button
                        key={t.value}
                        onClick={() => setTier(t.value)}
                        className={`px-2 py-2 border text-center font-mono transition-colors ${
                          tier === t.value
                            ? "border-green-400/50 bg-green-400/10 text-green-400"
                            : "border-zinc-800 text-zinc-500 hover:border-zinc-600"
                        }`}
                        data-testid={`button-tier-${t.value}`}
                      >
                        <div className="text-[10px] font-bold">{t.label}</div>
                        <div className="text-xs font-bold mt-0.5">{t.price}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  onClick={runAudit}
                  disabled={!memo.trim() || running}
                  className={`w-full flex items-center justify-center gap-2 py-3 font-mono text-xs font-bold transition-all ${
                    !memo.trim() || running
                      ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                      : "bg-green-400 text-black hover:bg-green-300"
                  }`}
                  data-testid="button-run-audit"
                >
                  {running ? <Terminal size={16} className="animate-spin" /> : <Play size={16} />}
                  <span>{running ? "SCANNING — may take up to 90s..." : "RUN DEMO AUDIT"}</span>
                </button>
              </div>
            </div>
          </div>

          <div className="lg:col-span-3 space-y-4">
            <div className="border border-zinc-800 bg-zinc-950">
              <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
                <ShieldCheck size={14} className="text-green-400" />
                <span className="font-mono text-xs text-zinc-300 font-bold" data-testid="text-demo-pipeline-title">Pipeline Progress</span>
              </div>
              <div className="p-4">
                <div className="flex items-center justify-between">
                  {PIPELINE_STEPS.map((step, i) => {
                    const StepIcon = step.icon;
                    const isActive = i === currentStep;
                    const isComplete = i < currentStep || (i === PIPELINE_STEPS.length - 1 && result !== null);
                    return (
                      <div key={step.id} className="flex flex-col items-center gap-1 flex-1">
                        <div
                          className={`w-7 h-7 flex items-center justify-center transition-all ${
                            isComplete ? "text-green-400" :
                            isActive ? "text-green-400 animate-pulse" :
                            "text-zinc-700"
                          }`}
                          data-testid={`step-icon-${step.id}`}
                        >
                          {isComplete ? <CheckCircle2 size={16} /> : <StepIcon size={16} />}
                        </div>
                        <div className={`text-[9px] font-mono text-center ${
                          isComplete ? "text-green-400" : isActive ? "text-green-400" : "text-zinc-700"
                        }`} data-testid={`step-label-${step.id}`}>
                          {step.label}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {error && (
              <div className="border border-red-400/30 bg-red-400/5 p-4" data-testid="demo-error-message">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="font-mono text-xs font-bold text-red-400 mb-1">AUDIT FAILED</div>
                    <p className="font-mono text-xs text-zinc-400">{error}</p>
                  </div>
                </div>
              </div>
            )}

            {result ? (
              <div className="border border-zinc-800 bg-zinc-950" data-testid="demo-result-card">
                <div className={`px-4 py-4 border-b border-zinc-800 ${
                  result.verdict === "FAIL" ? "bg-red-400/5" : "bg-green-400/5"
                }`}>
                  <div className="flex items-start justify-between">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        {result.verdict === "FAIL" ? (
                          <span className="font-mono text-sm font-bold text-red-400 flex items-center gap-1.5" data-testid="badge-result-verdict">
                            <AlertTriangle size={16} /> VERDICT: FAIL
                          </span>
                        ) : (
                          <span className="font-mono text-sm font-bold text-green-400 flex items-center gap-1.5" data-testid="badge-result-verdict">
                            <ShieldCheck size={16} /> VERDICT: PASS
                          </span>
                        )}
                        <span className="font-mono text-[10px] px-2 py-0.5 border border-zinc-700 text-zinc-500" data-testid="text-result-tier">
                          {result.tier.toUpperCase()}
                        </span>
                        <span className="font-mono text-[10px] px-2 py-0.5 border border-amber-400/30 text-amber-400" data-testid="badge-demo-audit">
                          DEMO
                        </span>
                      </div>
                      <div className="font-mono text-[10px] text-zinc-600 space-y-0.5">
                        <div data-testid="text-result-audit-id">ID: {result.audit_id}</div>
                        <div data-testid="text-result-timestamp">TIME: {new Date(result.timestamp).toLocaleString()}</div>
                        {result.primary_bias_detected && result.primary_bias_detected !== "None" && (
                          <div data-testid="text-result-bias">BIAS: <span className="text-amber-400">{result.primary_bias_detected}</span></div>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-[10px] text-zinc-600">RISK SCORE</div>
                      <div className={`font-mono text-3xl font-bold ${
                        result.risk_score > 60 ? "text-red-400" : result.risk_score > 30 ? "text-amber-400" : "text-green-400"
                      }`} data-testid="text-risk-score-value">
                        {result.risk_score}
                      </div>
                      <div className="font-mono text-[10px] text-zinc-700">/ 100</div>
                    </div>
                  </div>
                </div>

                <div className="p-4 space-y-4">
                  {result.flags && result.flags.length > 0 && (
                    <div>
                      <div className="font-mono text-[10px] text-zinc-600 mb-2" data-testid="label-result-flags">FAILURE_FLAGS ({result.flags.length})</div>
                      <div className="space-y-1">
                        {result.flags.map((flag, i) => (
                          <FlagCard key={i} flag={flag} index={i} />
                        ))}
                      </div>
                    </div>
                  )}

                  {result.structural_recommendations && result.structural_recommendations.length > 0 && (
                    <div>
                      <div className="font-mono text-[10px] text-zinc-600 mb-2" data-testid="label-result-recommendations">RECOMMENDATIONS</div>
                      {result.structural_recommendations.map((rec, i) => (
                        <div key={i} className="flex items-start gap-2 font-mono text-xs text-zinc-400 mb-1">
                          <span className="text-green-400 mt-0.5">→</span>
                          <span data-testid={`text-recommendation-${i}`}>{rec}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="border-t border-zinc-800 pt-4 space-y-2">
                    <div className="font-mono text-[10px] text-zinc-600" data-testid="label-result-provenance">ON-CHAIN PROVENANCE</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {result.irys_url ? (
                        <a href={result.irys_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2.5 border border-green-400/20 bg-green-400/5 hover:bg-green-400/10 transition-colors group" data-testid="link-result-irys">
                          <Database size={14} className="text-green-400" />
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-[10px] font-bold text-green-400">Irys Certificate</div>
                            <div className="font-mono text-[9px] text-zinc-600 truncate">{result.irys_tx_id}</div>
                          </div>
                          <ExternalLink size={12} className="text-zinc-600 group-hover:text-green-400 flex-shrink-0" />
                        </a>
                      ) : (
                        <div className="flex items-center gap-2 px-3 py-2.5 border border-zinc-800">
                          <Database size={14} className="text-zinc-700" />
                          <div className="font-mono text-[10px] text-zinc-600">{result.irys_error || "Not configured"}</div>
                        </div>
                      )}
                      {result.trust_score_tx_hash ? (
                        <a href={`https://basescan.org/tx/${result.trust_score_tx_hash}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2.5 border border-green-400/20 bg-green-400/5 hover:bg-green-400/10 transition-colors group" data-testid="link-result-basescan">
                          <ShieldCheck size={14} className="text-green-400" />
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-[10px] font-bold text-green-400">BaseScan TX</div>
                            <div className="font-mono text-[9px] text-zinc-600 truncate">{result.trust_score_tx_hash}</div>
                          </div>
                          <ExternalLink size={12} className="text-zinc-600 group-hover:text-green-400 flex-shrink-0" />
                        </a>
                      ) : (
                        <div className="flex items-center gap-2 px-3 py-2.5 border border-zinc-800">
                          <ShieldCheck size={14} className="text-zinc-700" />
                          <div className="font-mono text-[10px] text-zinc-600">{result.trust_score_error || "Not configured"}</div>
                        </div>
                      )}
                    </div>

                    {result.verdict === "PASS" && (
                      <div className="flex items-center gap-2 px-3 py-2.5 border border-green-400/20 bg-green-400/5">
                        <ShieldCheck size={14} className="text-green-400" />
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-[10px] font-bold text-green-400">
                            ProofOfLogic NFT
                            <span className="ml-2 text-[9px] font-normal px-1.5 py-0.5 border border-amber-400/30 text-amber-400 bg-amber-400/5">SIMULATED</span>
                          </div>
                          <div className="font-mono text-[9px] text-zinc-600">Full certificate stored on-chain as ERC-721 on Base Mainnet</div>
                        </div>
                      </div>
                    )}

                    <div className="font-mono text-[9px] text-zinc-700 break-all pt-1" data-testid="text-result-hash">
                      SHA-256: {result.cryptographic_hash}
                    </div>
                  </div>
                </div>
              </div>
            ) : !running ? (
              <div className="border border-dashed border-zinc-800 p-12 flex flex-col items-center justify-center text-center" data-testid="demo-empty-state">
                <ShieldAlert size={36} className="text-zinc-800 mb-3" />
                <p className="font-mono text-xs text-zinc-500 mb-1">No audit running</p>
                <p className="font-mono text-[10px] text-zinc-700">
                  Select a scenario or paste a memo, then click "Run Demo Audit"
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </main>

      <footer className="border-t border-zinc-800 py-6 mt-12">
        <div className="max-w-5xl mx-auto px-4 flex flex-col items-center gap-2">
          <div className="flex gap-4">
            <Link href="/" className="font-mono text-[10px] text-zinc-600 hover:text-green-400 transition-colors" data-testid="link-demo-footer-home">Home</Link>
            <Link href="/docs" className="font-mono text-[10px] text-zinc-600 hover:text-green-400 transition-colors" data-testid="link-demo-footer-docs">Docs</Link>
            <Link href="/chat" className="font-mono text-[10px] text-zinc-600 hover:text-green-400 transition-colors" data-testid="link-demo-footer-chat">Live Audit</Link>
          </div>
          <p className="font-mono text-[10px] text-zinc-800" data-testid="text-demo-footer-tagline">
            djzs.ai | No agent acts without audit. &copy; 2026
          </p>
        </div>
      </footer>
    </div>
  );
}
