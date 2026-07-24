// Goldens for the delegation gate — invariant #2 (nothing real-world executes
// un-gated), tested at its sharpest point: the hop into `worker`, where a task
// first gets real tool access.
//
// This is the tightest possible oracle in the whole system: the gate is a pure
// function of (tier, parent layer, static policy, run count), so these run
// deterministically in milliseconds with zero token cost. Every governance-
// critical behavior that can be reduced to a pure function belongs at this
// tier, on the PR path. Model-in-the-loop behaviors (flaky, token-costly) go
// in a separate, smaller tier — see README.
//
// Input shape mirrors the real `computeDelegationRequiresApproval` signature
// (packages/core/src/index.ts) exactly, on purpose: `parentLayer` is the layer
// initiating the delegation, not the layer being delegated into — one hop
// "earlier" than the behavior each golden's `intent` describes. Each input
// below was re-derived from its intent against `DELEGATION_LAYER_ORDER`
// (chair -> director -> department -> worker), not produced by renaming a
// `toLayer` field. `staticRequiresApproval` is `delegate_to_child`'s static
// ACTION_TOOL_POLICIES value, which is unconditionally `true` (class_c) --
// hardcoded here for that reason, not inferred.

import type { Golden } from "./schema";
import { AUTOPILOT_MAX_AUTO_APPROVED_DELEGATIONS_PER_ORG } from "@commons-crew/core";

export type AutonomyTier = "advisor" | "orchestrator" | "autopilot";

/** Mirrors CrewInstanceLayer (packages/contracts/src/index.ts). The chair is the root and is only ever a parentLayer, never a delegation target. */
export type Layer = "chair" | "director" | "department" | "worker";

export interface DelegationGateInput {
  tier: AutonomyTier;
  /** The layer initiating the delegation -- one hop above the layer being delegated into. */
  parentLayer: Layer;
  /** delegate_to_child's static policy value (always true; class_c). */
  staticRequiresApproval: boolean;
  /** Existing delegated runs for the org; drives the tier-independent backstop. */
  existingDelegatedRuns: number;
}

export interface DelegationGateExpected {
  requiresApproval: boolean;
}

export const delegationGateGoldens: Golden<
  DelegationGateInput,
  DelegationGateExpected
>[] = [
  {
    id: "deleg-advisor-worker",
    invariant: "no-ungated-execution",
    stakes: "governance-critical",
    intent: "advisor gates the hop into worker, where real tool access begins",
    input: {
      tier: "advisor",
      parentLayer: "department",
      staticRequiresApproval: true,
      existingDelegatedRuns: 0,
    },
    expected: { requiresApproval: true },
  },
  {
    id: "deleg-advisor-director",
    invariant: "no-ungated-execution",
    stakes: "high",
    intent: "advisor gates every hop, including the first into director",
    input: {
      tier: "advisor",
      parentLayer: "chair",
      staticRequiresApproval: true,
      existingDelegatedRuns: 0,
    },
    expected: { requiresApproval: true },
  },
  {
    id: "deleg-orchestrator-director",
    invariant: "no-ungated-execution",
    stakes: "high",
    intent: "orchestrator auto-approves the planning hop into director",
    input: {
      tier: "orchestrator",
      parentLayer: "chair",
      staticRequiresApproval: true,
      existingDelegatedRuns: 0,
    },
    expected: { requiresApproval: false },
  },
  {
    id: "deleg-orchestrator-department",
    invariant: "no-ungated-execution",
    stakes: "high",
    intent: "orchestrator auto-approves the planning hop into department",
    input: {
      tier: "orchestrator",
      parentLayer: "director",
      staticRequiresApproval: true,
      existingDelegatedRuns: 0,
    },
    expected: { requiresApproval: false },
  },
  {
    id: "deleg-orchestrator-worker",
    invariant: "no-ungated-execution",
    stakes: "governance-critical",
    intent:
      "orchestrator STOPS at the final hop into worker — the one boundary the whole governance claim rests on",
    input: {
      tier: "orchestrator",
      parentLayer: "department",
      staticRequiresApproval: true,
      existingDelegatedRuns: 0,
    },
    expected: { requiresApproval: true },
  },
  {
    id: "deleg-autopilot-worker-under-cap",
    invariant: "no-ungated-execution",
    stakes: "governance-critical",
    intent: "autopilot auto-approves into worker while under the run cap",
    input: {
      tier: "autopilot",
      parentLayer: "department",
      staticRequiresApproval: true,
      existingDelegatedRuns: 5,
    },
    expected: { requiresApproval: false },
  },
  {
    id: "deleg-autopilot-worker-at-cap",
    invariant: "no-ungated-execution",
    stakes: "governance-critical",
    intent:
      "the hard run-count backstop overrides autopilot and forces approval, independent of tier",
    input: {
      tier: "autopilot",
      parentLayer: "department",
      staticRequiresApproval: true,
      existingDelegatedRuns: AUTOPILOT_MAX_AUTO_APPROVED_DELEGATIONS_PER_ORG,
    },
    expected: { requiresApproval: true },
  },
  {
    id: "deleg-orchestrator-worker-at-cap",
    invariant: "no-ungated-execution",
    stakes: "high",
    intent:
      "the run-count backstop is checked before the orchestrator/autopilot branch, so it also forces approval for orchestrator, not just autopilot",
    input: {
      tier: "orchestrator",
      parentLayer: "department",
      staticRequiresApproval: true,
      existingDelegatedRuns: AUTOPILOT_MAX_AUTO_APPROVED_DELEGATIONS_PER_ORG,
    },
    expected: { requiresApproval: true },
  },
];
