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
          providerIdentity: "search-artifacts-test-provider",
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
        requestType: "execution",
        needsClarification: false,
        clarificationQuestion: null,
        clarificationReason: null,
        specialistCandidates: [],
        decisionConfidence: "medium",
        reasoningSummary: "Not exercised by search_artifacts."
      };
    }
  };
}

describe("search_artifacts action tool", () => {
  let tempRoot: string;
  let artifactCommonsRoot: string;
  let services: Awaited<ReturnType<typeof createAppServices>>;

  async function proposeAndExecute(targetRef: string) {
    const session = await services.pa.createSession("cli", "search artifacts test");
    const view = await services.pa.postMessage(session.session.id, "Need something built.");
    const runId = view?.latestRun?.id;
    if (!runId) throw new Error("expected postMessage to create a run");
    const runView = await services.runs.get(runId);
    const task = runView!.tasks[0];

    const proposal = await services.actions.createProposal({
      workItemId: runView!.run.workItemId,
      runId,
      taskId: task.id,
      toolId: "search_artifacts",
      actionClass: "class_a",
      targetRef,
      idempotencyKey: `search-${runId}-${targetRef}`
    });
    if ("error" in proposal) throw new Error(`createProposal failed: ${proposal.error.code}`);

    // class_a is requiresApproval: false -- must execute immediately with
    // no approval step, unlike delegate_to_child's class_c gate.
    expect(proposal.approval.approvalId).toBeNull();

    const executed = await services.actions.execute(proposal.id);
    if (!executed || "error" in executed) throw new Error(`execute failed: ${executed && "error" in executed ? executed.error.code : "null"}`);

    // ActionExecutionRecord itself only carries a flattened outcome string
    // ("<outcome>: <toolId> -> <targetRef>") -- the structured payload is
    // written to a durable evidence file instead (same reasoning as
    // delegate_to_child's real result living on the run's event log, not
    // the direct execute() response). Read it back the same way any real
    // caller would: from the deterministic evidence path.
    const evidencePath = path.join(tempRoot, "artifacts", "action-evidence", proposal.id, "execution-evidence.json");
    const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8")) as {
      execution: { outcome: string; payload: unknown };
    };
    return { outcome: evidence.execution.outcome, payload: evidence.execution.payload };
  }

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "search-artifacts-test-"));
    artifactCommonsRoot = path.join(tempRoot, "artifact-commons");
    await fs.mkdir(artifactCommonsRoot, { recursive: true });
    await fs.writeFile(
      path.join(artifactCommonsRoot, "catalog.json"),
      JSON.stringify({
        version: "1",
        packs: [
          {
            id: "gig-cooperative",
            name: "Gig Worker Cooperative",
            status: "available",
            description: "Configuration pack for platform-based gig worker delivery cooperatives.",
            artifact_types: ["service_catalog", "earnings_distribution_model"],
            tags: ["cooperative", "gig-work", "delivery", "labor"]
          },
          {
            id: "startup-launch",
            name: "Startup Launch",
            status: "available",
            description: "Configuration pack for founder-stage companies.",
            artifact_types: ["venture_profile", "launch_plan"],
            tags: ["startup", "founder"]
          }
        ]
      })
    );

    const config = loadConfigOrThrow({
      ...process.env,
      NODE_ENV: "test",
      PA_STORAGE_MODE: "memory",
      PA_ARTIFACTS_ROOT: path.join(tempRoot, "artifacts"),
      PA_STATE_FILE: path.join(tempRoot, "state.json"),
      PA_BACKUPS_ROOT: path.join(tempRoot, "backups"),
      OLF_AGENTS_ROOT: path.join(tempRoot, "labor-commons-fixture"),
      ARTIFACT_COMMONS_ROOT: artifactCommonsRoot
    });
    services = await createAppServices(config, { provider: createTestProvider(config) as never });
  });

  afterEach(async () => {
    await services.shutdown();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("finds a matching artifact by tag/description terms", async () => {
    const executed = await proposeAndExecute("gig worker cooperative delivery");
    expect(executed.outcome).toContain("artifact_search_completed");
    const payload = executed.payload as { matchCount: number; matches: Array<{ id: string; score: number }> };
    expect(payload.matchCount).toBeGreaterThan(0);
    expect(payload.matches[0].id).toBe("gig-cooperative");
  });

  it("returns zero matches (not an error) for a query that matches nothing", async () => {
    const executed = await proposeAndExecute("nonexistent unrelated widget factory");
    expect(executed.outcome).toContain("artifact_search_completed");
    const payload = executed.payload as { matchCount: number };
    expect(payload.matchCount).toBe(0);
  });

  it("ranks a more specific match above a less specific one", async () => {
    const executed = await proposeAndExecute("startup launch venture");
    const payload = executed.payload as { matches: Array<{ id: string; score: number }> };
    expect(payload.matches[0].id).toBe("startup-launch");
  });

  it("reports artifact_catalog_unavailable, not a crash, when artifact-commons isn't checked out", async () => {
    await fs.rm(path.join(artifactCommonsRoot, "catalog.json"));
    const executed = await proposeAndExecute("gig worker cooperative");
    expect(executed.outcome).toContain("artifact_catalog_unavailable");
  });
});
