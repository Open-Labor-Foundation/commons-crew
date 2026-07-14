import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
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
 * Proves the actual production gap this closes: autonomous-tool-selection.test.ts
 * only ever exercises the in-process shared_runner path (its task fixture has no
 * assigned specialist, so resolveSpecialistExecutionMode always returns
 * shared_runner regardless of profile/env). Production's default path for any
 * task WITH an assigned specialist is isolated_subprocess -- a real child
 * process that, before this change, could never reach the autonomous tool
 * loop at all (availableTools was stripped before spawning it).
 *
 * This test forces a real specialist assignment (a real catalog fixture) and
 * PA_SPECIALIST_EXECUTION_MODE=isolated_subprocess, then proves the loop runs
 * for real across a real process boundary: no in-process provider stands in
 * for the subprocess's own model call -- a local fake HTTP server plays that
 * role, and the actual `tsx` child process (apps/crew-runner/src/specialist-worker.ts,
 * unmodified) is what calls it, via the real createApiProvider used in
 * production. The in-process test provider below only answers for tasks that
 * have no assigned specialist (which always stay on shared_runner) and for
 * intake/planning/synthesis, never for "Execute planned work" itself.
 */
async function waitUntil<T>(fn: () => Promise<T | null>, timeoutMs = 30000, intervalMs = 100): Promise<T> {
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

async function pumpRunner(services: Awaited<ReturnType<typeof createAppServices>>, runnerId: string) {
  const claimed = await services.runner.claimNext(runnerId);
  if (claimed) {
    await services.runner.start(claimed.id, runnerId);
  }
}

const TEST_SPECIALIST_SLUG = "isolated-subprocess-test-specialist";

function fixtureSpecYaml(): string {
  return `schema_version: "1.0"
kind: "agent_definition"
metadata:
  slug: "${TEST_SPECIALIST_SLUG}"
  name: "Isolated Subprocess Test Specialist"
  domain_family: "test/${TEST_SPECIALIST_SLUG}"
  specialty_boundary: "Owns exactly one narrow test responsibility and nothing else."
  status: "validated"
purpose:
  summary: "Test fixture specialist used to force isolated_subprocess execution."
scope:
  supported_tasks:
    - "Do the one test task."
  common_inputs:
    - "test input"
  expected_outputs:
    - "test output"
`;
}

describe("autonomous tool-selection loop on the isolated_subprocess execution path", () => {
  let tempRoot: string;
  let artifactCommonsRoot: string;
  let fakeProviderServer: Server;
  let fakeProviderBaseUrl: string;
  let fakeProviderCallLog: Array<{ taskName: string; toolResultsCount: number }>;
  let services: Awaited<ReturnType<typeof createAppServices>>;
  const runnerId = "isolated-subprocess-tool-selection-test-runner";
  const savedEnv: Record<string, string | undefined> = {};

  function createInProcessTestProvider(config: AppConfig) {
    return {
      async getStatus(): Promise<ProviderStatus> {
        return {
          id: "api-provider",
          displayName: "In-Process Test Provider",
          model: config.provider.model,
          installed: true,
          authenticated: true,
          authMode: "api_key",
          capabilities: {
            providerIdentity: "isolated-subprocess-test-in-process-provider",
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
      // Only ever called for the specialist-less tasks (which always stay
      // shared_runner) -- "Execute planned work" here has a real assigned
      // specialist and is routed to the real subprocess/fake HTTP server
      // instead. If this fires for "Execute planned work" the routing
      // itself is broken, not just untested.
      async executeTask(input: TaskExecutionInput): Promise<TaskExecutionResult> {
        if (input.task.name === "Execute planned work") {
          throw new Error("In-process test provider was called for 'Execute planned work' -- isolated_subprocess routing did not take effect.");
        }
        return { summary: `Completed task: ${input.task.name}.`, detail: input.task.description };
      },
      async synthesizeRunResult(input: RunResultSynthesisInput): Promise<RunResultSynthesisResult> {
        return { summary: `Completed the request: ${input.run.request}`, content: `Completed the request: ${input.run.request}` };
      },
      async decideIntake(input: IntakeDecisionInput): Promise<IntakeDecision> {
        const entry = input.catalog.find((c) => c.agentSlug === TEST_SPECIALIST_SLUG);
        return {
          requestType: "execution",
          needsClarification: false,
          clarificationQuestion: null,
          clarificationReason: null,
          specialistCandidates: entry
            ? [{ catalogEntryId: entry.id, confidence: "high", reason: "Matches the test fixture specialist." }]
            : [],
          decisionConfidence: "high",
          reasoningSummary: "Test provider always routes to the fixture specialist when present."
        };
      }
    };
  }

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "isolated-subprocess-tools-test-"));

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

    const specialistDir = path.join(tempRoot, "labor-commons-fixture", "catalog", "naics-overlays", "test-industry", TEST_SPECIALIST_SLUG);
    await fs.mkdir(specialistDir, { recursive: true });
    await fs.writeFile(path.join(specialistDir, "spec.yaml"), fixtureSpecYaml());

    // Real HTTP server standing in for the LLM endpoint the real
    // createApiProvider (used by the real subprocess) calls -- this repo's
    // own established pattern for verifying real pipeline logic without a
    // live model key. Only ever needs to answer /chat/completions requests
    // for the "Execute planned work" task, since that's the only call the
    // subprocess ever makes.
    fakeProviderCallLog = [];
    fakeProviderServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ role: string; content: string }> };
        const userMessage = body.messages.find((m) => m.role === "user")?.content ?? "";
        const rawInput = userMessage.replace(/^Input:\n/, "");
        const input = JSON.parse(rawInput) as TaskExecutionInput;

        fakeProviderCallLog.push({ taskName: input.task.name, toolResultsCount: input.toolResults.length });

        let resultBody: TaskExecutionResult;
        if (input.task.name === "Execute planned work" && input.toolResults.length === 0) {
          expect(input.availableTools.some((t) => t.toolId === "search_artifacts")).toBe(true);
          resultBody = {
            summary: "",
            detail: null,
            toolCalls: [
              { toolId: "search_artifacts", targetRef: "gig worker cooperative delivery", reasoning: "checking artifact-commons before building anything new, from a real subprocess" }
            ]
          };
        } else if (input.task.name === "Execute planned work" && input.toolResults.length > 0) {
          const searchResult = input.toolResults.find((r) => r.toolId === "search_artifacts");
          const payload = searchResult?.payload as { matches?: Array<{ id: string }> } | undefined;
          const matchId = payload?.matches?.[0]?.id ?? "no-match";
          resultBody = { summary: `Found existing artifact via subprocess: ${matchId}`, detail: JSON.stringify(searchResult) };
        } else {
          resultBody = { summary: `Completed task: ${input.task.name}.`, detail: input.task.description };
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(resultBody) } }] }));
      });
    });
    await new Promise<void>((resolve) => fakeProviderServer.listen(0, "127.0.0.1", resolve));
    const address = fakeProviderServer.address();
    if (address === null || typeof address === "string") throw new Error("expected a network address");
    fakeProviderBaseUrl = `http://127.0.0.1:${address.port}`;

    // resolveSpecialistExecutionMode and the real subprocess's own config
    // both read these directly from process.env (not from the config
    // object this test builds below) -- see packages/core/src/specialist-worker-runtime.ts.
    savedEnv.PA_SPECIALIST_EXECUTION_MODE = process.env.PA_SPECIALIST_EXECUTION_MODE;
    savedEnv.PA_PROVIDER_BASE_URL = process.env.PA_PROVIDER_BASE_URL;
    savedEnv.PA_PROVIDER_API_KEY = process.env.PA_PROVIDER_API_KEY;
    savedEnv.PA_PROVIDER_MODEL = process.env.PA_PROVIDER_MODEL;
    process.env.PA_SPECIALIST_EXECUTION_MODE = "isolated_subprocess";
    process.env.PA_PROVIDER_BASE_URL = fakeProviderBaseUrl;
    process.env.PA_PROVIDER_API_KEY = "test-key-isolated-subprocess";
    process.env.PA_PROVIDER_MODEL = "test-model-isolated-subprocess";

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
    services = await createAppServices(config, { provider: createInProcessTestProvider(config) as never });
  });

  afterEach(async () => {
    await services.shutdown();
    await new Promise<void>((resolve) => fakeProviderServer.close(() => resolve()));
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it(
    "a task with a real assigned specialist, running in a real isolated_subprocess child process, autonomously calls search_artifacts and incorporates the real result",
    async () => {
      const session = await services.pa.createSession("cli", "isolated subprocess tool selection test");
      const posted = await services.pa.postMessage(session.session.id, "Build a service catalog for a gig worker delivery cooperative.");
      const runId = posted?.latestRun?.id;
      if (!runId) throw new Error("expected postMessage to create a run");

      // Generous timeout: unlike every other test in this suite, this one
      // spawns real tsx child processes (one per turn) rather than calling
      // an in-process provider, so it's meaningfully slower and more
      // variable than the shared_runner equivalent, especially cold.
      const runView = await waitUntil(async () => {
        await pumpRunner(services, runnerId);
        const view = await services.runs.get(runId);
        // The fixture specialist's legacy-format spec.yaml always maps to
        // permissions.approvalRequired: true (see packages/catalog/src/index.ts's
        // parseLegacyContract*), so "Execute planned work" blocks for a real
        // human approval before it can run at all -- unrelated to the
        // autonomous tool loop itself, and the same gate every other
        // specialist-assigned task goes through in production.
        const pendingApproval = view?.approvals.find((a) => a.status === "pending");
        if (pendingApproval) {
          await services.approvals.decide(pendingApproval.id, "approved", "approved for test", "user_primary");
        }
        return view?.run.status === "completed" ? view : null;
      }, 60000);

      const executeTask = runView!.tasks.find((t) => t.name === "Execute planned work");
      expect(executeTask?.assignedAgentId).not.toBeNull();
      expect(executeTask?.status).toBe("completed");
      expect(executeTask?.resultSummary).toBe("Found existing artifact via subprocess: gig-cooperative");

      // Prove the tool was actually, really executed through the normal
      // governed path (actions.createProposal/execute in the parent
      // process), not something the subprocess faked on its own.
      const events = await services.runs.events(runId);
      const executedEvent = events.find((e) => e.eventType === "task.autonomous_tool_call_executed");
      expect(executedEvent).toBeDefined();
      expect((executedEvent!.payload as { toolId: string }).toolId).toBe("search_artifacts");
      expect((executedEvent!.payload as { outcome: string }).outcome).toContain("artifact_search_completed");

      // Prove the real subprocess's own provider (via the fake HTTP server,
      // not the in-process test provider) was called twice for this task --
      // once to request the tool, once with the real result.
      const callsForThisTask = fakeProviderCallLog.filter((c) => c.taskName === "Execute planned work");
      expect(callsForThisTask.length).toBe(2);
      expect(callsForThisTask[0].toolResultsCount).toBe(0);
      expect(callsForThisTask[1].toolResultsCount).toBe(1);
    },
    75000
  );
});
