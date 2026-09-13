# Correction Records

A PoL certificate is immutable — that is the point of anchoring it. A
certificate that says something wrong therefore cannot be edited, withdrawn, or
quietly reissued. It can only be **corrected forward**: a separate record that
names the certificate, states plainly what is wrong with it, and is itself
anchored and permanent.

Nothing in this directory rewrites anything. The original certificate stands
exactly as issued, byte for byte, forever.

## Status

**`001.json` is NOT in this directory yet.** Its text is the operator's to
write and was not supplied when the surrounding machinery was built
(2026-09-13). The registry entry for it already exists in
`djzs-trust-mcp/src/corrections.ts` with `irys_id: null`, so a reader hitting
the affected certificate today is told a correction is authored and pending
anchor rather than being shown nothing. Drop the record in here, set the
`irys_id` after anchoring, and the join completes.

The certificate 001 concerns:

| | |
| --- | --- |
| Irys id | `7tNyZtffqCerZ9CdoQJTFMcrdjbRi3B9KbstAGe3G1br` |
| audit_id | `a3a5ad8f-0418-4d63-ae7b-85b39973a25b` |
| issued | 2026-08-18T19:12Z, micro tier, verdict FAIL |
| defect | `target_system: "Coinbase"` — operator-entered free text during testing. Coinbase had no involvement in the audit and no relationship to it. |

## Shape

```json
{
  "correction_id": "001",
  "corrects": {
    "irys_id": "...",
    "audit_id": "...",
    "issued_at": "2026-08-18T19:12:00Z"
  },
  "defect": "what the certificate says that is wrong",
  "correction": "what is actually true",
  "discovered": { "date": "2026-09-13", "method": "..." },
  "remedy": "the rule or code change that stops a recurrence",
  "authored_at": "..."
}
```

## Anchoring — operator only

Record-bearing operations run only from the operator's shell (CLAUDE.md §5). A
container drafts; it never anchors.

1. Write the record here.
2. Anchor it through the Q3 anchor path (`POST /q3/anchor`, `DJZS-Q3-Anchor-1`,
   `djzs-trust-mcp/src/q3-anchor.ts`) — the same Irys path the PoL certificates
   use, so a correction is exactly as permanent and as verifiable as the thing
   it corrects.
3. Attest via EAS from `0xfB0e11471D41f88D1eE43A1bA38d885fb6b77824`.
4. Put the returned Irys id and EAS uid into the `CORRECTIONS` entry in
   `djzs-trust-mcp/src/corrections.ts`, and deploy. The certificate query then
   returns the correction alongside the certificate.

A correction registered without an `irys_id` reads as
`authored_pending_anchor`, which is the honest state and renders as such. Do not
fill that field with anything but a real anchored id.
