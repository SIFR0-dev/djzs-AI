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
import { createWalletClient, http, fallback, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { base } from "viem/chains"

/** DJZSLogicTrustScore on Base mainnet (subgraph.yaml address). */
export const DJZS_TRUST_CONTRACT = "0xB3324D07A8713b354435FF0e2A982A504e81b137" as const
const DEFAULT_BASE_RPC = "https://mainnet.base.org"

/**
 * ROOT CAUSE, 2026-08-06: the writer's nonce sat at 1 across runs 003 and 007 —
 * no transaction was ever broadcast, so nothing reverted and nothing hung. The
 * write died client-side inside viem's pre-flight (chainId / nonce / estimateGas)
 * because a bare `http(mainnet.base.org)` transport was being rate-limited at the
 * Cloudflare egress. Probed live: /health/writer returned "rpc error: over rate
 * limit" from the Worker while the byte-identical eth_call succeeded from a
 * laptop. Workers share egress IPs across tenants; a public RPC throttles them
 * far sooner than a home connection.
 *
 * BASE_RPC_URL (a dedicated, keyed endpoint) remains the real fix and takes
 * priority when set. This ordered fallback is the resilience floor for when it
 * is not: distinct providers, so one throttle does not take the write with it.
 */
const FALLBACK_BASE_RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"] as const

function buildBaseTransport(rpcUrl: string | undefined) {
  const urls = rpcUrl ? [rpcUrl, ...FALLBACK_BASE_RPCS.filter((u) => u !== rpcUrl)] : [...FALLBACK_BASE_RPCS]
  return fallback(
    urls.map((u) => http(u, { retryCount: 2, retryDelay: 250, timeout: 10_000 })),
    { rank: false },
  )
}

/**
 * Coarse failure class for the response. Deliberately a fixed vocabulary, never
 * free text and never key material: the caller logs it, so it must be safe to
 * publish and stable enough to count across runs.
 */
export function classifyWriteError(message: string): string {
  const m = message.toLowerCase()
  if (/rate limit|ratelimit|429|too many requests/.test(m)) return "rate_limited"
  if (/insufficient funds|gas required exceeds|cannot afford/.test(m)) return "insufficient_gas_funds"
  if (/nonce/.test(m)) return "nonce_conflict"
  if (/revert|execution reverted/.test(m)) return "reverted"
  if (/timeout|timed out|aborted|abort/.test(m)) return "timeout"
  if (/unauthorized|not authorized|onlywriter|access/.test(m)) return "unauthorized_writer"
  if (/fetch failed|network|econn|socket|dns/.test(m)) return "network"
  return "unknown"
}

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

/**
 * Non-secret diagnosis of the DJZS_WRITER_KEY binding.
 *
 * NEVER carries key material. `hex_length` and `has_0x_prefix` are shape metadata
 * only — the two facts that distinguish "the dashboard value never deployed" from
 * "the stored value is damaged" (truncated paste, stray newline, missing prefix).
 * On a well-formed key the DERIVED ADDRESS is public information by construction.
 */
export type WriterKeyDiagnostic =
  | { state: "absent"; detail: string }
  | { state: "malformed"; detail: string; hex_length: number; has_0x_prefix: boolean }
  | { state: "ok"; address: string; hex_length: number; has_0x_prefix: boolean }

/** Classify the binding without logging, throwing, or echoing the value. */
export function describeWriterKey(raw: string | undefined | null): WriterKeyDiagnostic {
  if (raw === undefined || raw === null) {
    return { state: "absent", detail: "binding not present on this Worker (secret never deployed)" }
  }
  if (typeof raw !== "string") {
    return { state: "absent", detail: `binding present but not a string (typeof ${typeof raw})` }
  }
  if (raw.length === 0) {
    return { state: "absent", detail: "binding present but empty string" }
  }
  const has_0x_prefix = raw.startsWith("0x") || raw.startsWith("0X")
  const body = has_0x_prefix ? raw.slice(2) : raw
  const hex_length = body.length

  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    const nonHex = (body.match(/[^0-9a-fA-F]/g) ?? []).length
    const notes: string[] = [`expected 64 hex chars, got ${hex_length}`]
    if (nonHex > 0) notes.push(`${nonHex} non-hex char(s)`)
    if (/\s/.test(raw)) notes.push("contains whitespace (stray newline/space in the stored value)")
    return { state: "malformed", detail: notes.join("; "), hex_length, has_0x_prefix }
  }
  const key = (has_0x_prefix ? `0x${body}` : `0x${body}`) as Hex
  return { state: "ok", address: privateKeyToAccount(key).address, hex_length, has_0x_prefix }
}

const AUTHORIZED_WRITERS_SELECTOR = "0x526241a8" // authorizedWriters(address) -> bool

/**
 * Free, read-only check of whether `address` may call updateScore. eth_call only:
 * no signing, no gas, no key material. Returns null if the RPC could not answer.
 */
export async function checkWriterAuthorization(
  address: string,
  rpcUrl: string | undefined,
  contract: `0x${string}` = DJZS_TRUST_CONTRACT,
): Promise<{ authorized: boolean | null; detail?: string }> {
  const urls = rpcUrl ? [rpcUrl, ...FALLBACK_BASE_RPCS.filter((u) => u !== rpcUrl)] : [...FALLBACK_BASE_RPCS]
  const data = `${AUTHORIZED_WRITERS_SELECTOR}${address.slice(2).toLowerCase().padStart(64, "0")}`
  let lastDetail = "no rpc attempted"
  for (const url of urls) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: contract, data }, "latest"] }),
    })
    const j = (await r.json()) as { result?: string; error?: { message?: string } }
    if (j.error) { lastDetail = `rpc error: ${j.error.message ?? "unknown"} (${url})`; continue }
    if (!j.result) { lastDetail = `rpc returned no result (${url})`; continue }
    return { authorized: BigInt(j.result) === 1n }
  } catch (e) {
    lastDetail = `${(e instanceof Error ? e.message : String(e)).slice(0, 160)} (${url})`
  }
  }
  return { authorized: null, detail: lastDetail }
}

export type ScoreWriteResult =
  | { status: "written"; tx_hash: string; contract: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; error_class: string; detail: string }

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
  // Diagnostic split (2026-08-04): "absent" and "malformed" used to collapse into
  // one skip reason, so a never-deployed secret and a damaged stored value were
  // indistinguishable in the response. Shape metadata only — never the value.
  const diag = describeWriterKey(privateKeyHex)
  if (diag.state !== "ok") {
    const reason =
      diag.state === "absent"
        ? `DJZS_WRITER_KEY absent; on-chain scoring disabled (${diag.detail})`
        : `DJZS_WRITER_KEY malformed; on-chain scoring disabled (${diag.detail}; hex_length=${diag.hex_length}, has_0x_prefix=${diag.has_0x_prefix})`
    console.log(`[trust-writer] SKIP :: ${reason}`)
    return async () => ({ status: "skipped", reason })
  }
  // Derived address is PUBLIC information — it is the on-chain identity that must
  // match authorizeWriter(). Logged at construction so `wrangler tail` can read it.
  console.log(
    `[trust-writer] CONSTRUCTED :: derived_writer_address=${diag.address} contract=${contract} ` +
      `hex_length=${diag.hex_length} has_0x_prefix=${diag.has_0x_prefix}`,
  )
  // diag.state === "ok" implies a well-formed string; normalize the prefix
  // case-insensitively (a stored "0X..." would otherwise become "0x0X...").
  const raw = privateKeyHex as string
  const key = (/^0x/i.test(raw) ? `0x${raw.slice(2)}` : `0x${raw}`) as Hex
  const account = privateKeyToAccount(key)
  const client = createWalletClient({ account, chain: base, transport: buildBaseTransport(rpcUrl) })

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
      console.log(`[trust-writer] WRITE OK :: tx=${tx_hash} contract=${contract}`)
      return { status: "written", tx_hash, contract }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      const error_class = classifyWriteError(raw)
      console.log(`[trust-writer] WRITE FAILED :: class=${error_class} :: ${raw.slice(0, 300)}`)
      return { status: "error", error_class, detail: raw.slice(0, 300) }
    }
  }
}
