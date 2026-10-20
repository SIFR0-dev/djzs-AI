/**
 * Loopback stubs for the offline x402 route harnesses. ZERO keys, ZERO egress: every
 * listener binds 127.0.0.1 and nothing here can reach a real facilitator or chain.
 *
 *   startFacilitator — answers /supported, /verify, /settle. Counts every path, so a
 *     harness can prove how many times money MOVED (settle hits), not just what the
 *     response body claimed. `settle` selects the failure shape.
 *   startRpc — a Base JSON-RPC just faithful enough for viem's writeContract +
 *     waitForTransactionReceipt, so the REAL attestVerdict runs end to end. It records
 *     and decodes every raw transaction, which makes the attested intentHash an
 *     observable, not an assumption.
 *   testAttesterKey — derived at runtime from a label. Not a secret, and no key literal
 *     lives in this public file.
 */
import { createServer, type IncomingMessage, type Server } from "node:http"
import {
  keccak256,
  toBytes,
  parseTransaction,
  decodeFunctionData,
  encodeEventTopics,
  encodeAbiParameters,
  numberToHex,
  pad,
  parseAbi,
  type Hex,
  type Address,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { encodePaymentSignatureHeader } from "@x402/core/http"
import { decodeVerdict, EAS_ADDRESS, DJZS_SCHEMA_UID } from "../src/attest-worker"

export const PAYER = "0x00000000000000000000000000000000000b0b0b" as const
export const SETTLE_TX = ("0x" + "ab".repeat(32)) as Hex

/** Deterministic, obviously-not-a-secret attester key (a hash of a label, derived at runtime). */
export const testAttesterKey = (): Hex => keccak256(toBytes("djzs-offline-harness/attester"))
export const testAttesterAddress = (): Address => privateKeyToAccount(testAttesterKey()).address

// ── facilitator ─────────────────────────────────────────────────────────────

/**
 *  ok        — settle succeeds.
 *  reject    — HTTP 400 {success:false}: a DEFINITIVE refusal (the library throws SettleError).
 *  uncertain — HTTP 502 with a non-JSON body: the library throws a plain Error. The facilitator
 *              may or may not have broadcast — the caller cannot know.
 */
export type SettleMode = "ok" | "reject" | "uncertain"

export interface StubFacilitator {
  url: string
  hits: Record<string, number>
  setSettle: (mode: SettleMode) => void
  close: () => Promise<void>
}

export async function startFacilitator(network: string): Promise<StubFacilitator> {
  const hits: Record<string, number> = { supported: 0, verify: 0, settle: 0 }
  let settle: SettleMode = "ok"
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0].replace(/^.*\//, "")
    hits[path] = (hits[path] ?? 0) + 1
    const reply = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type })
      res.end(typeof body === "string" ? body : JSON.stringify(body))
    }
    if (path === "supported") {
      return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network }], extensions: [], signers: {} })
    }
    req.resume() // the body is irrelevant to the stub
    if (path === "verify") return reply(200, { isValid: true, payer: PAYER })
    if (path === "settle") {
      if (settle === "ok") return reply(200, { success: true, transaction: SETTLE_TX, network, payer: PAYER })
      if (settle === "reject") {
        return reply(400, { success: false, errorReason: "insufficient_funds", transaction: "", network })
      }
      return reply(502, "<html>bad gateway</html>", "text/html")
    }
    reply(500, { error: "stub facilitator: unexpected path " + path })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("could not bind loopback facilitator")
  return {
    url: `http://127.0.0.1:${addr.port}`,
    hits,
    setSettle: (mode) => {
      settle = mode
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A well-formed v2 payment header for the first `accepts` entry of a 402 challenge. */
export function paymentHeader(challenge: { accepts?: unknown[] }): string {
  const accepted = challenge.accepts?.[0]
  if (!accepted) throw new Error("challenge carries no accepts[0]")
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: PAYER } },
  } as never)
}

// ── Base JSON-RPC (just enough for viem attest) ─────────────────────────────

const EAS_ABI = parseAbi([
  "function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)",
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
])

export interface RecordedAttestation {
  raw: Hex
  txHash: Hex
  to: Address | undefined
  schema: Hex
  recipient: Address
  /** Decoded from the transaction's own calldata — exactly what would be written on chain. */
  verdict: ReturnType<typeof decodeVerdict>
}

export interface StubRpc {
  url: string
  /** Every attest the worker sent, decoded. */
  attestations: RecordedAttestation[]
  methods: Record<string, number>
  close: () => Promise<void>
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = ""
    req.on("data", (c) => (b += c))
    req.on("end", () => resolve(b))
  })

export async function startRpc(): Promise<StubRpc> {
  const attestations: RecordedAttestation[] = []
  const methods: Record<string, number> = {}
  const byHash = new Map<string, RecordedAttestation>()
  const BLOCK = 1_000_000n
  const blockHash = keccak256(toBytes("djzs-offline-harness/block"))

  const block = () => ({
    number: numberToHex(BLOCK),
    hash: blockHash,
    parentHash: pad("0x00"),
    timestamp: numberToHex(1_800_000_000n),
    baseFeePerGas: numberToHex(1_000_000n),
    gasLimit: numberToHex(30_000_000n),
    gasUsed: numberToHex(1_000_000n),
    miner: pad("0x00", { size: 20 }),
    transactions: [],
    uncles: [],
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    logsBloom: "0x" + "00".repeat(256),
    receiptsRoot: pad("0x00"),
    stateRoot: pad("0x00"),
    transactionsRoot: pad("0x00"),
    sha3Uncles: pad("0x00"),
    size: "0x1",
    mixHash: pad("0x00"),
  })

  const receipt = (rec: RecordedAttestation) => {
    const uid = keccak256(rec.raw)
    const topics = encodeEventTopics({
      abi: EAS_ABI,
      eventName: "Attested",
      args: { recipient: rec.recipient, attester: testAttesterAddress(), schemaUID: rec.schema },
    })
    return {
      blockHash,
      blockNumber: numberToHex(BLOCK),
      contractAddress: null,
      cumulativeGasUsed: numberToHex(100_000n),
      effectiveGasPrice: numberToHex(1_000_000n),
      from: testAttesterAddress(),
      gasUsed: numberToHex(100_000n),
      logs: [
        {
          address: EAS_ADDRESS,
          blockHash,
          blockNumber: numberToHex(BLOCK),
          data: encodeAbiParameters([{ type: "bytes32" }], [uid]),
          logIndex: "0x0",
          removed: false,
          topics,
          transactionHash: rec.txHash,
          transactionIndex: "0x0",
        },
      ],
      logsBloom: "0x" + "00".repeat(256),
      status: "0x1",
      to: EAS_ADDRESS,
      transactionHash: rec.txHash,
      transactionIndex: "0x0",
      type: "0x2",
    }
  }

  const handle = (call: { method: string; params?: unknown[] }): unknown => {
    methods[call.method] = (methods[call.method] ?? 0) + 1
    const p = call.params ?? []
    switch (call.method) {
      case "eth_chainId":
        return numberToHex(8453n)
      case "eth_blockNumber":
        return numberToHex(BLOCK)
      case "eth_getBlockByNumber":
        return block()
      case "eth_maxPriorityFeePerGas":
        return numberToHex(1_000n)
      case "eth_gasPrice":
        return numberToHex(2_000_000n)
      case "eth_feeHistory":
        return { oldestBlock: numberToHex(BLOCK), baseFeePerGas: ["0xf4240", "0xf4240"], gasUsedRatio: [0.5], reward: [["0x3e8"]] }
      case "eth_getTransactionCount":
        return numberToHex(7n)
      case "eth_estimateGas":
        return numberToHex(150_000n)
      case "eth_sendRawTransaction": {
        const raw = p[0] as Hex
        const tx = parseTransaction(raw)
        const txHash = keccak256(raw)
        const { args } = decodeFunctionData({ abi: EAS_ABI, data: tx.data as Hex })
        const rec: RecordedAttestation = {
          raw,
          txHash,
          to: tx.to ?? undefined,
          schema: args[0].schema,
          recipient: args[0].data.recipient,
          verdict: decodeVerdict(args[0].data.data),
        }
        attestations.push(rec)
        byHash.set(txHash, rec)
        return txHash
      }
      case "eth_getTransactionReceipt": {
        const rec = byHash.get(p[0] as string)
        return rec ? receipt(rec) : null
      }
      case "eth_getTransactionByHash": {
        const rec = byHash.get(p[0] as string)
        return rec
          ? { hash: rec.txHash, blockHash, blockNumber: numberToHex(BLOCK), from: testAttesterAddress(), to: EAS_ADDRESS, nonce: "0x7", input: "0x", value: "0x0", gas: "0x249f0", transactionIndex: "0x0", type: "0x2" }
          : null
      }
      default:
        throw new Error("stub rpc: unhandled method " + call.method)
    }
  }

  const server: Server = createServer(async (req, res) => {
    const text = await readBody(req)
    const respond = (c: { id: unknown; method: string; params?: unknown[] }) => {
      try {
        return { jsonrpc: "2.0", id: c.id, result: handle(c) }
      } catch (e) {
        return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: e instanceof Error ? e.message : String(e) } }
      }
    }
    const parsed = JSON.parse(text)
    const out = Array.isArray(parsed) ? parsed.map(respond) : respond(parsed)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(out))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("could not bind loopback rpc")
  return {
    url: `http://127.0.0.1:${addr.port}`,
    attestations,
    methods,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export { DJZS_SCHEMA_UID }
