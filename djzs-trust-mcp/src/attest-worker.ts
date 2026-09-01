import {
  createWalletClient, createPublicClient, http, parseAbi,
  encodeAbiParameters, decodeAbiParameters, decodeEventLog, formatEther,
  type Hex, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { schemaUID, ZERO32, intentHash } from "./djzs-intent";

export { intentHash };
export const EAS_ADDRESS     = "0x4200000000000000000000000000000000000021" as const;
export const DJZS_SCHEMA_UID = schemaUID();
export const ATTESTER        = "0xfB0e11471D41f88D1eE43A1bA38d885fb6b77824" as const;

const EAS_ABI = parseAbi([
  "function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)",
  "function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))",
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
]);
const VERDICT_PARAMS = [{ type: "bytes32" }, { type: "string" }, { type: "uint8" }, { type: "string[]" }, { type: "string" }] as const;

export type Verdict = "PASS" | "WAIT" | "FAIL";
export type VerdictAttestation = { intentHash: Hex; verdict: Verdict; riskScore: number; flags: string[]; rulesetVersion: string; agent: Address };
export type WorkerEnv = { DJZS_ATTESTER_KEY: string; BASE_RPC_URL?: string };

export function encodeVerdict(v: VerdictAttestation): Hex {
  if (!["PASS","WAIT","FAIL"].includes(v.verdict)) throw new Error(`bad verdict ${v.verdict}`);
  if (!Number.isInteger(v.riskScore) || v.riskScore < 0 || v.riskScore > 100) throw new Error("riskScore must be int 0-100");
  return encodeAbiParameters(VERDICT_PARAMS, [v.intentHash, v.verdict, v.riskScore, v.flags, v.rulesetVersion]);
}
export function decodeVerdict(data: Hex) {
  const [intentHash, verdict, riskScore, flags, rulesetVersion] = decodeAbiParameters(VERDICT_PARAMS, data);
  return { intentHash, verdict: verdict as Verdict, riskScore, flags: [...flags], rulesetVersion };
}
function clients(env: WorkerEnv) {
  const k = env.DJZS_ATTESTER_KEY;
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("HALT: DJZS_ATTESTER_KEY unset or malformed");
  const transport = http(env.BASE_RPC_URL ?? "https://mainnet.base.org");
  const account = privateKeyToAccount(k as Hex);
  return { account, wallet: createWalletClient({ account, chain: base, transport }), pub: createPublicClient({ chain: base, transport }) };
}
export async function attestVerdict(env: WorkerEnv, v: VerdictAttestation): Promise<{ uid: Hex; txHash: Hex; block: bigint }> {
  const { wallet, pub } = clients(env);
  const txHash = await wallet.writeContract({ address: EAS_ADDRESS, abi: EAS_ABI, functionName: "attest",
    args: [{ schema: DJZS_SCHEMA_UID, data: { recipient: v.agent, expirationTime: 0n, revocable: false, refUID: ZERO32, data: encodeVerdict(v), value: 0n } }] });
  const rc = await pub.waitForTransactionReceipt({ hash: txHash });
  if (rc.status !== "success") throw new Error(`attest reverted: ${txHash}`);
  for (const log of rc.logs) {
    if (log.address.toLowerCase() !== EAS_ADDRESS.toLowerCase()) continue;
    try { const ev = decodeEventLog({ abi: EAS_ABI, data: log.data, topics: log.topics });
          if (ev.eventName === "Attested") return { uid: ev.args.uid, txHash, block: rc.blockNumber }; } catch {}
  }
  throw new Error(`attest mined but no Attested event: ${txHash}`);
}
export function attestVerdictDeferred(env: WorkerEnv, v: VerdictAttestation, onDone: (r: { uid: Hex; txHash: Hex } | Error) => Promise<void> | void): Promise<void> {
  return attestVerdict(env, v).then(r => onDone(r), e => onDone(e instanceof Error ? e : new Error(String(e))));
}
export async function readAttestation(uid: Hex, rpc = "https://mainnet.base.org") {
  const pub = createPublicClient({ chain: base, transport: http(rpc) });
  const a = await pub.readContract({ address: EAS_ADDRESS, abi: EAS_ABI, functionName: "getAttestation", args: [uid] });
  return { uid: a.uid, schema: a.schema, time: a.time, recipient: a.recipient, attester: a.attester, revoked: a.revocationTime !== 0n,
    isDJZS: a.schema.toLowerCase() === DJZS_SCHEMA_UID.toLowerCase() && a.attester.toLowerCase() === ATTESTER.toLowerCase(), fields: decodeVerdict(a.data) };
}
export async function attesterBalance(env: WorkerEnv): Promise<{ address: Address; eth: string; low: boolean }> {
  const { account, pub } = clients(env);
  const wei = await pub.getBalance({ address: account.address });
  return { address: account.address, eth: formatEther(wei), low: wei < 200_000_000_000_000n };
}
