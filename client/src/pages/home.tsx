import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Link } from "wouter";
import {
  ChevronDown,
  ChevronRight,
  Shield,
  Zap,
  Lock,
  Database,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Menu,
  X,
} from "lucide-react";

// ─── Boot Sequence ───────────────────────────────────────────────────

const BOOT_LINES = [
  { text: "// SYS_ID: DJZS-MAINNET-01", delay: 0 },
  { text: "// PROTOCOL: Adversarial Logic Firewall v1.0", delay: 120 },
  { text: "// CHAIN: Base Mainnet (EIP-155:8453)", delay: 240 },
  { text: "// ORACLE: Venice AI — zero data retention", delay: 360 },
  { text: "// LEDGER: Irys Datachain — immutable certificates", delay: 480 },
  { text: "// PAYMENT: x402 USDC micropayments", delay: 600 },
  { text: "// TAXONOMY: 11 DJZS-LF failure codes loaded", delay: 720 },
  { text: "// STATUS: OPERATIONAL", delay: 860 },
];

function BootSequence({ onComplete }: { onComplete: () => void }) {
  const [visibleLines, setVisibleLines] = useState(0);

  useEffect(() => {
    const timers = BOOT_LINES.map((line, i) =>
      setTimeout(() => setVisibleLines(i + 1), line.delay)
    );
    const done = setTimeout(onComplete, 1400);
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(done);
    };
  }, [onComplete]);

  return (
    <div className="font-mono text-xs sm:text-sm leading-relaxed text-zinc-600">
      {BOOT_LINES.slice(0, visibleLines).map((line, i) => (
        <div
          key={i}
          className={`transition-colors duration-300 ${
            i === visibleLines - 1 ? "text-green-400" : "text-zinc-600"
          } ${line.text.includes("STATUS") ? "text-green-400 font-bold" : ""}`}
        >
          {line.text}
          {i === visibleLines - 1 && (
            <span className="inline-block w-2 h-4 bg-green-400 ml-1 animate-pulse" />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── LF Taxonomy Data ────────────────────────────────────────────────

const LF_CODES = [
  { code: "DJZS-S01", name: "CIRCULAR_LOGIC", category: "Structural", severity: "CRITICAL", autoAbort: true, weight: 40, description: "Conclusion is used as a premise. The reasoning loop references itself without external validation." },
  { code: "DJZS-S02", name: "MISSING_FALSIFIABILITY", category: "Structural", severity: "CRITICAL", autoAbort: true, weight: 40, description: "No failure condition defined. The thesis cannot be disproven, making it unfalsifiable and therefore unauditable." },
  { code: "DJZS-E01", name: "CONFIRMATION_TUNNEL", category: "Epistemic", severity: "HIGH", autoAbort: true, weight: 25, description: "Evidence selection is asymmetric. Only confirming data is cited; disconfirming signals are absent or dismissed." },
  { code: "DJZS-E02", name: "AUTHORITY_SUBSTITUTION", category: "Epistemic", severity: "HIGH", autoAbort: true, weight: 25, description: "Argument depends on authority or reputation rather than structural evidence. Removes the reasoning from audit." },
  { code: "DJZS-I01", name: "MISALIGNED_INCENTIVE", category: "Incentive", severity: "MEDIUM", autoAbort: false, weight: 10, description: "The proposed action benefits the proposer disproportionately relative to stated stakeholders." },
  { code: "DJZS-I02", name: "NARRATIVE_DEPENDENCY", category: "Incentive", severity: "MEDIUM", autoAbort: false, weight: 10, description: "Strategy survival depends on a specific narrative remaining true. No hedge against narrative collapse." },
  { code: "DJZS-X01", name: "UNHEDGED_EXECUTION", category: "Execution", severity: "CRITICAL", autoAbort: true, weight: 40, description: "No risk bounds defined. Unlimited downside exposure. No stop-loss, position sizing, or max drawdown." },
  { code: "DJZS-X02", name: "LIQUIDITY_RISK", category: "Execution", severity: "HIGH", autoAbort: true, weight: 25, description: "Strategy assumes liquidity that may not exist. Position may not be exitable at stated price." },
  { code: "DJZS-X03", name: "SLIPPAGE_EXPOSURE", category: "Execution", severity: "MEDIUM", autoAbort: false, weight: 10, description: "Strategy ignores execution costs that could erode returns." },
  { code: "DJZS-T01", name: "STALE_DATA_DEPENDENCY", category: "Temporal", severity: "HIGH", autoAbort: true, weight: 25, description: "Strategy relies on data that may no longer be current." },
  { code: "DJZS-T02", name: "RACE_CONDITION_RISK", category: "Temporal", severity: "MEDIUM", autoAbort: false, weight: 10, description: "Assumes sequential execution but could be front-run." },
] as const;

// ─── Demo Scenarios ──────────────────────────────────────────────────

const DEMO_SCENARIOS = {
  fomo: {
    label: "FOMO Momentum Buy",
    memo: "EXECUTE IMMEDIATE BUY: 500 SOL of $SHILL. 1-minute volume is spiking and Crypto Twitter implies a tier-1 exchange listing today. Cannot miss this pump.",
    verdict: "FAIL" as const,
    riskScore: 98,
    flags: [
      { code: "DJZS-I01", message: "FOMO Loop — execution driven by social momentum and unverified Twitter sentiment." },
      { code: "DJZS-X01", message: "No stop-loss, no position sizing. Unlimited downside on unverified rumor." },
      { code: "DJZS-E01", message: "Only confirming signals cited (volume spike, CT rumor). Zero contradicting evidence." },
    ],
    irysUrl: "https://gateway.irys.xyz/8kNMzL4hgLoXo7SNEsgPSJ8oCETs15jKwioke3V2rSH",
  },
  hallucination: {
    label: "Hallucinated Data",
    memo: "Routing 50k USDC into Yield Protocol V4 based on their latest audit report from yesterday.",
    verdict: "FAIL" as const,
    riskScore: 85,
    flags: [
      { code: "DJZS-E02", message: "Yield Protocol V4 does not exist. Audit report cannot be verified." },
      { code: "DJZS-S02", message: "No falsifiable evidence provided. Claim is unverifiable." },
      { code: "DJZS-T01", message: "Referenced audit report timestamp cannot be validated." },
    ],
    irysUrl: "https://gateway.irys.xyz/5rPQzM7kfHnWp9TNDrtgQRK9pBDUt26kXxjplf4W3tUI",
  },
  valid: {
    label: "Valid Strategy",
    memo: "Executing DCA of 2 ETH. Structural support verified at $2800. Liquidity depth is sufficient. Max slippage set to 0.5%.",
    verdict: "PASS" as const,
    riskScore: 12,
    flags: [],
    irysUrl: "https://gateway.irys.xyz/71oNMzL4hgLoXo7SNEsgPSJ8oCETs15jKwioke3V2rSH",
  },
} as const;

type DemoKey = keyof typeof DEMO_SCENARIOS;

// ─── Severity Helpers ────────────────────────────────────────────────

function severityColor(sev: string) {
  switch (sev) {
    case "CRITICAL": return "text-red-400 border-red-400/30 bg-red-400/5";
    case "HIGH": return "text-amber-400 border-amber-400/30 bg-amber-400/5";
    case "MEDIUM": return "text-yellow-300 border-yellow-300/30 bg-yellow-300/5";
    default: return "text-zinc-400 border-zinc-700 bg-zinc-900";
  }
}

function severityDot(sev: string) {
  switch (sev) {
    case "CRITICAL": return "bg-red-400";
    case "HIGH": return "bg-amber-400";
    case "MEDIUM": return "bg-yellow-300";
    default: return "bg-zinc-500";
  }
}

// ─── Header ──────────────────────────────────────────────────────────

function Header() {
  const { isConnected } = useAccount();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const navItems = [
    { href: "#taxonomy", label: "LF Codes" },
    { href: "#demo", label: "Demo" },
    { href: "#pricing", label: "Pricing" },
    { href: "/docs", label: "Docs", isRoute: true },
    { href: "/demo", label: "Live Audit", isRoute: true },
  ];

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-all duration-300 ${
        scrolled ? "border-zinc-800 bg-black/95 backdrop-blur-md" : "border-transparent bg-transparent"
      }`}
    >
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
        <Link href="/">
          <span className="font-mono text-lg font-bold tracking-tight text-white">
            DJZS<span className="text-green-400">.ai</span>
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-1">
          {navItems.map((item) =>
            item.isRoute ? (
              <Link key={item.label} href={item.href} className="px-3 py-1.5 font-mono text-xs text-zinc-500 hover:text-green-400 transition-colors">
                {item.label}
              </Link>
            ) : (
              <a key={item.label} href={item.href} className="px-3 py-1.5 font-mono text-xs text-zinc-500 hover:text-green-400 transition-colors">
                {item.label}
              </a>
            )
          )}
        </nav>

        <div className="flex items-center gap-3">
          {isConnected ? (
            <Link href="/chat">
              <button className="font-mono text-xs px-4 py-2 bg-green-400 text-black font-bold hover:bg-green-300 transition-colors">
                ENTER ZONE
              </button>
            </Link>
          ) : (
            <ConnectButton.Custom>
              {({ openConnectModal, account, mounted }) => {
                const connected = mounted && account;
                return connected ? (
                  <Link href="/chat">
                    <button className="font-mono text-xs px-4 py-2 bg-green-400 text-black font-bold hover:bg-green-300 transition-colors">
                      ENTER ZONE
                    </button>
                  </Link>
                ) : (
                  <button
                    onClick={openConnectModal}
                    className="font-mono text-xs px-4 py-2 border border-green-400/50 text-green-400 hover:bg-green-400/10 transition-colors"
                  >
                    CONNECT
                  </button>
                );
              }}
            </ConnectButton.Custom>
          )}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="md:hidden w-9 h-9 flex items-center justify-center text-zinc-400 hover:text-white"
            aria-label="Menu"
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="md:hidden border-t border-zinc-800 bg-black/98 px-4 py-3">
          {navItems.map((item) => (
            <a key={item.label} href={item.href} onClick={() => setMobileOpen(false)} className="block py-2 font-mono text-xs text-zinc-400 hover:text-green-400">
              {item.label}
            </a>
          ))}
        </div>
      )}
    </header>
  );
}

// ─── Hero ────────────────────────────────────────────────────────────

function useTypewriter(text: string, start: boolean, speed = 90) {
  const [displayed, setDisplayed] = useState("");

  useEffect(() => {
    if (!start) return;
    setDisplayed("");
    let i = 0;
    const id = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [text, start, speed]);

  return displayed;
}

function Hero() {
  const [bootDone, setBootDone] = useState(false);
  const onBootComplete = useCallback(() => setBootDone(true), []);
  const displayed = useTypewriter("Audit-Before-Act.", bootDone, 90);

  return (
    <section className="relative py-16 sm:py-24 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="border border-zinc-800 bg-zinc-950 p-6 sm:p-8 mb-8">
          <BootSequence onComplete={onBootComplete} />
        </div>

        <div className={`transition-all duration-700 ${bootDone ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}>
          <h1 className="font-mono text-3xl sm:text-5xl font-bold text-white leading-tight mb-4">
            {displayed}<span className="inline-block w-[3px] h-[0.9em] bg-green-400 ml-1 align-baseline" style={{ animation: "cursor-blink 1s step-end infinite" }} />
          </h1>
          <p className="font-mono text-base sm:text-lg text-zinc-400 leading-relaxed mb-8 max-w-2xl">
            The adversarial logic firewall for autonomous agents. Every reasoning trace is stress-tested against 11 failure codes before execution. Every verdict is permanently verifiable on Irys Datachain.
          </p>
          <div className="flex flex-wrap gap-3">
            <a href="#demo" className="font-mono text-xs px-5 py-2.5 bg-green-400 text-black font-bold hover:bg-green-300 transition-colors">
              TRY DEMO
            </a>
            <Link href="/docs" className="font-mono text-xs px-5 py-2.5 border border-zinc-700 text-zinc-300 hover:border-zinc-500 transition-colors">
              READ DOCS
            </Link>
          </div>

          <div className="grid grid-cols-3 gap-4 mt-12 pt-8 border-t border-zinc-800">
            {[
              { value: "11", label: "Failure Codes" },
              { value: "$0.10", label: "Per Audit" },
              { value: "∞", label: "Certificate TTL" },
            ].map((s) => (
              <div key={s.label}>
                <div className="font-mono text-2xl sm:text-3xl font-bold text-green-400">{s.value}</div>
                <div className="font-mono text-xs text-zinc-500 mt-1">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── LF Taxonomy Accordion ───────────────────────────────────────────

function TaxonomySection() {
  const [openCode, setOpenCode] = useState<string | null>(null);

  const categories = [
    { name: "Structural", prefix: "S", color: "text-red-400" },
    { name: "Epistemic", prefix: "E", color: "text-amber-400" },
    { name: "Incentive", prefix: "I", color: "text-yellow-300" },
    { name: "Execution", prefix: "X", color: "text-orange-400" },
    { name: "Temporal", prefix: "T", color: "text-blue-400" },
  ];

  return (
    <section id="taxonomy" className="py-16 sm:py-24 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="font-mono text-xs text-zinc-600 mb-2">// LOGIC_TAXONOMY: DJZS-LF v1.0</div>
        <h2 className="font-mono text-2xl sm:text-3xl font-bold text-white mb-2">Failure Code Taxonomy</h2>
        <p className="font-mono text-sm text-zinc-500 mb-8">11 machine-parseable codes across 5 domains. Agents halt on CRITICAL or HIGH.</p>

        <div className="space-y-1">
          {categories.map((cat) => {
            const codes = LF_CODES.filter((c) => c.category === cat.name);
            return (
              <div key={cat.name}>
                <div className="font-mono text-xs text-zinc-600 py-2 border-b border-zinc-900">
                  {cat.name.toUpperCase()} ({cat.prefix})
                </div>
                {codes.map((lf) => {
                  const isOpen = openCode === lf.code;
                  return (
                    <div key={lf.code} className="border-b border-zinc-900">
                      <button
                        onClick={() => setOpenCode(isOpen ? null : lf.code)}
                        className="w-full flex items-center justify-between py-3 px-2 hover:bg-zinc-900/50 transition-colors text-left"
                      >
                        <div className="flex items-center gap-3">
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${severityDot(lf.severity)}`} />
                          <span className="font-mono text-sm text-zinc-300">
                            <span className={cat.color}>{lf.code}</span>
                            <span className="text-zinc-600 mx-2">—</span>
                            {lf.name}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <span className={`font-mono text-[10px] px-2 py-0.5 border rounded ${severityColor(lf.severity)}`}>
                            {lf.severity}
                          </span>
                          {isOpen ? <ChevronDown size={14} className="text-zinc-600" /> : <ChevronRight size={14} className="text-zinc-600" />}
                        </div>
                      </button>
                      {isOpen && (
                        <div className="px-2 pb-4 pl-7">
                          <p className="font-mono text-xs text-zinc-400 leading-relaxed mb-2">{lf.description}</p>
                          <div className="flex gap-4 font-mono text-[10px] text-zinc-600">
                            <span>Weight: <span className="text-zinc-400">{lf.weight}/260</span></span>
                            <span>Auto-Abort: <span className={lf.autoAbort ? "text-red-400" : "text-zinc-500"}>{lf.autoAbort ? "YES" : "NO"}</span></span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ─── Interactive Demo ────────────────────────────────────────────────

function DemoSection() {
  const [activeKey, setActiveKey] = useState<DemoKey>("fomo");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<(typeof DEMO_SCENARIOS)[DemoKey] | null>(null);

  const runAudit = useCallback(() => {
    setScanning(true);
    setResult(null);
    setTimeout(() => {
      setScanning(false);
      setResult(DEMO_SCENARIOS[activeKey]);
    }, 1200);
  }, [activeKey]);

  return (
    <section id="demo" className="py-16 sm:py-24 px-4 bg-zinc-950">
      <div className="max-w-3xl mx-auto">
        <div className="font-mono text-xs text-zinc-600 mb-2">// INTERACTIVE_DEMO: Prediction Market Scenarios</div>
        <h2 className="font-mono text-2xl sm:text-3xl font-bold text-white mb-2">Test the Oracle</h2>
        <p className="font-mono text-sm text-zinc-500 mb-8">Submit a strategy memo. Watch it get stress-tested against the DJZS-LF taxonomy in real time.</p>

        {/* Scenario Tabs */}
        <div className="flex flex-wrap gap-1 mb-6">
          {(Object.keys(DEMO_SCENARIOS) as DemoKey[]).map((key) => (
            <button
              key={key}
              onClick={() => { setActiveKey(key); setResult(null); }}
              className={`font-mono text-xs px-4 py-2 border transition-colors ${
                activeKey === key
                  ? "border-green-400/50 bg-green-400/10 text-green-400"
                  : "border-zinc-800 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {DEMO_SCENARIOS[key].label}
            </button>
          ))}
        </div>

        {/* Memo */}
        <div className="border border-zinc-800 bg-black p-4 mb-4">
          <div className="font-mono text-[10px] text-zinc-600 mb-2">STRATEGY_MEMO:</div>
          <p className="font-mono text-sm text-zinc-300 leading-relaxed">{DEMO_SCENARIOS[activeKey].memo}</p>
        </div>

        {/* Run */}
        <button
          onClick={runAudit}
          disabled={scanning}
          className={`font-mono text-xs px-6 py-2.5 font-bold transition-all mb-6 ${
            scanning ? "bg-zinc-800 text-zinc-500 cursor-wait" : "bg-green-400 text-black hover:bg-green-300"
          }`}
        >
          {scanning ? "SCANNING..." : "RUN AUDIT"}
        </button>

        {/* Scanning */}
        {scanning && (
          <div className="border border-zinc-800 bg-black p-4 mb-4">
            <div className="font-mono text-xs text-green-400 animate-pulse">▌ Venice AI adversarial analysis in progress...</div>
            <div className="mt-2 h-1 bg-zinc-900 overflow-hidden">
              <div className="h-full bg-green-400" style={{ animation: "scan-bar 1.2s ease-in-out forwards" }} />
            </div>
          </div>
        )}

        {/* Result */}
        {result && !scanning && (
          <div className="border border-zinc-800 bg-black">
            <div className={`flex items-center justify-between p-4 border-b border-zinc-800 ${
              result.verdict === "FAIL" ? "bg-red-400/5" : "bg-green-400/5"
            }`}>
              <div className="flex items-center gap-3">
                {result.verdict === "FAIL" ? (
                  <XCircle size={20} className="text-red-400" />
                ) : (
                  <CheckCircle2 size={20} className="text-green-400" />
                )}
                <span className={`font-mono text-lg font-bold ${
                  result.verdict === "FAIL" ? "text-red-400" : "text-green-400"
                }`}>
                  {result.verdict}
                </span>
              </div>
              <div className="font-mono text-right">
                <div className="text-xs text-zinc-500">RISK SCORE</div>
                <div className={`text-xl font-bold ${
                  result.riskScore > 60 ? "text-red-400" : result.riskScore > 30 ? "text-amber-400" : "text-green-400"
                }`}>
                  {result.riskScore}/100
                </div>
              </div>
            </div>

            {result.flags.length > 0 ? (
              <div className="p-4 space-y-2">
                <div className="font-mono text-[10px] text-zinc-600 mb-2">FAILURE_FLAGS:</div>
                {result.flags.map((flag, i) => (
                  <div key={i} className="flex gap-3 p-3 border border-zinc-800 bg-zinc-950">
                    <span className="font-mono text-xs text-red-400 font-bold whitespace-nowrap">{flag.code}</span>
                    <span className="font-mono text-xs text-zinc-400">{flag.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-4">
                <div className="font-mono text-xs text-green-400/60">No failure codes triggered. Logic structure verified.</div>
              </div>
            )}

            <div className="flex items-center justify-between p-4 border-t border-zinc-800">
              <div className="font-mono text-[10px] text-zinc-600">PROVENANCE: IRYS_DATACHAIN</div>
              <a href={result.irysUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-[10px] text-green-400 hover:text-green-300 flex items-center gap-1">
                Verify Certificate <ExternalLink size={10} />
              </a>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Pricing ─────────────────────────────────────────────────────────

function PricingSection() {
  const tiers = [
    {
      name: "MICRO",
      price: "$0.10",
      unit: "per audit",
      description: "Operational sanity checks",
      features: ["1,000 char memo limit", "Binary PASS/FAIL verdict", "Irys Datachain certificate", "Prediction market verification", "11 LF code scan"],
      accent: "border-green-400/30 hover:border-green-400/60",
      badge: null,
    },
    {
      name: "FOUNDER",
      price: "$1.00",
      unit: "per audit",
      description: "Strategic roadmap diligence",
      features: ["5,000 char memo limit", "Full adversarial analysis", "Narrative drift detection", "Irys Datachain certificate", "11 LF code scan + recommendations"],
      accent: "border-amber-400/30 hover:border-amber-400/60",
      badge: "RECOMMENDED",
    },
    {
      name: "TREASURY",
      price: "$10.00",
      unit: "per audit",
      description: "Capital deployment stress-test",
      features: ["Unlimited memo length", "Exhaustive adversarial attack", "Multi-vector failure analysis", "Irys Datachain certificate", "Priority processing"],
      accent: "border-red-400/30 hover:border-red-400/60",
      badge: null,
    },
  ];

  return (
    <section id="pricing" className="py-16 sm:py-24 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="font-mono text-xs text-zinc-600 mb-2">// PRICING_MODE: x402 USDC on Base Mainnet</div>
        <h2 className="font-mono text-2xl sm:text-3xl font-bold text-white mb-2">Execution Zones</h2>
        <p className="font-mono text-sm text-zinc-500 mb-8">Pay per audit. No subscriptions. USDC on Base Mainnet via x402 protocol.</p>

        <div className="grid md:grid-cols-3 gap-4">
          {tiers.map((tier) => (
            <div key={tier.name} className={`border bg-black p-6 transition-colors ${tier.accent}`}>
              {tier.badge && (
                <div className="font-mono text-[10px] text-amber-400 mb-3 tracking-wider">{tier.badge}</div>
              )}
              <div className="font-mono text-xs text-zinc-500 mb-1">{tier.name}</div>
              <div className="font-mono text-3xl font-bold text-white mb-1">{tier.price}</div>
              <div className="font-mono text-[10px] text-zinc-600 mb-4">{tier.unit}</div>
              <p className="font-mono text-xs text-zinc-400 mb-4">{tier.description}</p>
              <div className="space-y-2">
                {tier.features.map((f) => (
                  <div key={f} className="flex items-start gap-2 font-mono text-xs text-zinc-500">
                    <span className="text-green-400 mt-0.5">→</span>{f}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Certificate + Architecture ──────────────────────────────────────

function CertificateSection() {
  const sampleCert = {
    audit_id: "fe1f14d0-73ac-4467-ac33-d76bf3fdce21",
    timestamp: "2026-02-25T00:58:33.760Z",
    tier: "micro",
    verdict: "PASS",
    risk_score: 0,
    flags: [],
    cryptographic_hash: "0e4576dd63709edd70573146b5e7255e79295cfe3eb18e517f03ab2e27d2850d",
    provenance_provider: "IRYS_DATACHAIN",
    irys_tx_id: "71oNMzL4hgLoXo7SNEsgPSJ8oCETs15jKwioke3V2rSH",
  };

  return (
    <section className="py-16 sm:py-24 px-4 bg-zinc-950">
      <div className="max-w-3xl mx-auto">
        <div className="font-mono text-xs text-zinc-600 mb-2">// OUTPUT: ProofOfLogic Certificate</div>
        <h2 className="font-mono text-2xl sm:text-3xl font-bold text-white mb-2">Immutable Certificates</h2>
        <p className="font-mono text-sm text-zinc-500 mb-8">Every audit produces a permanent, publicly verifiable certificate on Irys Datachain. No expiration. No authentication required to verify.</p>

        <div className="border border-zinc-800 bg-black p-6 mb-6">
          <pre className="font-mono text-xs text-zinc-400 overflow-x-auto leading-relaxed">
            {JSON.stringify(sampleCert, null, 2)}
          </pre>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { icon: Shield, label: "Venice AI", sub: "Zero retention" },
            { icon: Zap, label: "Base USDC", sub: "x402 payments" },
            { icon: Database, label: "Irys Datachain", sub: "Permanent storage" },
            { icon: Lock, label: "EigenCompute TEE", sub: "Intel TDX Enclave" },
          ].map((item) => (
            <div key={item.label} className="border border-zinc-800 bg-black p-4">
              <item.icon size={16} className="text-green-400 mb-2" />
              <div className="font-mono text-xs text-white font-bold">{item.label}</div>
              <div className="font-mono text-[10px] text-zinc-600">{item.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Footer ──────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="py-8 px-4 border-t border-zinc-800">
      <div className="max-w-3xl mx-auto">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
          <div>
            <div className="font-mono text-sm font-bold text-white">DJZS<span className="text-green-400">.ai</span></div>
            <div className="font-mono text-[10px] text-zinc-600 mt-1">The Adversarial Logic Layer for the A2A Economy</div>
          </div>
          <div className="flex gap-4 font-mono text-xs">
            <a href="https://x.com/Djzs_ai" target="_blank" rel="noopener noreferrer" className="text-zinc-600 hover:text-green-400 transition-colors">X</a>
            <a href="https://github.com/UsernameDAOEth" target="_blank" rel="noopener noreferrer" className="text-zinc-600 hover:text-green-400 transition-colors">GitHub</a>
            <a href="https://farcaster.xyz/djzs" target="_blank" rel="noopener noreferrer" className="text-zinc-600 hover:text-green-400 transition-colors">Farcaster</a>
          </div>
        </div>

        <div className="flex flex-wrap gap-4 font-mono text-[10px] text-zinc-700 mb-4">
          <Link href="/docs" className="hover:text-zinc-400">Docs</Link>
          <Link href="/demo" className="hover:text-zinc-400">Live Audit</Link>
          <Link href="/terms" className="hover:text-zinc-400">Terms</Link>
          <Link href="/privacy" className="hover:text-zinc-400">Privacy</Link>
          <Link href="/security" className="hover:text-zinc-400">Security</Link>
        </div>

        <div className="font-mono text-[10px] text-zinc-800 pt-4 border-t border-zinc-900">
          djzsx.eth | Base Mainnet | No agent acts without audit. © 2026
        </div>
      </div>
    </footer>
  );
}

// ─── Home Page ───────────────────────────────────────────────────────

export default function Home() {
  return (
    <div className="min-h-screen bg-black text-white" style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');
        ::selection { background: rgba(74, 222, 128, 0.3); }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0a0a0a; }
        ::-webkit-scrollbar-thumb { background: #333; }
        @keyframes scan-bar { 0% { width: 0%; } 100% { width: 100%; } }
        @keyframes cursor-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
      `}</style>

      {/* Scan lines overlay */}
      <div
        className="pointer-events-none fixed inset-0 z-50 opacity-[0.03]"
        style={{ background: "repeating-linear-gradient(0deg, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 1px, transparent 1px, transparent 2px)" }}
      />

      <Header />
      <main>
        <Hero />
        <TaxonomySection />
        <DemoSection />
        <PricingSection />
        <CertificateSection />
      </main>
      <Footer />
    </div>
  );
}
