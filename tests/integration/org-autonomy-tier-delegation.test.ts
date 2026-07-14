import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppServices } from "../../packages/core/src/index";
import { loadConfigOrThrow, type AppConfig } from "../../packages/config/src/index";
import type {
  ChatAnswer,
  ChatAnswerInput,
  IntakeDecision,
  PlanDraft,
  PlanDraftInput,
  ProviderStatus,
  RunResultSynthesisInput,
  RunResultSynthesisResult,
  TaskExecutionInput,
  TaskExecutionResult
} from "../../packages/contracts/src/index";

/**
 * No mocked/faked approval gate here -- this drives the real
 * createChairRun -> setOrgAutonomyTier -> createProposal -> execute path,
 * the same way commons-board (real caller) would, proving the org-autonomy
 * override actually changes what execute() does, not just what
 * createProposal returns.
 */
function createTestProvider(config: AppConfig) {
  return {
    async getStatus(): Promise<ProviderStatus> {
      return {
        id: "api-provider",
        displayName: "Test Provider",
        model: config.provider.model,
        installed: true,
        authenticated: true,
        authMode: "api_key",
        capabilities: {
          providerIdentity: "org-autonomy-tier-test-provider",
          supportsStreaming: true,
          supportsStructuredOutputs: true,
          supportsToolCalls: true,
          supportsFileIo: true,
          supportsCancellation: true
        },
        diagnostics: { checkedAt: new Date().toISOString(), apiKeyConfigured: true, readiness: "ready" }
      };
    },
    async answerChat(input: ChatAnswerInput): Promise<ChatAnswer> {
      return { content: `test provider chat answer for: ${input.message}` };
    },
    async createPlan(input: PlanDraftInput): Promise<PlanDraft> {
      return { title: "Test plan", summary: input.request, steps: [{ title: "Step", description: input.request, required: true }] };
    },
    async executeTask(input: TaskExecutionInput): Promise<TaskExecutionResult> {
      return { summary: `Completed task: ${input.task.name}.`, detail: input.task.description };
    },
    async synthesizeRunResult(input: RunResultSynthesisInput): Promise<RunResultSynthesisResult> {
      return { summary: `Completed the request: ${input.run.request}`, content: `Completed the request: ${input.run.request}` };
    },
    async decideIntake(): Promise<IntakeDecision> {
      return {
        requestType: "chat",
        needsClarification: false,
        clarificationQuestion: null,
        clarificationReason: null,
        specialistCandidates: [],
        decisionConfidence: "medium",
        reasoningSummary: "Not used by chair registration."
      };
    }
  };
}

describe("org autonomy tier -> delegate_to_child gating", () => {
  let tempRoot: string;
  let services: Awaited<ReturnType<typeof createAppServices>>;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commons-crew-autonomy-tier-test-"));
    const config = loadConfigOrThrow({
      ...process.env,
      NODE_ENV: "test",
      PA_STORAGE_MODE: "memory",
      PA_ARTIFACTS_ROOT: path.join(tempRoot, "artifacts"),
      PA_STATE_FILE: path.join(tempRoot, "state.json"),
      PA_BACKUPS_ROOT: path.join(tempRoot, "backups"),
      OLF_AGENTS_ROOT: path.join(tempRoot, "labor-commons-fixture")
    });
    services = await createAppServices(config, { provider: createTestProvider(config) as never });
  });

  afterEach(async () => {
    await services.shutdown();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function registerChairAndGetSeededTask(orgContext: string) {
    const chair = await services.pa.createChairRun({ orgContext, chairRole: "operations", surface: "cli", title: "Operations chair" });
    if ("error" in chair) {
      throw new Error(`createChairRun failed: ${chair.error}`);
    }
    const chairView = await services.runs.get(chair.run.id);
    const seededApproval = chairView!.approvals.find((approval) => approval.status === "pending");
    if (!seededApproval) {
      throw new Error("Expected createChairRun to seed a pending delegation approval.");
    }
    return { chair, taskId: seededApproval.taskId as string };
  }

  it("an org with no synced tier still requires explicit approval (unchanged default)", async () => {
    const { chair, taskId } = await registerChairAndGetSeededTask("board-no-tier-synced");

    const proposal = await services.actions.createProposal({
      workItemId: chair.run.workItemId,
      runId: chair.run.id,
      taskId,
      toolId: "delegate_to_child",
      actionClass: "class_c",
      targetRef: "Handle the IT-arm portion of this request",
      idempotencyKey: `delegate-${taskId}-no-tier`
    });
    if ("error" in proposal) {
      throw new Error(`createProposal failed: ${proposal.error.code} ${proposal.error.message}`);
    }
    expect(proposal.approval.required).toBe(true);
    expect(proposal.approval.status).toBe("pending");

    const executedBeforeApproval = await services.actions.execute(proposal.id);
    expect(executedBeforeApproval && "error" in executedBeforeApproval ? executedBeforeApproval.error.code : null).toBe("approval_required");
  });

  it("advisor tier (explicit) still requires explicit approval", async () => {
    const orgContext = "board-advisor-tier";
    await services.pa.setOrgAutonomyTier({ orgContext, tier: "advisor" });
    const { chair, taskId } = await registerChairAndGetSeededTask(orgContext);

    const proposal = await services.actions.createProposal({
      workItemId: chair.run.workItemId,
      runId: chair.run.id,
      taskId,
      toolId: "delegate_to_child",
      actionClass: "class_c",
      targetRef: "Handle the IT-arm portion of this request",
      idempotencyKey: `delegate-${taskId}-advisor`
    });
    if ("error" in proposal) {
      throw new Error(`createProposal failed: ${proposal.error.code} ${proposal.error.message}`);
    }
    expect(proposal.approval.required).toBe(true);
  });

  it("orchestrator tier auto-approves a chair-to-director delegation and it actually executes with no approval decision", async () => {
    const orgContext = "board-orchestrator-tier";
    await services.pa.setOrgAutonomyTier({ orgContext, tier: "orchestrator" });
    const { chair, taskId } = await registerChairAndGetSeededTask(orgContext);

    const proposal = await services.actions.createProposal({
      workItemId: chair.run.workItemId,
      runId: chair.run.id,
      taskId,
      toolId: "delegate_to_child",
      actionClass: "class_c",
      targetRef: "Handle the IT-arm portion of this request",
      idempotencyKey: `delegate-${taskId}-orchestrator`
    });
    if ("error" in proposal) {
      throw new Error(`createProposal failed: ${proposal.error.code} ${proposal.error.message}`);
    }
    expect(proposal.approval.required).toBe(false);
    expect(proposal.approval.status).toBe("not_required");

    // No approvals.decide call anywhere in this test -- the real proof.
    const executed = await services.actions.execute(proposal.id);
    if (!executed || "error" in executed) {
      throw new Error(`execute failed: ${executed && "error" in executed ? executed.error.code : "null result"}`);
    }
    expect(executed.outcome).toContain("child_run_delegated");
  });

  /** Proposes + executes a delegate_to_child from runId/taskId, asserts it needed no approval decision, and returns the spawned child's own run id and its seeded pending-approval task id. */
  async function autoDelegateOneHop(workItemId: string, runId: string, taskId: string, label: string) {
    const proposal = await services.actions.createProposal({
      workItemId,
      runId,
      taskId,
      toolId: "delegate_to_child",
      actionClass: "class_c",
      targetRef: `Route further down: ${label}`,
      idempotencyKey: `delegate-${taskId}-${label}`
    });
    if ("error" in proposal) {
      throw new Error(`createProposal (${label}) failed: ${proposal.error.code} ${proposal.error.message}`);
    }
    expect(proposal.approval.required).toBe(false);

    const executed = await services.actions.execute(proposal.id);
    if (!executed || "error" in executed) {
      throw new Error(`execute (${label}) failed: ${executed && "error" in executed ? executed.error.code : "null result"}`);
    }

    const events = await services.runs.events(runId);
    const childCreated = [...events].reverse().find((event) => event.eventType === "delegation.child_created");
    if (!childCreated) {
      throw new Error(`No delegation.child_created event found on run ${runId} after executing ${label}.`);
    }
    const { childRunId } = childCreated.payload as { childRunId: string };
    const childView = await services.runs.get(childRunId);
    const childSeededApproval = childView!.approvals.find((approval) => approval.status === "pending");
    return { childRunId, childTaskId: childSeededApproval?.taskId ?? null };
  }

  it("autopilot tier auto-approves every hop, including the final hop into worker", async () => {
    const orgContext = "board-autopilot-tier";
    await services.pa.setOrgAutonomyTier({ orgContext, tier: "autopilot" });
    const { chair, taskId: chairTaskId } = await registerChairAndGetSeededTask(orgContext);

    // chair -> director (orchestrator would also auto-approve this hop).
    const toDirector = await autoDelegateOneHop(chair.run.workItemId, chair.run.id, chairTaskId, "chair-to-director");
    expect(toDirector.childTaskId).not.toBeNull();

    // director -> department (still not the final hop).
    const toDepartment = await autoDelegateOneHop(chair.run.workItemId, toDirector.childRunId, toDirector.childTaskId!, "director-to-department");
    expect(toDepartment.childTaskId).not.toBeNull();

    // department -> worker: the one hop orchestrator would still gate
    // (see the orchestrator test above), but autopilot does not.
    const toWorker = await autoDelegateOneHop(chair.run.workItemId, toDepartment.childRunId, toDepartment.childTaskId!, "department-to-worker");
    const workerRun = await services.runs.get(toWorker.childRunId);
    expect(workerRun!.run.delegation?.layer).toBe("worker");
  });
});
