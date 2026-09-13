/**
 * Correction Records.
 *
 * A PoL certificate is immutable by design — that is the whole point of
 * anchoring it. So a certificate that says something wrong cannot be edited,
 * withdrawn, or quietly reissued. It can only be CORRECTED FORWARD: a separate,
 * separately-anchored record that names the certificate, states what is wrong
 * with it, and is itself permanent.
 *
 * This registry is what lets a reader find the correction from the certificate.
 * The certificate is never rewritten and its bytes never change; the query layer
 * joins the two so nobody reads the original without seeing the correction.
 *
 * WHY A TRACKED FILE RATHER THAN AN INDEX QUERY. A correction is rare and
 * consequential, and a reader must not be able to miss one because a GraphQL
 * window narrowed or an index lagged. Registering it in source means the join is
 * deterministic, reviewable in a diff, and survives any indexer. The cost is
 * that publishing a correction takes a deploy, which for something this rare is
 * the right trade.
 */

/**
 * The address every genuine DJZS Irys item is signed by — the address derived
 * from the Worker's IRYS_UPLOAD_KEY.
 *
 * DERIVED FROM PUBLIC DATA, NOT FROM THE KEY. A container never holds
 * IRYS_UPLOAD_KEY, so this was read off items the Worker has already signed:
 * queried Irys mainnet GraphQL for three known DJZS certificates —
 * 7tNyZtffqCerZ9CdoQJTFMcrdjbRi3B9KbstAGe3G1br (the certificate Correction 001
 * concerns), B7jfHadHUJRnarH7YkX4ixgLgCAqakQbdcmvYDhAcyYf and
 * EuJ1evB3PWiNwvcMkixyRreaXEhfKGrzGwS6e4o1pyzp — and all three report the same
 * signer. Publishing it costs nothing (an address is public by construction) and
 * buys the thing that was missing: a reader can now tell a DJZS record from a
 * copy of one.
 */
export const DJZS_IRYS_SIGNER = "0xcf2d8ef4dea0ef8957b0f4d4a6fbfc2aeaf990cd"

export interface CorrectionRecord {
  /** Record id, matching the `id` field of tests/q3/corrections/<n>.json. */
  id: string
  /** The record file this entry mirrors, so the join can be checked by hand. */
  record_file: string
  /** What the correction touches. "attribution only" leaves the verdict untouched. */
  scope: string
  /** audit_id of the certificate being corrected, as it appears in the audit-id tag. */
  corrects_audit_id: string
  /** Irys id of the certificate being corrected. */
  corrects_irys_id: string
  /** One line a reader sees inline, before they open anything. */
  summary: string
  /**
   * Irys id of the anchored Correction Record itself, or null while it is
   * authored but not yet anchored. Null is not a placeholder to be filled with
   * a guess: it is the honest state, and it renders as such.
   */
  anchored_irys_id: string | null
  /** EAS attestation uid for the correction, once attested. */
  eas_uid: string | null
  /**
   * Irys items that carry this correction's text and tags but are NOT DJZS
   * records — wrong signer. Listed so a reader who finds one by tag search can
   * see, from us, that we know about it and do not claim it. Silence would leave
   * them to guess.
   */
  known_strays?: Array<{ irys_id: string; signer: string; note: string }>
}

/**
 * The live register. Ordered by id.
 *
 * 001 is recorded with anchored_irys_id null because the certificate it corrects
 * is already public and already wrong: a reader hitting that certificate today
 * should be told a correction exists and is pending anchor, rather than be shown
 * nothing until the anchoring happens. The full text lives in the record file;
 * the summary here is the one line a reader sees before opening anything.
 */
export const CORRECTIONS: readonly CorrectionRecord[] = [
  {
    id: "DJZS-CORR-001",
    record_file: "tests/q3/corrections/001.json",
    scope: "attribution only",
    corrects_audit_id: "a3a5ad8f-0418-4d63-ae7b-85b39973a25b",
    corrects_irys_id: "7tNyZtffqCerZ9CdoQJTFMcrdjbRi3B9KbstAGe3G1br",
    summary:
      'Certificate carries target_system "Coinbase". The value was operator-entered free text during a test of the audit tool by the DJZS operator; Coinbase did not submit the intent, did not authorize use of its name, and had no involvement in the audit. The verdict says nothing about any Coinbase system. Attribution only: the verdict itself is untouched, the certificate is immutable and stands as issued.',
    anchored_irys_id: null,
    eas_uid: null,
    known_strays: [
      {
        irys_id: "8Kqfic6PVkUUVhEEBppGTzcpr2sZCkbDjventu3W1Fvk",
        signer: "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",
        note:
          "Carries this correction's text and tags but is NOT a DJZS record. Signed by " +
          "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a, the address of the public test key " +
          "0x1111...11 (derived and confirmed against the item's on-chain signer), not by " +
          "the DJZS signer. Created 2026-09-13 while testing the anchoring harness: a " +
          "--local-key mode warned about a non-devnet node and then uploaded anyway. That " +
          "mode has since been deleted. Irys does not permit deletion, so the item stands; " +
          "it is unreferenced, and it is invisible to query_pol_certificates because that " +
          "tool filters application-id DJZS-Oracle while this carries DJZS-Correction.",
      },
    ],
  },
]

/** Corrections naming this certificate, by either identifier. Empty for the overwhelming majority. */
export function correctionsFor(auditId: string | undefined, irysId: string | undefined): Array<Record<string, unknown>> {
  return CORRECTIONS.filter(
    (c) =>
      (auditId !== undefined && c.corrects_audit_id === auditId) ||
      (irysId !== undefined && c.corrects_irys_id === irysId),
  ).map((c) => ({
    correction_id: c.id,
    scope: c.scope,
    summary: c.summary,
    record_file: c.record_file,
    anchored_irys_id: c.anchored_irys_id,
    irys_url: c.anchored_irys_id ? `https://gateway.irys.xyz/${c.anchored_irys_id}` : null,
    eas_uid: c.eas_uid,
    status: c.anchored_irys_id ? "anchored" : "authored_pending_anchor",
    // The canonical anchor is the one named here AND signed by this address.
    // Returned on every correction so a caller never has to go looking for it.
    expected_signer: DJZS_IRYS_SIGNER,
    ...(c.known_strays?.length ? { known_strays: c.known_strays } : {}),
  }))
}
