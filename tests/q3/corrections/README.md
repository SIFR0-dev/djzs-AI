# Correction Records

A PoL certificate is immutable — that is the point of anchoring it. A
certificate that says something wrong therefore cannot be edited, withdrawn, or
quietly reissued. It can only be **corrected forward**: a separate record that
names the certificate, states plainly what is wrong with it, and is itself
anchored and permanent.

Nothing in this directory rewrites anything. The original certificate stands
exactly as issued, byte for byte, forever.

## Status

`001.json` is written (`DJZS-CORR-001`, text supplied by the operator
2026-09-13) and **not yet anchored** — `anchored_irys_id` and `eas_uid` are
`null`, which is the honest state and renders as `authored_pending_anchor`.
Set them after anchoring and the join completes.

The certificate 001 concerns:

| | |
| --- | --- |
| Irys id | `7tNyZtffqCerZ9CdoQJTFMcrdjbRi3B9KbstAGe3G1br` |
| audit_id | `a3a5ad8f-0418-4d63-ae7b-85b39973a25b` |
| issued | 2026-08-18T19:12Z, micro tier, verdict FAIL |
| defect | `target_system: "Coinbase"` — operator-entered free text during testing. Coinbase had no involvement in the audit and no relationship to it. |

## Shape

As written, not as once sketched — an earlier draft of this file described a
different field set, which is exactly the stale-surface problem these records
exist to correct. `djzs-trust-mcp/test/corrections.test.mjs` fails CI if the
registry and the record file disagree on any of these.

```json
{
  "id": "DJZS-CORR-001",
  "scope": "attribution only",
  "supersedes": {
    "audit_id": "...",
    "irys_id": "...",
    "minted_at": "2026-08-18T19:12Z",
    "tier": "micro",
    "verdict": "FAIL"
  },
  "effective": "2026-09-13",
  "signer": "0xfB0e11471D41f88D1eE43A1bA38d885fb6b77824",
  "anchored_irys_id": null,
  "eas_uid": null,
  "statement": ["paragraph", "paragraph", "..."]
}
```

`scope` says what the record touches. `"attribution only"` means the verdict
itself is untouched — the audit ran, the engine ruled, and that ruling stands;
only the claim about *whose* system it concerned is corrected.

`supersedes` names the certificate. It does **not** mean the certificate is
withdrawn or replaced: Irys does not permit deletion, and the record of the
error is part of the record.

## Anchoring — operator only

Record-bearing operations run only from the operator's shell (CLAUDE.md §5). A
container drafts; it never anchors.

1. Write the record here.
2. Anchor it through the Q3 anchor path (`POST /q3/anchor`, `DJZS-Q3-Anchor-1`,
   `djzs-trust-mcp/src/q3-anchor.ts`) — the same Irys path the PoL certificates
   use, so a correction is exactly as permanent and as verifiable as the thing
   it corrects.
3. Attest via EAS from `0xfB0e11471D41f88D1eE43A1bA38d885fb6b77824`.
4. Put the returned Irys id and EAS uid into **both** the record file and the
   `CORRECTIONS` entry in `djzs-trust-mcp/src/corrections.ts`, then deploy. The
   certificate query then returns the correction alongside the certificate.
   `test/corrections.test.mjs` fails if you update one and not the other.

A correction registered without an `anchored_irys_id` reads as
`authored_pending_anchor`, which is the honest state and renders as such. Do not
fill that field with anything but a real anchored id — the test asserts the
registry can never advertise an anchor the record file lacks.
