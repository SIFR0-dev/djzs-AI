/**
 * engine-v2 hash module — re-export shim.
 * ──────────────────────────────────────────
 * The pure SHA-256 + canonicalize primitives were moved to shared/hash.ts to
 * fix the layering (shared/ must not depend on server/). This module re-exports
 * them so existing engine-v2 imports (`from "./hash"`) keep working unchanged.
 * The implementation is identical — only its home moved.
 */
export { sha256Hex, canonicalize } from "@shared/hash";
