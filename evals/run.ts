// Golden runner — the promote gate.
//
// Run with: npx tsx evals/run.ts
// Exits 0 if every golden passes, 1 otherwise. Wire it as a REQUIRED status
// check in branch protection (see .github/workflows/evals.yml) so a session
// cannot promote a change that breaks an invariant.

import type { GoldenResult } from "./schema";
import {
  delegationGateGoldens,
  type DelegationGateInput,
} from "./delegation-gate.goldens";
import { computeDelegationRequiresApproval } from "@commons-crew/core";

// The golden input shape already mirrors computeDelegationRequiresApproval's
// real parameter names (parentLayer, staticRequiresApproval) -- see the
// comment at the top of delegation-gate.goldens.ts for why. No reference
// implementation: a green run here means the real gate passed, not a stand-in
// written from the docs.
function callRealGate(input: DelegationGateInput): boolean {
  return computeDelegationRequiresApproval({
    staticRequiresApproval: input.staticRequiresApproval,
    parentLayer: input.parentLayer,
    tier: input.tier,
    existingDelegatedCountForOrg: input.existingDelegatedRuns,
  });
}

function run(): number {
  const results: GoldenResult[] = delegationGateGoldens.map((g) => {
    const actual = callRealGate(g.input);
    const passed = actual === g.expected.requiresApproval;
    return {
      id: g.id,
      passed,
      detail: passed
        ? undefined
        : `expected requiresApproval=${g.expected.requiresApproval}, got ${actual} — ${g.intent}`,
    };
  });

  for (const r of results) {
    console.log(
      `${r.passed ? "PASS" : "FAIL"}  ${r.id}${r.detail ? `  ${r.detail}` : ""}`,
    );
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} goldens passed`);
  return failed === 0 ? 0 : 1;
}

process.exit(run());
