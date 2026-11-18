/**
 * Tavus tool calls: the signature is checked on the raw bytes, and the envelope is read strictly.
 * Offline, no key, no network. The "secret" here is a throwaway string made up in this file.
 *
 * Pins (Tavus docs, Tool Delivery: "Tavus callback shape" and "Verifying API signatures"):
 *   - X-Tavus-Signature is the hex HMAC-SHA256 of the EXACT body bytes under the shared secret;
 *   - one changed byte, a different secret, a missing or malformed header, or an empty secret all
 *     fail, and none of them throws;
 *   - the signature covers the bytes received, so a re-serialised copy of the same JSON does not
 *     verify (this is why the route verifies before it parses);
 *   - the envelope must carry name, tool_call_id and conversation_id as short opaque tokens;
 *     `arguments` is the model's JSON string and is passed through untouched;
 *   - the model's arguments are read strictly: unknown keys ignored, garbage reads as "nothing
 *     usable", a claim code is canonicalised, a reason is hashed and never kept as text;
 *   - the post-call envelope needs only a name and a conversation_id (no LLM turn produces it, so
 *     the per-turn ids may be missing), and nothing else in it is read.
 *
 * Run: npx tsx test/tavus-hmac.test.mjs
 */
import { createHmac } from "node:crypto"
import { canonicalCode, decisionPreimage, intentPreimage, parseToolArguments, sha256Hex } from "../src/intent.ts"
import { MAX_BODY_BYTES, parseEnvelope, parsePostCallEnvelope, verifyTavusSignature } from "../src/tavus.ts"

let pass = 0
const failures = []
function check(n, label, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}${detail ? ` :: ${detail}` : ""}`); console.log(`  FAIL ${n} ${label}${detail ? ` :: ${detail}` : ""}`) }
}

const SECRET = "test-only-shared-secret-not-a-real-one"
const bytes = (s) => new TextEncoder().encode(s).buffer
const sign = (secret, body) => createHmac("sha256", secret).update(Buffer.from(body)).digest("hex")

// The documented envelope, keys sorted as Tavus sends them.
const ENVELOPE = JSON.stringify({
  arguments: JSON.stringify({ recipient: "0x" + "a".repeat(40), amount_usdc: "1.00", reference: "PG-7K2M-9QX4-B1CD-E5FG", reason: "prize for the meetup raffle" }),
  conversation_id: "c123456789",
  inference_id: "inf_987654321",
  name: "request_transfer",
  tool_call_id: "call_abc123",
  turn_idx: 4,
})
const body = bytes(ENVELOPE)
const sig = sign(SECRET, body)

// 1. signature
check(1, "a correct signature verifies", await verifyTavusSignature(SECRET, body, sig))
check(2, "uppercase hex verifies too", await verifyTavusSignature(SECRET, body, sig.toUpperCase()))
const tampered = bytes(ENVELOPE.replace("1.00", "9.00"))
check(3, "one changed value in the body fails", !(await verifyTavusSignature(SECRET, tampered, sig)))
check(4, "a different secret fails", !(await verifyTavusSignature("another-secret", body, sig)))
check(5, "a missing header fails", !(await verifyTavusSignature(SECRET, body, null)) && !(await verifyTavusSignature(SECRET, body, undefined)))
check(6, "a header that is not 64 hex characters fails without throwing", !(await verifyTavusSignature(SECRET, body, "abc")) && !(await verifyTavusSignature(SECRET, body, "z".repeat(64))) && !(await verifyTavusSignature(SECRET, body, sig + "00")))
check(7, "an empty secret verifies nothing", !(await verifyTavusSignature("", body, sign("", body))))
const reserialised = bytes(JSON.stringify(JSON.parse(ENVELOPE), null, 1))
check(8, "the same JSON re-serialised does not verify: the signature is over bytes, not meaning", !(await verifyTavusSignature(SECRET, reserialised, sig)))
const flipped = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0")
check(9, "a signature off by one hex digit fails", !(await verifyTavusSignature(SECRET, body, flipped)))

// 2. envelope
const env = parseEnvelope(body)
check(10, "the documented envelope parses", env.ok === true && env.envelope.name === "request_transfer" && env.envelope.tool_call_id === "call_abc123" && env.envelope.conversation_id === "c123456789")
check(11, "`arguments` is passed through byte for byte", env.ok === true && env.envelope.argumentsJson === JSON.parse(ENVELOPE).arguments)
const bad = (obj) => parseEnvelope(bytes(typeof obj === "string" ? obj : JSON.stringify(obj)))
check(12, "not JSON is invalid_json", bad("{nope").ok === false && bad("{nope").error === "invalid_json")
check(13, "an array or a bare string is bad_envelope", bad([1]).error === "bad_envelope" && bad("\"x\"").error === "bad_envelope")
check(14, "a missing tool_call_id or conversation_id is bad_envelope", bad({ name: "request_transfer", arguments: "{}", conversation_id: "c1" }).error === "bad_envelope" && bad({ name: "request_transfer", arguments: "{}", tool_call_id: "t1" }).error === "bad_envelope")
check(15, "an id with spaces, slashes or 129 characters is bad_envelope", bad({ name: "request_transfer", arguments: "{}", tool_call_id: "a b", conversation_id: "c1" }).error === "bad_envelope" && bad({ name: "request_transfer", arguments: "{}", tool_call_id: "a/b", conversation_id: "c1" }).error === "bad_envelope" && bad({ name: "request_transfer", arguments: "{}", tool_call_id: "x".repeat(129), conversation_id: "c1" }).error === "bad_envelope")
const objArgs = bad({ name: "request_transfer", arguments: { amount_usdc: "1" }, tool_call_id: "t1", conversation_id: "c1" })
check(16, "`arguments` as an object is tolerated and re-encoded", objArgs.ok === true && objArgs.envelope.argumentsJson === "{\"amount_usdc\":\"1\"}")
const noArgs = bad({ name: "settle_after_call", tool_call_id: "t1", conversation_id: "c1" })
check(17, "absent `arguments` reads as an empty object", noArgs.ok === true && noArgs.envelope.argumentsJson === "{}")
check(18, "`arguments` as a number is bad_envelope", bad({ name: "request_transfer", arguments: 5, tool_call_id: "t1", conversation_id: "c1" }).error === "bad_envelope")
check(19, "the body cap is 16 KiB", MAX_BODY_BYTES === 16384)

// 3. the model's arguments
const A = "0x" + "A".repeat(40)
const p = await parseToolArguments(JSON.stringify({ recipient: A, amount_usdc: "1.50", reference: " pg-7k2m 9qx4-b1cd-e5fg ", reason: "  raffle prize  ", response_to_user: "One moment." }))
check(20, "recipient is lowercased; amount is exact; unknown keys are ignored", p.recipient.state === "present" && p.recipient.value === A.toLowerCase() && p.amount.state === "present" && p.amount.micro === 1_500_000n)
check(21, "a claim code is canonicalised (case, spaces, hyphens)", p.reference.state === "present" && p.reference.value === "PG7K2M9QX4B1CDE5FG")
check(22, "a reason is present as sha256 and length of the trimmed text, nothing else", p.reason.state === "present" && p.reason.sha256 === await sha256Hex("raffle prize") && p.reason.length === 12 && Object.keys(p.reason).sort().join(",") === "length,sha256,state")
const garbage = await parseToolArguments("not json at all")
check(23, "arguments that are not JSON read as nothing usable: every field absent", garbage.recipient.state === "absent" && garbage.amount.state === "absent" && garbage.reference.state === "absent" && garbage.reason.state === "absent")
const arr = await parseToolArguments("[1,2,3]")
check(24, "a JSON array reads the same way", arr.recipient.state === "absent" && arr.amount.state === "absent")
const odd = await parseToolArguments(JSON.stringify({ recipient: "0x1234", amount_usdc: "$5", reference: "code; DROP TABLE", reason: 42 }))
check(25, "a short address is invalid, \"$5\" is invalid, a code with punctuation is malformed, a numeric reason is absent", odd.recipient.state === "invalid" && odd.amount.state === "invalid" && odd.reference.state === "malformed" && odd.reason.state === "absent")
const zero = await parseToolArguments(JSON.stringify({ recipient: "0x" + "0".repeat(40) }))
check(26, "the zero address is invalid", zero.recipient.state === "invalid")
check(27, "canonicalCode refuses what cannot be a code", canonicalCode("abc") === null && canonicalCode("a".repeat(41)) === null && canonicalCode("PG_7K2M") === null && canonicalCode("") === null && canonicalCode("PG-7K2M-9QX4") === "PG7K2M9QX4")

// 4. preimages
const pre = await intentPreimage(p)
check(28, "the intent preimage is one line of validated fields; the code and the reason enter as sha256",
  pre === `palgate.intent.v1|action=transfer|asset=USDC|chain_id=8453|recipient=${A.toLowerCase()}|amount_micro=1500000|reference_sha256=${await sha256Hex("PG7K2M9QX4B1CDE5FG")}|reason_sha256=${await sha256Hex("raffle prize")}`, pre)
check(29, "the preimage carries neither the claim code nor the reason text", !pre.includes("PG7K2M") && !pre.includes("raffle"))
const preOdd = await intentPreimage(odd)
check(30, "absent renders empty and unusable renders \"!\"", preOdd === "palgate.intent.v1|action=transfer|asset=USDC|chain_id=8453|recipient=!|amount_micro=!|reference_sha256=!|reason_sha256=", preOdd)
const dp = decisionPreimage("ab".repeat(32), { verdict: "FAIL", disposition: "REFUSE", flags: ["REFERENCE_UNKNOWN", "REASON_ABSENT"], ruleset: "PALGATE-TRANSFER-v0.1" })
check(31, "the decision preimage is one line", dp === `palgate.decision.v1|intent_sha256=${"ab".repeat(32)}|verdict=FAIL|disposition=REFUSE|flags=REFERENCE_UNKNOWN,REASON_ABSENT|ruleset=PALGATE-TRANSFER-v0.1`, dp)
const reordered = await parseToolArguments(JSON.stringify({ reason: "raffle prize", reference: "PG7K2M9QX4B1CDE5FG", amount_usdc: 1.5, recipient: A.toLowerCase() }))
check(32, "key order, case and number-versus-string do not change intent_sha256", await sha256Hex(await intentPreimage(reordered)) === await sha256Hex(pre))

// 5. the post-call envelope
const post = (obj) => parsePostCallEnvelope(bytes(typeof obj === "string" ? obj : JSON.stringify(obj)))
const full = post({ arguments: "{\"purpose\":\"settle\"}", conversation_id: "c123456789", inference_id: "inf_1", name: "settle_after_call", tool_call_id: "call_post", turn_idx: 9 })
check(33, "the full tool-call envelope parses as a post-call envelope", full.ok === true && full.envelope.name === "settle_after_call" && full.envelope.conversation_id === "c123456789")
const minimal = post({ conversation_id: "c123456789", name: "settle_after_call" })
const nulls = post({ arguments: null, conversation_id: "c123456789", inference_id: null, name: "settle_after_call", tool_call_id: null, turn_idx: null })
check(34, "name and conversation_id alone are enough; missing or null per-turn ids are not an error", minimal.ok === true && nulls.ok === true && Object.keys(minimal.envelope).sort().join(",") === "conversation_id,name")
check(35, "without a usable conversation_id there is nothing to settle: bad_envelope", post({ name: "settle_after_call" }).error === "bad_envelope" && post({ name: "settle_after_call", conversation_id: "a b" }).error === "bad_envelope" && post({ name: "settle_after_call", conversation_id: 7 }).error === "bad_envelope" && post({ conversation_id: "c1" }).error === "bad_envelope")
check(36, "not JSON, or not an object, is refused the same way as a tool call", post("{nope").error === "invalid_json" && post([1]).error === "bad_envelope")

console.log(failures.length ? `\nTAVUS-HMAC: FAIL (${failures.length})\n  ${failures.join("\n  ")}` : `\nTAVUS-HMAC: PASS (${pass} checks)`)
process.exit(failures.length ? 1 : 0)
