// M03 probe: raw per-sample output for probability_basis on P1-P3. 9 calls.
import { readFileSync } from "node:fs";
import { extractAuditInput, type ModelFn } from "../server/engine-v2/extraction-layer";
const render=(i:Record<string,unknown>)=>Object.keys(i).sort().map(k=>{const v=i[k];return `${k}: ${typeof v==="string"?v:(typeof v==="number"||typeof v==="boolean")?String(v):JSON.stringify(v)}`}).join("\n");
const key=(()=>{if(process.env.ANTHROPIC_API_KEY)return process.env.ANTHROPIC_API_KEY;for(const l of readFileSync("djzs-trust-mcp/.dev.vars","utf8").split("\n")){const m=l.match(/^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?\s*$/);if(m)return m[1].trim()}throw new Error("no key")})();
const model:ModelFn=async(prompt)=>{const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:1024,temperature:0,messages:[{role:"user",content:prompt}]})});if(!r.ok)throw new Error(`API ${r.status}`);const d=await r.json() as any;return d.content?.[0]?.text??""};
const P:Record<string,Record<string,unknown>>={
 P1:{market:"KXBTCD-26SEP0217-T76999.99",side:"YES",thesis:"Resolves YES on a Sep 2 close above $77,000. BTC is at $77,263 and it feels like it holds.",probability_basis:"gut feel; it just looks strong",size_usd:250,bounds:{max_loss_usd:250,exit_condition:"exit on an hourly close below $77,000"}},
 P2:{market:"KXFEDDECISION-26SEP",side:"YES",thesis:"Resolves YES if the FOMC cuts on Sep 17. Everyone knows a cut is coming.",probability_basis:"consensus; everyone expects it",size_usd:400,bounds:{max_loss_usd:400,exit_condition:"exit if a voting member publicly opposes a cut"}},
 P3:{market:"polymarket:eth-above-4000-sep-30",side:"NO",thesis:"Resolves on the Sep 30 Coinbase close vs $4,000. ETH at $3,610 won't make it; the chart looks heavy.",probability_basis:"chart looks heavy",size_usd:300,bounds:{max_loss_usd:300,exit_condition:"exit if ETH closes above $3,850"}}};
const cws=(s:string)=>s.replace(/\s+/g," ").trim();
(async()=>{for(const [id,intent] of Object.entries(P)){const text=render(intent);console.log(`\n${id}`);
 for(let s=1;s<=3;s++){const r=await extractAuditInput(text,model);let j:any=null;try{const raw=r.raw;j=JSON.parse(raw.slice(raw.indexOf("{"),raw.lastIndexOf("}")+1))}catch{}
  const pb=j?.probability_basis, ec=j?.edge_claim;
  const quoteOk=pb?.state==="absent"&&typeof pb.quote==="string"&&cws(text).includes(cws(pb.quote));
  console.log(`  sample ${s}: RAW probability_basis=${JSON.stringify(pb)}  quote_verbatim=${pb?.state==="absent"?quoteOk:"n/a"}  → post-gate=${r.input.probability_basis.state}   | RAW edge_claim.state=${ec?.state}`);}}})();
