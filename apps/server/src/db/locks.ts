/**
 * Postgres advisory-lock keys. Every key lives here so two features can never
 * collide by picking the same number. Keys are 64-bit: "SURF" in the high 32 bits,
 * then a feature number.
 */
const NAMESPACE = 0x5355_5246n; // "SURF"

function key(feature: number): string {
  return ((NAMESPACE << 32n) | BigInt(feature)).toString();
}

export const LOCKS = {
  /** Serialises schema migrations across replicas (SPEC-004 E2). */
  migrations: key(1),
  /** Allocates commit-ordered sync ids (SPEC-002, PLAN-002 S2). */
  sync: key(2),
  /** Serialises CREATE DATABASE in the integration-test harness. */
  testDatabases: key(100),
} as const;
