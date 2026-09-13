/**
 * Target-System claim + render tests.
 *
 * THE ASSERTION THIS FILE EXISTS FOR: an unsigned target_system value must
 * never render bare. That is the failure the 2026-09-13 audit found in
 * production — certificate 7tNyZtff…G1br carries `target_system: "Coinbase"`,
 * typed by the operator during testing, and every surface printed it as though
 * the certificate attested to it. A test that only checked the happy path would
 * have passed against that build.
 *
 * Offline: no network, no keys beyond deterministic test keys.
 * Run: node --experimental-strip-types test/target-system.test.mjs
 */
import { privateKeyToAccount } from "viem/accounts"
import {
  canonicalTargetSystemMessage,
  verifyTargetSystemClaim,
  renderTargetSystem,
  isUnverifiedTargetSystem,
  UNVERIFIED_PREFIX,
  TARGET_SYSTEM_CLAIM_VERSION,
  TAG_VALUE,
  TAG_SUBJECT,
  TAG_PROOF,
  TAG_CLAIM,
} from "../src/target-system.ts"

let pass = 0
const failures = []
function check(n, label, ok) {
  if (ok) { pass++; console.log(`  ok  ${n} ${label}`) }
  else { failures.push(`${n} ${label}`); console.log(`  FAIL ${n} ${label}`) }
}

const A = privateKeyToAccount(`0x${"11".repeat(32)}`)
const B = privateKeyToAccount(`0x${"22".repeat(32)}`)

async function sign(account, value, subject = account.address) {
  return account.signMessage({ message: canonicalTargetSystemMessage(value, subject) })
}
function tags(value, subject, signature, claim = TARGET_SYSTEM_CLAIM_VERSION) {
  const t = {}
  if (value !== undefined) t[TAG_VALUE] = value
  if (subject !== undefined) t[TAG_SUBJECT] = subject
  if (signature !== undefined) t[TAG_PROOF] = signature
  if (claim !== undefined) t[TAG_CLAIM] = claim
  return t
}

console.log("TARGET-SYSTEM · signed claim or null")

// ── the happy path ────────────────────────────────────────────────────────
const goodSig = await sign(A, "vugola-agent")
const good = await verifyTargetSystemClaim({ value: "vugola-agent", subject: A.address, signature: goodSig })
check(1, "a correctly signed claim verifies", good !== null && good.value === "vugola-agent")
check(2, "subject is normalized to lowercase", good?.subject === A.address.toLowerCase())
check(3, "a verified claim renders bare", (await renderTargetSystem(tags("vugola-agent", A.address, goodSig))) === "vugola-agent")

// ── THE CORE ASSERTION: unsigned never renders bare ───────────────────────
// Each case below is a real shape a certificate can have. Every one must come
// back prefixed, and none may equal the bare value.
const unsignedCases = [
  ["no proof, no subject, no claim version (every pre-ruling certificate)", tags("Coinbase", undefined, undefined, undefined)],
  ["value + claim version but no proof", tags("Coinbase", undefined, undefined)],
  ["value + subject but no proof", tags("Coinbase", A.address, undefined)],
  ["proof present but claim version absent", tags("Coinbase", A.address, goodSig, undefined)],
  ["proof present but claim version wrong", tags("Coinbase", A.address, goodSig, "DJZS-TSC-999")],
  ["signature is well-formed but over a DIFFERENT value", tags("Coinbase", A.address, goodSig)],
  ["signature by a DIFFERENT key than the named subject", tags("vugola-agent", B.address, goodSig)],
  ["proof is garbage hex of the right length", tags("Coinbase", A.address, `0x${"ab".repeat(65)}`)],
  ["proof is not hex at all", tags("Coinbase", A.address, "not-a-signature")],
]
let n = 4
for (const [label, t] of unsignedCases) {
  const rendered = await renderTargetSystem(t)
  const ok = rendered === `${UNVERIFIED_PREFIX}${t[TAG_VALUE]}` && rendered !== t[TAG_VALUE]
  check(n++, `NEVER BARE: ${label}`, ok)
  check(n++, `  ...and is flagged unverified: ${label}`, isUnverifiedTargetSystem(rendered))
}

// The live certificate, by name, so a regression names its own victim.
const live = await renderTargetSystem(tags("Coinbase", undefined, undefined, undefined))
check(n++, 'live cert 7tNyZtff...G1br renders "unverified:Coinbase", never "Coinbase"',
  live === "unverified:Coinbase" && live !== "Coinbase")

// ── absence is null, not "unknown" ────────────────────────────────────────
check(n++, "no Target-System tag renders null (not the string 'unknown')", (await renderTargetSystem({})) === null)
check(n++, "empty Target-System value renders null", (await renderTargetSystem(tags("", A.address, goodSig))) === null)
check(n++, "null counts as unverified for aggregation", isUnverifiedTargetSystem(null))

// ── subject binding ───────────────────────────────────────────────────────
check(n++, "claim is refused when it does not match the expected subject (payer)",
  (await verifyTargetSystemClaim({ value: "vugola-agent", subject: A.address, signature: goodSig }, B.address)) === null)
check(n++, "claim is accepted when it matches the expected subject",
  (await verifyTargetSystemClaim({ value: "vugola-agent", subject: A.address, signature: goodSig }, A.address)) !== null)
check(n++, "expected-subject match is case-insensitive",
  (await verifyTargetSystemClaim({ value: "vugola-agent", subject: A.address, signature: goodSig }, A.address.toUpperCase())) !== null)

// ── malformed input never throws ──────────────────────────────────────────
for (const bad of [undefined, {}, { value: "x" }, { value: "x", subject: "nope", signature: goodSig },
                   { value: "x".repeat(129), subject: A.address, signature: goodSig }]) {
  let threw = false
  try { await verifyTargetSystemClaim(bad) } catch { threw = true }
  check(n++, `malformed claim returns null without throwing: ${JSON.stringify(bad)?.slice(0, 48)}`, !threw)
}

// ── the message is versioned ──────────────────────────────────────────────
check(n++, "canonical message carries the claim version",
  canonicalTargetSystemMessage("x", A.address).startsWith(`${TARGET_SYSTEM_CLAIM_VERSION} target-system claim`))
check(n++, "canonical message lowercases the subject",
  canonicalTargetSystemMessage("x", A.address.toUpperCase()).includes(A.address.toLowerCase()))

console.log(`\nTARGET-SYSTEM · ${pass}/${pass + failures.length} assertions pass`)
if (failures.length) {
  console.error(`\nFAILED:\n  ${failures.join("\n  ")}`)
  process.exit(1)
}
