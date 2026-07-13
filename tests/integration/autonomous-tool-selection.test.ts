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
 * Proves the actual reasoning loop this repo was missing: a task decides,
 * on its own, to call search_artifacts mid-execution -- no external caller
 * proposes it. The test provider below is the "model": on its first turn
 * for the "Execute planned work" task it requests search_artifacts instead
 * of answering; on its second turn (once toolResults are populated) it
 * gives a final answer built from the real result.
 */
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

describe("autonomous tool-selection loop", () => {
  let tempRoot: string;
  let artifactCommonsRoot: string;
  let executeTaskCallLog: TaskExecutionInput[];
  let services: Awaited<ReturnType<typeof createAppServices>>;
  const runnerId = "autonomous-tool-selection-test-runner";

  function createAutonomousTestProvider(config: AppConfig) {
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
            providerIdentity: "autonomous-tool-selection-test-provider",
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
        executeTaskCallLog.push(input);

        if (input.task.name === "Execute planned work" && input.toolResults.length === 0) {
          expect(input.availableTools.some((t) => t.toolId === "search_artifacts")).toBe(true);
          return {
            summary: "",
            detail: null,
            toolCalls: [
              { toolId: "search_artifacts", targetRef: "gig worker cooperative delivery", reasoning: "checking artifact-commons before building anything new" }
            ]
          };
        }

        if (input.task.name === "Execute planned work" && input.toolResults.length > 0) {
          const searchResult = input.toolResults.find((r) => r.toolId === "search_artifacts");
          const payload = searchResult?.payload as { matches?: Array<{ id: string }> } | undefined;
          const matchId = payload?.matches?.[0]?.id ?? "no-match";
          return { summary: `Found existing artifact: ${matchId}`, detail: JSON.stringify(searchResult) };
        }

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
          reasoningSummary: "Test provider always classifies as execution for this suite."
        };
      }
    };
  }

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autonomous-tools-test-"));
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
            artifact_types: ["service_catalog"],
            tags: ["cooperative", "gig-work", "delivery"]
          }
        ]
      })
    );

    executeTaskCallLog = [];
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
    services = await createAppServices(config, { provider: createAutonomousTestProvider(config) as never });
  });

  afterEach(async () => {
    await services.shutdown();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("a task autonomously calls search_artifacts mid-execution and incorporates the real result, with no external caller proposing it", async () => {
    const session = await services.pa.createSession("cli", "autonomous tool selection test");
    const posted = await services.pa.postMessage(session.session.id, "Build a service catalog for a gig worker delivery cooperative.");
    const runId = posted?.latestRun?.id;
    if (!runId) throw new Error("expected postMessage to create a run");

    const runView = await waitUntil(async () => {
      await pumpRunner(services, runnerId);
      const view = await services.runs.get(runId);
      return view?.run.status === "completed" ? view : null;
    });

    const executeTask = runView!.tasks.find((t) => t.name === "Execute planned work");
    expect(executeTask?.status).toBe("completed");
    expect(executeTask?.resultSummary).toBe("Found existing artifact: gig-cooperative");

    // Prove the tool was actually, really executed -- not just requested --
    // via the same governed event log every other action tool uses.
    const events = await services.runs.events(runId);
    const executedEvent = events.find((e) => e.eventType === "task.autonomous_tool_call_executed");
    expect(executedEvent).toBeDefined();
    expect((executedEvent!.payload as { toolId: string }).toolId).toBe("search_artifacts");
    expect((executedEvent!.payload as { outcome: string }).outcome).toContain("artifact_search_completed");

    // Prove the provider was called twice for this task -- once to request
    // the tool, once with the real result -- not just once with a canned answer.
    const executeTaskCallsForThisTask = executeTaskCallLog.filter((i) => i.task.name === "Execute planned work");
    expect(executeTaskCallsForThisTask.length).toBe(2);
    expect(executeTaskCallsForThisTask[0].toolResults).toEqual([]);
    expect(executeTaskCallsForThisTask[1].toolResults.length).toBe(1);
  });

  it("rejects an autonomous call to a tool that isn't on the safe list, without executing it", async () => {
    const config = loadConfigOrThrow({
      ...process.env,
      NODE_ENV: "test",
      PA_STORAGE_MODE: "memory",
      PA_ARTIFACTS_ROOT: path.join(tempRoot, "artifacts2"),
      PA_STATE_FILE: path.join(tempRoot, "state2.json"),
      PA_BACKUPS_ROOT: path.join(tempRoot, "backups2"),
      OLF_AGENTS_ROOT: path.join(tempRoot, "labor-commons-fixture2"),
      ARTIFACT_COMMONS_ROOT: artifactCommonsRoot
    });
    const maliciousProvider = {
      async getStatus(): Promise<ProviderStatus> {
        return {
          id: "api-provider", displayName: "Malicious Test Provider", model: config.provider.model,
          installed: true, authenticated: true, authMode: "api_key",
          capabilities: { providerIdentity: "malicious", supportsStreaming: true, supportsStructuredOutputs: true, supportsToolCalls: true, supportsFileIo: true, supportsCancellation: true },
          diagnostics: { checkedAt: new Date().toISOString(), apiKeyConfigured: true, readiness: "ready" }
        };
      },
      async answerChat(input: ChatAnswerInput): Promise<ChatAnswer> { return { content: input.message }; },
      async createPlan(input: PlanDraftInput): Promise<PlanDraft> { return { title: "t", summary: input.request, steps: [{ title: "s", description: input.request, required: true }] }; },
      async executeTask(input: TaskExecutionInput): Promise<TaskExecutionResult> {
        if (input.task.name === "Execute planned work" && input.toolResults.length === 0) {
          return { summary: "", detail: null, toolCalls: [{ toolId: "write_file", targetRef: "evil.txt", reasoning: "trying to sneak a class_b write past the safe list" }] };
        }
        return { summary: "done", detail: null };
      },
      async synthesizeRunResult(input: RunResultSynthesisInput): Promise<RunResultSynthesisResult> {
        return { summary: input.run.request, content: input.run.request };
      },
      async decideIntake(): Promise<IntakeDecision> {
        return { requestType: "execution", needsClarification: false, clarificationQuestion: null, clarificationReason: null, specialistCandidates: [], decisionConfidence: "medium", reasoningSummary: "" };
      }
    };
    const maliciousServices = await createAppServices(config, { provider: maliciousProvider as never });

    try {
      const session = await maliciousServices.pa.createSession("cli", "reject test");
      const posted = await maliciousServices.pa.postMessage(session.session.id, "Build something.");
      const runId = posted?.latestRun?.id;
      if (!runId) throw new Error("expected a run");

      await waitUntil(async () => {
        await pumpRunner(maliciousServices, runnerId);
        const view = await maliciousServices.runs.get(runId);
        return view?.run.status === "completed" ? view : null;
      });

      const events = await maliciousServices.runs.events(runId);
      const rejectedEvent = events.find((e) => e.eventType === "task.autonomous_tool_call_rejected");
      expect(rejectedEvent).toBeDefined();
      expect((rejectedEvent!.payload as { toolId: string }).toolId).toBe("write_file");
      expect(events.some((e) => e.eventType === "task.autonomous_tool_call_executed")).toBe(false);
    } finally {
      await maliciousServices.shutdown();
    }
  });
});
