import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Upload, ShieldCheck, Video, ExternalLink, Copy, Loader2 } from "lucide-react";

type ModuleName = "dst_claim" | "prediction_market" | "perp_trade" | "journal_reflection";

type Receipt = {
  sys_id: string;
  receipt_id: string;
  receipt_hash: string;
  audit_id: string;
  timestamp: string;
  module: ModuleName;
  title?: string | null;
  thesis: string;
  verdict: "PASS" | "FAIL";
  risk_score: number;
  flags: Array<{ code: string; severity: string; evidence?: string; recommendation?: string }>;
  logic_hash?: string;
  video?: { provider: string; uid: string; requireSignedURLs: boolean } | null;
  irys_tx_id?: string | null;
  irys_url?: string | null;
  irys_error?: string;
};

type Status = "idle" | "creating-upload" | "uploading" | "auditing" | "signing" | "complete" | "error";

const MODULES: Array<{ value: ModuleName; label: string; hint: string }> = [
  { value: "dst_claim", label: "DST Claim", hint: "Theory, laws, doctrine" },
  { value: "prediction_market", label: "Prediction Market", hint: "Outcome thesis audit" },
  { value: "perp_trade", label: "Perp Trade", hint: "Trade logic pre-check" },
  { value: "journal_reflection", label: "Journal Reflection", hint: "Private reasoning review" },
];

function shortHash(value?: string | null) {
  if (!value) return "—";
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function StatusLine({ status }: { status: Status }) {
  const label = {
    idle: "READY",
    "creating-upload": "CREATING CLOUDFLARE UPLOAD URL",
    uploading: "UPLOADING VIDEO TO STREAM",
    auditing: "RUNNING DJZS DETERMINISTIC AUDIT",
    signing: "CREATING SIGNED PLAYBACK TOKEN",
    complete: "RECEIPT COMPLETE",
    error: "ERROR",
  }[status];

  return (
    <div className="font-mono text-xs text-zinc-500 flex items-center gap-2">
      {status !== "idle" && status !== "complete" && status !== "error" ? (
        <Loader2 size={13} className="animate-spin text-green-400" />
      ) : (
        <span className={`w-2 h-2 rounded-full ${status === "error" ? "bg-red-400" : status === "complete" ? "bg-green-400" : "bg-zinc-600"}`} />
      )}
      STATUS: <span className={status === "error" ? "text-red-400" : status === "complete" ? "text-green-400" : "text-zinc-300"}>{label}</span>
    </div>
  );
}

export default function VideoAudit() {
  const [title, setTitle] = useState("DJZS video claim audit");
  const [thesis, setThesis] = useState("");
  const [context, setContext] = useState("");
  const [moduleName, setModuleName] = useState<ModuleName>("dst_claim");
  const [paymentProof, setPaymentProof] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [videoUid, setVideoUid] = useState<string | null>(null);
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const canSubmit = useMemo(() => thesis.trim().length >= 20 && status !== "uploading" && status !== "auditing" && status !== "creating-upload" && status !== "signing", [thesis, status]);

  const headers = useMemo(() => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (paymentProof.trim()) h["x-payment-proof"] = paymentProof.trim();
    return h;
  }, [paymentProof]);

  async function generateReceipt() {
    setError(null);
    setReceipt(null);
    setIframeUrl(null);
    setVideoUid(null);

    try {
      let uploadedVideoUid: string | undefined;

      if (file) {
        setStatus("creating-upload");
        const uploadUrlResponse = await fetch("/api/stream/upload-url", {
          method: "POST",
          headers,
          body: JSON.stringify({ title, maxDurationSeconds: 600, creator: "djzs.io" }),
        });

        if (!uploadUrlResponse.ok) {
          const data = await uploadUrlResponse.json().catch(() => ({}));
          throw new Error(data.error || "Could not create Cloudflare Stream upload URL.");
        }

        const uploadData = await uploadUrlResponse.json();
        uploadedVideoUid = uploadData.videoUid;
        if (!uploadedVideoUid) {
          throw new Error("Cloudflare Stream did not return a video UID.");
        }
        setVideoUid(uploadedVideoUid);

        setStatus("uploading");
        const form = new FormData();
        form.append("file", file);
        const uploadResponse = await fetch(uploadData.uploadURL, { method: "POST", body: form });
        if (!uploadResponse.ok) throw new Error("Video upload failed. Try a shorter clip first.");
      }

      setStatus("auditing");
      const auditResponse = await fetch("/api/dst/video-audit", {
        method: "POST",
        headers,
        body: JSON.stringify({
          title,
          thesis,
          context,
          module: moduleName,
          videoUid: uploadedVideoUid,
          creator: "djzs.io",
        }),
      });

      const auditData = await auditResponse.json().catch(() => ({}));
      if (!auditResponse.ok) throw new Error(auditData.error || "Video audit failed.");
      setReceipt(auditData);

      if (uploadedVideoUid) {
        setStatus("signing");
        const tokenResponse = await fetch("/api/stream/playback-token", {
          method: "POST",
          headers,
          body: JSON.stringify({ videoUid: uploadedVideoUid, expiresInSeconds: 3600 }),
        });
        const tokenData = await tokenResponse.json().catch(() => ({}));
        if (tokenResponse.ok && tokenData.iframeUrl) setIframeUrl(tokenData.iframeUrl);
      }

      setStatus("complete");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function copyReceipt() {
    if (!receipt) return;
    await navigator.clipboard.writeText(JSON.stringify(receipt, null, 2));
  }

  return (
    <main className="min-h-screen bg-black text-white px-4 py-8">
      <div className="max-w-5xl mx-auto">
        <Link href="/" className="inline-flex items-center gap-2 font-mono text-xs text-zinc-500 hover:text-green-400 mb-8">
          <ArrowLeft size={14} /> BACK TO DJZS
        </Link>

        <section className="border border-zinc-800 bg-zinc-950 p-6 sm:p-8 mb-6">
          <div className="font-mono text-xs tracking-[0.35em] text-green-400 mb-4">API // VERIFIED REASONING MEDIA</div>
          <h1 className="font-mono text-3xl sm:text-5xl font-bold leading-tight mb-4">
            VIDEO CLAIM AUDIT.
          </h1>
          <p className="font-mono text-sm sm:text-base text-zinc-400 leading-relaxed max-w-3xl">
            Upload a short thesis explanation video. DJZS audits the written claim, attaches the Cloudflare Stream UID, and returns strict JSON plus a verifiable receipt. The video explains the human context; the deterministic engine owns the verdict.
          </p>
        </section>

        <div className="grid lg:grid-cols-[1fr_420px] gap-6">
          <section className="border border-zinc-800 bg-black p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4 mb-6">
              <div className="font-mono text-xs text-zinc-500">POST /API/DST/VIDEO-AUDIT</div>
              <div className="font-mono text-xs text-green-400 border border-green-400/60 px-3 py-1">$0.25</div>
            </div>

            <label className="block font-mono text-xs text-zinc-500 mb-2">MODULE</label>
            <div className="grid sm:grid-cols-2 gap-2 mb-5">
              {MODULES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setModuleName(m.value)}
                  className={`text-left border p-3 transition-colors ${moduleName === m.value ? "border-green-400/70 bg-green-400/10" : "border-zinc-800 hover:border-zinc-700"}`}
                >
                  <div className="font-mono text-xs text-zinc-200">{m.label}</div>
                  <div className="font-mono text-[10px] text-zinc-600 mt-1">{m.hint}</div>
                </button>
              ))}
            </div>

            <label className="block font-mono text-xs text-zinc-500 mb-2">TITLE</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 px-4 py-3 font-mono text-sm text-zinc-200 outline-none focus:border-green-400/60 mb-5"
            />

            <label className="block font-mono text-xs text-zinc-500 mb-2">THESIS / CLAIM</label>
            <textarea
              value={thesis}
              onChange={(e) => setThesis(e.target.value)}
              rows={7}
              placeholder="I believe this market is mispriced because... Risk is invalidated if... Time horizon is..."
              className="w-full bg-zinc-950 border border-zinc-800 px-4 py-3 font-mono text-sm text-zinc-200 outline-none focus:border-green-400/60 mb-5"
            />

            <label className="block font-mono text-xs text-zinc-500 mb-2">OPTIONAL CONTEXT</label>
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={4}
              placeholder="Market, source links, deadline, invalidation level, risk notes..."
              className="w-full bg-zinc-950 border border-zinc-800 px-4 py-3 font-mono text-sm text-zinc-200 outline-none focus:border-green-400/60 mb-5"
            />

            <label className="block font-mono text-xs text-zinc-500 mb-2">OPTIONAL VIDEO</label>
            <label className="flex items-center justify-center gap-3 border border-dashed border-zinc-700 bg-zinc-950 px-4 py-6 cursor-pointer hover:border-green-400/50 transition-colors mb-5">
              <Upload size={18} className="text-green-400" />
              <span className="font-mono text-xs text-zinc-400">{file ? file.name : "Upload short thesis explanation clip"}</span>
              <input type="file" accept="video/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </label>

            <label className="block font-mono text-xs text-zinc-500 mb-2">MPP / X402 PAYMENT PROOF</label>
            <input
              value={paymentProof}
              onChange={(e) => setPaymentProof(e.target.value)}
              placeholder="Optional in dev. Required in production if payment gate is enabled."
              className="w-full bg-zinc-950 border border-zinc-800 px-4 py-3 font-mono text-xs text-zinc-200 outline-none focus:border-green-400/60 mb-5"
            />

            <button
              onClick={generateReceipt}
              disabled={!canSubmit}
              className="w-full bg-green-400 text-black font-mono text-xs font-bold px-5 py-3 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-green-300 transition-colors"
            >
              GENERATE VIDEO RECEIPT
            </button>

            <div className="mt-5"><StatusLine status={status} /></div>
            {error && <div className="mt-4 border border-red-400/40 bg-red-400/10 p-3 font-mono text-xs text-red-300">{error}</div>}
          </section>

          <aside className="space-y-6">
            <div className="border border-zinc-800 bg-zinc-950 p-5">
              <div className="flex items-center gap-2 font-mono text-xs text-zinc-300 mb-4"><ShieldCheck size={15} className="text-green-400" /> RECEIPT MODEL</div>
              <div className="space-y-3 font-mono text-xs text-zinc-500">
                <div>Video = Cloudflare Stream media layer</div>
                <div>Verdict = DJZS deterministic engine</div>
                <div>Proof = JSON receipt + Irys anchor</div>
                <div>Playback = signed token only</div>
              </div>
            </div>

            {videoUid && (
              <div className="border border-zinc-800 bg-zinc-950 p-5">
                <div className="flex items-center gap-2 font-mono text-xs text-zinc-300 mb-3"><Video size={15} className="text-green-400" /> STREAM UID</div>
                <div className="font-mono text-xs text-zinc-500 break-all">{videoUid}</div>
              </div>
            )}

            {iframeUrl && (
              <div className="border border-zinc-800 bg-black overflow-hidden">
                <iframe
                  src={iframeUrl}
                  title="DJZS video audit playback"
                  allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
                  allowFullScreen
                  className="w-full aspect-video"
                />
              </div>
            )}

            {receipt && (
              <div className="border border-green-400/40 bg-green-400/5 p-5">
                <div className="flex items-center justify-between gap-3 mb-4">
                  <div className="font-mono text-xs text-green-400">{receipt.verdict} // {receipt.risk_score}</div>
                  <button onClick={copyReceipt} className="font-mono text-[10px] text-zinc-500 hover:text-green-400 flex items-center gap-1"><Copy size={11} /> COPY JSON</button>
                </div>

                <div className="space-y-3 font-mono text-xs">
                  <div>
                    <div className="text-zinc-600">RECEIPT_ID</div>
                    <div className="text-zinc-300 break-all">{receipt.receipt_id}</div>
                  </div>
                  <div>
                    <div className="text-zinc-600">RECEIPT_HASH</div>
                    <div className="text-zinc-300">{shortHash(receipt.receipt_hash)}</div>
                  </div>
                  <div>
                    <div className="text-zinc-600">LOGIC_HASH</div>
                    <div className="text-zinc-300">{shortHash(receipt.logic_hash)}</div>
                  </div>
                  <div>
                    <div className="text-zinc-600">FLAGS</div>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {receipt.flags.length ? receipt.flags.map((flag) => (
                        <span key={flag.code} className="border border-zinc-700 px-2 py-1 text-zinc-400">{flag.code}</span>
                      )) : <span className="text-green-400">NONE</span>}
                    </div>
                  </div>
                  {receipt.irys_url && (
                    <a href={receipt.irys_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-green-400 hover:text-green-300">
                      VERIFY ON IRYS <ExternalLink size={11} />
                    </a>
                  )}
                  {receipt.irys_error && <div className="text-amber-400">IRYS: {receipt.irys_error}</div>}
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
