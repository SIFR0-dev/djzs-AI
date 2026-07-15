/**
 * On-chain trust-score writer (Phase 3, D1-D3). Sends
 * DJZSLogicTrustScore.updateScore from a dedicated, owner-authorized writer key
 * on Base mainnet.
 *
 * FAIL-OPEN BY CONSTRUCTION: every path returns a ScoreWriteResult value, never
 * throws into the audit path. The caller (verify_pm_trade) annotates the
 * response with the result and NEVER gates the verdict_hash or the Irys
 * certificate on it. An absent key or absent/invalid agent_address is a SKIP,
 * not an error.
 *
 * Supersedes spec A3 ("do not add viem as a direct Worker dependency; the
 * resource server needs no signer"): that held for Step 2's signer-less
 * resource server. Phase 3's score-writer IS the signer A3 excluded. viem's
 * sign+encode+send bundles clean under workerd — instrumented pre-code: no
 * node: builtins in the closure, updateScore selector 0x62d6d4b6, exit 0.
 *
 * D2: the writer is a DEDICATED key authorized via authorizeWriter() from the
 * contract owner (0xc2ec..3a98); it is NOT the owner key. Held as the Worker
 * SECRET DJZS_WRITER_KEY, read request-scoped. D3: written synchronously after
 * the Irys anchor (fail-open); nonce uses viem's default "pending" — acceptable
 * at pilot volume, revisit (batched writer / DO) at scale.
 */
import { createWalletClient, http, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { base } from "viem/chains"

/** DJZSLogicTrustScore on Base mainnet (subgraph.yaml address). */
export const DJZS_TRUST_CONTRACT = "0xB3324D07A8713b354435FF0e2A982A504e81b137" as const
const DEFAULT_BASE_RPC = "https://mainnet.base.org"

const UPDATE_SCORE_ABI = [
  {
    type: "function",
    name: "updateScore",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agent", type: "address" },
      { name: "riskScore", type: "uint256" },
      { name: "verdict", type: "string" },
      { name: "flags", type: "string[]" },
      { name: "irysTxId", type: "string" },
    ],
    outputs: [],
  },
] as const

export type ScoreWriteResult =
  | { status: "written"; tx_hash: string; contract: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; detail: string }

export interface ScoreWriteInputs {
  /** 0x-prefixed 20-byte agent wallet whose trust is scored. */
  agentAddress: string
  /** Engine risk_score; contract requires 0-100 (PM taxonomy maxes at 100). */
  riskScore: number
  /** PASS | WAIT | FAIL. */
  verdict: string
  /** Fired flag CODE strings (e.g. "DJZS-M03"). */
  flags: string[]
  /** The Irys certificate id, so the on-chain record points back at the cert. */
  irysTxId: string
}

export type TrustWriteFn = (inp: ScoreWriteInputs) => Promise<ScoreWriteResult>

/**
 * Build the writer. An absent/malformed key yields a writer that always SKIPS
 * (fail-open: scoring is simply disabled, audits and certs are unaffected).
 */
export function buildTrustWriter(
  privateKeyHex: string | undefined,
  rpcUrl: string | undefined,
  contract: `0x${string}` = DJZS_TRUST_CONTRACT,
): TrustWriteFn {
  if (!privateKeyHex || !/^(0x)?[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    return async () => ({ status: "skipped", reason: "DJZS_WRITER_KEY not configured; on-chain scoring disabled" })
  }
  const key = (privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`) as Hex
  const account = privateKeyToAccount(key)
  const client = createWalletClient({ account, chain: base, transport: http(rpcUrl || DEFAULT_BASE_RPC) })

  return async (inp) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(inp.agentAddress)) {
      return { status: "skipped", reason: "agent_address absent or not a 20-byte 0x address" }
    }
    if (!Number.isInteger(inp.riskScore) || inp.riskScore < 0 || inp.riskScore > 100) {
      return { status: "skipped", reason: `riskScore ${inp.riskScore} outside contract range 0-100` }
    }
    try {
      const tx_hash = await client.writeContract({
        address: contract,
        abi: UPDATE_SCORE_ABI,
        functionName: "updateScore",
        args: [
          inp.agentAddress as `0x${string}`,
          BigInt(inp.riskScore),
          inp.verdict,
          inp.flags,
          inp.irysTxId,
        ],
        account,
        chain: base,
      })
      return { status: "written", tx_hash, contract }
    } catch (e) {
      return { status: "error", detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) }
    }
  }
}
