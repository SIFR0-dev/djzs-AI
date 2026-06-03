import type { DJZSLFCode, UniversalLFCode, AgencyLFCode } from "./types";

export const DJZS_WEIGHTS: Record<DJZSLFCode, number> = {
  S01: 30,
  S02: 25,
  S03: 18,
  E01: 25,
  E02: 18,
  I01: 16,
  I02: 16,
  I03: 16,
  X01: 15,
  X02:  9,
  T01: 12,
} as const;

export const UNIVERSAL_WEIGHTS: Record<UniversalLFCode, number> = {
  UNAUTHORIZED_SCOPE: 25,
  PARAMETER_OVERFLOW: 20,
  DESTRUCTIVE_UNGUARDED: 25,
  NO_ROLLBACK_PATH: 15,
  CHAIN_UNVERIFIED: 15,
} as const;

export const AGENCY_WEIGHTS: Record<AgencyLFCode, number> = {
  A01: 30,
  A02: 15,
  A03: 20,
  A04: 25,
  A05: 10,
} as const;

export const LF_LABELS: Record<DJZSLFCode | UniversalLFCode | AgencyLFCode, string> = {
  S01: "CIRCULAR_LOGIC",
  S02: "LAYER_INVERSION",
  S03: "DEPENDENCY_GHOST",
  E01: "ORACLE_UNVERIFIED",
  E02: "CONFIDENCE_INFLATION",
  I01: "FOMO_LOOP",
  I02: "MISALIGNED_REWARD",
  I03: "DATA_UNVERIFIED",
  X01: "EXECUTION_UNBOUND",
  X02: "RACE_CONDITION",
  T01: "STALE_REFERENCE",
  UNAUTHORIZED_SCOPE: "UNAUTHORIZED_SCOPE",
  PARAMETER_OVERFLOW: "PARAMETER_OVERFLOW",
  DESTRUCTIVE_UNGUARDED: "DESTRUCTIVE_UNGUARDED",
  NO_ROLLBACK_PATH: "NO_ROLLBACK_PATH",
  CHAIN_UNVERIFIED: "CHAIN_UNVERIFIED",
  A01: "MISSING_FALSIFIABLE_THESIS",
  A02: "UNTESTABLE_METRICS",
  A03: "STATIC_REASONING",
  A04: "IGNORES_CONSTRAINTS",
  A05: "INTERFACE_EROSION_ONLY",
};

const _djzsSum = Object.values(DJZS_WEIGHTS).reduce((a, b) => a + b, 0);
const _uniSum = Object.values(UNIVERSAL_WEIGHTS).reduce((a, b) => a + b, 0);
const _agencySum = Object.values(AGENCY_WEIGHTS).reduce((a, b) => a + b, 0);
if (_djzsSum !== 200) throw new Error(`DJZS weights sum ${_djzsSum} !== 200`);
if (_uniSum !== 100) throw new Error(`Universal weights sum ${_uniSum} !== 100`);
if (_agencySum !== 100) throw new Error(`Agency weights sum ${_agencySum} !== 100`);
