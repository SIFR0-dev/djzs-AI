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
  }))
}
