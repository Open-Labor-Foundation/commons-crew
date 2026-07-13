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
          providerIdentity: "redelegatable-approvals-test-provider",
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
      // "execution" (not "chat") so the one test that calls postMessage
      // directly (not createChairRun, which bypasses this entirely) gets a
      // real run created -- needed to prove requestDelegationApproval
      // rejects an ordinary, non-chain root run.
      return {
        requestType: "execution",
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

/**
 * The seeded approval a chair gets at registration is one-shot: once a
 * delegate_to_child proposal executes against it, createProposal's own
 * binding check refuses to reuse it for a second, different act. This
 * suite proves the fix -- pa.requestDelegationApproval -- makes a second
 * delegation from the *same* long-lived chair run actually work, which is
 * what an external caller (commons-board, dispatching a second piece of
 * board work to an already-registered chair) depends on.
 */
describe("pa.requestDelegationApproval", () => {
  let tempRoot: string;
  let services: Awaited<ReturnType<typeof createAppServices>>;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commons-crew-redelegate-test-"));
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

  // execute()'s own return (ActionExecutionRecord) has no structured payload
  // field -- the delegated child's id surfaces on the PARENT run's own event
  // log instead (eventType "delegation.child_created"), same pattern proven
  // in chair-registration.test.ts. Returns the newest such event's payload.
  async function delegateOnce(chairRunId: string, workItemId: string, taskId: string, targetRef: string, idempotencyKey: string) {
    const proposal = await services.actions.createProposal({
      workItemId,
      runId: chairRunId,
      taskId,
      toolId: "delegate_to_child",
      actionClass: "class_c",
      targetRef,
      idempotencyKey
    });
    if ("error" in proposal) throw new Error(`createProposal failed: ${proposal.error.code}`);
    const executed = await services.actions.execute(proposal.id);
    if (!executed || "error" in executed) throw new Error(`execute failed: ${executed && "error" in executed ? executed.error.code : "null"}`);

    const events = await services.runs.events(chairRunId);
    const childCreatedEvents = events.filter((e) => e.eventType === "delegation.child_created");
    const latest = childCreatedEvents[childCreatedEvents.length - 1]; // runEvents is append-only, oldest-first
    if (!latest) throw new Error("delegate_to_child executed but no delegation.child_created event was found");
    return latest.payload as { childRunId: string; childTaskId: string; layer: string };
  }

  it("a chair can delegate a second time after requesting a fresh approval", async () => {
    const chair = await services.pa.createChairRun({
      orgContext: "board-acme-widgets",
      chairRole: "finance",
      surface: "cli",
      title: "Finance chair"
    });
    if ("error" in chair) throw new Error(`createChairRun failed: ${chair.error}`);

    const firstView = await services.runs.get(chair.run.id);
    const firstApproval = firstView!.approvals.find((a) => a.status === "pending")!;
    await services.approvals.decide(firstApproval.id, "approved", "approved for test", "user_primary");
    await delegateOnce(chair.run.id, chair.run.workItemId, firstApproval.taskId, "first piece of work", `redelegate-1-${firstApproval.taskId}`);

    // Second delegation attempt against the SAME (now-consumed) approval must fail --
    // this is the bug being fixed, asserted here so a regression that silently makes
    // approvals reusable wouldn't hide the real fix underneath it.
    const secondProposalReusingOldApproval = await services.actions.createProposal({
      workItemId: chair.run.workItemId,
      runId: chair.run.id,
      taskId: firstApproval.taskId,
      toolId: "delegate_to_child",
      actionClass: "class_c",
      targetRef: "second piece of work, attempted without a fresh approval",
      idempotencyKey: `redelegate-2-no-fresh-approval-${firstApproval.taskId}`
    });
    expect("error" in secondProposalReusingOldApproval && secondProposalReusingOldApproval.error.code).toBe("approval_required");

    // The actual fix: request a fresh approval, approve it, delegate again.
    const secondApproval = await services.pa.requestDelegationApproval(chair.run.id);
    if ("error" in secondApproval) throw new Error(`requestDelegationApproval failed: ${secondApproval.error}`);
    expect(secondApproval.id).not.toBe(firstApproval.id);
    expect(secondApproval.status).toBe("pending");

    await services.approvals.decide(secondApproval.id, "approved", "approved for test", "user_primary");
    const secondExecuted = await delegateOnce(
      chair.run.id,
      chair.run.workItemId,
      secondApproval.taskId,
      "second piece of work",
      `redelegate-2-${secondApproval.taskId}`
    );

    const events = await services.runs.events(chair.run.id);
    const childCreatedEvents = events.filter((e) => e.eventType === "delegation.child_created");
    expect(childCreatedEvents.length).toBe(2);
    const firstChildRunId = (childCreatedEvents[0].payload as { childRunId: string }).childRunId;
    expect(secondExecuted.childRunId).not.toBe(firstChildRunId);
  });

  it("returns the same pending approval if one is already pending (idempotent, not a duplicate)", async () => {
    const chair = await services.pa.createChairRun({
      orgContext: "board-acme-widgets",
      chairRole: "hr",
      surface: "cli",
      title: "HR chair"
    });
    if ("error" in chair) throw new Error(`createChairRun failed: ${chair.error}`);

    const view = await services.runs.get(chair.run.id);
    const seeded = view!.approvals.find((a) => a.status === "pending")!;

    const requested = await services.pa.requestDelegationApproval(chair.run.id);
    if ("error" in requested) throw new Error(`requestDelegationApproval failed: ${requested.error}`);
    expect(requested.id).toBe(seeded.id);
  });

  it("rejects a request for a run id that doesn't exist", async () => {
    const requested = await services.pa.requestDelegationApproval("not-a-real-run-id");
    expect("error" in requested && requested.error).toContain("not found");
  });

  it("rejects a request for an ordinary root run with no chair/delegation context", async () => {
    const session = await services.pa.createSession("cli", "plain session");
    const view = await services.pa.postMessage(session.session.id, "Something on the codebase needs to be fixed.");
    const plainRunId = view?.latestRun?.id;
    if (!plainRunId) throw new Error("expected postMessage to create a run");

    const requested = await services.pa.requestDelegationApproval(plainRunId);
    expect("error" in requested && requested.error).toContain("not part of a delegation chain");
  });

  it("rejects a request for a worker-layer run", async () => {
    const chair = await services.pa.createChairRun({
      orgContext: "board-acme-widgets",
      chairRole: "operations",
      surface: "cli",
      title: "Operations chair"
    });
    if ("error" in chair) throw new Error(`createChairRun failed: ${chair.error}`);
    const chairView = await services.runs.get(chair.run.id);
    const chairApproval = chairView!.approvals.find((a) => a.status === "pending")!;
    await services.approvals.decide(chairApproval.id, "approved", "approved for test", "user_primary");

    // chair -> director
    const directorExec = await delegateOnce(chair.run.id, chair.run.workItemId, chairApproval.taskId, "director scope", `worker-chain-1-${chairApproval.taskId}`);
    const directorRunId = directorExec.childRunId;
    const directorView = await services.runs.get(directorRunId);
    const directorApproval = directorView!.approvals.find((a) => a.status === "pending")!;
    await services.approvals.decide(directorApproval.id, "approved", "approved for test", "user_primary");

    // director -> department
    const departmentExec = await delegateOnce(directorRunId, directorView!.run.workItemId, directorApproval.taskId, "department scope", `worker-chain-2-${directorApproval.taskId}`);
    const departmentRunId = departmentExec.childRunId;
    const departmentView = await services.runs.get(departmentRunId);
    const departmentApproval = departmentView!.approvals.find((a) => a.status === "pending")!;
    await services.approvals.decide(departmentApproval.id, "approved", "approved for test", "user_primary");

    // department -> worker
    const workerExec = await delegateOnce(departmentRunId, departmentView!.run.workItemId, departmentApproval.taskId, "worker scope", `worker-chain-3-${departmentApproval.taskId}`);
    const workerRunId = workerExec.childRunId;

    const requested = await services.pa.requestDelegationApproval(workerRunId);
    expect("error" in requested && requested.error).toContain("cannot delegate further");
  });
});
