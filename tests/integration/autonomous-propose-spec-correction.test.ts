import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

const TEST_SPECIALIST_SLUG = "propose-correction-test-specialist";

const FIXTURE_SPEC = `schema_version: "1.0"
kind: "agent_definition"
metadata:
  slug: "${TEST_SPECIALIST_SLUG}"
  name: "Propose Correction Test Specialist"
  domain_family: "test/${TEST_SPECIALIST_SLUG}"
  specialty_boundary: "Owns exactly one narrow test responsibility and nothing else."
  status: "validated"
purpose:
  summary: "Original summary the specialist itself will flag as wrong."
scope:
  supported_tasks:
    - "Do the one test task."
  common_inputs:
    - "test input"
  expected_outputs:
    - "test output"
`;

/**
 * Proves the "specialist correcting its own record mid-conversation" half
 * of the practitioner-corrections gap named in
 * open-labor-foundation/ARCHITECTURE.md: a task decides on its own,
 * mid-execution, to propose a correction to its OWN spec.yaml -- no
 * external caller (commons-board's UI, a human) initiates it. Distinct
 * from search_artifacts's autonomous loop in one deliberate way: this
 * tool is only ever autonomously PROPOSED, never auto-executed -- a real
 * human decision, through the normal external action-proposal flow, is
 * still required before any PR against labor-commons actually opens.
 */
async function waitUntil<T>(fn: () => Promise<T | null>, timeoutMs = 15000, intervalMs = 40): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function pumpRunner(services: Awaited<ReturnType<typeof createAppServices>>, runnerId: string) {
  const claimed = await services.runner.claimNext(runnerId);
  if (claimed) {
    await services.runner.start(claimed.id, runnerId);
  }
}

describe("autonomous propose_spec_correction: proposed, never auto-executed", () => {
  let tempRoot: string;
  let bareRepoPath: string;
  let checkoutPath: string;
  let server: Server;
  let apiBaseUrl: string;
  let lastPrRequestBody: Record<string, unknown> | null;
  let services: Awaited<ReturnType<typeof createAppServices>>;
  let testSpecialistManifestId: string;
  const runnerId = "autonomous-propose-correction-test-runner";

  function createInProcessTestProvider(config: AppConfig) {
    return {
      async getStatus(): Promise<ProviderStatus> {
        return {
          id: "api-provider", displayName: "Test Provider", model: config.provider.model,
          installed: true, authenticated: true, authMode: "api_key",
          capabilities: { providerIdentity: "propose-correction-test-provider", supportsStreaming: true, supportsStructuredOutputs: true, supportsToolCalls: true, supportsFileIo: true, supportsCancellation: true },
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
        if (input.task.name === "Execute planned work" && input.toolResults.length === 0) {
          expect(input.availableTools.some((t) => t.toolId === "propose_spec_correction")).toBe(true);
          return {
            summary: "",
            detail: null,
            toolCalls: [
              {
                toolId: "propose_spec_correction",
                targetRef: JSON.stringify({
                  manifestId: input.specialist.id,
                  fieldPath: ["purpose", "summary"],
                  proposedValue: "Corrected summary the specialist itself noticed was wrong mid-task.",
                  justification: "Discovered the original summary was inaccurate while doing the actual work."
                }),
                reasoning: "Noticed my own spec.yaml summary is wrong while doing this task."
              }
            ]
          };
        }
        if (input.task.name === "Execute planned work" && input.toolResults.length > 0) {
          const correctionResult = input.toolResults.find((r) => r.toolId === "propose_spec_correction");
          return { summary: `Filed a correction: ${correctionResult?.outcome}`, detail: JSON.stringify(correctionResult) };
        }
        return { summary: `Completed task: ${input.task.name}.`, detail: input.task.description };
      },
      async synthesizeRunResult(input: RunResultSynthesisInput): Promise<RunResultSynthesisResult> {
        return { summary: `Completed the request: ${input.run.request}`, content: `Completed the request: ${input.run.request}` };
      },
      async decideIntake(input: IntakeDecisionInput): Promise<IntakeDecision> {
        const entry = input.catalog.find((c) => c.agentSlug === TEST_SPECIALIST_SLUG);
        return {
          requestType: "execution", needsClarification: false, clarificationQuestion: null, clarificationReason: null,
          specialistCandidates: entry ? [{ catalogEntryId: entry.id, confidence: "high", reason: "Matches the test fixture specialist." }] : [],
          decisionConfidence: "high", reasoningSummary: "Test provider always routes to the fixture specialist when present."
        };
      }
    };
  }

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autonomous-propose-correction-test-"));
    bareRepoPath = path.join(tempRoot, "labor-commons-bare.git");
    checkoutPath = path.join(tempRoot, "labor-commons-checkout");

    await execFileAsync("git", ["init", "--bare", "-b", "main", bareRepoPath]);
    await fs.mkdir(checkoutPath, { recursive: true });
    await git(["init", "-b", "main"], checkoutPath);
    await git(["remote", "add", "origin", bareRepoPath], checkoutPath);

    const specDir = path.join(checkoutPath, "catalog", "naics-overlays", "test-industry", TEST_SPECIALIST_SLUG);
    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(path.join(specDir, "spec.yaml"), FIXTURE_SPEC, "utf8");
    await git(["add", "."], checkoutPath);
    await git(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "seed"], checkoutPath);
    await git(["push", "origin", "main"], checkoutPath);

    testSpecialistManifestId = path.posix.join("catalog", "naics-overlays", "test-industry", TEST_SPECIALIST_SLUG, "spec.yaml");

    lastPrRequestBody = null;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        lastPrRequestBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ html_url: "https://github.com/Open-Labor-Foundation/labor-commons/pull/999" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a network address");
    apiBaseUrl = `http://127.0.0.1:${address.port}`;

    const config = loadConfigOrThrow({
      ...process.env,
      NODE_ENV: "test",
      PA_STORAGE_MODE: "memory",
      PA_ARTIFACTS_ROOT: path.join(tempRoot, "artifacts"),
      PA_STATE_FILE: path.join(tempRoot, "state.json"),
      PA_BACKUPS_ROOT: path.join(tempRoot, "backups"),
      OLF_AGENTS_ROOT: checkoutPath,
      PA_LABOR_COMMONS_GH_TOKEN: "test-token",
      PA_LABOR_COMMONS_REMOTE_URL: bareRepoPath,
      PA_LABOR_COMMONS_GH_API_BASE: apiBaseUrl
    });
    services = await createAppServices(config, { provider: createInProcessTestProvider(config) as never });
  });

  afterEach(async () => {
    await services.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("proposes a real, auditable correction mid-task but never auto-executes it -- then a human approval opens the real PR", async () => {
    const session = await services.pa.createSession("cli", "autonomous propose correction test");
    const posted = await services.pa.postMessage(session.session.id, "Do the one test task for propose-correction-test-specialist.");
    const runId = posted?.latestRun?.id;
    if (!runId) throw new Error("expected postMessage to create a run");

    const runView = await waitUntil(async () => {
      await pumpRunner(services, runnerId);
      const view = await services.runs.get(runId);
      // Same fixture-format gotcha as the isolated_subprocess test: the
      // legacy spec.yaml format always maps to permissions.approvalRequired:
      // true, so the task itself needs a real human approval before it can
      // even start -- unrelated to the correction tool's own approval gate.
      const pendingTaskApproval = view?.approvals.find((a) => a.status === "pending" && a.toolId === null);
      if (pendingTaskApproval) {
        await services.approvals.decide(pendingTaskApproval.id, "approved", "approved for test", "user_primary");
      }
      return view?.run.status === "completed" ? view : null;
    });

    const executeTask = runView!.tasks.find((t) => t.name === "Execute planned work");
    expect(executeTask?.status).toBe("completed");
    expect(executeTask?.resultSummary).toBe("Filed a correction: proposed_pending_approval");

    // Prove it was PROPOSED, not executed -- the real proof this tool
    // never bypasses human approval even when a task decides to call it
    // entirely on its own.
    const events = await services.runs.events(runId);
    expect(events.some((e) => e.eventType === "task.autonomous_tool_call_proposed")).toBe(true);
    expect(events.some((e) => e.eventType === "task.autonomous_tool_call_executed")).toBe(false);
    expect(lastPrRequestBody).toBeNull();

    const proposedEvent = events.find((e) => e.eventType === "task.autonomous_tool_call_proposed");
    const correctionActionId = (proposedEvent!.payload as { actionId: string }).actionId;

    const proposalView = await services.actions.get(correctionActionId);
    if (!proposalView) throw new Error("expected the correction proposal to exist");
    expect(proposalView.proposal.approval.required).toBe(true);
    expect(proposalView.proposal.approval.status).toBe("pending");
    expect(proposalView.proposal.status).toBe("proposed");

    // Now a real human decision, through the normal external
    // action-proposal flow -- separate from the task, which already
    // finished. Only now should the real git/PR mechanism run.
    const approvalId = proposalView.proposal.approval.approvalId;
    if (!approvalId) throw new Error("expected a bound approval on the correction proposal");
    const decided = await services.approvals.decide(approvalId, "approved", "human reviewed and approved the specialist's self-correction", "user_primary");
    expect(decided && "error" in decided ? decided : null).toBeNull();

    const executed = await services.actions.execute(correctionActionId);
    if (!executed || "error" in executed) {
      throw new Error(`expected the correction to execute after approval, got: ${executed && "error" in executed ? executed.error.code : "null"}`);
    }
    expect(executed.outcome).toContain("spec_correction_pr_opened");

    expect(lastPrRequestBody).not.toBeNull();
    expect((lastPrRequestBody as { base?: string })?.base).toBe("main");
    expect((lastPrRequestBody as { body?: string })?.body ?? "").toMatch(/mid-task/);
  });
});
