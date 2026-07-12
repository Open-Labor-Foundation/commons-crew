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
  IntakeDecisionInput,
  PlanDraft,
  PlanDraftInput,
  ProviderStatus,
  RunResultSynthesisInput,
  RunResultSynthesisResult,
  TaskExecutionInput,
  TaskExecutionResult
} from "../../packages/contracts/src/index";

/**
 * No mocked/faked approval gate here — this drives the real
 * propose -> approve -> execute path (packages/core/src/index.ts) the same
 * way any external caller (e.g. the VS Code extension) would. The only
 * thing standing in for the real world is the LLM provider (network calls
 * would make this test flaky and slow) and the labor-commons catalog
 * (empty on purpose, to prove delegation doesn't require a selected
 * specialist to work).
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
          providerIdentity: "delegation-test-provider",
          supportsStreaming: true,
          supportsStructuredOutputs: true,
          supportsToolCalls: true,
          supportsFileIo: true,
          supportsCancellation: true
        },
        diagnostics: {
          checkedAt: new Date().toISOString(),
          apiKeyConfigured: true,
          readiness: "ready"
        }
      };
    },

    async answerChat(input: ChatAnswerInput): Promise<ChatAnswer> {
      return { content: `test provider chat answer for: ${input.message}` };
    },

    async createPlan(input: PlanDraftInput): Promise<PlanDraft> {
      return {
        title: "Test plan",
        summary: input.request,
        steps: [{ title: "Step", description: input.request, required: true }]
      };
    },

    async executeTask(input: TaskExecutionInput): Promise<TaskExecutionResult> {
      return {
        summary: `Completed task: ${input.task.name}.`,
        detail: input.task.description
      };
    },

    async synthesizeRunResult(input: RunResultSynthesisInput): Promise<RunResultSynthesisResult> {
      return {
        summary: `Completed the request: ${input.run.request}`,
        content: `Completed the request: ${input.run.request}`
      };
    },

    async decideIntake(input: IntakeDecisionInput): Promise<IntakeDecision> {
      if (input.message.includes("__DELEGATION_TEST__")) {
        return {
          requestType: "execution",
          needsClarification: false,
          clarificationQuestion: null,
          clarificationReason: null,
          specialistCandidates: [],
          decisionConfidence: "high",
          reasoningSummary: "Deterministic test routing for delegate_to_child integration test."
        };
      }
      return {
        requestType: "chat",
        needsClarification: false,
        clarificationQuestion: null,
        clarificationReason: null,
        specialistCandidates: [],
        decisionConfidence: "medium",
        reasoningSummary: "Not the delegation test trigger phrase."
      };
    }
  };
}

async function waitUntil<T>(fn: () => Promise<T | null>, timeoutMs = 15000, intervalMs = 40): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result) {
      return result;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Claims and starts whatever runner job is next queued, if any. No-op if the queue is empty. */
async function pumpRunner(services: Awaited<ReturnType<typeof createAppServices>>, runnerId: string) {
  const claimed = await services.runner.claimNext(runnerId);
  if (claimed) {
    await services.runner.start(claimed.id, runnerId);
  }
}

describe("delegate_to_child", () => {
  let tempRoot: string;
  let services: Awaited<ReturnType<typeof createAppServices>>;
  const runnerId = "delegation-test-runner";

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commons-crew-delegation-test-"));
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

  it("spawns a child run one layer down and reports completion back to the parent", async () => {
    const sessionView = await services.pa.createSession("cli", "Delegation integration test");
    const sessionId = sessionView.session.id;

    // "production" trips the requiresApproval() trigger-word regex in
    // buildExecutionTasksForSelectedAgents, so the middle task blocks for
    // approval without needing any catalog/specialist data.
    await services.pa.postMessage(sessionId, "__DELEGATION_TEST__ deploy this to production");

    const blocked = await waitUntil(async () => {
      await pumpRunner(services, runnerId);
      const session = await services.pa.getSession(sessionId);
      const latestRun = session?.latestRun ?? null;
      const pendingApproval = session?.pendingApprovals.find((approval) => approval.status === "pending") ?? null;
      if (!latestRun || !pendingApproval || !pendingApproval.taskId) {
        return null;
      }
      return { runId: latestRun.id, taskId: pendingApproval.taskId, approvalId: pendingApproval.id, workItemId: latestRun.workItemId };
    });

    const parentRun = await services.runs.get(blocked.runId);
    expect(parentRun).not.toBeNull();
    expect(parentRun!.run.delegation).toBeNull();

    // Propose delegate_to_child against the same run/task the pending
    // approval already covers. Not approved yet -- this proves createProposal
    // binds to an existing pending approval rather than requiring one to
    // already be approved.
    const proposal = await services.actions.createProposal({
      workItemId: blocked.workItemId,
      runId: blocked.runId,
      taskId: blocked.taskId,
      toolId: "delegate_to_child",
      actionClass: "class_c",
      targetRef: "Handle the IT-arm portion of this request",
      actionSummary: "Delegate IT-arm work to a director-layer instance",
      idempotencyKey: `delegate-${blocked.taskId}`
    });
    if ("error" in proposal) {
      throw new Error(`createProposal failed: ${proposal.error.code} ${proposal.error.message}`);
    }
    expect(proposal.approval.status).toBe("pending");

    // Executing before approval must fail closed -- this is the real gate,
    // not a stub, so prove it actually gates.
    const executedBeforeApproval = await services.actions.execute(proposal.id);
    expect(executedBeforeApproval && "error" in executedBeforeApproval ? executedBeforeApproval.error.code : null).toBe("approval_required");

    const decided = await services.approvals.decide(blocked.approvalId, "approved", "approved for test", "user_primary");
    expect(decided?.status).toBe("approved");

    const executed = await services.actions.execute(proposal.id);
    if (!executed || "error" in executed) {
      throw new Error(`execute failed: ${executed && "error" in executed ? executed.error.code : "null result"}`);
    }
    expect(executed.outcome).toContain("child_run_delegated");

    // The raw spawn payload (childRunId/layer) isn't on ActionExecutionRecord
    // itself -- it's written to the evidence file and mirrored onto the
    // parent's own event stream via delegation.child_created, which is also
    // the more natural place for anything downstream to read it from.
    const parentEventsAfterDelegation = await services.runs.events(blocked.runId);
    const childCreatedEvent = parentEventsAfterDelegation.find((event) => event.eventType === "delegation.child_created");
    expect(childCreatedEvent).toBeDefined();
    const { childRunId, layer } = childCreatedEvent!.payload as { childRunId: string; childTaskId: string; layer: string };
    expect(layer).toBe("director");

    const childRun = await services.runs.get(childRunId);
    expect(childRun).not.toBeNull();
    expect(childRun!.run.delegation).toMatchObject({
      parentRunId: blocked.runId,
      parentTaskId: blocked.taskId,
      layer: "director",
      scope: "Handle the IT-arm portion of this request"
    });

    // Drive the child run to completion the same way -- no approval needed,
    // no specialist assigned, same generic path createEvaluationTaskExecutionResult
    // exercises in the existing (unused-until-now) evaluation harness.
    await waitUntil(async () => {
      await pumpRunner(services, runnerId);
      const view = await services.runs.get(childRunId);
      return view?.run.status === "completed" ? view : null;
    });

    const parentEvents = await waitUntil(async () => {
      const events = await services.runs.events(blocked.runId);
      const completionEvent = events.find((event) => event.eventType === "delegation.completed");
      return completionEvent ? events : null;
    });

    const completionEvent = parentEvents.find((event) => event.eventType === "delegation.completed")!;
    expect(completionEvent.taskId).toBe(blocked.taskId);
    expect(completionEvent.payload).toMatchObject({
      childRunId,
      childStatus: "completed",
      layer: "director"
    });
  });

  it("rejects delegation from a task with no approval on record", async () => {
    // Guards the same gate the "before approval" assertion above checks,
    // from the other direction: delegate_to_child bound to a run/task pair
    // that never had an ApprovalRecord created at all (no trigger word, so
    // requiresApproval() never fired) must fail closed, not silently
    // succeed because no approval was ever required.
    const sessionView = await services.pa.createSession("cli", "No-approval delegation test");
    const sessionId = sessionView.session.id;
    await services.pa.postMessage(sessionId, "__DELEGATION_TEST__ just look something up, nothing risky");

    const running = await waitUntil(async () => {
      await pumpRunner(services, runnerId);
      const session = await services.pa.getSession(sessionId);
      const latestRun = session?.latestRun ?? null;
      if (!latestRun) {
        return null;
      }
      const tasks = await services.runs.tasks(latestRun.id);
      const middleTask = tasks.find((task) => task.name === "Execute planned work") ?? null;
      if (!middleTask) {
        return null;
      }
      return { runId: latestRun.id, taskId: middleTask.id, workItemId: latestRun.workItemId };
    });

    const proposal = await services.actions.createProposal({
      workItemId: running.workItemId,
      runId: running.runId,
      taskId: running.taskId,
      toolId: "delegate_to_child",
      actionClass: "class_c",
      targetRef: "Attempted delegation with no approval on record",
      idempotencyKey: `delegate-no-approval-${running.taskId}`
    });
    if ("error" in proposal) {
      throw new Error(`createProposal failed unexpectedly: ${proposal.error.code}`);
    }
    expect(proposal.approval.status).toBe("not_requested");

    const executed = await services.actions.execute(proposal.id);
    expect(executed && "error" in executed ? executed.error.code : null).toBe("approval_required");
  });

  it("walks the full chain to worker, pre-seeding delegation approval at every non-terminal layer", async () => {
    const sessionView = await services.pa.createSession("cli", "Full-chain delegation test");
    const sessionId = sessionView.session.id;
    await services.pa.postMessage(sessionId, "__DELEGATION_TEST__ deploy this to production");

    const chairBlocked = await waitUntil(async () => {
      await pumpRunner(services, runnerId);
      const session = await services.pa.getSession(sessionId);
      const latestRun = session?.latestRun ?? null;
      const pendingApproval = session?.pendingApprovals.find((approval) => approval.status === "pending") ?? null;
      if (!latestRun || !pendingApproval || !pendingApproval.taskId) {
        return null;
      }
      return { runId: latestRun.id, taskId: pendingApproval.taskId, approvalId: pendingApproval.id, workItemId: latestRun.workItemId };
    });

    /** Delegates once from a given run/task/approval, returns the child's own run/task/pending-approval (if any). */
    async function delegateOneHop(
      parent: { runId: string; taskId: string; approvalId: string; workItemId: string },
      scopeLabel: string
    ) {
      await services.approvals.decide(parent.approvalId, "approved", "approved for test", "user_primary");

      const proposal = await services.actions.createProposal({
        workItemId: parent.workItemId,
        runId: parent.runId,
        taskId: parent.taskId,
        toolId: "delegate_to_child",
        actionClass: "class_c",
        targetRef: scopeLabel,
        idempotencyKey: `delegate-${parent.taskId}-${scopeLabel}`
      });
      if ("error" in proposal) {
        throw new Error(`createProposal failed at ${scopeLabel}: ${proposal.error.code}`);
      }
      const executed = await services.actions.execute(proposal.id);
      if (!executed || "error" in executed) {
        throw new Error(`execute failed at ${scopeLabel}: ${executed && "error" in executed ? executed.error.code : "null result"}`);
      }

      const parentEvents = await services.runs.events(parent.runId);
      const childCreatedEvent = [...parentEvents].reverse().find((event) => event.eventType === "delegation.child_created");
      const { childRunId, childTaskId, layer } = childCreatedEvent!.payload as {
        childRunId: string;
        childTaskId: string;
        layer: string;
      };

      const childView = await services.runs.get(childRunId);
      const childPendingApproval = childView!.approvals.find((approval) => approval.status === "pending") ?? null;

      return {
        runId: childRunId,
        taskId: childTaskId,
        layer,
        workItemId: childView!.run.workItemId,
        approvalId: childPendingApproval?.id ?? null
      };
    }

    const director = await delegateOneHop(chairBlocked, "director scope");
    expect(director.layer).toBe("director");
    expect(director.approvalId).not.toBeNull(); // pre-seeded: director can delegate further

    const department = await delegateOneHop(
      { runId: director.runId, taskId: director.taskId, approvalId: director.approvalId!, workItemId: director.workItemId },
      "department scope"
    );
    expect(department.layer).toBe("department");
    expect(department.approvalId).not.toBeNull(); // pre-seeded: department can delegate further

    const worker = await delegateOneHop(
      { runId: department.runId, taskId: department.taskId, approvalId: department.approvalId!, workItemId: department.workItemId },
      "worker scope"
    );
    expect(worker.layer).toBe("worker");
    expect(worker.approvalId).toBeNull(); // NOT pre-seeded: worker is the bottom of the chain

    // Confirm the boundary is enforced at the tool level too, not just by
    // omission of a pre-seeded approval -- proposing delegate_to_child from
    // worker must fail even if someone tried to force an approval into
    // existence some other way. Since no approval exists for the worker's
    // task, createProposal itself can still succeed (status: not_requested),
    // but execute must fail closed exactly like the no-approval case above.
    const workerProposal = await services.actions.createProposal({
      workItemId: worker.workItemId,
      runId: worker.runId,
      taskId: worker.taskId,
      toolId: "delegate_to_child",
      actionClass: "class_c",
      targetRef: "attempted delegation past worker",
      idempotencyKey: `delegate-${worker.taskId}-past-worker`
    });
    if ("error" in workerProposal) {
      throw new Error(`createProposal failed unexpectedly at worker: ${workerProposal.error.code}`);
    }
    const workerExecuted = await services.actions.execute(workerProposal.id);
    expect(workerExecuted && "error" in workerExecuted ? workerExecuted.error.code : null).toBe("approval_required");
  });
});
