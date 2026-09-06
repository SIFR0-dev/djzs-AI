// fill25 — q3-verify: optional third-source cross-check of Polymarket VWAPs via Surf's indexed trades (use 6). WARN by default; CROSS_CHECK=strict fails; CROSS_CHECK=off skips. Never record-bearing.
import { readFileSync, writeFileSync } from "fs";
const R=process.env.REPO||"."; const V=R+"/tests/q3/q3-verify.ts"; let v=readFileSync(V,"utf8"); const fails=[],ch=[];
const once=(s,n,lab)=>{const k=s.split(n).length-1;if(k!==1)fails.push(lab+": "+k);return k===1};
const V0='import { kalshiVwap } from "./kalshi-client";';
if(!v.includes('from "./tape/surf"')&&once(v,V0,"verify import")){v=v.replace(V0,V0+'\nimport { surf, surfAvailable, rows } from "./tape/surf";');ch.push("verify: import tape client")}
const V1='  if (priceChecks.length) {';
const N1=`  // v1.4 use 6 — third-source cross-check (Surf-indexed Polymarket trades) on Dune-priced records. Tape tier: WARN by default, never record-bearing.
  const CROSS = process.env.CROSS_CHECK ?? "warn";
  if (CROSS !== "off" && priceChecks.length && surfAvailable()) {
    for (const pc of priceChecks) { try { const q = pc.ps.query_params; const end = Math.floor(new Date(q.captured_at).getTime() / 1000); const start = end - Number(q.window_min ?? 60) * 60;
        const rec = JSON.parse(readFileSync(\`\${REC_DIR}/\${pc.id.slice(3, 13)}.json\`, "utf8")).find((r: any) => r.id === pc.id); const side = String(rec?.market?.side ?? "YES") === "NO" ? "No" : "Yes";
        const t = rows(surf("polymarket-trades", ["--condition-id", String(rec.market.ticker), "--outcome-label", side, "--type", "trade", "--from", String(start), "--to", String(end), "--limit", "500"]), pc.id);
        let num = 0, den = 0; for (const x of t as any[]) { const px = Number(x.price ?? x.price_usd); const sz = Number(x.size ?? x.shares ?? (x.amount_usd && px ? x.amount_usd / px : 0)); if (px > 0 && sz > 0) { num += px * sz; den += sz; } }
        const v3 = den ? num / den : NaN; const d = Math.abs(v3 - pc.price);
        if (!Number.isFinite(v3)) warns.push(\`\${pc.id}: Surf cross-check — no trades returned (\${t.length} rows)\`);
        else if (d > 0.02) (CROSS === "strict" ? fails : warns).push(\`\${pc.id}: Surf cross-check vwap \${v3.toFixed(4)} vs Dune \${pc.price} (Δ \${d.toFixed(4)} > 0.02)\`);
        else warns.push(\`\${pc.id}: Surf cross-check agrees (Δ \${d.toFixed(4)})\`);
      } catch (e) { warns.push(\`\${pc.id}: Surf cross-check unavailable — \${(e as Error).message.slice(0, 100)}\`); } }
  }
`+V1;
if(!v.includes("Surf cross-check")&&once(v,V1,"verify async start")){v=v.replace(V1,N1);ch.push("verify: third-source cross-check (warn-level)")}
if(fails.length){console.error("ABORT — nothing written:\n  "+fails.join("\n  "));process.exit(1)} writeFileSync(V,v); console.log("APPLIED:\n  "+ch.join("\n  "));
