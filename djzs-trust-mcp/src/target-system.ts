/**
 * Target-System: a signed claim, or nothing.
 *
 * WHY THIS EXISTS. `target_system` was an optional free-text tool input that
 * landed verbatim on a permanent Irys certificate. Nothing checked that the
 * caller had any relationship to the system they named. A live audit of the
 * first 100 mainnet certificates (2026-09-13) found 94 carrying
 * `target_system: unknown` and one carrying `"Coinbase"` — Irys
 * 7tNyZtffqCerZ9CdoQJTFMcrdjbRi3B9KbstAGe3G1br, audit a3a5ad8f-0418-4d63-ae7b-
 * 85b39973a25b, typed by the operator during testing. Coinbase had no
 * involvement. The certificate is immutable, so the value cannot be withdrawn;
 * it can only be corrected forward and rendered honestly.
 *
 * THE RULE, from this commit: the field is populated only from a claim signed
 * by the subject address, and is otherwise null. Every value that predates the
 * rule is unsigned by construction, so it renders as `unverified:<value>` on
 * every surface that shows it.
 *
 * WHAT A SIGNATURE DOES AND DOES NOT PROVE. It proves the holder of a key
 * authored the claim, and binds the claim to an address that the v2 EAS receipt
 * already attests onto. It does NOT prove the signer is who the string names —
 * no signature can. A key that signs `target_system: Coinbase` still has to be
 * Coinbase's key for the claim to mean anything, and the reader is the one who
 * decides that. What the rule removes is the weaker failure: a name appearing on
 * a permanent record because somebody typed it into a free-text box.
 */
import { recoverMessageAddress, type Hex } from "viem"

/** Claim envelope version. Bumping this invalidates older proofs by construction. */
export const TARGET_SYSTEM_CLAIM_VERSION = "DJZS-TSC-1"

/** The prefix an unverified value is rendered behind. Never strip it at a display layer. */
export const UNVERIFIED_PREFIX = "unverified:"

/** Tag names on the certificate. `Target-System` stays the filter key for backwards compatibility. */
export const TAG_VALUE = "Target-System"
export const TAG_SUBJECT = "Target-System-Subject"
export const TAG_PROOF = "Target-System-Proof"
export const TAG_CLAIM = "Target-System-Claim"

export interface TargetSystemClaim {
  /** The claimed system identifier. */
  value: string
  /** Address that signed it. Lowercased on the way in. */
  subject: string
  /** EIP-191 personal_sign signature over canonicalTargetSystemMessage(). */
  signature: string
}

/**
 * The exact bytes a subject signs. Stable and versioned: any change to this
 * string invalidates every previously issued proof, which is why the version
 * lives inside the message rather than beside it.
 */
export function canonicalTargetSystemMessage(value: string, subject: string): string {
  return [
    `${TARGET_SYSTEM_CLAIM_VERSION} target-system claim`,
    `subject: ${subject.toLowerCase()}`,
    `target_system: ${value}`,
  ].join("\n")
}

/**
 * Verify a claim. Returns the normalized claim on success and null on ANY
 * failure — malformed input, a signature that does not recover, or a recovery
 * that lands on a different address. Never throws: a bad claim is a claim that
 * is absent, not an audit that fails.
 *
 * `expectedSubject`, when given, is the address the payment settled from. The
 * recovered signer must equal it, which is what binds the claim to the paying
 * agent rather than to any key the caller happens to hold.
 */
export async function verifyTargetSystemClaim(
  claim: Partial<TargetSystemClaim> | undefined,
  expectedSubject?: string,
): Promise<TargetSystemClaim | null> {
  if (!claim) return null
  const { value, subject, signature } = claim
  if (typeof value !== "string" || !value.length || value.length > 128) return null
  if (typeof subject !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(subject)) return null
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null
  if (expectedSubject && subject.toLowerCase() !== expectedSubject.toLowerCase()) return null
  let recovered: string
  try {
    recovered = await recoverMessageAddress({
      message: canonicalTargetSystemMessage(value, subject),
      signature: signature as Hex,
    })
  } catch {
    return null
  }
  if (recovered.toLowerCase() !== subject.toLowerCase()) return null
  return { value, subject: subject.toLowerCase(), signature }
}

/**
 * How a certificate's target_system renders. This is the single place the rule
 * lives; every surface calls it rather than reading the tag directly.
 *
 *  - no value tag            -> null
 *  - value + verifying proof -> the bare value
 *  - anything else           -> `unverified:<value>`
 *
 * The proof is re-verified HERE, at read time, not trusted from the presence of
 * the tags. The Irys query filters on tags alone and does not constrain the
 * uploader, so a third party can write an item carrying our tag names; only
 * recovering the signature distinguishes a real claim from a decorated one.
 */
export async function renderTargetSystem(
  tags: Record<string, string>,
  expectedSubject?: string,
): Promise<string | null> {
  const value = tags[TAG_VALUE]
  if (typeof value !== "string" || !value.length) return null
  if (tags[TAG_CLAIM] !== TARGET_SYSTEM_CLAIM_VERSION) return `${UNVERIFIED_PREFIX}${value}`
  const verified = await verifyTargetSystemClaim(
    { value, subject: tags[TAG_SUBJECT], signature: tags[TAG_PROOF] },
    expectedSubject,
  )
  return verified ? value : `${UNVERIFIED_PREFIX}${value}`
}

/** True when a rendered value is NOT a verified claim. Aggregators exclude these. */
export function isUnverifiedTargetSystem(rendered: string | null): boolean {
  return rendered === null || rendered.startsWith(UNVERIFIED_PREFIX)
}
