import { describe, expect, it } from "vitest";
import { AUTOPILOT_MAX_AUTO_APPROVED_DELEGATIONS_PER_ORG, computeDelegationRequiresApproval } from "../../packages/core/src/index";

describe("computeDelegationRequiresApproval", () => {
  it("advisor always requires approval, regardless of layer or existing count", () => {
    expect(
      computeDelegationRequiresApproval({
        staticRequiresApproval: true,
        parentLayer: "chair",
        tier: "advisor",
        existingDelegatedCountForOrg: 0
      })
    ).toBe(true);

    expect(
      computeDelegationRequiresApproval({
        staticRequiresApproval: true,
        parentLayer: "department",
        tier: "advisor",
        existingDelegatedCountForOrg: 0
      })
    ).toBe(true);
  });

  it("orchestrator auto-approves delegating to director or department", () => {
    expect(
      computeDelegationRequiresApproval({
        staticRequiresApproval: true,
        parentLayer: "chair", // -> director
        tier: "orchestrator",
        existingDelegatedCountForOrg: 0
      })
    ).toBe(false);

    expect(
      computeDelegationRequiresApproval({
        staticRequiresApproval: true,
        parentLayer: "director", // -> department
        tier: "orchestrator",
        existingDelegatedCountForOrg: 0
      })
    ).toBe(false);
  });

  it("orchestrator still requires approval for the final hop into worker", () => {
    expect(
      computeDelegationRequiresApproval({
        staticRequiresApproval: true,
        parentLayer: "department", // -> worker
        tier: "orchestrator",
        existingDelegatedCountForOrg: 0
      })
    ).toBe(true);
  });

  it("orchestrator requires approval if there is nowhere left to delegate (already worker)", () => {
    expect(
      computeDelegationRequiresApproval({
        staticRequiresApproval: true,
        parentLayer: "worker",
        tier: "orchestrator",
        existingDelegatedCountForOrg: 0
      })
    ).toBe(true);
  });

  it("autopilot auto-approves every hop, including into worker", () => {
    expect(
      computeDelegationRequiresApproval({
        staticRequiresApproval: true,
        parentLayer: "department", // -> worker
        tier: "autopilot",
        existingDelegatedCountForOrg: 0
      })
    ).toBe(false);
  });

  it("autopilot falls back to requiring approval past the safety cap, regardless of tier", () => {
    expect(
      computeDelegationRequiresApproval({
        staticRequiresApproval: true,
        parentLayer: "chair",
        tier: "autopilot",
        existingDelegatedCountForOrg: AUTOPILOT_MAX_AUTO_APPROVED_DELEGATIONS_PER_ORG
      })
    ).toBe(true);
  });

  it("orchestrator also falls back to requiring approval past the safety cap", () => {
    expect(
      computeDelegationRequiresApproval({
        staticRequiresApproval: true,
        parentLayer: "chair",
        tier: "orchestrator",
        existingDelegatedCountForOrg: AUTOPILOT_MAX_AUTO_APPROVED_DELEGATIONS_PER_ORG + 5
      })
    ).toBe(true);
  });

  it("the cap does not affect advisor, which is always gated regardless", () => {
    expect(
      computeDelegationRequiresApproval({
        staticRequiresApproval: true,
        parentLayer: "chair",
        tier: "advisor",
        existingDelegatedCountForOrg: 0
      })
    ).toBe(true);
  });
});
