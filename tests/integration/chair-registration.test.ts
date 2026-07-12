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
 * createChairRun bypasses decideIntake entirely (chair registration is an
 * administrative act, not a request to classify), so this provider only
 * needs to cover what a chair run's own task execution touches once it's
 * running -- the same generic paths the delegation tests already exercise.
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
          providerIdentity: "chair-registration-test-provider",
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
      return { title: "Test plan", summary: input.request, steps: [{ title: "Step", description: input.request, required: true }] };
    },
    async executeTask(input: TaskExecutionInput): Promise<TaskExecutionResult> {
      return { summary: `Completed task: ${input.task.name}.`, detail: input.task.description };
    },
    async synthesizeRunResult(input: RunResultSynthesisInput): Promise<RunResultSynthesisResult> {
      return { summary: `Completed the request: ${input.run.request}`, content: `Completed the request: ${input.run.request}` };
    },
    async decideIntake(): Promise<IntakeDecision> {
      // Not exercised by createChairRun, but AppProvider requires it.
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

describe("pa.createChairRun", () => {
  let tempRoot: string;
  let services: Awaited<ReturnType<typeof createAppServices>>;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commons-crew-chair-test-"));
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

  it("registers a root run as a specific chair for a specific org", async () => {
    const result = await services.pa.createChairRun({
      orgContext: "board-acme-widgets",
      chairRole: "finance",
      surface: "cli",
      title: "Finance chair"
    });
    if ("error" in result) {
      throw new Error(`createChairRun failed unexpectedly: ${result.error}`);
    }

    expect(result.run.delegation).toBeNull();
    expect(result.run.chairRegistration).toMatchObject({
      orgContext: "board-acme-widgets",
      chairRole: "finance"
    });

    const events = await services.runs.events(result.run.id);
    expect(events.some((event) => event.eventType === "run.chair_registered")).toBe(true);
  });

  it("rejects a chair role outside the fixed v1 set", async () => {
    const result = await services.pa.createChairRun({
      orgContext: "board-acme-widgets",
      // @ts-expect-error -- deliberately invalid to prove the runtime check, not just the type
      chairRole: "engineering",
      surface: "cli",
      title: "Bogus chair"
    });
    expect("error" in result && result.error).toContain("not a recognized chair role");
  });

  it("rejects an empty orgContext", async () => {
    const result = await services.pa.createChairRun({
      orgContext: "   ",
      chairRole: "hr",
      surface: "cli",
      title: "HR chair"
    });
    expect("error" in result && result.error).toContain("orgContext is required");
  });

  it("a registered chair can delegate immediately, and its child inherits the chair's orgContext", async () => {
    const chair = await services.pa.createChairRun({
      orgContext: "board-acme-widgets",
      chairRole: "operations",
      surface: "cli",
      title: "Operations chair"
    });
    if ("error" in chair) {
      throw new Error(`createChairRun failed: ${chair.error}`);
    }

    // Registration seeds a pending approval on the run's own "Execute
    // planned work" task, the same way a non-worker delegated child gets
    // one -- a chair should be able to delegate from the moment it's
    // registered, not only once one of its own tasks happens to trip
    // requiresApproval(). Find that seeded approval directly.
    const chairView = await services.runs.get(chair.run.id);
    const seededApproval = chairView!.approvals.find((approval) => approval.status === "pending");
    expect(seededApproval).toBeDefined();

    await services.approvals.decide(seededApproval!.id, "approved", "approved for test", "user_primary");

    const proposal = await services.actions.createProposal({
      workItemId: chair.run.workItemId,
      runId: chair.run.id,
      taskId: seededApproval!.taskId,
      toolId: "delegate_to_child",
      actionClass: "class_c",
      targetRef: "director scope from a freshly registered chair",
      idempotencyKey: `delegate-fresh-chair-${seededApproval!.taskId}`
    });
    if ("error" in proposal) {
      throw new Error(`createProposal failed unexpectedly: ${proposal.error.code}`);
    }
    const executed = await services.actions.execute(proposal.id);
    if (!executed || "error" in executed) {
      throw new Error(`execute failed: ${executed && "error" in executed ? executed.error.code : "null result"}`);
    }

    const chairEvents = await services.runs.events(chair.run.id);
    const childCreatedEvent = chairEvents.find((event) => event.eventType === "delegation.child_created");
    expect(childCreatedEvent).toBeDefined();
    const { childRunId, layer } = childCreatedEvent!.payload as { childRunId: string; layer: string };
    expect(layer).toBe("director");

    const childRun = await services.runs.get(childRunId);
    expect(childRun!.run.delegation).toMatchObject({
      parentRunId: chair.run.id,
      orgContext: "board-acme-widgets", // inherited from chairRegistration, not from a delegation parent
      layer: "director"
    });
    expect(childRun!.run.chairRegistration).toBeNull();
  });

  it("rejects delegation from a fresh chair run before its seeded approval is approved", async () => {
    const chair = await services.pa.createChairRun({
      orgContext: "board-acme-widgets",
      chairRole: "marketing",
      surface: "cli",
      title: "Marketing chair"
    });
    if ("error" in chair) {
      throw new Error(`createChairRun failed: ${chair.error}`);
    }
    const chairView = await services.runs.get(chair.run.id);
    const seededApproval = chairView!.approvals.find((approval) => approval.status === "pending")!;

    const proposal = await services.actions.createProposal({
      workItemId: chair.run.workItemId,
      runId: chair.run.id,
      taskId: seededApproval.taskId,
      toolId: "delegate_to_child",
      actionClass: "class_c",
      targetRef: "attempted delegation before approval",
      idempotencyKey: `delegate-unapproved-chair-${seededApproval.taskId}`
    });
    if ("error" in proposal) {
      throw new Error(`createProposal failed unexpectedly: ${proposal.error.code}`);
    }
    expect(proposal.approval.status).toBe("pending");
    const executed = await services.actions.execute(proposal.id);
    expect(executed && "error" in executed ? executed.error.code : null).toBe("approval_required");
  });
});
