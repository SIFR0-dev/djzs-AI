import {
  createWalletClient, createPublicClient, http, parseAbi,
  encodeAbiParameters, decodeAbiParameters, decodeEventLog, encodePacked, formatEther, keccak256,
  type Hex, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { schemaUID, ZERO32, intentHash } from "./djzs-intent";

export { intentHash };
export const EAS_ADDRESS     = "0x4200000000000000000000000000000000000021" as const;
export const DJZS_SCHEMA_UID = schemaUID();
export const ATTESTER        = "0xfB0e11471D41f88D1eE43A1bA38d885fb6b77824" as const;

/**
 * Schema v3 (DJZS-VR-v1.0): the v2 fields verbatim, then the rest of the tally. Registered with
 * DJZSVerdictResolver as its resolver and revocable = false, so its UID depends on the resolver's
 * address: schemaUIDv3(resolver). The resolver derives the verdict from the tally with
 * DJZSVerdictRule and refuses the attestation when the stated verdict or risk score differs.
 * Must equal DJZSVerdictResolver.SCHEMA, character for character.
 */
export const EAS_SCHEMA_V3 =
  "bytes32 intentHash,string verdict,uint8 riskScore,string[] flags,string rulesetVersion,uint8 unknownCount,bool bounded,bool thesisPresent" as const;
export function schemaUIDv3(resolver: Address): Hex {
  return keccak256(encodePacked(["string", "address", "bool"], [EAS_SCHEMA_V3, resolver, false]));
}
/** The schema a Worker attests under: v3 when a resolver is configured, else v2. */
export function schemaUIDFor(resolver?: string): Hex {
  return isAddress(resolver) ? schemaUIDv3(resolver) : DJZS_SCHEMA_UID;
}
export function isAddress(x: unknown): x is Address {
  return typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
}

const EAS_ABI = parseAbi([
  "function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)",
  "function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))",
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
]);
const VERDICT_PARAMS = [{ type: "bytes32" }, { type: "string" }, { type: "uint8" }, { type: "string[]" }, { type: "string" }] as const;
const VERDICT_PARAMS_V3 = [...VERDICT_PARAMS, { type: "uint8" }, { type: "bool" }, { type: "bool" }] as const;

export type Verdict = "PASS" | "WAIT" | "FAIL";
/** The rest of the tally (DJZS-VR-v1.0). Only a v3 attestation carries it. */
export type AttestedTally = { unknownCount: number; bounded: boolean; thesisPresent: boolean };
export type VerdictAttestation = { intentHash: Hex; verdict: Verdict; riskScore: number; flags: string[]; rulesetVersion: string; agent: Address; tally?: AttestedTally };
export type WorkerEnv = { DJZS_ATTESTER_KEY: string; BASE_RPC_URL?: string };

function checkVerdictFields(v: VerdictAttestation): void {
  if (!["PASS","WAIT","FAIL"].includes(v.verdict)) throw new Error(`bad verdict ${v.verdict}`);
  // The LF weight budget is 200, so a perp risk score can exceed 100; uint8 holds it.
  if (!Number.isInteger(v.riskScore) || v.riskScore < 0 || v.riskScore > 200) throw new Error("riskScore must be int 0-200");
}
export function encodeVerdict(v: VerdictAttestation): Hex {
  checkVerdictFields(v);
  return encodeAbiParameters(VERDICT_PARAMS, [v.intentHash, v.verdict, v.riskScore, v.flags, v.rulesetVersion]);
}
export function decodeVerdict(data: Hex) {
  const [intentHash, verdict, riskScore, flags, rulesetVersion] = decodeAbiParameters(VERDICT_PARAMS, data);
  return { intentHash, verdict: verdict as Verdict, riskScore, flags: [...flags], rulesetVersion };
}
export function encodeVerdictV3(v: VerdictAttestation): Hex {
  checkVerdictFields(v);
  if (!v.tally) throw new Error("v3 attestation needs the tally (unknownCount, bounded, thesisPresent)");
  if (!Number.isInteger(v.tally.unknownCount) || v.tally.unknownCount < 0 || v.tally.unknownCount > 255) throw new Error("unknownCount must be int 0-255");
  return encodeAbiParameters(VERDICT_PARAMS_V3, [
    v.intentHash, v.verdict, v.riskScore, v.flags, v.rulesetVersion, v.tally.unknownCount, v.tally.bounded, v.tally.thesisPresent,
  ]);
}
export function decodeVerdictV3(data: Hex) {
  const [intentHash, verdict, riskScore, flags, rulesetVersion, unknownCount, bounded, thesisPresent] = decodeAbiParameters(VERDICT_PARAMS_V3, data);
  return { intentHash, verdict: verdict as Verdict, riskScore, flags: [...flags], rulesetVersion, tally: { unknownCount, bounded, thesisPresent } };
}
/** v3 when a resolver is configured (and the tally is present), else v2. Exported for the tests. */
export function encodeForSchema(v: VerdictAttestation, resolver?: string): { schema: Hex; data: Hex; version: 2 | 3 } {
  if (isAddress(resolver)) {
    if (!v.tally) throw new Error("EAS_RESOLVER_ADDRESS is set but the verdict carries no tally: refusing to attest under v2 silently");
    return { schema: schemaUIDv3(resolver), data: encodeVerdictV3(v), version: 3 };
  }
  return { schema: DJZS_SCHEMA_UID, data: encodeVerdict(v), version: 2 };
}
function clients(env: WorkerEnv) {
  const k = env.DJZS_ATTESTER_KEY;
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("HALT: DJZS_ATTESTER_KEY unset or malformed");
  const transport = http(env.BASE_RPC_URL ?? "https://mainnet.base.org");
  const account = privateKeyToAccount(k as Hex);
  return { account, wallet: createWalletClient({ account, chain: base, transport }), pub: createPublicClient({ chain: base, transport }) };
}
export async function attestVerdict(env: WorkerEnv, v: VerdictAttestation, resolver?: string): Promise<{ uid: Hex; txHash: Hex; block: bigint }> {
  const { wallet, pub } = clients(env);
  const { schema, data } = encodeForSchema(v, resolver);
  const txHash = await wallet.writeContract({ address: EAS_ADDRESS, abi: EAS_ABI, functionName: "attest",
    args: [{ schema, data: { recipient: v.agent, expirationTime: 0n, revocable: false, refUID: ZERO32, data, value: 0n } }] });
  const rc = await pub.waitForTransactionReceipt({ hash: txHash });
  if (rc.status !== "success") throw new Error(`attest reverted: ${txHash}`);
  for (const log of rc.logs) {
    if (log.address.toLowerCase() !== EAS_ADDRESS.toLowerCase()) continue;
    try { const ev = decodeEventLog({ abi: EAS_ABI, data: log.data, topics: log.topics });
          if (ev.eventName === "Attested") return { uid: ev.args.uid, txHash, block: rc.blockNumber }; } catch {}
  }
  throw new Error(`attest mined but no Attested event: ${txHash}`);
}
export function attestVerdictDeferred(env: WorkerEnv, v: VerdictAttestation, onDone: (r: { uid: Hex; txHash: Hex } | Error) => Promise<void> | void, resolver?: string): Promise<void> {
  return attestVerdict(env, v, resolver).then(r => onDone(r), e => onDone(e instanceof Error ? e : new Error(String(e))));
}
export async function readAttestation(uid: Hex, rpc = "https://mainnet.base.org", resolver?: string) {
  const pub = createPublicClient({ chain: base, transport: http(rpc) });
  const a = await pub.readContract({ address: EAS_ADDRESS, abi: EAS_ABI, functionName: "getAttestation", args: [uid] });
  const v3 = isAddress(resolver) && a.schema.toLowerCase() === schemaUIDv3(resolver).toLowerCase();
  const v2 = a.schema.toLowerCase() === DJZS_SCHEMA_UID.toLowerCase();
  return { uid: a.uid, schema: a.schema, schemaVersion: v3 ? 3 : v2 ? 2 : null, time: a.time, recipient: a.recipient, attester: a.attester, revoked: a.revocationTime !== 0n,
    isDJZS: (v2 || v3) && a.attester.toLowerCase() === ATTESTER.toLowerCase(), fields: v3 ? decodeVerdictV3(a.data) : decodeVerdict(a.data) };
}
export async function attesterBalance(env: WorkerEnv): Promise<{ address: Address; eth: string; low: boolean }> {
  const { account, pub } = clients(env);
  const wei = await pub.getBalance({ address: account.address });
  return { address: account.address, eth: formatEther(wei), low: wei < 200_000_000_000_000n };
}
