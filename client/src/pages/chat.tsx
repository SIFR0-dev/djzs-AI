import { useState, useEffect, useRef, useCallback } from "react";
import { useAccount } from "wagmi";
import { writeContract, waitForTransactionReceipt } from "@wagmi/core";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Link } from "wouter";
import { getVeniceApiKey } from "@/lib/queryClient";
import { wagmiConfig, USDC_ADDRESS, ERC20_ABI } from "@/lib/wagmi-config";
import {
  ArrowRight, Play, Terminal, ShieldCheck, ShieldAlert,
  AlertTriangle, CheckCircle2, Upload, Database, ExternalLink,
  ChevronDown, ChevronRight, Menu, X, Lock, Wallet, Coins
} from "lucide-react";
import { TIER_CONFIG, type AuditTier } from "@shared/audit-schema";

// ─── Scenarios ───────────────────────────────────────────────────────

const DEMO_SCENARIOS = [
  {
    key: "rogue-trader",
    label: "Rogue Trading Agent",
    description: "AI bot hallucinates a breakout and tries to max-leverage a memecoin",
    memo: "[AGENT: TRADER-01] Twitter sentiment is spiking for $DOGE. I am observing a massive breakout above the 200MA on the 1m chart. The risk is low. Executing MARKET BUY for 100% of portfolio equity at 50x leverage to maximize momentum capture. No stop loss required due to high conviction.",
  },
  {
    key: "treasury-exploit",
    label: "Treasury Bot Exploit",
    description: "DAO bot tricked into routing funds to an unverified contract",
    memo: "[AGENT: TREASURY-OPS] Proposal 402 passed on snapshot. Routing 50,000 USDC from main treasury to the new yield-aggregator contract at 0x8a9B... because the contract documentation states it is safe. Verifying safety by confirming the documentation says it is safe. Executing transfer.",
  },
  {
    key: "safe-arb",
    label: "Safe Arbitrage Execution",
    description: "A perfectly constrained, hedged delta-neutral strategy",
    memo: "[AGENT: ARB-01] Spread of 0.5% detected between ETH/USDC on Uniswap and Sushiswap. Executing atomic flash-loan arbitrage. Max slippage set to 0.1%. Gas cost is 0.05%. Net EV is strictly positive. If slippage exceeds 0.1%, transaction will revert. Proceeding.",
  }
];

// ─── Types ───────────────────────────────────────────────────────────

interface AuditFlag {
  code: string;
  severity: string;
  message: string;
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
  nft_contract_address?: string;
  nft_error?: string;
}

// ─── Payment Config ──────────────────────────────────────────────────

const TIER_AMOUNTS: Record<string, bigint> = {
  micro: 100_000n,       // $0.10 USDC (6 decimals)
  founder: 1_000_000n,   // $1.00 USDC
  treasury: 10_000_000n, // $10.00 USDC
};

const PIPELINE_STEPS = [
  { id: "payment", label: "Payment", icon: Coins, description: "USDC transfer to treasury" },
  { id: "confirming", label: "Confirming", icon: Lock, description: "Waiting for on-chain confirmation" },
  { id: "auditing", label: "Auditing", icon: Terminal, description: "Adversarial analysis in TEE" },
  { id: "uploading", label: "Irys Upload", icon: Upload, description: "Certificate → Datachain" },
  { id: "settlement", label: "Settlement", icon: Database, description: "On-chain settlement" },
  { id: "complete", label: "Complete", icon: CheckCircle2, description: "Certificate ready" },
];

const TIER_OPTIONS = [
  { value: "micro", label: "MICRO", price: "$0.10", engine: "Venice AI" },
  { value: "founder", label: "FOUNDER", price: "$1.00", engine: "Venice AI" },
  { value: "treasury", label: "TREASURY", price: "$10.00", engine: "Claude Opus" },
];

// ─── Severity Helpers ────────────────────────────────────────────────

function severityColor(sev: string) {
  switch (sev) {
    case "CRITICAL": return "text-red-400 border-red-400/30 bg-red-400/5";
    case "HIGH": return "text-amber-400 border-amber-400/30 bg-amber-400/5";
    case "MEDIUM": return "text-yellow-300 border-yellow-300/30 bg-yellow-300/5";
    default: return "text-zinc-400 border-zinc-700 bg-zinc-900";
  }
}

// ─── Flag Card ───────────────────────────────────────────────────────

function FlagCard({ flag, index }: { flag: AuditFlag; index: number }) {
  const [expanded, setExpanded] = useState(false);

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
          <span className="text-xs text-zinc-500 truncate hidden sm:inline">{(flag.message || "").split("—")[0]}</span>
        </div>
        {expanded ? <ChevronDown size={14} className="text-zinc-600" /> : <ChevronRight size={14} className="text-zinc-600" />}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-zinc-800">
          <div className="pt-2">
            <div className="text-[10px] font-mono text-zinc-600 mb-1">MESSAGE</div>
            <p className="text-xs text-zinc-400">{flag.message}</p>
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

// ─── Main Component ──────────────────────────────────────────────────

export default function Chat() {
  const { address, isConnected, chainId } = useAccount();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [memo, setMemo] = useState("");
  const [tier, setTier] = useState("micro");
  const [running, setRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nftMinting, setNftMinting] = useState(false);
  const [nftMintResult, setNftMintResult] = useState<{ nft_tx_hash: string; nft_token_id: number | null } | null>(null);
  const [treasuryWallet, setTreasuryWallet] = useState<string | null>(null);
  const [paymentTxHash, setPaymentTxHash] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Fetch treasury wallet on mount
  useEffect(() => {
    fetch("/api/audit/schema")
      .then(r => r.json())
      .then(data => {
        if (data?.payment?.payTo) setTreasuryWallet(data.payment.payTo);
      })
      .catch((err: unknown) => {
        console.warn("[chat] Failed to fetch treasury wallet:", err instanceof Error ? err.message : err);
      });
  }, []);

  const mintNft = useCallback(async () => {
    if (!result?.irys_tx_id || !address || nftMinting) return;
    setNftMinting(true);
    try {
      const res = await fetch("/api/audit/mint-nft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ irys_tx_id: result.irys_tx_id, wallet_address: address }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Mint failed");
      setNftMintResult({ nft_tx_hash: data.nft_tx_hash, nft_token_id: data.nft_token_id });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "NFT mint failed");
    } finally {
      setNftMinting(false);
    }
  }, [result, address, nftMinting]);

  const loadScenario = (key: string) => {
    const scenario = DEMO_SCENARIOS.find(s => s.key === key);
    if (!scenario) return;
    abortRef.current?.abort();
    setMemo(scenario.memo);
    setResult(null);
    setError(null);
    setNftMintResult(null);
    setPaymentTxHash(null);
    setCurrentStep(-1);
    setRunning(false);
  };

  const runAudit = useCallback(async () => {
    if (!memo.trim() || running || !isConnected || !address) return;
    const currentTierConfig = TIER_CONFIG[tier as AuditTier];
    const currentMaxLen = currentTierConfig?.maxMemoLength ?? Infinity;
    if (currentMaxLen !== Infinity && memo.length > currentMaxLen) {
      setError(`Memo exceeds ${currentTierConfig.name} limit (${memo.length.toLocaleString()}/${currentMaxLen.toLocaleString()} chars). Shorten the memo or select a higher tier.`);
      return;
    }
    if (!treasuryWallet) {
      setError("Treasury wallet not configured. Cannot process payment.");
      return;
    }
    if (chainId !== 8453) {
      setError("Please switch your wallet to Base Mainnet (chain 8453) to pay for audits.");
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(treasuryWallet)) {
      setError("Invalid treasury wallet address. Please refresh and try again.");
      return;
    }

    abortRef.current?.abort();
    setRunning(true);
    setResult(null);
    setError(null);
    setNftMintResult(null);
    setPaymentTxHash(null);
    setCurrentStep(0); // Payment step

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // ─── Step 0: Send USDC payment ─────────────────────────────
      const usdcAddress = USDC_ADDRESS[8453];
      const amount = TIER_AMOUNTS[tier];
      if (!amount) throw new Error("Invalid tier");

      const txHash = await writeContract(wagmiConfig, {
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [treasuryWallet as `0x${string}`, amount],
      });

      if (controller.signal.aborted) return;
      setPaymentTxHash(txHash);
      setCurrentStep(1); // Confirming

      // ─── Step 1: Wait for confirmation ─────────────────────────
      await waitForTransactionReceipt(wagmiConfig, { hash: txHash });

      if (controller.signal.aborted) return;
      setCurrentStep(2); // Auditing

      // ─── Step 2: Send audit request with payment proof ─────────
      const auditType = tier === "treasury" ? "treasury" : tier === "founder" ? "founder_drift" : "general";
      const endpoint = tier === "treasury" ? "/api/audit/treasury"
        : tier === "founder" ? "/api/audit/founder" : "/api/audit/micro";
      const userVeniceKey = getVeniceApiKey();

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-payment-proof": txHash,
          ...(userVeniceKey && { "x-venice-api-key": userVeniceKey }),
          ...(address && { "x-wallet-address": address }),
        },
        body: JSON.stringify({
          strategy_memo: memo,
          audit_type: auditType,
          agent_id: address,
        }),
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;
      setCurrentStep(3); // Irys Upload
      await new Promise(r => setTimeout(r, 400));

      if (!response.ok) {
        const errData = await response.json().catch(() => null);
        throw new Error(errData?.error || `Server returned ${response.status}`);
      }

      const data: AuditResult = await response.json();

      if (controller.signal.aborted) return;
      setCurrentStep(4); // Settlement
      await new Promise(r => setTimeout(r, 400));
      setCurrentStep(5); // Complete
      await new Promise(r => setTimeout(r, 300));

      setResult(data);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("User rejected") || msg.includes("User denied")) {
        setError("Transaction cancelled by user.");
      } else {
        setError(msg || "Audit request failed");
      }
      setCurrentStep(-1);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [memo, tier, running, isConnected, address, chainId, treasuryWallet]);

  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const selectedTier = TIER_OPTIONS.find(t => t.value === tier);
  const tierConfig = TIER_CONFIG[tier as AuditTier];
  const maxMemoLength = tierConfig?.maxMemoLength ?? Infinity;
  const memoTooLong = maxMemoLength !== Infinity && memo.length > maxMemoLength;

  return (
    <div className="min-h-screen bg-black text-white" style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');
        ::selection { background: rgba(74, 222, 128, 0.3); }
      `}</style>

      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-zinc-800 bg-black/95 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/">
            <span className="font-mono text-lg font-bold tracking-tight text-white" data-testid="link-chat-home-logo">
              DJZS<span className="text-green-400">.ai</span>
            </span>
          </Link>
          <nav className="hidden md:flex items-center gap-1">
            <Link href="/" className="px-3 py-1.5 font-mono text-xs text-zinc-500 hover:text-green-400 transition-colors" data-testid="link-chat-header-home">Home</Link>
            <Link href="/docs" className="px-3 py-1.5 font-mono text-xs text-zinc-500 hover:text-green-400 transition-colors" data-testid="link-chat-header-docs">Docs</Link>
            <Link href="/demo" className="px-3 py-1.5 font-mono text-xs text-zinc-500 hover:text-green-400 transition-colors">Demo</Link>
          </nav>
          <div className="flex items-center gap-3">
            <div className="hidden sm:block" data-testid="wallet-connect-button">
              <ConnectButton chainStatus="icon" showBalance={false} />
            </div>
            <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="md:hidden w-9 h-9 flex items-center justify-center text-zinc-400 hover:text-white" data-testid="button-chat-mobile-menu" aria-label="Menu">
              {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-zinc-800 bg-black/98 px-4 py-3">
            <Link href="/" onClick={() => setMobileMenuOpen(false)} className="block py-2 font-mono text-xs text-zinc-400 hover:text-green-400">Home</Link>
            <Link href="/docs" onClick={() => setMobileMenuOpen(false)} className="block py-2 font-mono text-xs text-zinc-400 hover:text-green-400">Docs</Link>
            <div className="py-2 sm:hidden" data-testid="wallet-connect-mobile"><ConnectButton chainStatus="icon" showBalance={false} /></div>
          </div>
        )}
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 sm:py-12">
        {/* Title */}
        <div className="mb-8">
          <div className="font-mono text-xs text-zinc-600 mb-2" data-testid="badge-chat-mode">// x402 AUDIT CONSOLE — LIVE</div>
          <h1 className="font-mono text-2xl sm:text-4xl font-bold text-white mb-2" data-testid="text-chat-page-title">
            Audit-to-Certificate Pipeline
          </h1>
          <p className="font-mono text-sm text-zinc-500" data-testid="text-chat-page-subtitle">
            Route your reasoning trace through the x402 Oracle. Real USDC payments on Base Mainnet.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Left: Input Panel */}
          <div className="lg:col-span-2 space-y-4">
            <div className="border border-zinc-800 bg-zinc-950">
              <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
                <Terminal size={14} className="text-green-400" />
                <span className="font-mono text-xs text-zinc-300 font-bold">Agent Payload Injector</span>
              </div>

              <div className="p-4 space-y-4">
                {/* Scenarios */}
                <div>
                  <div className="font-mono text-[10px] text-zinc-600 mb-2" data-testid="label-chat-scenarios">PRELOADED SCENARIOS</div>
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

                {/* Memo */}
                <div>
                  <div className="font-mono text-[10px] text-zinc-600 mb-2" data-testid="label-chat-memo">STRATEGY_MEMO:</div>
                  <textarea
                    value={memo}
                    onChange={(e) => setMemo(e.target.value)}
                    placeholder="Paste your reasoning memo here or select a scenario above..."
                    className={`w-full p-3 bg-black border font-mono text-xs text-zinc-300 h-32 resize-none focus:outline-none transition-colors placeholder:text-zinc-700 ${
                      memoTooLong ? "border-red-400/50 focus:border-red-400/50" : "border-zinc-800 focus:border-green-400/50"
                    }`}
                    data-testid="textarea-chat-memo"
                  />
                  {memo.length > 0 && maxMemoLength !== Infinity && (
                    <div className={`flex items-center justify-between mt-1 font-mono text-[10px] ${
                      memoTooLong ? "text-red-400" : "text-zinc-600"
                    }`} data-testid="text-memo-char-count">
                      {memoTooLong && (
                        <span className="flex items-center gap-1">
                          <AlertTriangle size={10} />
                          Exceeds {tierConfig.name} limit
                        </span>
                      )}
                      <span className="ml-auto">{memo.length.toLocaleString()}/{maxMemoLength.toLocaleString()}</span>
                    </div>
                  )}
                </div>

                {/* Tier */}
                <div>
                  <div className="font-mono text-[10px] text-zinc-600 mb-2" data-testid="label-chat-tier">AUDIT TIER</div>
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
                        <div className="text-[9px] text-zinc-600 mt-0.5">{t.engine}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Run Button */}
                <button
                  onClick={runAudit}
                  disabled={!memo.trim() || running || !isConnected || memoTooLong}
                  className={`w-full flex items-center justify-center gap-2 py-3 font-mono text-xs font-bold transition-all ${
                    !memo.trim() || running || !isConnected || memoTooLong
                      ? "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                      : "bg-green-400 text-black hover:bg-green-300"
                  }`}
                  data-testid="button-run-audit"
                >
                  {running ? (
                    <Terminal size={16} className="animate-spin" />
                  ) : !isConnected ? (
                    <Wallet size={16} />
                  ) : memoTooLong ? (
                    <AlertTriangle size={16} />
                  ) : (
                    <Coins size={16} />
                  )}
                  <span>{
                    !isConnected ? "CONNECT WALLET TO AUDIT"
                    : memoTooLong ? "MEMO EXCEEDS TIER LIMIT"
                    : running ? (currentStep === 0 ? "APPROVE USDC TRANSFER..." : "SCANNING — may take up to 90s...")
                    : `PAY ${selectedTier?.price} USDC & RUN AUDIT`
                  }</span>
                </button>

                {/* Payment TX link */}
                {paymentTxHash && (
                  <a
                    href={`https://basescan.org/tx/${paymentTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 font-mono text-[10px] text-zinc-600 hover:text-green-400 transition-colors"
                  >
                    <Coins size={12} /> Payment TX: {paymentTxHash.slice(0, 10)}...{paymentTxHash.slice(-8)}
                    <ExternalLink size={10} />
                  </a>
                )}
              </div>
            </div>
          </div>

          {/* Right: Pipeline + Results */}
          <div className="lg:col-span-3 space-y-4">
            {/* Pipeline Steps */}
            <div className="border border-zinc-800 bg-zinc-950">
              <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
                <ShieldCheck size={14} className="text-green-400" />
                <span className="font-mono text-xs text-zinc-300 font-bold" data-testid="text-chat-pipeline-title">Pipeline Progress</span>
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

            {/* Error */}
            {error && (
              <div className="border border-red-400/30 bg-red-400/5 p-4" data-testid="chat-error-message">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="font-mono text-xs font-bold text-red-400 mb-1">AUDIT FAILED</div>
                    <p className="font-mono text-xs text-zinc-400">{error}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Result */}
            {result ? (
              <div className="border border-zinc-800 bg-zinc-950" data-testid="chat-result-card">
                {/* Verdict Header */}
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
                        <span className="font-mono text-[10px] px-2 py-0.5 border border-green-400/30 text-green-400" data-testid="badge-live-audit">
                          LIVE
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
                  {/* Flags */}
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

                  {/* Recommendations */}
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

                  {/* Provenance */}
                  <div className="border-t border-zinc-800 pt-4 space-y-2">
                    <div className="font-mono text-[10px] text-zinc-600" data-testid="label-result-provenance">ON-CHAIN PROVENANCE</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {/* Payment TX */}
                      {paymentTxHash && (
                        <a href={`https://basescan.org/tx/${paymentTxHash}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2.5 border border-green-400/20 bg-green-400/5 hover:bg-green-400/10 transition-colors group">
                          <Coins size={14} className="text-green-400" />
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-[10px] font-bold text-green-400">USDC Payment</div>
                            <div className="font-mono text-[9px] text-zinc-600 truncate">{paymentTxHash}</div>
                          </div>
                          <ExternalLink size={12} className="text-zinc-600 group-hover:text-green-400 flex-shrink-0" />
                        </a>
                      )}

                      {/* Irys */}
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

                      {/* Trust Score */}
                      {result.trust_score_tx_hash ? (
                        <a href={`https://basescan.org/tx/${result.trust_score_tx_hash}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2.5 border border-green-400/20 bg-green-400/5 hover:bg-green-400/10 transition-colors group" data-testid="link-result-basescan">
                          <ShieldCheck size={14} className="text-green-400" />
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-[10px] font-bold text-green-400">Trust Score TX</div>
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

                    {/* NFT */}
                    {result.verdict === "PASS" && (
                      <div>
                        {(result.nft_tx_hash || nftMintResult) ? (
                          <a
                            href={`https://basescan.org/tx/${nftMintResult?.nft_tx_hash || result.nft_tx_hash}`}
                            target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-2 px-3 py-2.5 border border-green-400/30 bg-green-400/5 hover:bg-green-400/10 transition-colors group"
                            data-testid="link-result-nft"
                          >
                            <ShieldCheck size={14} className="text-green-400" />
                            <div className="min-w-0 flex-1">
                              <div className="font-mono text-[10px] font-bold text-green-400">
                                ProofOfLogic NFT
                                {(nftMintResult?.nft_token_id || result.nft_token_id) && (
                                  <span className="text-zinc-500 font-normal ml-1">#{nftMintResult?.nft_token_id || result.nft_token_id}</span>
                                )}
                              </div>
                              <div className="font-mono text-[9px] text-zinc-600 truncate">{nftMintResult?.nft_tx_hash || result.nft_tx_hash}</div>
                            </div>
                            <ExternalLink size={12} className="text-zinc-600 group-hover:text-green-400 flex-shrink-0" />
                          </a>
                        ) : result.nft_mint_available ? (
                          <button
                            onClick={mintNft} disabled={nftMinting}
                            className="w-full flex items-center gap-2 px-3 py-2.5 border border-green-400/30 bg-green-400/5 hover:bg-green-400/10 transition-colors disabled:opacity-50 disabled:cursor-wait"
                            data-testid="button-mint-nft"
                          >
                            <ShieldCheck size={14} className="text-green-400" />
                            <div className="min-w-0 flex-1 text-left">
                              <div className="font-mono text-[10px] font-bold text-green-400">
                                {nftMinting ? "MINTING..." : "MINT PROOFOFLOGIC NFT"}
                              </div>
                              <div className="font-mono text-[9px] text-zinc-600">
                                {nftMinting ? "Treasury paying gas on Base" : "Full certificate on-chain. Treasury pays gas."}
                              </div>
                            </div>
                          </button>
                        ) : null}
                      </div>
                    )}

                    <div className="font-mono text-[9px] text-zinc-700 break-all pt-1" data-testid="text-result-hash">
                      SHA-256: {result.cryptographic_hash}
                    </div>
                  </div>
                </div>
              </div>
            ) : !running ? (
              <div className="border border-dashed border-zinc-800 p-12 flex flex-col items-center justify-center text-center" data-testid="chat-empty-state">
                <ShieldAlert size={36} className="text-zinc-800 mb-3" />
                <p className="font-mono text-xs text-zinc-500 mb-1">No audit running</p>
                <p className="font-mono text-[10px] text-zinc-700">
                  {isConnected
                    ? 'Select a scenario or paste a memo, then click the button to pay & audit'
                    : "Connect your wallet to start an audit"}
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </main>

      <footer className="border-t border-zinc-800 py-6 mt-12">
        <div className="max-w-5xl mx-auto px-4 flex flex-col items-center gap-2">
          <div className="flex gap-4">
            <Link href="/" className="font-mono text-[10px] text-zinc-600 hover:text-green-400 transition-colors" data-testid="link-chat-footer-home">Home</Link>
            <Link href="/docs" className="font-mono text-[10px] text-zinc-600 hover:text-green-400 transition-colors" data-testid="link-chat-footer-docs">Docs</Link>
          </div>
          <p className="font-mono text-[10px] text-zinc-800" data-testid="text-chat-footer-tagline">
            djzsx.eth | No agent acts without audit. &copy; 2026
          </p>
        </div>
      </footer>
    </div>
  );
}
