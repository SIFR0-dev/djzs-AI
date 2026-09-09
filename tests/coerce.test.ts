/** coerceField widening: bare values and stateless {value} are PRESENT; absent is never inferred; PM path unaffected. */
import { extractAuditInputConsensus } from "../server/engine-v2/extraction-layer";
import { runDeterministicAudit } from "../server/engine-v2/deterministic-engine";
const bare: any = { agent_type:"t", intended_action:"open", market_type:"perp", leverage: 10, position_size: 3000, stop_loss: 79800, take_profit: { value: 73000 }, invalidation_condition:{state:"unknown"}, thesis_statement:{state:"absent",quote:"Short BTC, entry $77,481.55"}, resolution_engagement:{state:"unknown"}, probability_basis:{state:"unknown"}, edge_claim:{state:"unknown"}, data_sources:["Binance"], oracle_source:"Binance mark", confidence: null };
const INTENT="Short BTC, entry $77,481.55, $3,000 notional, 10x leverage, stop $79,800, TP $73,000.";
(async () => {
  const r=await extractAuditInputConsensus(INTENT, async()=>JSON.stringify(bare), 3, "perp"); const e=runDeterministicAudit(r.input);
  const st=(f:string)=>(r.input as any)[f].state;
  const strAbsent: any = { ...bare, thesis_statement: "absent" };
  const r2=await extractAuditInputConsensus(INTENT, async()=>JSON.stringify(strAbsent), 3, "perp");
  const ok = ["leverage","position_size","stop_loss","take_profit","data_sources","oracle_source"].every(f=>st(f)==="present") && st("confidence")==="unknown" && e.verdict==="FAIL" && e.flags.some((f:any)=>f.code==="DJZS-S01") && r2.input.thesis_statement.state==="unknown";
  console.log(`bare values → ${e.verdict} ${e.flags.map((f:any)=>f.code)} · bare "absent" string → ${r2.input.thesis_statement.state}`);
  console.log(ok?"COERCE TEST PASS":"COERCE TEST FAIL"); if(!ok) process.exit(1);
})();
