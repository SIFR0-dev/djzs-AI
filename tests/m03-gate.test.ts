import { extractAuditInput } from "../server/engine-v2/extraction-layer";
import { runDeterministicAudit } from "../server/engine-v2/deterministic-engine";
const text=`bounds: {"max_loss_usd":250,"exit_condition":"exit on an hourly close below $77,000"}
market: KXBTCD-26SEP0217-T76999.99
probability_basis: gut feel; it just looks strong
side: YES
size_usd: 250
thesis: Resolves YES on a Sep 2 close above $77,000. BTC is at $77,263 and it feels like it holds.`;
const stub=async()=>JSON.stringify({agent_type:"a",intended_action:"bet",audit_context:"prediction_market",leverage:{state:"absent"},position_size:{state:"present",value:250},stop_loss:{state:"absent"},take_profit:{state:"absent"},
 invalidation_condition:{state:"present",value:"exit on an hourly close below $77,000"},resolution_engagement:{state:"present",value:"Resolves YES on a Sep 2 close above $77,000"},
 probability_basis:{state:"absent",quote:"gut feel; it just looks strong"},edge_claim:{state:"unknown"},data_sources:{state:"absent"},oracle_source:{state:"absent"},confidence:{state:"absent"}});
(async()=>{const r=await extractAuditInput(text,stub); const e=runDeterministicAudit(r.input);
console.log(`post-gate probability_basis=${r.input.probability_basis.state} → verdict=${e.verdict} codes=${e.flags.map(f=>f.code).join("+")} risk=${e.risk_score}`);
console.log(r.input.probability_basis.state==="absent"&&e.flags.some(f=>f.code==="DJZS-M03")?"v1.1 PROOF PASS — absent survives, M03 fires":"PROOF FAIL");})();
