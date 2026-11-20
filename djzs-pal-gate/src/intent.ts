/**
 * intent.ts - what the model sent, read strictly, and the two hashes that bind a decision to it.
 *
 * The tool arguments are a JSON string written by a language model. This file is the only place
 * that reads them. Each field comes out as a STATE (present, absent, invalid or malformed) plus,
 * when present, a normalised value. Nothing here is lenient: a value that is not plainly what the
 * schema asked for is not "fixed up", it is reported as what it is.
 *
 * BINDING KEYS (v0.1). Two sha256 hashes over single-line preimages that the ledger publishes next
 * to them, so anyone can recompute both:
 *
 *   intent_sha256    what was asked. Validated fields only; a missing field renders empty and an
 *                    unusable one renders "!". The caller's reason and the claim code enter as
 *                    their own sha256, never as text.
 *   decision_sha256  what the gate answered: intent_sha256, verdict, disposition, flags, ruleset.
 *
 * The decision also depends on the records at that moment (was the claim open, what was left of
 * the day's budget), and those are not in the preimage. So the same intent can legitimately get a
 * different decision later, and decision_sha256 is the key for THIS answer, not for the intent.
 *
 * NOT IN v0.1: the EIP-712 intent_hash and the EAS attestation that djzs-trust-mcp writes for
 * paid verdicts. "transfer" is already an action class in djzs-trust-mcp/src/djzs-intent.ts, but
 * how a transfer maps onto that struct is a permanent public contract and is the operator's
 * ruling (README, open ruling R1). Until it is ruled these two hashes are the receipt.
 */
import { parseUsdc, type AmountParse } from "./money"
import type { Decision, RecipientField, ReferenceField } from "./ruleset"

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = "0x" + "0".repeat(40)

/** Canonical claim code: uppercase letters and digits, 6 to 40 of them, no separators. */
const CODE_CANONICAL_RE = /^[A-Z0-9]{6,40}$/
/** What a cited code may contain before canonicalisation: letters, digits, spaces and hyphens. */
const CODE_WRITTEN_RE = /^[A-Za-z0-9 -]+$/

export type ReasonField = { state: "present"; sha256: string; length: number } | { state: "absent" }

export interface ParsedIntent {
  recipient: RecipientField
  amount: AmountParse
  reference: ReferenceField
  reason: ReasonField
}

/**
 * "PG-7K2M 9qx4" -> "PG7K2M9QX4". Spoken or pasted codes arrive with hyphens, spaces and mixed
 * case; the record key has none of them. Returns null when the text cannot be a code at all.
 */
export function canonicalCode(raw: string): string | null {
  const t = raw.trim()
  if (t === "" || !CODE_WRITTEN_RE.test(t)) return null
  const c = t.replace(/[ -]/g, "").toUpperCase()
  return CODE_CANONICAL_RE.test(c) ? c : null
}

/** A recipient is present only as a well-formed, non-zero 0x address. It is compared lowercase. */
function readRecipient(raw: unknown): RecipientField {
  if (raw === undefined || raw === null) return { state: "absent" }
  if (typeof raw !== "string") return { state: "invalid" }
  const t = raw.trim()
  if (t === "") return { state: "absent" }
  if (!ADDRESS_RE.test(t)) return { state: "invalid" }
  const lower = t.toLowerCase()
  if (lower === ZERO_ADDRESS) return { state: "invalid" }
  return { state: "present", value: lower }
}

function readReference(raw: unknown): ReferenceField {
  if (raw === undefined || raw === null) return { state: "absent" }
  if (typeof raw !== "string") return { state: "malformed" }
  if (raw.trim() === "") return { state: "absent" }
  const code = canonicalCode(raw)
  return code === null ? { state: "malformed" } : { state: "present", value: code }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * A reason is present when the caller said something. WHAT they said is never read by the gate and
 * never stored: only its sha256 and its length are kept. The gate cannot be argued with because it
 * does not listen to the argument; it only records that one was made.
 */
async function readReason(raw: unknown): Promise<ReasonField> {
  if (typeof raw !== "string") return { state: "absent" }
  const t = raw.trim()
  if (t === "") return { state: "absent" }
  return { state: "present", sha256: await sha256Hex(t), length: t.length }
}

/**
 * The tool's `arguments` string -> field states. A string that is not a JSON object yields every
 * field absent: the model sent nothing usable, and the gate says which things it still needs.
 * Keys the schema does not declare (for example the `response_to_user` filler Tavus injects when
 * on_call is generate_filler) are ignored.
 */
export async function parseToolArguments(argumentsJson: string): Promise<ParsedIntent> {
  let obj: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>
  } catch {
    /* not JSON: every field stays absent */
  }
  return {
    recipient: readRecipient(obj.recipient),
    amount: parseUsdc(obj.amount_usdc),
    reference: readReference(obj.reference),
    reason: await readReason(obj.reason),
  }
}

/** Empty for absent, "!" for present-but-unusable, the value otherwise. */
function render(state: string, value: string | undefined): string {
  if (state === "present") return value as string
  return state === "absent" ? "" : "!"
}

/**
 * The intent preimage, one line:
 *
 *   palgate.intent.v1|action=transfer|asset=USDC|chain_id=8453|recipient=<0x..>|amount_micro=<n>|reference_sha256=<hex>|reason_sha256=<hex>
 *
 * The claim code enters as sha256(canonical code), so the ledger can publish the preimage without
 * publishing a live code.
 */
export async function intentPreimage(p: ParsedIntent): Promise<string> {
  const reference = p.reference.state === "present" ? await sha256Hex(p.reference.value) : undefined
  return [
    "palgate.intent.v1",
    "action=transfer",
    "asset=USDC",
    "chain_id=8453",
    `recipient=${render(p.recipient.state, p.recipient.state === "present" ? p.recipient.value : undefined)}`,
    `amount_micro=${render(p.amount.state, p.amount.state === "present" ? p.amount.micro.toString() : undefined)}`,
    `reference_sha256=${render(p.reference.state, reference)}`,
    `reason_sha256=${render(p.reason.state, p.reason.state === "present" ? p.reason.sha256 : undefined)}`,
  ].join("|")
}

/**
 * The decision preimage, one line:
 *
 *   palgate.decision.v1|intent_sha256=<hex>|verdict=<V>|disposition=<D>|flags=<A,B>|ruleset=<version>
 */
export function decisionPreimage(intentSha256: string, d: Decision): string {
  return [
    "palgate.decision.v1",
    `intent_sha256=${intentSha256}`,
    `verdict=${d.verdict}`,
    `disposition=${d.disposition}`,
    `flags=${d.flags.join(",")}`,
    `ruleset=${d.ruleset}`,
  ].join("|")
}
