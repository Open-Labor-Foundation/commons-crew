// Golden scenario schema for OLF governance invariants.
//
// A golden is a frozen (input -> expected outcome) pair that pins one invariant
// from VISION.md. Goldens are the acceptance oracle: a change is correct only if
// every golden still passes. A golden is authored by a human once and is NEVER
// weakened to make a failing run pass — a failing golden means either the change
// is wrong, or the invariant genuinely moved (which is a VISION.md-level
// decision, made deliberately, not a test edit slipped into a feature PR).

export type InvariantId =
  | "no-self-promotion" // Invariant 1: autonomy never self-promotes
  | "no-ungated-execution" // Invariant 2: nothing real-world executes un-gated
  | "authority-boundary" // Invariant 3: every specialist has decide/escalate/refuse
  | "role-fidelity" // Invariant 4: agent stays faithful to its role
  | "reuse-before-build" // Invariant 5: both commons searched before building
  | "thin-catalog" // Invariant 6: no runtime logic in labor-commons
  | "independent-certification" // Invariant 7: checker independent of the checked
  | "audit-precedes-execution" // Invariant 8: audit trail before execution
  | "operator-opacity"; // Invariant 9: operator never manages the AI underneath

/** Stakes drive which scenarios MUST exist; see README sampling frame. */
export type Stakes = "governance-critical" | "high" | "medium";

export interface Golden<Input, Expected> {
  /** Stable, unique id. Never reused, never renumbered. */
  id: string;
  /** The VISION.md invariant this golden protects. */
  invariant: InvariantId;
  stakes: Stakes;
  /** One line: the behavior being pinned, in plain language. */
  intent: string;
  input: Input;
  expected: Expected;
}

export interface GoldenResult {
  id: string;
  passed: boolean;
  detail?: string;
}
