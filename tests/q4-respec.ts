// Q4 — RESPEC CONVERSION. Does applying a FAIL's stated fix open the gate? Engine-run, K replays each, no payment.
// Input: tests/q4/pairs.json = [{ "id":"N5-0902", "fix":"state the NFP threshold; bind FOMC+NFP", "original":{...intent}, "respec":{...intent} }, ...]
// Run:   npx tsx tests/q4-respec.ts            (K=3 default; K=5 npx tsx ... for tighter)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extractAuditInputConsensus, EXTRACTION_CONTRACT_VERSION, type ModelFn } from "../server/engine-v2/extraction-layer";
import { runDeterministicAudit } from "../server/engine-v2/deterministic-engine";
const render=(i:Record<string,unknown>)=>Object.keys(i).sort().map(k=>{const v=i[k];return `${k}: ${typeof v==="string"?v:(typeof v==="number"||typeof v==="boolean")?String(v):JSON.stringify(v)}`}).join("\n");
const key=(()=>{if(process.env.ANTHROPIC_API_KEY)return process.env.ANTHROPIC_API_KEY;for(const l of readFileSync("djzs-trust-mcp/.dev.vars","utf8").split("\n")){const m=l.match(/^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?\s*$/);if(m)return m[1].trim()}throw new Error("no ANTHROPIC_API_KEY")})();
const model:ModelFn=async(prompt)=>{for(let a=1;a<=4;a++){let r:Response;try{r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:1024,temperature:0,messages:[{role:"user",content:prompt}]})})}catch(e){if(a<4){await new Promise(z=>setTimeout(z,2500*a));continue}throw e}
 if(r.status===429||r.status===529||r.status>=500){await new Promise(z=>setTimeout(z,1500*a));continue} if(!r.ok)throw new Error(`API ${r.status}`);const d=await r.json() as any;return d.content?.[0]?.text??""}throw new Error("retries exhausted")};
const K=Number(process.env.K??3);
type V={verdict:string;codes:string[];risk:number;unknown:string[]};
async function audit(intent:Record<string,unknown>):Promise<V[]>{const text=render(intent);const out:V[]=[];for(let k=0;k<K;k++){const r=await extractAuditInputConsensus(text,model,3);
 if(r.input.audit_context!=="prediction_market"){out.push({verdict:"OUT_OF_SCOPE",codes:[],risk:0,unknown:[]});continue}
 const e=runDeterministicAudit(r.input);out.push({verdict:e.verdict,codes:e.flags.map(f=>f.code).sort(),risk:e.risk_score,unknown:e.unknown_fields})}return out}
const mode=(xs:string[])=>{const c:Record<string,number>={};for(const x of xs)c[x]=(c[x]??0)+1;return Object.entries(c).sort((a,b)=>b[1]-a[1])[0]};
const rank={PASS:0,WAIT:1,FAIL:2,OUT_OF_SCOPE:3} as Record<string,number>;
(async()=>{const pairs=JSON.parse(readFileSync("tests/q4/pairs.json","utf8")) as {id:string;fix:string;original:Record<string,unknown>;respec:Record<string,unknown>}[];
 console.log(`Q4 respec conversion · engine ${EXTRACTION_CONTRACT_VERSION} · K=${K} · ${pairs.length} pairs · ${pairs.length*2*K*3} model calls\n`);
 const rows:any[]=[];let converted=0,opened=0;
 for(const p of pairs){const o=await audit(p.original),r=await audit(p.respec);
  const [ov,oc]=mode(o.map(x=>x.verdict)),[rv,rc]=mode(r.map(x=>x.verdict));const [ocodes]=mode(o.map(x=>x.codes.join("+")||"—")),[rcodes]=mode(r.map(x=>x.codes.join("+")||"—"));
  const conv=rank[rv]<rank[ov];const open=rv==="PASS";if(conv)converted++;if(open)opened++;
  const decision=(p.original as any).side!==(p.respec as any).side?"side":((p.original as any).size_usd!==(p.respec as any).size_usd?"size":(JSON.stringify((p.original as any).bounds)!==JSON.stringify((p.respec as any).bounds)?"exit":"none"));
  console.log(`${p.id.padEnd(10)} ${ov.padEnd(5)} ${String(oc)}/${K} ${ocodes.padEnd(22)} → ${rv.padEnd(5)} ${String(rc)}/${K} ${rcodes.padEnd(22)} ${conv?"CONVERTED":"no change"}${open?" · GATE OPEN":""}  decision Δ: ${decision}   fix: ${p.fix}`);
  rows.push({id:p.id,fix:p.fix,original:{verdict:ov,stability:oc/K,codes:ocodes,runs:o},respec:{verdict:rv,stability:rc/K,codes:rcodes,runs:r},converted:conv,gate_open:open,decision_delta:decision})}
 console.log(`\nconverted ${converted}/${pairs.length} · gate opened ${opened}/${pairs.length}`);
 mkdirSync("tests/q4/out",{recursive:true});const f=`tests/q4/out/q4-${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}.json`;
 writeFileSync(f,JSON.stringify({contract:EXTRACTION_CONTRACT_VERSION,K,rows},null,2));console.log(`raw → ${f}`)})();
