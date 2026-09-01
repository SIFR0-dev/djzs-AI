// Exhaustive PM verdict-space test against the real deterministic engine. No LLM, no network.
import { runDeterministicAudit, type EngineResult } from "../server/engine-v2/deterministic-engine";
import type { AuditInput, Field } from "../server/engine-v2/audit-input-schema";
import { PM_FAIL_THRESHOLD, PM_TAXONOMY } from "../shared/pm-taxonomy";
type S="present"|"absent"|"unknown"; const STATES:S[]=["present","absent","unknown"];
const f=<T,>(s:S,v:T):Field<T>=>s==="present"?{state:"present",value:v}:{state:s};
function mk(inv:S,res:S,prob:S,edge:S|"omitted"):AuditInput{const b:any={agent_type:"t",intended_action:"bet",audit_context:"prediction_market",
 leverage:{state:"absent"},position_size:{state:"present",value:250},stop_loss:{state:"absent"},take_profit:{state:"absent"},
 invalidation_condition:f(inv,"x"),resolution_engagement:f(res,"y"),probability_basis:f(prob,"z"),
 data_sources:{state:"present",value:["c"]},oracle_source:{state:"present",value:"k"},confidence:{state:"absent"}};
 if(edge!=="omitted")b.edge_claim=f(edge,"e");return b}
const rows:{inv:S;res:S;prob:S;edge:string;r:EngineResult;r2:EngineResult}[]=[];
for(const inv of STATES)for(const res of STATES)for(const prob of STATES)for(const edge of [...STATES,"omitted"] as const)rows.push({inv,res,prob,edge,r:runDeterministicAudit(mk(inv,res,prob,edge)),r2:runDeterministicAudit(mk(inv,res,prob,edge))});
const fails:string[]=[];const ok=(c:boolean,m:string)=>{if(!c)fails.push(m)};const codes=(r:EngineResult)=>r.flags.map(x=>x.code).sort().join("+")||"—";
for(const x of rows){ok(["PASS","WAIT","FAIL"].includes(x.r.verdict),`totality ${x.inv}/${x.res}/${x.prob}/${x.edge}`);
 ok(x.r.verdict_hash===x.r2.verdict_hash&&x.r.verdict_hash.length===66&&x.r.verdict_hash.startsWith("0x"),`determinism ${x.inv}/${x.res}/${x.prob}/${x.edge}`);
 const crit=x.r.flags.some(fl=>fl.severity==="CRITICAL");if(crit)ok(x.r.verdict==="FAIL",`critical->FAIL ${codes(x.r)}`);
 if(x.r.risk_score>=PM_FAIL_THRESHOLD)ok(x.r.verdict==="FAIL",`threshold ${x.r.risk_score}`);
 if(x.r.verdict==="PASS")ok(x.inv==="present"&&x.res==="present"&&x.prob==="present"&&x.r.unknown_fields.length===0,`PASS invariant ${x.inv}/${x.res}/${x.prob}`);
 if(x.r.verdict==="WAIT")ok(x.r.unknown_fields.length>0&&!crit,`WAIT invariant`)}
const key=(a:S,b:S,c:S,d:string)=>`${a}|${b}|${c}|${d}`;const idx=new Map(rows.map(x=>[key(x.inv,x.res,x.prob,x.edge),x]));const order:S[]=["present","unknown","absent"];const V={PASS:0,WAIT:1,FAIL:2} as const;
for(const x of rows)for(const dim of ["inv","res","prob"] as const){const i=order.indexOf(x[dim] as S);if(i===2)continue;const n:any={...x,[dim]:order[i+1]};const y=idx.get(key(n.inv,n.res,n.prob,n.edge))!;
 ok(y.r.risk_score>=x.r.risk_score,`risk non-monotone on ${dim}`);ok(V[y.r.verdict]>=V[x.r.verdict],`verdict improved on degrading ${dim}`)}
const m04=idx.get(key("present","present","present","absent"))!;ok(m04.r.verdict==="PASS"&&codes(m04.r)==="DJZS-M04"&&m04.r.risk_score===15,"solo M04 rides PASS at 15");
const m34=idx.get(key("present","present","absent","absent"))!;ok(m34.r.verdict==="FAIL"&&m34.r.risk_score===40,"M03+M04 FAIL at 40");
ok(Object.values(PM_TAXONOMY).reduce((s,d)=>s+d.weight,0)===100,"weights sum 100");
const dist:Record<string,number>={};for(const x of rows)dist[x.r.verdict]=(dist[x.r.verdict]||0)+1;
console.log(`PM verdict space: ${rows.length} inputs · distribution ${JSON.stringify(dist)} · distinct hashes ${new Set(rows.map(x=>x.r.verdict_hash)).size}`);
if(fails.length){console.error("FAIL:\n  "+fails.join("\n  "));process.exit(1)}console.log("PASS — 8 engine properties hold across the full PM space");
