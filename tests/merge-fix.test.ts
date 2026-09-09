/** Consensus merge: a 2-of-3 "present" on an objective numeric fact must survive one dissenting sample (offline). */
import { extractAuditInputConsensus } from "../server/engine-v2/extraction-layer";
import { runDeterministicAudit } from "../server/engine-v2/deterministic-engine";
const good: any = { agent_type:"t", intended_action:"open", market_type:"perp", leverage:{state:"present",value:10}, position_size:{state:"present",value:3000}, stop_loss:{state:"present",value:79800}, take_profit:{state:"present",value:73000}, invalidation_condition:{state:"unknown"}, thesis_statement:{state:"absent",quote:"Short BTC, entry $77,481.55"}, resolution_engagement:{state:"unknown"}, probability_basis:{state:"unknown"}, edge_claim:{state:"unknown"}, data_sources:{state:"unknown"}, oracle_source:{state:"unknown"}, confidence:{state:"unknown"} };
const dissent: any = { ...good, leverage:{state:"unknown"}, position_size:{state:"unknown"} };
const INTENT="Short BTC, entry $77,481.55, $3,000 notional, 10x leverage, stop $79,800, TP $73,000.";
(async () => {
  let c1=0; const m1=async()=>JSON.stringify(c1++===1?dissent:good);
  const r=await extractAuditInputConsensus(INTENT,m1,3,"perp"); const e=runDeterministicAudit(r.input);
  let c2=0; const m2=async()=>JSON.stringify(c2++===0?good:dissent);
  const r2=await extractAuditInputConsensus(INTENT,m2,3,"perp"); const e2=runDeterministicAudit(r2.input);
  const ok = r.input.leverage.state==="present" && r.input.position_size.state==="present" && e.verdict==="FAIL" && e.flags.some((f:any)=>f.code==="DJZS-S01") && r2.input.leverage.state==="unknown" && e2.verdict==="WAIT";
  console.log(`2:1 present → ${e.verdict} ${e.flags.map((f:any)=>f.code)} · 1:2 present → ${e2.verdict}`);
  console.log(ok?"MERGE FIX PASS":"MERGE FIX FAIL"); if(!ok) process.exit(1);
})();
