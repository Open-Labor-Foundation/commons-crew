import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createAppServices } from "../../../packages/core/src/index";
import type { AppConfig, FeatureFlagName } from "../../../packages/config/src/index";
import { loadConfigOrThrow } from "../../../packages/config/src/index";
import { createApiProvider } from "../../../packages/provider-api/src/index";
import {
  API_CONTRACT_VERSION,
  API_CONTRACT_VERSION_HEADER,
  AUTONOMOUS_INTEGRATION_CONTRACT,
  type ChatAnswer,
  type ChatAnswerInput,
  CONTRACT_GOVERNANCE,
  EVENT_CONTRACT_VERSION,
  EVENT_CONTRACT_VERSION_HEADER,
  type IntakeDecision,
  type IntakeDecisionInput,
  type PlanDraft,
  type PlanDraftInput,
  type ProviderStatus,
  type RunResultSynthesisInput,
  type RunResultSynthesisResult,
  type TaskExecutionInput,
  type TaskExecutionResult,
  serializeRunEventSse,
  toRunEventContract
} from "../../../packages/contracts/src/index";
import {
  CORRELATION_HEADER_NAMES,
  createStructuredLog,
  readCorrelationHeaders,
  resolveTraceId
} from "../../../packages/core/src/observability";

function isValidApiToken(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

function notFound(code: string, message: string) {
  return {
    error: {
      code,
      message,
      retryable: false
    }
  };
}

function forbidden(code: string, message: string) {
  return {
    error: {
      code,
      message,
      retryable: false
    }
  };
}

function conflict(code: string, message: string) {
  return {
    error: {
      code,
      message,
      retryable: false
    }
  };
}

function requireFeatureFlag(config: AppConfig, flag: FeatureFlagName) {
  if (config.featureFlags[flag]) {
    return null;
  }

  return forbidden("feature_disabled", `The "${flag}" feature flag is disabled for config profile "${config.profile.name}".`);
}

function policyErrorStatus(code: string) {
  if (code === "unsafe_action_blocked" || code === "action_policy_denied" || code === "approval_denied") {
    return 403;
  }
  if (code === "action_preflight_failed") {
    return 400;
  }
  return 409;
}

type ApiProvider = ReturnType<typeof createApiProvider>;

function createTestChatAnswer(input: ChatAnswerInput): ChatAnswer {
  const lower = input.message.toLowerCase();
  if (lower.includes("what can pa do") || lower.includes("what can you do") || lower.includes("capabilities")) {
    return {
      content:
        "Crew can answer questions directly, draft plans tied to work items, queue execution runs, ask clarifying questions when scope is unclear, manage approvals, and show run progress."
    };
  }

  return {
    content: `Crew can help with that directly, or turn it into a plan or execution run if the work needs orchestration.`
  };
}

function createTestPlanDraft(input: PlanDraftInput): PlanDraft {
  return {
    title: input.request.toLowerCase().includes("release") ? "Release plan" : "PA plan",
    summary: input.request,
    steps: [
      {
        title: "Clarify scope",
        description: `Confirm the scope, constraints, and expected outcome for: ${input.request}`,
        required: true
      },
      {
        title: "Break down work",
        description: `Split ${input.request} into concrete workstreams, dependencies, and sequencing.`,
        required: true
      },
      {
        title: "Define execution checkpoints",
        description: `Identify approvals, validation points, and completion criteria for: ${input.request}`,
        required: true
      }
    ]
  };
}

function createTestTaskExecutionResult(input: TaskExecutionInput): TaskExecutionResult {
  if (input.specialist.name && input.specialist.domain) {
    if (input.materializedSpecialist) {
      return {
        summary: `${input.specialist.name} executed from materialized specialist bundle ${input.materializedSpecialist.materializationId}.`,
        detail: `Loaded the governed bundle from ${input.materializedSpecialist.generatedPath} and applied the declared ${input.materializedSpecialist.runtimeBundle.identity.boundary.domain} boundary.`
      };
    }
    if (input.task.name === "Execute planned work") {
      return {
        summary: `${input.specialist.name} led planning and integration, collected the specialist handoffs, and returned the integrated result to PA.`,
        detail: `Completed the lead ${input.specialist.domain} workstream.`
      };
    }
    if (input.task.name.startsWith("Specialist contribution:")) {
      return {
        summary: `${input.specialist.name} completed the ${input.specialist.domain} workstream and handed back deliverables, dependencies, and follow-up constraints.`,
        detail: `Delivered the specialist handoff for ${input.task.description}.`
      };
    }
    return {
      summary: `${input.specialist.name} advanced the ${input.specialist.domain} workstream for this run.`,
      detail: input.task.description
    };
  }

  if (input.task.taskKind === "cleanup") {
    return {
      summary: "PA packaged the final completion summary.",
      detail: "Collected the task handoffs into a final PA result."
    };
  }

  return {
    summary: `PA completed task: ${input.task.name}.`,
    detail: input.task.description
  };
}

function createTestRunResultSynthesis(input: RunResultSynthesisInput): RunResultSynthesisResult {
  const completedCount = input.completedTasks.length;
  const nonSpecialistTaskSummaries = input.completedTasks
    .filter((task) => task.assignedAgentName === null)
    .map((task) => task.summary)
    .filter((summary) => summary.trim().length > 0);
  const delegationSummaries = input.delegationDecisions
    .map((decision) => decision.completionSummary)
    .filter((summary): summary is string => Boolean(summary?.trim()));
  const taskSummaries = input.completedTasks
    .map((task) => task.summary)
    .filter((summary) => summary.trim().length > 0);
  const combinedSummaries = delegationSummaries.length > 0 ? [...delegationSummaries, ...nonSpecialistTaskSummaries] : taskSummaries;
  const handoffSummary =
    combinedSummaries.join(" ") ||
    "PA completed the run and returned the final result.";

  return {
    summary: `Execution run for request: ${input.run.request} Completed ${completedCount} tasks. Specialist handoffs: ${handoffSummary}`,
    content: `Completed the request: ${input.run.request}\n\nOutcome: ${handoffSummary}`
  };
}

function createTestProvider(config: AppConfig): ApiProvider {
  const status: ProviderStatus = {
    id: "api-provider",
    displayName: "API Provider",
    model: config.provider.model,
    installed: true,
    authenticated: true,
    authMode: "api_key",
    capabilities: {
      providerIdentity: "Test operator",
      supportsStreaming: false,
      supportsStructuredOutputs: true,
      supportsToolCalls: false,
      supportsFileIo: false,
      supportsCancellation: false
    },
    diagnostics: {
      checkedAt: "2026-04-04T00:00:00.000Z",
      apiKeyConfigured: Boolean(config.provider.apiKey),
      readiness: "ready"
    }
  };

  return {
    async getStatus() {
      return structuredClone(status);
    },
    async answerChat(input: ChatAnswerInput): Promise<ChatAnswer> {
      return createTestChatAnswer(input);
    },
    async createPlan(input: PlanDraftInput): Promise<PlanDraft> {
      return createTestPlanDraft(input);
    },
    async executeTask(input: TaskExecutionInput): Promise<TaskExecutionResult> {
      return createTestTaskExecutionResult(input);
    },
    async synthesizeRunResult(input: RunResultSynthesisInput): Promise<RunResultSynthesisResult> {
      return createTestRunResultSynthesis(input);
    },
    async decideIntake(input: IntakeDecisionInput): Promise<IntakeDecision> {
      const lower = input.message.toLowerCase();
      const clarificationIndex = lower.lastIndexOf("clarification:");
      const clarifiedSegment = clarificationIndex >= 0 ? lower.slice(clarificationIndex + "clarification:".length).trim() : "";
      const execution = /(implement|build|fix|run|execute|deploy|validation|api|dashboard|ui)/.test(lower);
      const planning = /(plan|roadmap|scope|workstreams)/.test(lower);
      const needsClarification = !clarifiedSegment && /(something|anything|do this|do that)/.test(lower);

      if (planning) {
        return {
          requestType: "planning",
          needsClarification: false,
          clarificationQuestion: null,
          clarificationReason: null,
          specialistCandidates: [],
          decisionConfidence: "high",
          reasoningSummary: "Test API provider classified the request as planning."
        };
      }

      if (execution) {
        return {
          requestType: "execution",
          needsClarification,
          clarificationQuestion: needsClarification ? "What exact task should PA perform, and what outcome do you want?" : null,
          clarificationReason: needsClarification ? "This execution request is missing concrete target details." : null,
          specialistCandidates: needsClarification
            ? []
            : input.catalog.slice(0, 1).map((entry) => ({
                catalogEntryId: entry.id,
                confidence: "medium",
                reason: "Test API provider selected the first available specialist."
              })),
          decisionConfidence: "medium",
          reasoningSummary: "Test API provider classified the request as execution."
        };
      }

      return {
        requestType: "chat",
        needsClarification: false,
        clarificationQuestion: null,
        clarificationReason: null,
        specialistCandidates: [],
        decisionConfidence: "medium",
        reasoningSummary: "Test API provider classified the request as chat."
      };
    }
  };
}

export async function createApiApp(
  config: AppConfig = loadConfigOrThrow(),
  options: { provider?: ApiProvider } = {}
) {
  const app = Fastify({ logger: true });
  const provider = options.provider ?? (config.profile.name === "test" ? createTestProvider(config) : undefined);
  const services = await createAppServices(config, {
    provider,
    logger: app.log,
    serviceName: "crew-api"
  });

  await app.register(cors, { origin: true });
  app.addHook("onClose", async () => {
    await services.shutdown();
  });

  const apiToken = config.auth.apiToken;
  if (apiToken) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.url === "/health" || request.url.startsWith("/health?")) return;
      const [scheme, token] = (request.headers.authorization ?? "").split(" ");
      if (scheme !== "Bearer" || !isValidApiToken(apiToken, token)) {
        reply.code(401);
        return reply.send({
          error: { code: "unauthorized", message: "A valid bearer token is required.", retryable: false }
        });
      }
    });
  }

  app.addHook("onRequest", async (request) => {
    const traceId = resolveTraceId(request.headers, request.id);
    request.log.info(
      createStructuredLog(
        "crew-api",
        "http.request.received",
        {
          ...readCorrelationHeaders(request.headers),
          requestId: request.id,
          traceId
        },
        {
          method: request.method,
          url: request.url
        }
      ),
      "http.request.received"
    );
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header(API_CONTRACT_VERSION_HEADER, API_CONTRACT_VERSION);
    reply.header(CORRELATION_HEADER_NAMES.traceId, resolveTraceId(request.headers, request.id));
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const traceId = resolveTraceId(request.headers, request.id);
    request.log.info(
      createStructuredLog(
        "crew-api",
        "http.request.completed",
        {
          ...readCorrelationHeaders(request.headers),
          requestId: request.id,
          traceId
        },
        {
          method: request.method,
          route: request.routeOptions.url,
          statusCode: reply.statusCode
        }
      ),
      "http.request.completed"
    );
  });

  app.get("/health", async () => ({
    ok: true,
    service: "crew-api",
    profile: config.profile.name,
    storageMode: config.storage.mode,
    catalogRoot: config.paths.olfAgentsRoot,
    stateFile: config.paths.stateFile,
    storageSchema: config.database.schema
  }));

  app.get("/api/config/runtime", async () => {
    const diagnostics = await services.diagnostics.getDiagnostics();
    return {
      profile: config.profile,
      providerProfile: diagnostics.activeProviderProfile,
      configProfile: diagnostics.activeConfigProfile,
      featureFlagRecords: diagnostics.featureFlagRecords,
      promptSpecs: diagnostics.promptSpecs,
      migrationRecords: diagnostics.migrationRecords,
      contract: CONTRACT_GOVERNANCE,
      autonomousIntegration: AUTONOMOUS_INTEGRATION_CONTRACT,
      app: {
        name: config.app.name,
        env: config.app.env
      },
      storage: {
        ...config.storage,
        schema: config.database.schema
      },
      featureFlags: config.featureFlags,
      environment: {
        allowedOverrides: config.environment.allowedOverrides,
        appliedOverrides: config.environment.appliedOverrides,
        unknownOverrides: config.environment.unknownOverrides
      },
      paths: {
        olfAgentsRoot: config.paths.olfAgentsRoot,
        artifactsRoot: config.paths.artifactsRoot,
        stateFile: config.paths.stateFile,
        backupsRoot: config.paths.backupsRoot
      }
    };
  });

  app.post("/api/config/validate", async () => {
    const checks = services.configValidator.validate();
    return {
      ok: checks.every((entry) => entry.ok),
      checks
    };
  });

  app.get("/api/providers", async () => {
    const diagnostics = await services.diagnostics.getDiagnostics();
    return {
      defaultProviderId: diagnostics.activeProviderProfile?.id ?? "api-provider",
      providers: [await services.provider.getStatus()]
    };
  });

  app.get("/api/workspace", async () => await services.collaboration.getWorkspace());

  app.get("/api/workspaces/:workspaceId", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const workspace = await services.collaboration.getWorkspace();
    if (workspace.workspace.id !== params.workspaceId) {
      reply.code(404);
      return notFound("workspace_not_found", "Workspace was not found.");
    }
    return workspace;
  });

  app.post("/api/users", async (request, reply) => {
    const body = (request.body ?? {}) as {
      emailOrLogin?: string;
      displayName?: string;
      role?: "primary" | "supporting";
      status?: "active" | "inactive";
    };

    if (!body.emailOrLogin?.trim() || !body.displayName?.trim()) {
      reply.code(400);
      return notFound("user_identity_required", "emailOrLogin and displayName are required.");
    }

    try {
      return {
        user: await services.collaboration.createUser({
          emailOrLogin: body.emailOrLogin,
          displayName: body.displayName,
          role: body.role,
          status: body.status
        })
      };
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      if (error.message === "user_identity_conflict") {
        reply.code(409);
        return forbidden("user_identity_conflict", "A user with that emailOrLogin already exists.");
      }
      if (error.message === "primary_user_already_exists") {
        reply.code(409);
        return forbidden("primary_user_already_exists", "The workspace already has an active primary user.");
      }
      if (error.message === "user_identity_required") {
        reply.code(400);
        return notFound("user_identity_required", "emailOrLogin and displayName are required.");
      }
      throw error;
    }
  });

  app.post("/api/workspaces/:workspaceId/memberships", async (request, reply) => {
    const params = request.params as { workspaceId: string };
    const body = (request.body ?? {}) as {
      userId?: string;
      actorUserId?: string;
      role?: "primary" | "supporting";
      permissions?: ("work_item_collaboration" | "approval_decision")[];
    };

    if (!body.userId || !body.actorUserId) {
      reply.code(400);
      return notFound("workspace_membership_invalid", "userId and actorUserId are required.");
    }

    try {
      return await services.collaboration.addWorkspaceMembership({
        workspaceId: params.workspaceId,
        userId: body.userId,
        actorUserId: body.actorUserId,
        role: body.role,
        permissions: body.permissions
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      if (error.message === "workspace_not_found") {
        reply.code(404);
        return notFound("workspace_not_found", "Workspace was not found.");
      }
      if (error.message === "user_not_found") {
        reply.code(404);
        return notFound("user_not_found", "User was not found.");
      }
      if (error.message === "primary_user_required") {
        reply.code(403);
        return forbidden("primary_user_required", "Only the primary user may manage workspace memberships.");
      }
      if (error.message === "workspace_membership_exists" || error.message === "primary_membership_locked") {
        reply.code(409);
        return forbidden(error.message, "Workspace membership could not be created.");
      }
      throw error;
    }
  });

  app.patch("/api/workspaces/:workspaceId/memberships/:userId/permissions", async (request, reply) => {
    const params = request.params as { workspaceId: string; userId: string };
    const body = (request.body ?? {}) as {
      actorUserId?: string;
      permissions?: ("work_item_collaboration" | "approval_decision")[];
    };

    if (!body.actorUserId || !Array.isArray(body.permissions)) {
      reply.code(400);
      return notFound("workspace_membership_invalid", "actorUserId and permissions are required.");
    }

    try {
      return await services.collaboration.updateWorkspaceMembershipPermissions({
        workspaceId: params.workspaceId,
        userId: params.userId,
        actorUserId: body.actorUserId,
        permissions: body.permissions
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      if (error.message === "workspace_not_found") {
        reply.code(404);
        return notFound("workspace_not_found", "Workspace was not found.");
      }
      if (error.message === "workspace_membership_not_found") {
        reply.code(404);
        return notFound("workspace_membership_not_found", "Workspace membership was not found.");
      }
      if (error.message === "primary_user_required") {
        reply.code(403);
        return forbidden("primary_user_required", "Only the primary user may manage support user permissions.");
      }
      if (error.message === "supporting_membership_required") {
        reply.code(409);
        return forbidden("supporting_membership_required", "Only supporting memberships may have configurable permissions.");
      }
      throw error;
    }
  });

  app.get("/api/providers/:providerId/capabilities", async (request, reply) => {
    const params = request.params as { providerId: string };
    const status = await services.provider.getStatus();
    const diagnostics = await services.diagnostics.getDiagnostics();
    const activeProfile = diagnostics.activeProviderProfile;
    if (params.providerId !== status.id && params.providerId !== activeProfile?.id) {
      reply.code(404);
      return notFound("provider_unavailable", "Provider was not found.");
    }
    return {
      id: `provider-snapshot:live:${status.id}`,
      providerProfileId: activeProfile?.id ?? null,
      runId: null,
      providerId: status.id,
      providerDisplayName: status.displayName,
      model: status.model,
      installed: status.installed,
      authenticated: status.authenticated,
      authMode: status.authMode,
      capabilities: status.capabilities,
      diagnostics: status.diagnostics,
      environment: {
        appEnv: config.app.env,
        storageMode: config.storage.mode,
        apiPort: config.ports.api,
        runnerPort: config.ports.runner,
        olfAgentsRoot: config.paths.olfAgentsRoot
      },
      capturedAt: status.diagnostics.checkedAt
    };
  });

  app.post("/api/providers/test", async () => await services.provider.getStatus());

  app.post("/api/catalog/sync", async (_request, reply) => {
    const error = requireFeatureFlag(config, "catalogSync");
    if (error) {
      reply.code(403);
      return error;
    }
    return await services.catalog.sync();
  });

  app.get("/api/catalog/agents", async () => ({
    entries: await services.catalog.listEntries()
  }));

  app.get("/api/catalog/agents/:agentId", async (request, reply) => {
    const params = request.params as { agentId: string };
    const entry = await services.catalog.getEntry(params.agentId);
    if (!entry) {
      reply.code(404);
      return notFound("catalog_entry_not_found", "Catalog entry was not found.");
    }
    return entry;
  });

  app.get("/api/catalog/syncs/:syncId", async (request, reply) => {
    const params = request.params as { syncId: string };
    const sync = await services.catalog.getSync(params.syncId);
    if (!sync) {
      reply.code(404);
      return notFound("catalog_entry_not_found", "Catalog sync was not found.");
    }
    return sync;
  });

  app.post("/api/materializations", async (request, reply) => {
    const body = (request.body ?? {}) as { agentCatalogEntryId?: string; runId?: string | null };
    if (!body.agentCatalogEntryId) {
      reply.code(400);
      return notFound("materialization_failed", "agentCatalogEntryId is required.");
    }
    const materialization = await services.materials.create(body.agentCatalogEntryId, body.runId ?? null);
    if (!materialization) {
      reply.code(404);
      return notFound("catalog_entry_not_found", "Catalog entry was not found for materialization.");
    }
    return materialization;
  });

  app.get("/api/materializations/:materializationId", async (request, reply) => {
    const params = request.params as { materializationId: string };
    const materialization = await services.materials.get(params.materializationId);
    if (!materialization) {
      reply.code(404);
      return notFound("materialization_failed", "Materialization was not found.");
    }
    return materialization;
  });

  app.post("/api/sessions", async (request) => {
    const body = (request.body ?? {}) as { surface?: "cli" | "web"; title?: string };
    return await services.pa.createSession(body.surface ?? "cli", body.title ?? "PA session");
  });

  app.get("/api/sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const session = await services.pa.getSession(params.sessionId);
    if (!session) {
      reply.code(404);
      return notFound("permission_denied", "Session was not found.");
    }
    return session;
  });

  app.get("/api/sessions/:sessionId/clarifications", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const query = (request.query ?? {}) as { state?: "open" | "resolved" | "abandoned" };
    const session = await services.pa.getSession(params.sessionId);
    if (!session) {
      reply.code(404);
      return notFound("permission_denied", "Session was not found.");
    }
    const clarifications = (await services.clarifications.list(params.sessionId)) ?? [];
    const filteredClarifications = query.state ? clarifications.filter((entry) => entry.thread.state === query.state) : clarifications;
    return {
      session: session.session,
      sessionStatus: session.session.status,
      clarificationThread: session.clarificationThread,
      pendingClarifications: session.pendingClarifications,
      clarifications: filteredClarifications
    };
  });

  app.post("/api/sessions/:sessionId/messages", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const body = (request.body ?? {}) as { content?: string };
    if (!body.content?.trim()) {
      reply.code(400);
      return notFound("clarification_required", "Message content is required.");
    }

    const session = await services.pa.postMessage(params.sessionId, body.content, {
      traceId: resolveTraceId(request.headers, request.id)
    });
    if (!session) {
      reply.code(404);
      return notFound("permission_denied", "Session was not found.");
    }
    return session;
  });

  app.post("/api/sessions/:sessionId/clarifications", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const body = (request.body ?? {}) as { title?: string; message?: string; planId?: string | null; runId?: string | null; authorType?: "user" | "pa" };
    if (!body.message?.trim()) {
      reply.code(400);
      return notFound("clarification_required", "Clarification message content is required.");
    }

    const clarification = await services.clarifications.create({
      sessionId: params.sessionId,
      title: body.title?.trim() || "Clarification required",
      message: body.message,
      planId: body.planId ?? null,
      runId: body.runId ?? null,
      authorType: body.authorType ?? "pa"
    });
    if (!clarification) {
      reply.code(404);
      return notFound("permission_denied", "Clarification target was not found.");
    }
    return clarification;
  });

  app.post("/api/sessions/:sessionId/clarify", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const body = (request.body ?? {}) as { content?: string };
    if (!body.content?.trim()) {
      reply.code(400);
      return notFound("clarification_required", "Message content is required.");
    }
    const session = await services.pa.postMessage(params.sessionId, body.content, {
      traceId: resolveTraceId(request.headers, request.id)
    });
    if (!session) {
      reply.code(404);
      return notFound("permission_denied", "Session was not found.");
    }
    return session;
  });

  app.post("/api/sessions/:sessionId/clarifications/:threadId/resolve", async (request, reply) => {
    const params = request.params as { sessionId: string; threadId: string };
    const body = (request.body ?? {}) as { content?: string; authorType?: "user" | "pa" };
    const session = await services.pa.getSession(params.sessionId);
    if (!session) {
      reply.code(404);
      return notFound("permission_denied", "Session was not found.");
    }
    const clarification = await services.clarifications.resolve(params.threadId, {
      content: body.content,
      authorType: body.authorType ?? "user"
    });
    if (!clarification || clarification.thread.sessionId !== params.sessionId) {
      reply.code(404);
      return notFound("clarification_required", "Clarification thread was not found for this session.");
    }
    return clarification;
  });

  app.post("/api/work-items", async (request) => {
    const body = (request.body ?? {}) as { title?: string; summary?: string };
    return await services.pa.createWorkItem(body.title ?? "Untitled work item", body.summary ?? "");
  });

  app.get("/api/work-items/:workItemId", async (request, reply) => {
    const params = request.params as { workItemId: string };
    const workItem = await services.pa.getWorkItem(params.workItemId);
    if (!workItem) {
      reply.code(404);
      return notFound("permission_denied", "Work item was not found.");
    }
    return workItem;
  });

  app.get("/api/work-items/:workItemId/collaboration", async (request, reply) => {
    const params = request.params as { workItemId: string };
    const threads = await services.collaboration.listWorkItemThreads(params.workItemId);
    if (!threads) {
      reply.code(404);
      return notFound("permission_denied", "Work item was not found.");
    }
    return {
      workItemId: params.workItemId,
      threads
    };
  });

  app.post("/api/work-items/:workItemId/collaboration/threads", async (request, reply) => {
    const params = request.params as { workItemId: string };
    const body = (request.body ?? {}) as { actorUserId?: string; title?: string; message?: string };
    if (!body.actorUserId?.trim() || !body.message?.trim()) {
      reply.code(400);
      return notFound("work_item_collaboration_invalid", "actorUserId and message are required.");
    }

    try {
      const thread = await services.collaboration.createWorkItemThread({
        workItemId: params.workItemId,
        actorUserId: body.actorUserId,
        title: body.title?.trim() || "Collaboration",
        message: body.message
      });
      if (!thread) {
        reply.code(404);
        return notFound("permission_denied", "Work item was not found.");
      }
      return thread;
    } catch (error) {
      if (error instanceof Error && (error.message === "workspace_membership_required" || error.message === "workspace_permission_required")) {
        reply.code(403);
        return forbidden(error.message, "Only authorized workspace members may contribute collaboration notes.");
      }
      throw error;
    }
  });

  app.post("/api/work-items/:workItemId/collaboration/threads/:threadId/messages", async (request, reply) => {
    const params = request.params as { workItemId: string; threadId: string };
    const body = (request.body ?? {}) as { actorUserId?: string; content?: string };
    if (!body.actorUserId?.trim() || !body.content?.trim()) {
      reply.code(400);
      return notFound("work_item_collaboration_invalid", "actorUserId and content are required.");
    }

    try {
      const thread = await services.collaboration.postWorkItemThreadMessage({
        workItemId: params.workItemId,
        threadId: params.threadId,
        actorUserId: body.actorUserId,
        content: body.content
      });
      if (!thread) {
        reply.code(404);
        return notFound("permission_denied", "Work item collaboration thread was not found.");
      }
      return thread;
    } catch (error) {
      if (error instanceof Error && (error.message === "workspace_membership_required" || error.message === "workspace_permission_required")) {
        reply.code(403);
        return forbidden(error.message, "Only authorized workspace members may contribute collaboration notes.");
      }
      throw error;
    }
  });

  app.post("/api/sessions/:sessionId/plans", async (request, reply) => {
    const params = request.params as { sessionId: string };
    const body = (request.body ?? {}) as { summary?: string };
    const plan = await services.pa.createPlanFromSession(params.sessionId, body.summary ?? "");
    if (!plan) {
      reply.code(404);
      return notFound("permission_denied", "Session was not found.");
    }
    return plan;
  });

  app.get("/api/plans/:planId", async (request, reply) => {
    const params = request.params as { planId: string };
    const plan = await services.pa.getPlan(params.planId);
    if (!plan) {
      reply.code(404);
      return notFound("permission_denied", "Plan was not found.");
    }
    return plan;
  });

  app.post("/api/plans/:planId/lock", async (request, reply) => {
    const params = request.params as { planId: string };
    const plan = await services.pa.lockPlan(params.planId);
    if (!plan) {
      reply.code(404);
      return notFound("permission_denied", "Plan was not found.");
    }
    return plan;
  });

  app.post("/api/runs/:runId/plan-changes", async (request, reply) => {
    const params = request.params as { runId: string };
    const body = (request.body ?? {}) as { reason?: string };
    const change = await services.pa.createPlanChange(params.runId, body.reason ?? "Execution requested a plan change.");
    if (!change) {
      reply.code(404);
      return notFound("plan_change_required", "Run does not have a locked plan.");
    }
    return change;
  });

  app.get("/api/runs/:runId", async (request, reply) => {
    const params = request.params as { runId: string };
    const run = await services.runs.get(params.runId);
    if (!run) {
      reply.code(404);
      return notFound("run_not_resumable", "Run was not found.");
    }
    return run;
  });

  app.get("/api/runs/:runId/tasks", async (request) => {
    const params = request.params as { runId: string };
    return {
      tasks: await services.runs.tasks(params.runId)
    };
  });

  app.get("/api/runs/:runId/events", async (request, reply) => {
    const params = request.params as { runId: string };
    reply.header(EVENT_CONTRACT_VERSION_HEADER, EVENT_CONTRACT_VERSION);
    const events = (await services.runs.events(params.runId)).map(toRunEventContract);
    return {
      contract: {
        version: EVENT_CONTRACT_VERSION
      },
      events
    };
  });

  app.get("/api/incidents", async (request) => {
    const query = (request.query ?? {}) as { runId?: string; serviceRef?: string; status?: "open" | "investigating" | "monitoring" | "resolved" };
    return {
      incidents: await services.incidents.list({
        runId: query.runId,
        serviceRef: query.serviceRef,
        status: query.status
      })
    };
  });

  app.post("/api/incidents", async (request, reply) => {
    const body = (request.body ?? {}) as {
      runId?: string | null;
      serviceRef?: string | null;
      severity?: "low" | "medium" | "high" | "critical";
      summary?: string;
    };
    if (!body.summary?.trim()) {
      reply.code(400);
      return notFound("incident_invalid", "Incident summary is required.");
    }
    if (!body.runId && !body.serviceRef) {
      reply.code(400);
      return notFound("incident_invalid", "Incident must reference a runId or serviceRef.");
    }
    const incident = await services.incidents.create({
      runId: body.runId ?? null,
      serviceRef: body.serviceRef ?? null,
      severity: body.severity ?? "medium",
      summary: body.summary
    });
    if (!incident) {
      reply.code(404);
      return notFound("incident_not_found", "Referenced run was not found for incident creation.");
    }
    return incident;
  });

  app.get("/api/incidents/:incidentId", async (request, reply) => {
    const params = request.params as { incidentId: string };
    const incident = await services.incidents.get(params.incidentId);
    if (!incident) {
      reply.code(404);
      return notFound("incident_not_found", "Incident was not found.");
    }
    return incident;
  });

  app.post("/api/incidents/:incidentId/lifecycle", async (request, reply) => {
    const params = request.params as { incidentId: string };
    const body = (request.body ?? {}) as { status?: "open" | "investigating" | "monitoring" | "resolved"; summary?: string };
    if (!body.status || !body.summary?.trim()) {
      reply.code(400);
      return notFound("incident_invalid", "Incident lifecycle status and summary are required.");
    }
    const incident = await services.incidents.transition(params.incidentId, body.status, body.summary);
    if (!incident) {
      reply.code(404);
      return notFound("incident_not_found", "Incident was not found.");
    }
    return incident;
  });

  app.get("/api/runs/:runId/stream", async (request, reply) => {
    const params = request.params as { runId: string };
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader(EVENT_CONTRACT_VERSION_HEADER, EVENT_CONTRACT_VERSION);
    reply.raw.flushHeaders?.();

    const existing = await services.runs.events(params.runId);
    for (const event of existing) {
      reply.raw.write(serializeRunEventSse(toRunEventContract(event)));
    }

    const unsubscribe = services.runs.subscribe(params.runId, (event) => {
      reply.raw.write(serializeRunEventSse(toRunEventContract(event)));
    });

    request.raw.on("close", () => {
      unsubscribe();
      reply.raw.end();
    });

    return reply;
  });

  app.post("/api/runs/:runId/control", async (request, reply) => {
    const params = request.params as { runId: string };
    const body = (request.body ?? {}) as { action?: "pause" | "resume" | "cancel"; reason?: string };
    if (!body.action) {
      reply.code(400);
      return notFound("run_not_resumable", "Run control action is required.");
    }
    const run = await services.runs.control(params.runId, body.action, body.reason);
    if (!run) {
      reply.code(404);
      return notFound("run_not_resumable", "Run was not found.");
    }
    if ("error" in run) {
      reply.code(409);
      return conflict(run.error.code, run.error.message);
    }
    return run;
  });

  app.get("/api/runner/jobs", async () => ({
    jobs: await services.runner.list()
  }));

  app.post("/api/runner/jobs/claim", async (request, reply) => {
    const body = (request.body ?? {}) as { runnerId?: string };
    if (!body.runnerId?.trim()) {
      reply.code(400);
      return notFound("runner_job_conflict", "runnerId is required.");
    }
    return {
      job: await services.runner.claimNext(body.runnerId)
    };
  });

  app.get("/api/runner/jobs/:jobId", async (request, reply) => {
    const params = request.params as { jobId: string };
    const job = await services.runner.get(params.jobId);
    if (!job) {
      reply.code(404);
      return notFound("runner_job_conflict", "Runner job was not found.");
    }
    return job;
  });

  app.post("/api/runner/jobs/:jobId/start", async (request, reply) => {
    const params = request.params as { jobId: string };
    const body = (request.body ?? {}) as { runnerId?: string };
    if (!body.runnerId?.trim()) {
      reply.code(400);
      return notFound("runner_job_conflict", "runnerId is required.");
    }
    const result = await services.runner.start(params.jobId, body.runnerId);
    if (!result) {
      reply.code(404);
      return notFound("runner_job_conflict", "Runner job was not found.");
    }
    if ("error" in result) {
      reply.code(409);
      return result;
    }
    return result;
  });

  app.post("/api/runner/jobs/:jobId/fail", async (request, reply) => {
    const params = request.params as { jobId: string };
    const body = (request.body ?? {}) as {
      runnerId?: string;
      code?: "approval_denied" | "dispatch_failed" | "execution_error" | "provider_unavailable" | "runner_unreachable" | "cancelled" | "unknown";
      message?: string;
      retryable?: boolean;
      detail?: Record<string, unknown>;
    };
    if (!body.runnerId?.trim() || !body.code || !body.message?.trim()) {
      reply.code(400);
      return notFound("runner_job_conflict", "runnerId, code, and message are required.");
    }
    const result = await services.runner.fail(params.jobId, body.runnerId, {
      code: body.code,
      message: body.message,
      retryable: body.retryable ?? false,
      detail: body.detail
    });
    if (!result) {
      reply.code(404);
      return notFound("runner_job_conflict", "Runner job was not found.");
    }
    if ("error" in result) {
      reply.code(409);
      return result;
    }
    return result;
  });

  app.get("/api/approvals", async () => ({
    approvals: await services.approvals.list()
  }));

  app.post("/api/approvals/:approvalId/decision", async (request, reply) => {
    const params = request.params as { approvalId: string };
    const body = (request.body ?? {}) as { decision?: "approved" | "denied"; comment?: string; actorUserId?: string };
    if (!body.decision) {
      reply.code(400);
      return notFound("approval_required", "Approval decision is required.");
    }
    if (!body.actorUserId?.trim()) {
      reply.code(400);
      return notFound("approval_actor_required", "actorUserId is required.");
    }
    try {
      const approval = await services.approvals.decide(params.approvalId, body.decision, body.comment, body.actorUserId);
      if (!approval) {
        reply.code(404);
        return notFound("approval_required", "Approval was not found.");
      }
      return approval;
    } catch (error) {
      if (error instanceof Error && (error.message === "workspace_membership_required" || error.message === "workspace_permission_required")) {
        reply.code(403);
        return forbidden(error.message, "Only authorized workspace members may decide approvals.");
      }
      throw error;
    }
  });

  app.post("/api/clarifications/:threadId/resolve", async (request, reply) => {
    const params = request.params as { threadId: string };
    const body = (request.body ?? {}) as { content?: string; authorType?: "user" | "pa" };
    const clarification = await services.clarifications.resolve(params.threadId, {
      content: body.content,
      authorType: body.authorType ?? "user"
    });
    if (!clarification) {
      reply.code(404);
      return notFound("clarification_required", "Clarification thread was not found.");
    }
    return clarification;
  });

  app.post("/api/actions/proposals", async (request, reply) => {
    const body = (request.body ?? {}) as {
      workItemId: string;
      runId?: string | null;
      taskId?: string | null;
      toolId: string;
      actionClass: "class_a" | "class_b" | "class_c";
      targetRef: string;
      actionSummary?: string;
      idempotencyKey: string;
    };
    const proposal = await services.actions.createProposal({
      workItemId: body.workItemId,
      runId: body.runId ?? null,
      taskId: body.taskId ?? null,
      toolId: body.toolId,
      actionClass: body.actionClass,
      targetRef: body.targetRef,
      actionSummary: body.actionSummary,
      idempotencyKey: body.idempotencyKey
    });
    if ("error" in proposal) {
      reply.code(policyErrorStatus(proposal.error.code));
      return proposal;
    }
    return proposal;
  });

  app.post("/api/actions/:actionId/execute", async (request, reply) => {
    const params = request.params as { actionId: string };
    const result = await services.actions.execute(params.actionId);
    if (!result) {
      reply.code(404);
      return notFound("action_preflight_failed", "Action was not found.");
    }
    if ("error" in result) {
      reply.code(policyErrorStatus(result.error.code));
      return result;
    }
    return result;
  });

  app.get("/api/actions/:actionId", async (request, reply) => {
    const params = request.params as { actionId: string };
    const action = await services.actions.get(params.actionId);
    if (!action) {
      reply.code(404);
      return notFound("action_preflight_failed", "Action was not found.");
    }
    return action;
  });

  app.post("/api/evaluations/runs", async (request, reply) => {
    const error = requireFeatureFlag(config, "evaluations");
    if (error) {
      reply.code(403);
      return error;
    }
    const body = (request.body ?? {}) as { profile?: string };
    return await services.evaluations.create(body.profile ?? "full");
  });

  app.get("/api/evaluations/:evaluationRunId", async (request, reply) => {
    const params = request.params as { evaluationRunId: string };
    const evaluation = await services.evaluations.get(params.evaluationRunId);
    if (!evaluation) {
      reply.code(404);
      return notFound("permission_denied", "Evaluation run was not found.");
    }
    return evaluation;
  });

  app.post("/api/admin/runs/:runId/rerun", async (request, reply) => {
    const error = requireFeatureFlag(config, "adminOperations");
    if (error) {
      reply.code(403);
      return error;
    }
    const params = request.params as { runId: string };
    const run = await services.runs.get(params.runId);
    if (!run) {
      reply.code(404);
      return notFound("run_not_resumable", "Run was not found.");
    }
    const rerun = await services.runs.rerun(params.runId);
    if (!rerun) {
      reply.code(404);
      return notFound("run_not_resumable", "Run was not found.");
    }
    if ("error" in rerun) {
      reply.code(policyErrorStatus(rerun.error.code));
      return rerun;
    }
    return rerun;
  });

  app.post("/api/admin/runs/:runId/replay-events", async (request, reply) => {
    const error = requireFeatureFlag(config, "adminOperations");
    if (error) {
      reply.code(403);
      return error;
    }
    const params = request.params as { runId: string };
    const replay = await services.runs.replayEvents(params.runId);
    if (!replay) {
      reply.code(404);
      return notFound("run_not_resumable", "Run was not found.");
    }
    if ("error" in replay) {
      reply.code(409);
      return conflict(replay.error?.code ?? "run_replay_conflict", replay.error?.message ?? "Run event replay is not allowed in the current state.");
    }
    return replay;
  });

  app.get("/api/admin/runs/:runId/diagnostics", async (request, reply) => {
    const error = requireFeatureFlag(config, "adminOperations");
    if (error) {
      reply.code(403);
      return error;
    }
    const params = request.params as { runId: string };
    const diagnostics = await services.diagnostics.getRunDiagnostics(params.runId);
    if (!diagnostics) {
      reply.code(404);
      return notFound("run_not_resumable", "Run was not found.");
    }
    return diagnostics;
  });

  app.post("/api/admin/backups/verify", async (_request, reply) => {
    const error = requireFeatureFlag(config, "adminOperations");
    if (error) {
      reply.code(403);
      return error;
    }
    return await services.diagnostics.verifyBackup();
  });

  app.get("/api/admin/health/diagnostics", async (_request, reply) => {
    const error = requireFeatureFlag(config, "adminOperations");
    if (error) {
      reply.code(403);
      return error;
    }
    return await services.diagnostics.getDiagnostics();
  });

  app.get("/api/admin/metrics", async (_request, reply) => {
    const error = requireFeatureFlag(config, "adminOperations");
    if (error) {
      reply.code(403);
      return error;
    }
    return await services.diagnostics.getMetrics();
  });

  app.addHook("onClose", async () => {
    await services.shutdown();
  });

  return app;
}
