import { termsHashOf } from "./chain"
import { TERMS_TEXT as GENERATED_TERMS } from "./terms.generated"

/** The terms the page serves: terms/member-terms-v1.md byte for byte (scripts/gen-terms.mjs), the file whose
 *  keccak256 is the vault's termsHash. Lives outside the entry module: a Worker entry may only export handlers. */
export const TERMS_TEXT: string = GENERATED_TERMS
export const TERMS_HASH = termsHashOf(TERMS_TEXT)
