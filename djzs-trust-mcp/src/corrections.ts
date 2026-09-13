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
  /** Correction number, zero-padded, matching tests/q3/corrections/<id>.json. */
  id: string
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
  irys_id: string | null
  /** EAS attestation uid for the correction, once attested. */
  eas_uid: string | null
}

/**
 * The live register. Ordered by id.
 *
 * 001 is recorded here with irys_id null because the certificate it corrects is
 * already public and already wrong: a reader hitting that certificate today
 * should be told a correction exists and is pending anchor, rather than be shown
 * nothing until the anchoring happens. The record text itself is the operator's
 * to write and the operator's to anchor.
 */
export const CORRECTIONS: readonly CorrectionRecord[] = [
  {
    id: "001",
    corrects_audit_id: "a3a5ad8f-0418-4d63-ae7b-85b39973a25b",
    corrects_irys_id: "7tNyZtffqCerZ9CdoQJTFMcrdjbRi3B9KbstAGe3G1br",
    summary:
      'Certificate carries target_system "Coinbase". The value was operator-entered free text during testing; Coinbase had no involvement in this audit and no relationship to it. The certificate is immutable and stands as issued; this record corrects it.',
    irys_id: null,
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
    summary: c.summary,
    irys_id: c.irys_id,
    irys_url: c.irys_id ? `https://gateway.irys.xyz/${c.irys_id}` : null,
    eas_uid: c.eas_uid,
    status: c.irys_id ? "anchored" : "authored_pending_anchor",
  }))
}
