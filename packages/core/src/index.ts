import { createHash, randomUUID, fs, path, execFileAsync } from "./host";
import {
  canTransitionRunnerJobStatus,
  type ActionCheckRecord,
  type ActionEvidenceReference,
  type RunnerJobFailure,
  type RunnerJobFailureCode,
  type RunnerJobRecord,
  type RunnerJobStatus,
  ActionExecutionRecord,
  ActionProposalRecord,
  AgentRuntimeMode,
  AgentRuntimeRecord,
  ArtifactRecord,
  type ActionRollbackRecord,
  ApprovalRecord,
  BudgetProfile,
  CatalogEntry,
  CatalogSyncRecord,
  ChatAnswer,
  ChatAnswerInput,
  ClarificationRecord,
  ClarificationMessageRecord,
  ClarificationThreadRecord,
  ClarificationThreadView,
  ClarificationState,
  ConfigProfileRecord,
  DelegationDecisionRecord,
  DiagnosticsSnapshot,
  EvaluationRunRecord,
  FeatureFlagRecord,
  IncidentEvidenceRecord,
  IncidentRecord,
  IncidentSeverity,
  IncidentStatus,
  IntakeCatalogEntry,
  IntakeDecision,
  IntakeDecisionInput,
  IntakeSpecialistCandidate,
  MATERIALIZED_SPECIALIST_EXECUTION_CONTRACT_VERSION,
  MATERIALIZED_SPECIALIST_FAILURE_EVIDENCE_VERSION,
  MATERIALIZED_SPECIALIST_IO_CONTRACT_VERSION,
  MATERIALIZED_SPECIALIST_PACKAGE_VERSION,
  MATERIALIZED_SPECIALIST_RUNTIME_BUNDLE_VERSION,
  MATERIALIZED_SPECIALIST_STARTUP_VERIFICATION_VERSION,
  MaterializedSpecialistExecutionContract,
  MaterializationRecord,
  MaterializedSpecialistRuntimeBundle,
  MessageRecord,
  PersistentState,
  PlanDraft,
  PlanDraftInput,
  PlanChangeRequestRecord,
  PlanRecord,
  PlanStepRecord,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderStatus,
  ProviderCapabilitySnapshot,
  ProviderEnvironmentSnapshot,
  ProviderProfileRecord,
  PromptSpecRecord,
  SpecialistManifestContract,
  RequestRecord,
  RunEventRecord,
  RunDiagnosticsView,
  RunRerunView,
  RunRecord,
  RunResultSynthesisInput,
  RunResultSynthesisResult,
  RunView,
  SessionRecord,
  SessionView,
  Surface,
  TaskPlanLinkRecord,
  TaskRecord,
  TaskExecutionInput,
  TaskExecutionResult,
  ToolStepInput,
  ToolStepResult,
  ProviderToolCall,
  ProviderToolDefinition,
  ProviderToolLoopMessage,
  UserRecord,
  WorkItemCollaborationMessageRecord,
  WorkItemCollaborationThreadRecord,
  WorkItemCollaborationThreadView,
  WorkItemRecord,
  WorkItemView,
  WorkspaceIdentityView,
  WorkspaceMembershipRecord,
  MigrationRecord
} from "../../contracts/src/index";
import type { AppConfig } from "../../config/src/index";
import { validateConfig } from "../../config/src/index";
import { LocalCatalogService, ManifestValidationError, parseSpecialistManifest } from "../../catalog/src/index";
import { createApiProvider } from "../../provider-api/src/index";
import { JsonStateStore } from "./json-store";
import { verifyPostgresBackup, writeBackupVerificationEvidence } from "./postgres-backup";
import { PostgresStateStore } from "./postgres-store";
import {
  AUTONOMOUS_BUDGET_POLICY,
  buildAutonomousReleaseGate,
  buildDiagnosticsSnapshot,
  buildRuntimeMetricsSnapshot,
  CORRELATION_HEADER_NAMES,
  logInfo,
  type LogCorrelationFields,
  type StructuredLogger
} from "./observability";
import {
  buildMaterializedSpecialistPromptValues,
  buildExecutionTasksFromArtifacts,
  buildRuntimeExecutionExpectationsFromArtifacts,
  loadPromptArtifacts,
  renderPromptTemplate,
  renderMaterializedSpecialistInstructionsPreface,
  renderMaterializedSpecialistSystemPromptFromArtifact,
  summarizeMode,
  syncPromptSpecRecords,
  syncPromptGovernanceState
} from "./prompt-governance";
import type { StateStore } from "./persistence";
import {
  createDefaultActionToolExecutor,
  type ActionToolExecutionResult,
  type ActionToolExecutor,
  type ActionToolPolicy
} from "./action-executor";
import {
  executeTaskInSubprocess,
  executeTaskInWorkerContainer,
  resolveSpecialistExecutionMode
} from "./specialist-worker-runtime";

type EventListener = (event: RunEventRecord) => void;
type ProviderRunError = {
  code: string;
  message: string;
  remediation: string;
  detail?: Record<string, unknown>;
};
type AppProvider = ProviderAdapter;
type AppServicesOptions = {
  provider?: AppProvider;
  logger?: StructuredLogger;
  serviceName?: string;
  actionExecutor?: ActionToolExecutor;
};

const DEFAULT_SUPPORT_USER_PERMISSIONS: WorkspaceMembershipRecord["permissions"] = ["work_item_collaboration"];
const PA_RUNTIME_CAPABILITIES = [
  "answer direct questions in PA chat",
  "draft plans tied to work items",
  "queue orchestrated execution runs",
  "ask clarifying questions before execution when scope is unclear",
  "pause for approvals on real-world-impact work",
  "show run progress, events, and artifacts"
] as const;
type SpecialistDelegationContext = {
  entry: CatalogEntry;
  delegationRole: NonNullable<DelegationDecisionRecord["delegationRole"]>;
  delegatedScope: string;
  handoffSummary: string;
  completionSummary: string;
};
type EvaluationDecisionPoint = EvaluationRunRecord["decisionPoints"][number]["decisionPoint"];
type EvaluationScenarioResult = EvaluationRunRecord["scenarios"][number];
type EvaluationDecisionPointScore = EvaluationRunRecord["decisionPoints"][number];
type EvaluationHarnessContext = {
  services: Awaited<ReturnType<typeof createAppServices>>;
  cleanup: () => Promise<void>;
};


const listeners = new Map<string, Set<EventListener>>();
const REPLAY_SAFE_RUN_STATUSES: RunRecord["status"][] = ["completed", "failed", "cancelled", "paused"];
const CONTROL_REASON_EVENT_TYPES = new Set([
  "run.paused",
  "run.resumed",
  "run.cancelled",
  "run.recovered",
  "runner.job.requeued",
  "run.replay_requested"
]);
const runTimers = new Map<string, NodeJS.Timeout>();

// Two-stage intake routing bounds. Below MIN_CATALOG the whole catalog is cheap
// to send, so stage 1 (domain narrowing) is skipped. Otherwise the stage-2 prompt
// is capped at MAX_NARROWED specialists; NO_DOMAIN_SAMPLE is the tiny sample sent
// when the router picks no domain (conversational requests).
const INTAKE_STAGE1_MIN_CATALOG = 40;
const INTAKE_MAX_NARROWED = 80;
const INTAKE_NO_DOMAIN_SAMPLE = 24;
const activeRunJobs = new Set<Promise<void>>();
const terminalRunStatuses = new Set<RunRecord["status"]>(["completed", "failed", "cancelled"]);

function getDefaultBudgetProfile(): BudgetProfile {
  return {
    id: AUTONOMOUS_BUDGET_POLICY.profile,
    name: AUTONOMOUS_BUDGET_POLICY.profile,
    concurrencyCeiling: AUTONOMOUS_BUDGET_POLICY.concurrencyCeiling,
    wallClockBudgetMinutes: AUTONOMOUS_BUDGET_POLICY.wallClockBudgetMinutes,
    retryCeiling: AUTONOMOUS_BUDGET_POLICY.retryCeiling,
    materializationCeiling: AUTONOMOUS_BUDGET_POLICY.materializationCeiling,
    providerUsageBudget: AUTONOMOUS_BUDGET_POLICY.providerUsageBudget
  };
}

function resolveBudgetProfileForRun(): BudgetProfile {
  return getDefaultBudgetProfile();
}

function findBudgetProfileById(budgetProfileId: string | null | undefined): BudgetProfile | null {
  if (!budgetProfileId) {
    return null;
  }
  const defaultProfile = getDefaultBudgetProfile();
  return defaultProfile.id === budgetProfileId ? defaultProfile : null;
}

async function resolveStartupShell(): Promise<string> {
  if (process.platform === "win32") {
    return process.env.ComSpec || "cmd.exe";
  }

  for (const candidate of ["/bin/bash", "/bin/sh"]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return "sh";
}

type ActionPolicyContract = ActionToolPolicy;

const ACTION_TOOL_POLICIES: Record<string, ActionPolicyContract> = {
  read_file: {
    actionClass: "class_a",
  readOnly: true,
  supportsDryRun: true,
  supportsPreflight: true,
  supportsRollback: false,
  requiresApproval: false,
  idempotencyScope: "run_task",
  requiredPermissions: ["workspace_read"],
  evidenceShape: "read_result"
  },
  inspect_workspace: {
    actionClass: "class_a",
  readOnly: true,
  supportsDryRun: true,
  supportsPreflight: true,
  supportsRollback: false,
  requiresApproval: false,
  idempotencyScope: "run_task",
  requiredPermissions: ["workspace_read"],
  evidenceShape: "artifact_list"
  },
  write_file: {
    actionClass: "class_b",
  readOnly: false,
  supportsDryRun: true,
  supportsPreflight: true,
  supportsRollback: true,
  requiresApproval: false,
  idempotencyScope: "run_task",
  requiredPermissions: ["workspace_write"],
  evidenceShape: "file_delta"
  },
  edit_file: {
    actionClass: "class_b",
  readOnly: false,
  supportsDryRun: true,
  supportsPreflight: true,
  supportsRollback: true,
  requiresApproval: false,
  idempotencyScope: "run_task",
  requiredPermissions: ["workspace_write"],
  evidenceShape: "file_delta"
  },
  deploy: {
    actionClass: "class_c",
  readOnly: false,
  supportsDryRun: true,
  supportsPreflight: true,
  supportsRollback: false,
  requiresApproval: true,
  idempotencyScope: "run_task",
  requiredPermissions: ["external_system_mutation"],
  evidenceShape: "external_change_log"
  },
  run_command: {
    actionClass: "class_c",
  readOnly: false,
  supportsDryRun: false,
  supportsPreflight: false,
  supportsRollback: false,
  requiresApproval: true,
  idempotencyScope: "run_task",
  requiredPermissions: ["command_execution"],
  evidenceShape: "command_output"
  }
};

type ActionPolicyError = {
  error: {
    code: "unsafe_action_blocked" | "action_idempotency_conflict" | "approval_required" | "action_preflight_failed" | "run_replay_conflict";
    message: string;
    retryable: boolean;
    runId?: string | null;
  };
};

type MaterializationFailureCode = Exclude<MaterializationRecord["failureCode"], null>;

const MATERIALIZATION_FAILURE_POLICIES: Record<
  MaterializationFailureCode,
  {
    retryable: boolean;
    recoveryAction: string;
  }
> = {
  invalid_manifest: {
    retryable: false,
    recoveryAction: "Fix the manifest fields, run /api/catalog/sync, then request a new materialization."
  },
  self_check_failed: {
    retryable: true,
    recoveryAction: "Inspect dependencies or agent packaging, then retry materialization once the self-check can pass."
  },
  materialization_io_error: {
    retryable: true,
    recoveryAction: "Verify the catalog checkout and artifact storage paths, then retry materialization."
  }
};

// What the governed runtime actually requires of a provider: structured outputs
// (intake/plan JSON) and tool calls (the governed execution loop). File IO is
// performed by the runtime's action executor, not the provider; streaming and
// cancellation are optional conveniences. Requiring those of the raw provider was
// a pre-governed-loop assumption that blocked every real BYO provider.
const requiredProviderCapabilities: Omit<ProviderCapabilities, "providerIdentity"> = {
  supportsStreaming: false,
  supportsStructuredOutputs: true,
  supportsToolCalls: true,
  supportsFileIo: false,
  supportsCancellation: false
};

const RUNTIME_MIGRATION_KEYS = [
  "0001_runtime_foundation",
  "0002_runtime_indexes",
  "0003_runtime_entities",
  "0004_runtime_entity_indexes"
] as const;

function now() {
  return new Date().toISOString();
}

function buildProviderProfileId(workspaceId: string, providerId: string) {
  return `provider-profile:${workspaceId}:${providerId}`;
}

function buildMigrationRecordId(migrationKey: string) {
  return `migration-record:${migrationKey}`;
}

function titleFromMessage(content: string) {
  return content.trim().slice(0, 80) || "Untitled work";
}

function requiresApproval(content: string) {
  const lower = content.toLowerCase();
  return /(delete|deploy|publish|email|message someone|production|real world|external system)/.test(lower);
}

function normalizeContent(content: string) {
  return content.trim().replace(/\s+/g, " ");
}

function isShellStartupCheck(kind: string) {
  return kind === "shell_command" || kind === "command" || kind === "script";
}

function recordMaterializationFailure(
  materialization: MaterializationRecord,
  code: MaterializationFailureCode,
  reason: string
) {
  const policy = MATERIALIZATION_FAILURE_POLICIES[code];

  if (!materialization.failureCode) {
    materialization.failureCode = code;
    materialization.failureDetail = reason;
    materialization.retryable = policy.retryable;
    materialization.recoveryAction = policy.recoveryAction;
  }

  materialization.failureReasons.push(reason);
  materialization.diagnostics.push(reason);
}

function hasRequiredStartupHook(
  startupChecks: SpecialistManifestContract["startupChecks"],
  matcher: { id?: string; kind?: string; target?: string }
) {
  return startupChecks.some((check) => {
    const idMatches = matcher.id ? check.id === matcher.id : true;
    const kindMatches =
      matcher.kind
        ? check.kind === matcher.kind ||
          (matcher.kind === "provider_auth" && check.kind === "provider") ||
          (matcher.kind === "approval_hook" && check.kind === "approval")
        : true;
    const targetMatches = matcher.target ? check.target === matcher.target : true;
    return idMatches && kindMatches && targetMatches;
  });
}

function checkMaterializationManifestContract(manifest: SpecialistManifestContract) {
  const failures: string[] = [];

  if (!manifest.permissions.approvalRequired) {
    failures.push("permissions.approvalRequired must be true");
  }

  // Must match the catalog parser's DEFAULT_STARTUP_CHECKS (packages/catalog/src/index.ts)
  // exactly -- this check previously required id "provider-api-auth"/target "api", which
  // no manifest the parser ever produces has, so materialization failed for every
  // specialist unconditionally the one time this was actually run against real data.
  if (!hasRequiredStartupHook(manifest.startupChecks, { id: "provider-commons-crew-auth", kind: "provider_auth", target: "commons-crew" })) {
    failures.push("missing required startup hook for provider auth");
  }

  if (!hasRequiredStartupHook(manifest.startupChecks, { id: "approval-hook", kind: "approval_hook", target: "commons-keeper" })) {
    failures.push("missing required startup approval hook");
  }

  return failures;
}

function buildClarificationPrompt(content: string, requestType: Exclude<RequestRecord["requestType"], "chat">) {
  if (requestType === "planning") {
    return `PA needs clarification before it can draft a plan for "${content}". What outcome and scope should the plan cover?`;
  }

  return `PA needs clarification before it can execute "${content}". What concrete task should it perform, and what outcome do you want?`;
}

function combineClarifiedRequest(originalContent: string, clarification: string) {
  return `${normalizeContent(originalContent)}\n\nClarification: ${normalizeContent(clarification)}`;
}

function createDefaultState(): PersistentState {
  const timestamp = now();
  const primaryUserId = "user_primary";
  return {
    workspace: {
      id: "workspace_primary",
      ownerUserId: primaryUserId,
      name: "Primary Workspace",
      mode: "single_user",
      createdAt: timestamp
    },
    users: [
      {
        id: primaryUserId,
        emailOrLogin: "primary-user",
        displayName: "Primary User",
        role: "primary",
        status: "active",
        createdAt: timestamp,
        lastSeenAt: timestamp
      }
    ],
    workspaceMemberships: [
      {
        id: "membership_primary",
        workspaceId: "workspace_primary",
        userId: primaryUserId,
        role: "primary",
        permissions: [],
        status: "active",
        addedByUserId: primaryUserId,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    promptGovernance: {
      artifactSetSignature: null,
      artifactVersions: {},
      reevaluationPending: false,
      reevaluationChecks: [],
      reevaluationNotes: [],
      updatedAt: null
    },
    providerProfiles: [],
    providerCapabilitySnapshots: [],
    configProfiles: [],
    featureFlags: [],
    promptSpecs: [],
    sessions: [],
    messages: [],
    clarifications: [],
    workItems: [],
    workItemCollaborationThreads: [],
    workItemCollaborationMessages: [],
    requests: [],
    plans: [],
    planSteps: [],
    planChangeRequests: [],
    clarificationThreads: [],
    clarificationMessages: [],
    runs: [],
    tasks: [],
    agentRuntimes: [],
    taskPlanLinks: [],
    delegationDecisions: [],
    catalogEntries: [],
    catalogSyncs: [],
    materializations: [],
    runnerJobs: [],
    approvals: [],
    actionProposals: [],
    actionExecutions: [],
    artifacts: [],
    runEvents: [],
    evaluationRuns: [],
    incidents: [],
    migrationRecords: []
  };
}

function findSessionAnchorWorkItemId(state: PersistentState, sessionId: string) {
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session) {
    return null;
  }

  return session.workItemId ?? state.plans.find((plan) => plan.sessionId === sessionId)?.workItemId ?? state.runs.find((run) => run.sessionId === sessionId)?.workItemId ?? null;
}

function syncConfigProfileRecords(
  workspaceId: string,
  config: AppConfig,
  existingProfiles: ConfigProfileRecord[],
  existingFeatureFlags: FeatureFlagRecord[],
  timestamp: string
) {
  const activeProfileId = `config-profile:${workspaceId}:${config.profile.name}`;
  const previousActive = existingProfiles.find((entry) => entry.id === activeProfileId) ?? null;
  const nextProfile: ConfigProfileRecord = {
    id: activeProfileId,
    workspaceId,
    name: config.profile.name,
    environment: config.app.env,
    status: "active",
    createdAt: previousActive?.createdAt ?? timestamp,
    updatedAt: timestamp
  };

  const nextProfiles = [
    nextProfile,
    ...existingProfiles
      .filter((entry) => entry.id !== activeProfileId)
      .map((entry) => ({
        ...entry,
        status: "retired" as const,
        updatedAt: timestamp
      }))
  ];

  const existingFlagsById = new Map(existingFeatureFlags.map((entry) => [entry.id, entry]));
  const nextFeatureFlags: FeatureFlagRecord[] = Object.entries(config.featureFlags).map(([flagKey, flagValue]) => {
    const id = `feature-flag:${activeProfileId}:${flagKey}`;
    const previous = existingFlagsById.get(id);
    return {
      id,
      configProfileId: activeProfileId,
      flagKey,
      flagValue,
      rolloutState: flagValue ? "enabled" : "disabled",
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
  });

  return {
    configProfiles: nextProfiles,
    featureFlags: nextFeatureFlags
  };
}

function syncProviderProfileRecords(
  workspaceId: string,
  providerStatus: ProviderStatus,
  existingProfiles: ProviderProfileRecord[],
  timestamp: string
) {
  const activeProfileId = buildProviderProfileId(workspaceId, providerStatus.id);
  const previousActive = existingProfiles.find((entry) => entry.id === activeProfileId) ?? null;
  const nextProfile: ProviderProfileRecord = {
    id: activeProfileId,
    workspaceId,
    providerType: providerStatus.id,
    displayName: providerStatus.displayName,
    transportMode: "cli",
    isDefault: true,
    status: "active",
    createdAt: previousActive?.createdAt ?? timestamp,
    updatedAt: timestamp
  };

  return [
    nextProfile,
    ...existingProfiles
      .filter((entry) => entry.id !== activeProfileId)
      .map((entry) => ({
        ...entry,
        isDefault: false,
        status: "retired" as const,
        updatedAt: timestamp
      }))
  ];
}

function syncMigrationRecords(existing: MigrationRecord[], timestamp: string, appliedBy: string) {
  const existingById = new Map(existing.map((entry) => [entry.id, entry]));
  return RUNTIME_MIGRATION_KEYS.map((migrationKey) => {
    const id = buildMigrationRecordId(migrationKey);
    const previous = existingById.get(id);
    return {
      id,
      migrationKey,
      appliedAt: previous?.appliedAt ?? timestamp,
      appliedBy: previous?.appliedBy ?? appliedBy,
      status: "applied" as const
    };
  });
}

function validateMigrationRecords(records: MigrationRecord[]) {
  const appliedKeys = new Set(
    records.filter((entry) => entry.status === "applied").map((entry) => entry.migrationKey)
  );
  const missingKeys = RUNTIME_MIGRATION_KEYS.filter((migrationKey) => !appliedKeys.has(migrationKey));
  if (missingKeys.length > 0) {
    throw new Error(`migration_state_invalid:${missingKeys.join(",")}`);
  }
}

function normalizeClarificationState(input: ClarificationState | undefined): ClarificationState {
  return input === "open" || input === "resolved" || input === "abandoned" ? input : "resolved";
}

function isClarificationOpen(thread: ClarificationThreadRecord) {
  return normalizeClarificationState(thread.state) === "open" || normalizeClarificationState(thread.status) === "open";
}

function isClarificationResolved(thread: ClarificationThreadRecord) {
  return normalizeClarificationState(thread.state) === "resolved" || normalizeClarificationState(thread.status) === "resolved";
}

function getOpenClarificationForSession(state: PersistentState, sessionId: string) {
  return state.clarificationThreads.find((entry) => entry.sessionId === sessionId && isClarificationOpen(entry)) ?? null;
}

function buildPlanningSteps(content: string): Array<{ title: string; description: string }> {
  return [
    {
      title: "Clarify the objective",
      description: `Clarify success criteria and intended outcome for: ${content}`
    },
    {
      title: "Map the work",
      description: "Break the request into explicit execution-ready steps."
    },
    {
      title: "Prepare execution",
      description: "Lock the plan so PA can execute against it without silent drift."
    }
  ];
}

function buildExecutionTasks(content: string, availableAgents: CatalogEntry[]) {
  const primaryAgent = availableAgents[0] ?? null;
  return [
    {
      name: "Analyze request",
      description: `Analyze the request and select the best execution path for: ${content}`,
      taskKind: "operational" as const,
      assignedAgentId: primaryAgent?.id ?? null,
      approvalRequired: false
    },
    {
      name: "Execute planned work",
      description: "Carry out the main implementation or orchestration work.",
      taskKind: "plan_step" as const,
      assignedAgentId: primaryAgent?.id ?? null,
      approvalRequired: requiresApproval(content)
    },
    {
      name: "Summarize outcome",
      description: "Package the completed result for PA to present back to the user.",
      taskKind: "cleanup" as const,
      assignedAgentId: null,
      approvalRequired: false
    }
  ];
}

function buildIntakeCatalog(catalogEntries: CatalogEntry[]): IntakeCatalogEntry[] {
  const compact = (value: string, maxLength: number) => value.replace(/\s+/g, " ").trim().slice(0, maxLength);

  return catalogEntries.map((entry) => ({
    id: entry.id,
    agentSlug: entry.agentSlug,
    name: entry.name,
    readinessState: entry.readinessState,
    description: compact(entry.manifest.identity.description, 220),
    domain: entry.manifest.identity.boundary.domain,
    constraints: [],
    supportedTasks: entry.supportedTasks.slice(0, 3).map((task) => compact(task, 80)),
    expectedOutputs: []
  }));
}

function buildRecentIntakeMessages(messages: MessageRecord[], sessionId: string) {
  return messages
    .filter((entry) => entry.sessionId === sessionId)
    .slice(-8)
    .map((entry) => ({
      authorType: entry.authorType,
      messageKind: entry.messageKind,
      content: entry.content,
      createdAt: entry.createdAt
    }));
}

function buildChatAnswerInput(session: SessionRecord, content: string, messages: MessageRecord[]): ChatAnswerInput {
  return {
    session: {
      id: session.id,
      title: session.title,
      surface: session.surface,
      status: session.status
    },
    message: content,
    recentMessages: buildRecentIntakeMessages(messages, session.id),
    runtimeContext: {
      availableCapabilities: [...PA_RUNTIME_CAPABILITIES]
    }
  };
}

function buildPlanDraftInput(session: SessionRecord, request: string, messages: MessageRecord[]): PlanDraftInput {
  return {
    session: {
      id: session.id,
      title: session.title,
      surface: session.surface,
      status: session.status
    },
    request,
    recentMessages: buildRecentIntakeMessages(messages, session.id)
  };
}

async function loadMaterializedSpecialistExecutionContext(
  state: PersistentState,
  task: TaskRecord
): Promise<TaskExecutionInput["materializedSpecialist"]> {
  if (!task.materializationId) {
    return null;
  }

  const materialization = state.materializations.find((entry) => entry.id === task.materializationId) ?? null;
  if (!materialization || materialization.status !== "ready") {
    return null;
  }

  const generatedRoot = path.join(materialization.generatedPath, "generated-specialist");
  const [instructions, systemPrompt, runtimeBundleRaw, executionContractRaw] = await Promise.all([
    fs.readFile(path.join(generatedRoot, "instructions.md"), "utf8"),
    fs.readFile(path.join(generatedRoot, "system-prompt.md"), "utf8"),
    fs.readFile(path.join(generatedRoot, "runtime-bundle.json"), "utf8"),
    fs.readFile(path.join(generatedRoot, "execution-contract.json"), "utf8")
  ]);

  return {
    materializationId: materialization.id,
    generatedPath: materialization.generatedPath,
    instructions,
    systemPrompt,
    runtimeBundle: JSON.parse(runtimeBundleRaw) as MaterializedSpecialistRuntimeBundle,
    executionContract: JSON.parse(executionContractRaw) as MaterializedSpecialistExecutionContract
  };
}

async function buildTaskExecutionInput(
  state: PersistentState,
  session: SessionRecord,
  run: RunRecord,
  task: TaskRecord,
  catalogEntries: CatalogEntry[]
): Promise<TaskExecutionInput> {
  await Promise.all([
    ensureSharedWritableDirectory(run.artifactRootPath),
    ensureSharedWritableDirectory(run.workspacePath)
  ]);
  const assignedEntry = task.assignedAgentId ? catalogEntries.find((entry) => entry.id === task.assignedAgentId) ?? null : null;
  const materializedSpecialist = await loadMaterializedSpecialistExecutionContext(state, task);
  const approvedForSideEffects = task.approvalRequired
    ? state.approvals.some((approval) => approval.taskId === task.id && approval.status === "approved")
    : true;
  const priorCompletedTasks = sortExecutionTasks(
    state.tasks.filter((entry) => entry.runId === run.id && entry.status === "completed" && entry.id !== task.id)
  )
    .map((entry) => ({
      name: entry.name,
      summary: entry.resultSummary?.trim() || `${entry.name} completed.`
    }))
    .filter((entry) => entry.summary.length > 0)
    .slice(-6);

  return {
    session: {
      id: session.id,
      title: session.title,
      surface: session.surface,
      status: session.status
    },
    run: {
      id: run.id,
      mode: run.mode,
      summary: run.summary,
      workspacePath: run.workspacePath,
      artifactRootPath: run.artifactRootPath
    },
    task: {
      id: task.id,
      name: task.name,
      description: task.description,
      taskKind: task.taskKind,
      approvalRequired: task.approvalRequired,
      approvedForSideEffects
    },
    specialist: {
      id: assignedEntry?.id ?? null,
      name: assignedEntry?.name ?? null,
      domain: assignedEntry?.manifest.identity.boundary.domain ?? null
    },
    materializedSpecialist,
    priorCompletedTasks
  };
}

async function ensureSharedWritableDirectory(location: string) {
  await fs.mkdir(location, { recursive: true });
  await fs.chmod(location, 0o777);
}

function resolveTaskRuntimeMode(task: Pick<TaskRecord, "assignedAgentId" | "materializationId">): AgentRuntimeMode {
  if (task.materializationId) {
    return "materialized_specialist";
  }
  if (task.assignedAgentId) {
    return "catalog_specialist";
  }
  return "pa_runtime";
}

function buildTaskRuntimeRecord(run: RunRecord, task: Pick<TaskRecord, "assignedAgentId" | "materializationId">): AgentRuntimeRecord {
  return {
    id: randomUUID(),
    runId: run.id,
    agentCatalogEntryId: task.assignedAgentId ?? null,
    agentMaterializationId: task.materializationId ?? null,
    providerProfileId: run.providerProfileId,
    runtimeMode: resolveTaskRuntimeMode(task),
    status: "queued",
    startedAt: now(),
    endedAt: null
  };
}

function resolveIntakeSpecialistSelection(
  catalogEntries: CatalogEntry[],
  candidates: IntakeSpecialistCandidate[]
) {
  const catalogById = new Map(catalogEntries.map((entry) => [entry.id, entry]));
  const selectedEntries: CatalogEntry[] = [];
  const candidatesByEntryId = new Map<string, IntakeSpecialistCandidate>();

  for (const candidate of candidates) {
    const entry = catalogById.get(candidate.catalogEntryId);
    if (!entry || candidatesByEntryId.has(entry.id)) {
      continue;
    }
    candidatesByEntryId.set(entry.id, candidate);
    selectedEntries.push(entry);
  }

  return {
    selectedEntries,
    candidatesByEntryId
  };
}

function resolveRequestContentForRerun(state: PersistentState, run: RunRecord): string | null {
  const request = state.requests.find((entry) => entry.id === run.requestId) ?? null;
  if (!request) {
    return null;
  }

  const latestResolvedClarification = [...(state.clarifications ?? [])]
    .filter((entry) => entry.requestId === request.id && entry.status === "resolved" && entry.resolutionSummary)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;

  if (latestResolvedClarification?.resolutionSummary) {
    return combineClarifiedRequest(
      latestResolvedClarification.originalContent,
      latestResolvedClarification.resolutionSummary
    );
  }

  const originalMessage = state.messages.find((entry) => entry.id === request.messageId && entry.authorType === "user") ?? null;
  return originalMessage?.content ?? null;
}

function buildRerunSpecialistSelection(
  state: PersistentState,
  runId: string,
  catalogEntries: CatalogEntry[]
) {
  const taskAgentIds = sortExecutionTasks(state.tasks.filter((entry) => entry.runId === runId))
    .map((entry) => entry.assignedAgentId)
    .filter((entry): entry is string => Boolean(entry));
  const selectedEntries = Array.from(new Set(taskAgentIds))
    .map((agentId) => catalogEntries.find((entry) => entry.id === agentId) ?? null)
    .filter((entry): entry is CatalogEntry => Boolean(entry));
  const candidatesByEntryId = new Map<string, IntakeSpecialistCandidate>(
    selectedEntries.map((entry) => [
      entry.id,
      {
        catalogEntryId: entry.id,
        confidence: "high",
        reason: "operator_rerun_preserved_specialist_selection"
      }
    ])
  );

  return {
    selectedEntries,
    candidatesByEntryId
  };
}

function buildExecutionTasksForSelectedAgents(
  content: string,
  taskTemplates: Array<{ name: string; description: string }>,
  selectedSpecialists: CatalogEntry[]
) {
  const specialistsById = new Map(selectedSpecialists.map((specialist) => [specialist.id, specialist]));
  const delegationContexts = buildSpecialistDelegationContexts(content, selectedSpecialists);
  const leadContext = delegationContexts[0] ?? null;
  const supportingContexts = delegationContexts.slice(1);
  const primaryAgent = selectedSpecialists[0] ?? null;
  const supportingSpecialists = selectedSpecialists.slice(1);
  const supportingNames = supportingSpecialists.map((specialist) => specialist.name);
  const tasks: Array<{
    name: string;
    description: string;
    taskKind: "plan_step" | "operational" | "validation" | "cleanup";
    assignedAgentId: string | null;
    approvalRequired: boolean;
  }> = taskTemplates.map((task, index) => {
    const assignedAgentId = index === taskTemplates.length - 1 ? null : primaryAgent?.id ?? null;
    const assignedSpecialist = assignedAgentId ? specialistsById.get(assignedAgentId) ?? null : null;
    const specialistRequiresApproval = assignedSpecialist?.manifest.permissions.approvalRequired ?? false;

    return {
      name: task.name,
      description:
        selectedSpecialists.length > 1 && index === 0
          ? `${task.description} ${leadContext?.handoffSummary ?? "Lead the multi-specialist delegation plan."}`
          : selectedSpecialists.length > 1 && index === 1
            ? `${task.description} Keep the shared implementation aligned, track incoming specialist handoffs, and collect the dependencies each specialist reports before final synthesis.`
            : selectedSpecialists.length > 1 && index === taskTemplates.length - 1
              ? `${task.description} Combine the specialist handoffs into one coherent completion summary for PA, covering ${supportingContexts.map((context) => `${context.entry.name} (${context.entry.manifest.identity.boundary.domain})`).join(", ")} and the final integrated result.`
              : task.description,
      taskKind: index === 0 ? "operational" : index === taskTemplates.length - 1 ? "cleanup" : "plan_step",
      assignedAgentId,
      approvalRequired:
        index > 0 && index < taskTemplates.length - 1
          ? requiresApproval(content) || specialistRequiresApproval
          : false
    };
  });

  for (const context of supportingContexts) {
    const specialist = context.entry;
    tasks.splice(Math.max(1, tasks.length - 1), 0, {
      name: `Specialist contribution: ${specialist.name}`,
      description: `${context.delegatedScope} ${context.handoffSummary}`,
      taskKind: "operational",
      assignedAgentId: specialist.id,
      approvalRequired: specialist.manifest.permissions.approvalRequired
    });
  }

  return tasks;
}

function rankExecutionTask(task: Pick<TaskRecord, "name" | "taskKind" | "id">) {
  if (task.name === "Analyze request") {
    return 0;
  }
  if (task.name === "Execute planned work") {
    return 1;
  }
  if (task.name.startsWith("Specialist contribution:")) {
    return 2;
  }
  if (task.taskKind === "validation") {
    return 3;
  }
  if (task.name === "Summarize outcome" || task.taskKind === "cleanup") {
    return 4;
  }
  if (task.taskKind === "operational") {
    return 5;
  }
  if (task.taskKind === "plan_step") {
    return 6;
  }
  return 7;
}

function sortExecutionTasks<T extends Pick<TaskRecord, "name" | "taskKind" | "id">>(tasks: T[]) {
  return [...tasks].sort(
    (left, right) =>
      rankExecutionTask(left) - rankExecutionTask(right) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id)
  );
}

function joinWithAnd(values: string[]) {
  if (values.length <= 1) {
    return values[0] ?? "";
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function buildSpecialistDelegationContexts(content: string, selectedSpecialists: CatalogEntry[]): SpecialistDelegationContext[] {
  const lead = selectedSpecialists[0] ?? null;
  const supporting = selectedSpecialists.slice(1);
  const supportingNames = supporting.map((entry) => entry.name);

  return selectedSpecialists.map((entry, index) => {
    const isLead = index === 0;
    const domain = entry.manifest.identity.boundary.domain;
    if (isLead) {
      return {
        entry,
        delegationRole: "lead",
        delegatedScope:
          supporting.length > 0
            ? `Lead planning, shared implementation, and final synthesis for: ${content}`
            : `Handle the primary execution path for: ${content}`,
        handoffSummary:
          supporting.length > 0
            ? `Split the work across ${joinWithAnd(supportingNames)}, define the handoff expectations for each specialist, and keep the cross-specialist plan aligned.`
            : `Complete the requested work directly and return the final handoff to PA.`,
        completionSummary:
          supporting.length > 0
            ? `${entry.name} led planning and integration, collected the specialist handoffs, and returned the integrated result to PA.`
            : `${entry.name} handled the assigned work and returned the final handoff to PA.`
      };
    }

    return {
      entry,
      delegationRole: "contributor",
      delegatedScope: `Own the ${domain} workstream for: ${content}`,
      handoffSummary: `Receive the delegation handoff from ${lead?.name ?? "PA"}, complete the specialist work, and hand back deliverables, unresolved dependencies, and follow-up constraints.`,
      completionSummary: `${entry.name} completed the ${domain} workstream and handed back deliverables, dependencies, and follow-up constraints.`
    };
  });
}

function buildDelegationDecisions(
  runId: string,
  content: string,
  selectedCatalogEntries: CatalogEntry[],
  candidatesByEntryId: Map<string, IntakeSpecialistCandidate>,
  fallbackReasonSummary: string
): DelegationDecisionRecord[] {
  const contexts = buildSpecialistDelegationContexts(content, selectedCatalogEntries);
  return contexts.map((context) => {
    const candidate = candidatesByEntryId.get(context.entry.id) ?? null;
    const decisionType: "catalog_agent" | "jit_materialized_agent" =
      context.entry.readinessState === "definition_only" ? "jit_materialized_agent" : "catalog_agent";
    return {
      id: randomUUID(),
      runId,
      decisionType,
      specialistId: context.entry.id,
      specialistName: context.entry.name,
      delegationRole: context.delegationRole,
      delegatedScope: context.delegatedScope,
      handoffSummary: context.handoffSummary,
      completionSummary: context.completionSummary,
      reasonSummary: candidate ? `Selected ${context.entry.name}: ${candidate.reason} (confidence: ${candidate.confidence})` : fallbackReasonSummary,
      industryContext: "general",
      domainContext: context.entry.manifest.identity.boundary.domain,
      createdAt: now()
    };
  });
}

function buildTaskDelegationPlan(tasks: TaskRecord[], catalogEntries: CatalogEntry[]) {
  const catalogById = new Map(catalogEntries.map((entry) => [entry.id, entry]));
  return sortExecutionTasks(tasks).map((task, index) => {
    const assignedEntry = task.assignedAgentId ? catalogById.get(task.assignedAgentId) ?? null : null;
    return {
      sequence: index + 1,
      taskId: task.id,
      assignedRuntimeId: task.assignedRuntimeId ?? null,
      name: task.name,
      taskKind: task.taskKind,
      assignedAgentId: task.assignedAgentId,
      materializationId: task.materializationId ?? null,
      assignedAgentName: assignedEntry?.name ?? null,
      assignedAgentDomain: assignedEntry?.manifest.identity.boundary.domain ?? null,
      approvalRequired: task.approvalRequired,
      handoffContext: task.description
    };
  });
}

function buildRunResultSynthesisInput(
  state: PersistentState,
  runId: string,
  catalogEntries: CatalogEntry[]
): RunResultSynthesisInput | null {
  const run = state.runs.find((entry) => entry.id === runId) ?? null;
  if (!run) {
    return null;
  }

  const session = state.sessions.find((entry) => entry.id === run.sessionId) ?? null;
  const request = state.requests.find((entry) => entry.id === run.requestId) ?? null;
  const requestMessage = request ? state.messages.find((entry) => entry.id === request.messageId) ?? null : null;
  const tasks = state.tasks.filter((task) => task.runId === runId);
  const delegationDecisions = state.delegationDecisions
    .filter((entry) => entry.runId === runId)
    .sort((left, right) => {
      const rank = (role: DelegationDecisionRecord["delegationRole"]) => (role === "lead" ? 0 : role === "contributor" ? 1 : 2);
      return rank(left.delegationRole) - rank(right.delegationRole);
    });
  const catalogById = new Map(catalogEntries.map((entry) => [entry.id, entry]));
  const completedTasks = sortExecutionTasks(tasks)
    .filter((task) => task.status === "completed")
    .map((task) => {
      const assignedEntry = task.assignedAgentId ? catalogById.get(task.assignedAgentId) ?? null : null;
      return {
        name: task.name,
        taskKind: task.taskKind,
        assignedAgentName: assignedEntry?.name ?? null,
        assignedAgentDomain: assignedEntry?.manifest.identity.boundary.domain ?? null,
        summary: task.resultSummary ?? `Completed task: ${task.name}`,
        detail: task.resultDetail ?? null
      };
    });

  return {
    session: {
      id: run.sessionId,
      title: session?.title ?? "PA session",
      surface: session?.surface ?? "cli",
      status: session?.status ?? "active"
    },
    run: {
      id: run.id,
      mode: run.mode,
      request: requestMessage?.content ?? run.summary
    },
    completedTasks,
    delegationDecisions: delegationDecisions.map((decision) => ({
      specialistName: decision.specialistName ?? null,
      delegationRole: decision.delegationRole,
      domainContext: decision.domainContext,
      completionSummary: decision.completionSummary ?? null
    }))
  };
}

function renderMaterializedSpecialistInstructions(
  manifest: SpecialistManifestContract,
  artifact: Awaited<ReturnType<typeof loadPromptArtifacts>>["specialist"]
) {
  const promptValues = buildMaterializedSpecialistPromptValues({
    name: manifest.identity.name,
    description: manifest.identity.description,
    domain: manifest.identity.boundary.domain,
    constraints: manifest.identity.boundary.constraints,
    supportedTasks: manifest.supportedTasks,
    requiredOutputs: manifest.outputs.map((output) => output.name),
    approvalRequired: manifest.permissions.approvalRequired
  });

  return [
    `# ${manifest.identity.name}`,
    "",
    manifest.identity.description,
    "",
    renderMaterializedSpecialistInstructionsPreface(artifact, promptValues),
    "",
    "## Domain Boundary",
    `- Domain: ${manifest.identity.boundary.domain}`,
    ...manifest.identity.boundary.constraints.map((constraint) => `- Constraint: ${constraint}`),
    "",
    "## Supported Tasks",
    ...manifest.supportedTasks.map((task) => `- ${task}`),
    "",
    "## Required Inputs",
    ...manifest.inputs.map((input) => `- ${input.name} (${input.type})${input.required ? " [required]" : ""}: ${input.description}`),
    "",
    "## Required Outputs",
    ...manifest.outputs.map((output) => `- ${output.name} (${output.type})${output.required ? " [required]" : ""}: ${output.description}`),
    "",
    "## Runtime Guardrails",
    `- Approval required: ${manifest.permissions.approvalRequired ? "yes" : "no"}`,
    ...manifest.permissions.allow.map((permission) => `- Allowed capability: ${permission}`),
    "",
    "## Startup Hooks",
    ...manifest.startupChecks.map((check) => `- ${check.id}: ${check.kind} -> ${check.target}${check.required ? " [required]" : ""}`)
  ].join("\n");
}

function renderMaterializedSpecialistSystemPrompt(
  manifest: SpecialistManifestContract,
  artifact: Awaited<ReturnType<typeof loadPromptArtifacts>>["specialist"]
) {
  return renderMaterializedSpecialistSystemPromptFromArtifact(
    artifact,
    buildMaterializedSpecialistPromptValues({
      name: manifest.identity.name,
      description: manifest.identity.description,
      domain: manifest.identity.boundary.domain,
      constraints: manifest.identity.boundary.constraints,
      supportedTasks: manifest.supportedTasks,
      requiredOutputs: manifest.outputs.map((output) => output.name),
      approvalRequired: manifest.permissions.approvalRequired
    })
  );
}

async function describeGeneratedArtifact(filePath: string, description: string) {
  const content = await fs.readFile(filePath);
  return {
    path: path.basename(filePath),
    description,
    bytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

function selectRunMode(selectedEntries: CatalogEntry[], providerSnapshot: ProviderCapabilitySnapshot): RunRecord["mode"] {
  const supportsSpecialistExecution =
    providerSnapshot.installed &&
    providerSnapshot.authenticated &&
    providerSnapshot.capabilities.supportsToolCalls &&
    providerSnapshot.capabilities.supportsFileIo;
  if (!supportsSpecialistExecution || selectedEntries.length === 0) {
    return "direct_pa";
  }
  return selectedEntries.length > 1 ? "multi_specialist" : "single_specialist";
}

function createEvaluationProviderStatus(config: AppConfig): ProviderStatus {
  return {
    id: "api-provider",
    displayName: "API Provider",
    model: config.provider.model,
    installed: true,
    authenticated: true,
    authMode: "api_key",
    capabilities: {
      providerIdentity: "evaluation-provider",
      supportsStreaming: true,
      supportsStructuredOutputs: true,
      supportsToolCalls: true,
      supportsFileIo: true,
      supportsCancellation: true
    },
    diagnostics: {
      checkedAt: now(),
      apiKeyConfigured: Boolean(config.provider.apiKey),
      readiness: "ready"
    }
  };
}

function createEvaluationChatAnswer(input: ChatAnswerInput): ChatAnswer {
  const lower = input.message.toLowerCase();
  if (lower.includes("what can pa do") || lower.includes("what can you do") || lower.includes("capabilities")) {
    return {
      content:
        "PA can answer questions directly, draft plans tied to work items, queue execution runs, ask clarifying questions when scope is unclear, manage approvals, and show run progress."
    };
  }

  return {
    content: `PA can help with that directly, or turn it into a plan or execution run if the work needs orchestration.`
  };
}

function createEvaluationPlanDraft(input: PlanDraftInput): PlanDraft {
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

function createEvaluationTaskExecutionResult(input: TaskExecutionInput): TaskExecutionResult {
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
        detail: `Completed the lead ${input.specialist.domain} workstream for ${input.run.summary}.`
      };
    }
    if (input.task.name.startsWith("Specialist contribution:")) {
      return {
        summary: `${input.specialist.name} completed the ${input.specialist.domain} workstream and handed back deliverables, dependencies, and follow-up constraints.`,
        detail: `Returned a governed specialist handoff for ${input.task.description}.`
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
      detail: "Collected the completed task handoffs into a final PA-facing update."
    };
  }

  return {
    summary: `PA completed task: ${input.task.name}.`,
    detail: input.task.description
  };
}

function createEvaluationRunResultSynthesis(input: RunResultSynthesisInput): RunResultSynthesisResult {
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

function createEvaluationProvider(config: AppConfig) {
  function findCatalogEntryId(input: IntakeDecisionInput, agentSlug: string) {
    return input.catalog.find((entry) => entry.agentSlug === agentSlug)?.id ?? "";
  }

  return {
    async getStatus() {
      return createEvaluationProviderStatus(config);
    },

    async answerChat(input: ChatAnswerInput): Promise<ChatAnswer> {
      return createEvaluationChatAnswer(input);
    },

    async createPlan(input: PlanDraftInput): Promise<PlanDraft> {
      return createEvaluationPlanDraft(input);
    },

    async executeTask(input: TaskExecutionInput): Promise<TaskExecutionResult> {
      return createEvaluationTaskExecutionResult(input);
    },

    async proposeToolCalls(): Promise<ToolStepResult> {
      // Evaluation provider is deterministic and never proposes tool calls.
      return { content: "evaluation provider: no tool calls", toolCalls: [] };
    },

    async selectIntakeDomains(input: { domains: string[] }): Promise<{ domains: string[] }> {
      // Deterministic: the evaluation catalog is small, so keep every domain.
      return { domains: input.domains };
    },

    async synthesizeRunResult(input: RunResultSynthesisInput): Promise<RunResultSynthesisResult> {
      return createEvaluationRunResultSynthesis(input);
    },

    async decideIntake(input: IntakeDecisionInput): Promise<IntakeDecision> {
      const lower = input.message.toLowerCase();

      if (lower.includes("slug") && lower.includes("validation")) {
        return {
          requestType: "execution",
          needsClarification: false,
          clarificationQuestion: null,
          clarificationReason: null,
          specialistCandidates: [
            {
              catalogEntryId: findCatalogEntryId(input, "backend-api"),
              confidence: "high",
              reason: "The request is about backend API validation behavior."
            }
          ],
          decisionConfidence: "high",
          reasoningSummary: "Clear execution request for backend API validation."
        };
      }

      if (lower.includes("dashboard") && lower.includes("backend")) {
        return {
          requestType: "execution",
          needsClarification: false,
          clarificationQuestion: null,
          clarificationReason: null,
          specialistCandidates: [
            {
              catalogEntryId: findCatalogEntryId(input, "backend-api"),
              confidence: "high",
              reason: "Backend API work is explicitly required."
            },
            {
              catalogEntryId: findCatalogEntryId(input, "frontend-dashboard"),
              confidence: "high",
              reason: "Dashboard UI work is explicitly required."
            }
          ],
          decisionConfidence: "high",
          reasoningSummary: "Cross-domain execution request spanning backend and frontend."
        };
      }

      if (lower.includes("release plan") || (lower.includes("release") && lower.includes("scope"))) {
        return {
          requestType: "planning",
          needsClarification: false,
          clarificationQuestion: null,
          clarificationReason: null,
          specialistCandidates: [],
          decisionConfidence: "high",
          reasoningSummary: "The user is asking for planning rather than direct execution."
        };
      }

      if (lower.includes("something") && lower.includes("codebase")) {
        return {
          requestType: "execution",
          needsClarification: true,
          clarificationQuestion: "What exactly is broken, and what outcome should PA deliver?",
          clarificationReason: "The request identifies work but not a concrete target or expected result.",
          specialistCandidates: [],
          decisionConfidence: "high",
          reasoningSummary: "Execution intent is present, but the scope is too vague to route safely."
        };
      }

      return {
        requestType: "chat",
        needsClarification: false,
        clarificationQuestion: null,
        clarificationReason: null,
        specialistCandidates: [],
        decisionConfidence: "medium",
        reasoningSummary: "The message is best treated as conversational intake."
      };
    }
  };
}

function createEvaluationManifest(options: {
  slug: string;
  name: string;
  description: string;
  domain: string;
  supportedTasks: string[];
  readinessState?: "validated" | "deployable" | "definition_only" | "partial" | "planned";
}) {
  return [
    "schemaVersion: olf.specialist/v1",
    "kind: specialist",
    "identity:",
    `  slug: ${options.slug}`,
    `  name: ${options.name}`,
    `  description: ${options.description}`,
    "  boundary:",
    `    domain: ${options.domain}`,
    "    constraints:",
    "      - controlled-workspace-only",
    "supportedTasks:",
    ...options.supportedTasks.map((task) => `  - ${task}`),
    `readinessState: ${options.readinessState ?? "validated"}`,
    "inputs:",
    "  - name: request",
    "    type: context",
    "    description: Request passed to the specialist.",
    "    required: true",
    "outputs:",
    "  - name: patch",
    "    type: artifact",
    "    description: Implemented change set.",
    "    required: true",
    "permissions:",
    "  approvalRequired: false",
    "  allow:",
    "    - workspace.read",
    "    - workspace.write",
    "startupChecks:",
    '  - id: self-check-1',
    "    kind: shell_command",
    '    target: "node -e \\"process.exit(0)\\""',
    "    required: true",
    "  - id: provider-api-auth",
    "    kind: provider_auth",
    '    target: "api"',
    "    required: true",
    "  - id: approval-hook",
    "    kind: approval_hook",
    '    target: "commons-keeper"',
    "    required: true",
    ""
  ].join("\n");
}

async function initializeEvaluationCatalog(root: string) {
  await fs.mkdir(path.join(root, "agents"), { recursive: true });
  const entries = [
    {
      slug: "frontend-dashboard",
      manifest: createEvaluationManifest({
        slug: "frontend-dashboard",
        name: "Frontend Dashboard Specialist",
        description: "Handles dashboard UI, frontend workflows, and React interfaces.",
        domain: "frontend-ui",
        supportedTasks: ["frontend", "dashboard", "react", "ui", "implement"]
      })
    },
    {
      slug: "backend-api",
      manifest: createEvaluationManifest({
        slug: "backend-api",
        name: "Backend API Specialist",
        description: "Builds API endpoints, backend services, and validation logic.",
        domain: "backend-api",
        supportedTasks: ["api", "backend", "endpoint", "validation", "implement"]
      })
    },
    {
      slug: "docs-runbooks",
      manifest: createEvaluationManifest({
        slug: "docs-runbooks",
        name: "Documentation Specialist",
        description: "Maintains docs, guides, and operator runbooks.",
        domain: "documentation",
        supportedTasks: ["docs", "runbook", "documentation", "guide", "update"]
      })
    }
  ];

  for (const entry of entries) {
    const manifestPath = path.join(root, "agents", entry.slug, "manifest.yaml");
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, entry.manifest, "utf8");
  }

  try {
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
  } catch {
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["branch", "-M", "main"], { cwd: root });
  }
  await execFileAsync("git", ["config", "user.name", "PA Evaluation"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "pa-evaluation@example.com"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "Add evaluation catalog fixtures"], { cwd: root });
}

function createScenarioResult(
  id: string,
  title: string,
  decisionPoint: EvaluationDecisionPoint,
  passed: boolean,
  summary: string,
  evidence: Record<string, unknown>
): EvaluationScenarioResult {
  return {
    id,
    title,
    decisionPoint,
    passed,
    score: passed ? 1 : 0,
    summary,
    evidence
  };
}

function summarizeEvaluationDecisionPoints(scenarios: EvaluationScenarioResult[]): EvaluationDecisionPointScore[] {
  const decisionPoints: EvaluationDecisionPoint[] = ["routing", "clarification", "specialist_selection"];
  return decisionPoints.map((decisionPoint) => {
    const scoped = scenarios.filter((scenario) => scenario.decisionPoint === decisionPoint);
    const passed = scoped.filter((scenario) => scenario.passed).length;
    const total = scoped.length;
    return {
      decisionPoint,
      passed,
      total,
      score: total === 0 ? 0 : Number((passed / total).toFixed(2))
    };
  });
}

async function createEvaluationHarness(config: AppConfig, evaluationRunId: string): Promise<EvaluationHarnessContext> {
  const workspaceRoot = path.join(config.paths.artifactsRoot, "evaluations", evaluationRunId, "workspace");
  const catalogRoot = path.join(workspaceRoot, "catalog");
  const runtimeRoot = path.join(workspaceRoot, "runtime");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await initializeEvaluationCatalog(catalogRoot);

  const evaluationConfig: AppConfig = {
    ...config,
    ports: {
      api: 0,
      runner: 0
    },
    paths: {
      ...config.paths,
      olfAgentsRoot: catalogRoot,
      artifactsRoot: path.join(runtimeRoot, "artifacts"),
      stateFile: path.join(runtimeRoot, "state.json"),
      backupsRoot: path.join(runtimeRoot, "backups")
    },
    storage: {
      mode: "memory"
    },
    database: {
      connectionString: "pg-mem://evaluation",
      schema: "pa_runtime"
    }
  };

  const services = await createAppServices(evaluationConfig, {
    provider: createEvaluationProvider(evaluationConfig)
  });
  await services.catalog.sync();

  return {
    services,
    cleanup: async () => {
      await services.shutdown();
    }
  };
}

async function runDecisionQualityEvaluation(harness: EvaluationHarnessContext): Promise<EvaluationScenarioResult[]> {
  const scenarios: EvaluationScenarioResult[] = [];

  {
    const session = await harness.services.pa.createSession("cli", "Evaluation chat routing");
    const view = await harness.services.pa.postMessage(session.session.id, "What can PA do right now?");
    const passed = Boolean(
      view &&
      view.latestRun === null &&
      view.pendingClarifications.length === 0 &&
      view.messages.at(-1)?.messageKind === "chat"
    );
    scenarios.push(
      createScenarioResult(
        "routing-chat",
        "Chat requests stay conversational",
        "routing",
        passed,
        passed ? "Chat request stayed on the conversational path." : "Chat request did not stay on the conversational path.",
        {
          latestRunId: view?.latestRun?.id ?? null,
          pendingClarifications: view?.pendingClarifications.length ?? null,
          latestMessageKind: view?.messages.at(-1)?.messageKind ?? null
        }
      )
    );
  }

  {
    const session = await harness.services.pa.createSession("cli", "Evaluation planning routing");
    const view = await harness.services.pa.postMessage(session.session.id, "We need a release plan that lays out the scope and workstreams for the next release.");
    const passed = Boolean(
      view &&
      view.latestRun === null &&
      view.session.workItemId &&
      view.messages.at(-1)?.messageKind === "plan"
    );
    scenarios.push(
      createScenarioResult(
        "routing-planning",
        "Planning requests draft a plan",
        "routing",
        passed,
        passed ? "Planning request drafted a plan and anchored a work item." : "Planning request did not produce the expected plan path.",
        {
          workItemId: view?.session.workItemId ?? null,
          latestRunId: view?.latestRun?.id ?? null,
          latestMessageKind: view?.messages.at(-1)?.messageKind ?? null
        }
      )
    );
  }

  {
    const session = await harness.services.pa.createSession("cli", "Evaluation execution routing");
    const view = await harness.services.pa.postMessage(session.session.id, "The API is accepting empty slugs and needs server-side slug validation.");
    const runView = view?.latestRun ? await harness.services.runs.get(view.latestRun.id) : null;
    const selectedNames = runView?.delegationDecisions?.map((decision) => decision.specialistName) ?? [];
    const passed = Boolean(
      view?.latestRun &&
      runView?.run.mode === "single_specialist" &&
      selectedNames.length === 1 &&
      selectedNames[0] === "Backend API Specialist"
    );
    scenarios.push(
      createScenarioResult(
        "routing-execution",
        "Concrete execution requests create a routed run",
        "routing",
        passed,
        passed ? "Concrete execution request created a single-specialist run." : "Concrete execution request did not route to the expected run path.",
        {
          runId: view?.latestRun?.id ?? null,
          runMode: runView?.run.mode ?? null,
          selectedSpecialists: selectedNames
        }
      )
    );
  }

  {
    const session = await harness.services.pa.createSession("cli", "Evaluation clarification");
    const view = await harness.services.pa.postMessage(session.session.id, "Something on the codebase needs to be fixed.");
    const passed = Boolean(
      view &&
      view.latestRun === null &&
      view.pendingClarifications.length === 1 &&
      view.clarificationThread?.state === "open" &&
      view.messages.at(-1)?.messageKind === "clarification"
    );
    scenarios.push(
      createScenarioResult(
        "clarification-needed",
        "Ambiguous execution requests trigger clarification",
        "clarification",
        passed,
        passed ? "Ambiguous execution request opened clarification instead of starting a run." : "Ambiguous execution request missed the clarification gate.",
        {
          latestRunId: view?.latestRun?.id ?? null,
          pendingClarifications: view?.pendingClarifications.length ?? null,
          clarificationThreadId: view?.clarificationThread?.id ?? null,
          latestMessageKind: view?.messages.at(-1)?.messageKind ?? null
        }
      )
    );
  }

  {
    const session = await harness.services.pa.createSession("cli", "Evaluation clarification resume");
    await harness.services.pa.postMessage(session.session.id, "Something on the codebase needs to be fixed.");
    const resumed = await harness.services.pa.postMessage(
      session.session.id,
      "Add slug validation to the API so empty slugs are rejected."
    );
    const runView = resumed?.latestRun ? await harness.services.runs.get(resumed.latestRun.id) : null;
    const passed = Boolean(
      resumed?.latestRun &&
      resumed.pendingClarifications.length === 0 &&
      runView?.run.status === "queued"
    );
    scenarios.push(
      createScenarioResult(
        "clarification-resume",
        "Clarification answers resume execution",
        "clarification",
        passed,
        passed ? "Clarification answer resumed execution into a queued run." : "Clarification answer did not resume execution correctly.",
        {
          runId: resumed?.latestRun?.id ?? null,
          runStatus: runView?.run.status ?? null,
          pendingClarifications: resumed?.pendingClarifications.length ?? null
        }
      )
    );
  }

  {
    const session = await harness.services.pa.createSession("cli", "Evaluation specialist single");
    const view = await harness.services.pa.postMessage(session.session.id, "The API is accepting empty slugs and needs server-side slug validation.");
    const runView = view?.latestRun ? await harness.services.runs.get(view.latestRun.id) : null;
    const selectedNames = runView?.delegationDecisions?.map((decision) => decision.specialistName) ?? [];
    const passed = Boolean(
      runView?.run.mode === "single_specialist" &&
      selectedNames.length === 1 &&
      selectedNames[0] === "Backend API Specialist"
    );
    scenarios.push(
      createScenarioResult(
        "specialist-single",
        "Single-domain requests select one best-fit specialist",
        "specialist_selection",
        passed,
        passed ? "Single-domain request selected the backend specialist only." : "Single-domain request selected the wrong specialist set.",
        {
          runId: view?.latestRun?.id ?? null,
          runMode: runView?.run.mode ?? null,
          selectedSpecialists: selectedNames
        }
      )
    );
  }

  {
    const session = await harness.services.pa.createSession("cli", "Evaluation specialist multi");
    const view = await harness.services.pa.postMessage(
      session.session.id,
      "The release needs backend API endpoints plus a dashboard UI to manage the workspace."
    );
    const runView = view?.latestRun ? await harness.services.runs.get(view.latestRun.id) : null;
    const selectedNames = runView?.delegationDecisions?.map((decision) => decision.specialistName) ?? [];
    const passed = Boolean(
      runView?.run.mode === "multi_specialist" &&
      selectedNames.includes("Backend API Specialist") &&
      selectedNames.includes("Frontend Dashboard Specialist") &&
      !selectedNames.includes("Documentation Specialist")
    );
    scenarios.push(
      createScenarioResult(
        "specialist-multi",
        "Cross-domain requests select the right specialist set",
        "specialist_selection",
        passed,
        passed ? "Cross-domain request selected backend and frontend specialists without pulling in docs." : "Cross-domain request selected the wrong specialist mix.",
        {
          runId: view?.latestRun?.id ?? null,
          runMode: runView?.run.mode ?? null,
          selectedSpecialists: selectedNames
        }
      )
    );
  }

  return scenarios;
}

function listMissingRequiredCapabilities(capabilities: ProviderCapabilities) {
  return Object.entries(requiredProviderCapabilities)
    .filter(([capability, required]) => required && !capabilities[capability as keyof typeof requiredProviderCapabilities])
    .map(([capability]) => capability);
}

function getProviderValidationError(run: RunRecord, liveStatus: ProviderStatus): ProviderRunError | null {
  const snapshot = run.providerSnapshot;
  if (!liveStatus.installed) {
    return {
      code: "provider_unavailable",
      message: "The commons-crew provider API is unavailable in the current runner environment. Execution is blocked before task start.",
      remediation: "Verify the provider API key and network connectivity, then retry the run."
    };
  }

  if (snapshot?.authenticated && !liveStatus.authenticated) {
    return {
      code: "provider_auth_stale",
      message: "The stored provider snapshot was authenticated, but the live runner is no longer authenticated.",
      remediation: "Verify the provider API key is still valid and re-supply it through the deployment environment configuration."
    };
  }

  const storedProviderIdentity = snapshot?.capabilities.providerIdentity ?? run.providerIdentity;
  const liveProviderIdentity = liveStatus.capabilities.providerIdentity;
  if (storedProviderIdentity && liveProviderIdentity && storedProviderIdentity !== liveProviderIdentity) {
    return {
      code: "provider_identity_mismatch",
      message: `Run ${run.id} was created for provider identity "${storedProviderIdentity}", but the live runner reports "${liveProviderIdentity}".`,
      remediation: "Re-authenticate the runner to the original provider identity or create a new run for the currently active identity.",
      detail: {
        storedProviderIdentity,
        liveProviderIdentity
      }
    };
  }

  const liveMissingCapabilities = listMissingRequiredCapabilities(liveStatus.capabilities);
  if (liveMissingCapabilities.length > 0) {
    return {
      code: "provider_capability_mismatch",
      message: `The live provider no longer satisfies the execution contract for run ${run.id}: ${liveMissingCapabilities.join(", ")}.`,
      remediation: "Restore the missing provider capabilities or rerun the work with a provider that supports the required execution contract.",
      detail: {
        source: "live_runner",
        missingCapabilities: liveMissingCapabilities
      }
    };
  }

  const persistedMissingCapabilities = snapshot ? listMissingRequiredCapabilities(snapshot.capabilities) : [];
  if (persistedMissingCapabilities.length > 0) {
    return {
      code: "provider_capability_mismatch",
      message: `Run ${run.id} was recorded with provider capabilities that do not satisfy the execution contract: ${persistedMissingCapabilities.join(", ")}.`,
      remediation: "Recreate the run after restoring the provider capability contract or reroute the work to a compatible provider.",
      detail: {
        source: "persisted_snapshot",
        missingCapabilities: persistedMissingCapabilities
      }
    };
  }

  return null;
}

function emitToListeners(event: RunEventRecord) {
  const runListeners = listeners.get(event.runId);
  if (!runListeners) {
    return;
  }
  for (const listener of runListeners) {
    listener(event);
  }
}

function createIncidentEvidence(kind: IncidentEvidenceRecord["kind"], label: string, ref: string): IncidentEvidenceRecord {
  return {
    id: randomUUID(),
    kind,
    label,
    ref,
    retentionPolicy: kind === "run" || kind === "event_stream" ? "workspace_lifetime" : "summary_only",
    capturedAt: now(),
    summary:
      kind === "log"
        ? "Structured-log correlation is retained through stable run and trace identifiers."
        : kind === "metric"
          ? "Metrics correlation is retained as an operator-facing incident reference."
          : kind === "trace"
            ? "Trace correlation is retained through the stable run trace identifier."
            : kind === "diagnostic"
              ? "Operator diagnostics are retained as a stable drill-down endpoint."
              : "Durable runtime state preserves this incident evidence reference."
  };
}

function dedupeIncidentEvidence(evidenceRefs: IncidentEvidenceRecord[]) {
  const seen = new Set<string>();
  return evidenceRefs.filter((entry) => {
    const key = `${entry.kind}:${entry.ref}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildProviderEnvironmentSnapshot(config: AppConfig): ProviderEnvironmentSnapshot {
  return {
    appEnv: config.app.env,
    storageMode: config.storage.mode,
    apiPort: config.ports.api,
    runnerPort: config.ports.runner,
    olfAgentsRoot: config.paths.olfAgentsRoot
  };
}

function buildClarificationView(thread: ClarificationThreadRecord, messages: ClarificationMessageRecord[]): ClarificationThreadView {
  return {
    thread,
    messages: messages.filter((entry) => entry.threadId === thread.id)
  };
}

function buildWorkItemCollaborationView(
  thread: WorkItemCollaborationThreadRecord,
  messages: WorkItemCollaborationMessageRecord[]
): WorkItemCollaborationThreadView {
  return {
    thread,
    messages: messages.filter((entry) => entry.threadId === thread.id)
  };
}

export async function createAppServices(
  config: AppConfig,
  options: AppServicesOptions = {}
) {
  await fs.mkdir(config.paths.artifactsRoot, { recursive: true });
  await fs.mkdir(config.paths.backupsRoot, { recursive: true });
  let shuttingDown = false;
  const provider = options.provider ?? createApiProvider(config);
  const actionExecutor = options.actionExecutor ?? createDefaultActionToolExecutor(config);
  const logger = options.logger;
  const serviceName = options.serviceName ?? config.app.name;
  const serviceStartedAt = now();
  const catalog = new LocalCatalogService(config);
  const store: StateStore =
    config.storage.mode === "postgres"
      ? new PostgresStateStore(config, createDefaultState())
      : new JsonStateStore(config.paths.stateFile, createDefaultState());
  await store.init();
  const promptArtifacts = await loadPromptArtifacts(config.paths.repoRoot);
  const startupTimestamp = now();
  const startupProviderStatus = await provider.getStatus();

  await store.write((state) => ({
    ...state,
    promptGovernance: syncPromptGovernanceState(state.promptGovernance, promptArtifacts, startupTimestamp),
    providerProfiles: syncProviderProfileRecords(
      state.workspace.id,
      startupProviderStatus,
      state.providerProfiles,
      startupTimestamp
    ),
    ...syncConfigProfileRecords(
      state.workspace.id,
      config,
      state.configProfiles,
      state.featureFlags,
      startupTimestamp
    ),
    promptSpecs: syncPromptSpecRecords(state.promptSpecs, promptArtifacts, startupTimestamp),
    migrationRecords: syncMigrationRecords(state.migrationRecords, startupTimestamp, serviceName)
  }));
  validateMigrationRecords((await store.read()).migrationRecords);

  function getToolPolicy(toolId: string): ActionPolicyContract | null {
    return ACTION_TOOL_POLICIES[toolId] ?? null;
  }

  function actionEvidenceLocation(actionId: string, fileName: string) {
    return path.join(config.paths.artifactsRoot, "action-evidence", actionId, fileName);
  }

  function runArtifactRootPath(runId: string) {
    return path.join(config.paths.artifactsRoot, "runs", runId);
  }

  function runWorkspacePath(runId: string) {
    return path.join(runArtifactRootPath(runId), "workspace");
  }

  function actionEvidenceUri(actionId: string, fileName: string) {
    return `evidence://${actionId}/${fileName}`;
  }

  function getActiveProviderProfile(state: PersistentState, providerStatus: ProviderStatus) {
    return (
      state.providerProfiles.find((entry) => entry.status === "active" && entry.providerType === providerStatus.id) ??
      state.providerProfiles.find((entry) => entry.id === buildProviderProfileId(state.workspace.id, providerStatus.id)) ??
      null
    );
  }

  function createArtifactRecord(
    runId: string | null,
    taskId: string | null,
    artifactType: string,
    storagePath: string,
    summary: string,
    evaluationRunId: string | null = null
  ): ArtifactRecord {
    return {
      id: randomUUID(),
      runId,
      taskId,
      evaluationRunId,
      artifactType,
      storagePath,
      summary,
      createdAt: now()
    };
  }

  function createActionEvidenceRef(
    kind: "dry_run_output" | "preflight_output" | "execution_output" | "rollback_instructions" | "rollback_metadata" | "idempotency_collision",
    label: string,
    ref: string,
    capturedAt: string | null
  ): ActionEvidenceReference {
    return {
      kind,
      label,
      ref,
      capturedAt
    };
  }

  function buildApprovalBinding(
    workItemId: string,
    runId: string | null,
    taskId: string | null,
    required: boolean,
    approvalId: string | null = null,
    approvalStatus: "pending" | "approved" | "denied" | "expired" | "not_required" | "not_requested" = required ? "not_requested" : "not_required",
    actionProposalId: string | null = null,
    toolId: string | null = null,
    targetRef: string | null = null,
    expiresAt: string | null = null
  ) {
    return {
      required,
      approvalId,
      status: approvalStatus,
      runId,
      taskId,
      workItemId,
      actionProposalId,
      toolId,
      targetRef,
      expiresAt
    };
  }

  function buildApprovalBindingFromRecord(
    approval: ApprovalRecord | null,
    fallback: {
      workItemId: string;
      runId: string | null;
      taskId: string | null;
      required: boolean;
    }
  ) {
    return buildApprovalBinding(
      fallback.workItemId,
      fallback.runId,
      fallback.taskId,
      fallback.required,
      approval?.id ?? null,
      approval?.status ?? (fallback.required ? "not_requested" : "not_required"),
      approval?.actionProposalId ?? null,
      approval?.toolId ?? null,
      approval?.targetRef ?? null,
      approval?.expiresAt ?? null
    );
  }

  async function writeActionEvidenceArtifact(location: string, payload: unknown) {
    await fs.mkdir(path.dirname(location), { recursive: true });
    if (typeof payload === "string") {
      await fs.writeFile(location, payload, "utf8");
      return;
    }
    await fs.writeFile(location, JSON.stringify(payload, null, 2));
  }

  function buildActionCheck(options: {
    supported: boolean;
    outputRef?: string | null;
    status?: "pending" | "completed" | "unavailable";
    executedAt?: string | null;
    outcome?: string | null;
    unavailableReason?: string | null;
    evidenceRefs?: ActionEvidenceReference[];
  }): ActionCheckRecord {
    return {
      supported: options.supported,
      status: options.status ?? (options.supported ? "pending" : "unavailable"),
      executedAt: options.executedAt ?? null,
      outcome: options.outcome ?? null,
      outputRef: options.outputRef ?? null,
      unavailableReason: options.unavailableReason ?? null,
      evidenceRefs: options.evidenceRefs ?? []
    };
  }

  function buildRollbackRecord(options: {
    supported: boolean;
    preparedAt?: string | null;
    instructionsRef?: string | null;
    metadataRef?: string | null;
    unavailableReason?: string | null;
    evidenceRefs?: ActionEvidenceReference[];
  }): ActionRollbackRecord {
    return {
      supported: options.supported,
      status: options.supported ? "available" : "not_supported",
      preparedAt: options.preparedAt ?? null,
      instructionsRef: options.instructionsRef ?? null,
      metadataRef: options.metadataRef ?? null,
      unavailableReason: options.unavailableReason ?? null,
      evidenceRefs: options.evidenceRefs ?? []
    };
  }

  function trackRunJob(job: Promise<void>) {
    activeRunJobs.add(job);
    void job.finally(() => {
      activeRunJobs.delete(job);
    });
  }

  function logEvent(event: string, fields: LogCorrelationFields = {}, attributes: Record<string, unknown> = {}) {
    logInfo(logger, serviceName, event, fields, attributes);
  }

  function buildRunCorrelation(state: PersistentState, runId: string, extra: LogCorrelationFields = {}) {
    const run = state.runs.find((entry) => entry.id === runId);
    return {
      requestId: run?.requestId ?? null,
      traceId: run?.traceId ?? null,
      sessionId: run?.sessionId ?? null,
      workItemId: run?.workItemId ?? null,
      runId,
      taskId: extra.taskId ?? null,
      providerJobId: extra.providerJobId ?? null,
      approvalId: extra.approvalId ?? null,
      materializationId: extra.materializationId ?? null,
      actionId: extra.actionId ?? null,
      planId: run?.planId ?? null
    };
  }

  function startRunExecution(runId: string, jobId: string) {
    const job = executeRun(runId, jobId);
    trackRunJob(job.catch((error) => {
      if (!shuttingDown) {
        console.error("run execution failed", error);
      }
    }));
  }

  async function appendEvent(runId: string, eventType: string, payload: Record<string, unknown>, taskId: string | null = null, detailLevel: "summary" | "full" = "summary") {
    if (shuttingDown) {
      return;
    }
    const state = await store.read();
    const run = state.runs.find((entry) => entry.id === runId);
    if (!run) {
      return;
    }
    const event: RunEventRecord = {
      id: randomUUID(),
      runId,
      workItemId: run.workItemId,
      taskId,
      eventType,
      detailLevel,
      payload,
      createdAt: now()
    };

    await store.write((state) => ({
      ...state,
      runEvents: [...state.runEvents, event]
    }));

    logEvent(eventType, buildRunCorrelation(state, runId, { taskId }), {
      detailLevel,
      payload
    });
    emitToListeners(event);
  }

  function buildIncidentEvidenceRefs(
    state: PersistentState,
    runId: string | null,
    serviceRef: string | null,
    summary: string,
    status: IncidentStatus
  ) {
    const subject = runId ? `run ${runId}` : `service ${serviceRef ?? "platform"}`;
    const service = serviceRef ?? "pa-api";
    const run = runId ? state.runs.find((entry) => entry.id === runId) ?? null : null;
    const traceId = run?.traceId ?? "service";
    const scopeSuffix = runId ? `?traceId=${encodeURIComponent(traceId)}` : "";
    return dedupeIncidentEvidence([
      createIncidentEvidence(
        "log",
        `Structured logs for ${subject}`,
        runId ? `log://runs/${runId}${scopeSuffix}` : `log://services/${service}`
      ),
      createIncidentEvidence(
        "metric",
        `Metrics snapshot for ${subject}`,
        runId ? `metric://runs/${runId}${scopeSuffix}` : `metric://services/${service}`
      ),
      createIncidentEvidence(
        "trace",
        `Trace correlation for ${subject}`,
        runId ? `trace://runs/${runId}${scopeSuffix}` : `trace://services/${service}`
      ),
      ...(runId
        ? [
            createIncidentEvidence("run", `Run record for ${runId}`, `/api/runs/${runId}`),
            createIncidentEvidence("event_stream", `Run events for ${runId}`, `/api/runs/${runId}/events`)
          ]
        : []),
      createIncidentEvidence("diagnostic", `Operator diagnostics for ${subject}`, `/api/admin/health/diagnostics#${encodeURIComponent(`${service}:${status}:${summary}`)}`)
    ]);
  }

  async function createIncidentRecord(input: {
    runId?: string | null;
    serviceRef?: string | null;
    severity: IncidentSeverity;
    status?: IncidentStatus;
    summary: string;
    evidenceRefs?: IncidentEvidenceRecord[];
  }) {
    if (shuttingDown) {
      return null;
    }
    const state = await store.read();
    const runId = input.runId ?? null;
    const serviceRef = input.serviceRef ?? null;
    if (!runId && !serviceRef) {
      return null;
    }
    if (runId && !state.runs.some((entry) => entry.id === runId)) {
      return null;
    }

    const status = input.status ?? "open";
    const openedAt = now();
    const incident: IncidentRecord = {
      id: randomUUID(),
      workspaceId: state.workspace.id,
      runId,
      serviceRef,
      severity: input.severity,
      status,
      summary: input.summary,
      openedAt,
      resolvedAt: status === "resolved" ? openedAt : null,
      evidenceRefs: dedupeIncidentEvidence([
        ...buildIncidentEvidenceRefs(state, runId, serviceRef, input.summary, status),
        ...(input.evidenceRefs ?? [])
      ]),
      lifecycle: [
        {
          id: randomUUID(),
          status,
          summary: input.summary,
          createdAt: openedAt
        }
      ]
    };

    await store.write((current) => ({
      ...current,
      incidents: [incident, ...current.incidents]
    }));

    return incident;
  }

  async function transitionIncidentRecord(
    incidentId: string,
    status: IncidentStatus,
    summary: string,
    evidenceRefs: IncidentEvidenceRecord[] = [],
    severity?: IncidentSeverity
  ) {
    if (shuttingDown) {
      return null;
    }
    let updatedIncident: IncidentRecord | null = null;
    await store.write((state) => ({
      ...state,
      incidents: state.incidents.map((incident) => {
        if (incident.id !== incidentId) {
          return incident;
        }

        const lastLifecycle = incident.lifecycle.at(-1) ?? null;
        if (incident.status === status && lastLifecycle?.status === status && lastLifecycle.summary === summary) {
          updatedIncident = incident;
          return incident;
        }

        updatedIncident = {
          ...incident,
          severity: severity ?? incident.severity,
          status,
          summary,
          resolvedAt: status === "resolved" ? now() : null,
          evidenceRefs: dedupeIncidentEvidence([
            ...incident.evidenceRefs,
            ...buildIncidentEvidenceRefs(state, incident.runId, incident.serviceRef, summary, status),
            ...evidenceRefs
          ]),
          lifecycle: [
            ...incident.lifecycle,
            {
              id: randomUUID(),
              status,
              summary,
              createdAt: now()
            }
          ]
        };

        return updatedIncident;
      })
    }));

    return updatedIncident;
  }

  async function syncRunIncident(runId: string, status: RunRecord["status"]) {
    if (!["blocked", "failed", "running", "completed", "cancelled"].includes(status)) {
      return null;
    }

    const state = await store.read();
    const activeIncident = state.incidents.find((incident) => incident.runId === runId && incident.status !== "resolved") ?? null;

    if (status === "blocked") {
      if (activeIncident) {
        return await transitionIncidentRecord(activeIncident.id, "open", "Run entered a degraded blocked state and needs operator review.");
      }
      return await createIncidentRecord({
        runId,
        severity: "medium",
        status: "open",
        summary: "Run entered a degraded blocked state and needs operator review."
      });
    }

    if (status === "failed") {
      if (activeIncident) {
        return await transitionIncidentRecord(activeIncident.id, "investigating", "Run failed and needs operator recovery.", [], "high");
      }
      return await createIncidentRecord({
        runId,
        severity: "high",
        status: "investigating",
        summary: "Run failed and needs operator recovery."
      });
    }

    if (status === "running" && activeIncident) {
      return await transitionIncidentRecord(activeIncident.id, "monitoring", "Run resumed and is being monitored for recovery.");
    }

    if (["completed", "cancelled"].includes(status) && activeIncident) {
      return await transitionIncidentRecord(activeIncident.id, "resolved", "Run reached a terminal state and incident evidence remains available for review.");
    }

    return null;
  }

  async function syncCatalogIntoState() {
    const sync = await catalog.sync();
    const entries = await catalog.listEntries();
    await store.write((state) => ({
      ...state,
      catalogSyncs: [sync, ...state.catalogSyncs.filter((entry) => entry.id !== sync.id)],
      catalogEntries: entries
    }));
    return { sync, entries };
  }

  async function ensureCatalog() {
    const state = await store.read();
    if (state.catalogEntries.length > 0) {
      return state.catalogEntries;
    }
    const { entries } = await syncCatalogIntoState();
    return entries;
  }

  async function resolveCatalogSyncForRunCreation() {
    let state = await store.read();
    let activeSync = state.catalogSyncs[0] ?? null;
    if (activeSync) {
      return activeSync;
    }

    await syncCatalogIntoState();
    state = await store.read();
    activeSync = state.catalogSyncs[0] ?? null;
    return activeSync;
  }

  // Stage 1 of intake: narrow the catalog to the specialists worth showing the
  // router. Below a small threshold the whole catalog is cheap to send, so we
  // skip straight to stage 2. Otherwise we ask the provider which domain(s) are
  // relevant and keep only those specialists (capped), so the stage-2 prompt is
  // small no matter how large the catalog grows.
  async function narrowCatalogByDomain(
    entries: CatalogEntry[],
    content: string,
    recentMessages: ReturnType<typeof buildRecentIntakeMessages>
  ): Promise<CatalogEntry[]> {
    if (entries.length <= INTAKE_STAGE1_MIN_CATALOG) {
      return entries;
    }
    const domains = [...new Set(entries.map((entry) => entry.manifest.identity.boundary.domain).filter(Boolean))];
    if (domains.length <= 1) {
      return entries.slice(0, INTAKE_MAX_NARROWED);
    }

    const canonicalByLower = new Map(domains.map((domain) => [domain.toLowerCase(), domain]));
    let selected: string[] = [];
    try {
      const result = await provider.selectIntakeDomains({ message: content, recentMessages, domains });
      selected = (result.domains ?? [])
        .map((domain) => canonicalByLower.get(domain.trim().toLowerCase()))
        .filter((domain): domain is string => Boolean(domain));
    } catch {
      selected = [];
    }

    const selectedSet = new Set(selected);
    let filtered = selectedSet.size
      ? entries.filter((entry) => selectedSet.has(entry.manifest.identity.boundary.domain))
      : [];
    if (filtered.length === 0) {
      // No domain matched (conversational request, or the router abstained). Send
      // a small sample so stage 2 can still classify the request; specialist
      // routing simply won't fire.
      filtered = entries.slice(0, INTAKE_NO_DOMAIN_SAMPLE);
    }
    return filtered.slice(0, INTAKE_MAX_NARROWED);
  }

  async function decideIntake(session: SessionRecord, content: string) {
    const state = await store.read();
    const catalogEntries = await ensureCatalog();
    // Two-stage routing keeps the catalog out of the prompt at scale. The full
    // catalog is hundreds (potentially thousands) of specialists; serializing all
    // of them into one intake prompt produces a payload the provider rejects
    // ("model busy"/oversized). Instead:
    //   Stage 1: show only the distinct domains and pick the relevant one(s).
    //   Stage 2: show only the specialists inside those domains, then decide.
    // Every specialist is still reachable, but each prompt stays small.
    const recentMessages = buildRecentIntakeMessages(state.messages, session.id);
    const narrowedEntries = await narrowCatalogByDomain(catalogEntries, content, recentMessages);
    const decision = await provider.decideIntake({
      session: {
        id: session.id,
        title: session.title,
        surface: session.surface,
        status: session.status
      },
      message: content,
      recentMessages,
      catalog: buildIntakeCatalog(narrowedEntries)
    });

    return {
      decision,
      catalogEntries,
      selection: resolveIntakeSpecialistSelection(catalogEntries, decision.specialistCandidates)
    };
  }

  async function answerChat(session: SessionRecord, content: string) {
    const state = await store.read();
    return await provider.answerChat(buildChatAnswerInput(session, content, state.messages));
  }

  function createProviderSnapshot(
    providerStatus: Awaited<ReturnType<typeof provider.getStatus>>,
    providerProfileId: string | null,
    runId: string | null,
    snapshotId: string
  ): ProviderCapabilitySnapshot {
    return {
      id: snapshotId,
      providerProfileId,
      runId,
      providerId: providerStatus.id,
      providerDisplayName: providerStatus.displayName,
      model: providerStatus.model,
      installed: providerStatus.installed,
      authenticated: providerStatus.authenticated,
      authMode: providerStatus.authMode,
      capabilities: providerStatus.capabilities,
      diagnostics: providerStatus.diagnostics,
      environment: buildProviderEnvironmentSnapshot(config),
      capturedAt: now()
    };
  }

  async function getLatestRunForSession(sessionId: string) {
    const state = await store.read();
    return state.runs.find((run) => run.sessionId === sessionId) ?? null;
  }

  function buildWorkspaceIdentityView(state: PersistentState): WorkspaceIdentityView {
    const memberships = state.workspaceMemberships
      .filter((membership) => membership.workspaceId === state.workspace.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const users = memberships
      .map((membership) => state.users.find((user) => user.id === membership.userId) ?? null)
      .filter((user): user is UserRecord => user !== null);
    const primaryUser =
      state.users.find((user) => user.id === state.workspace.ownerUserId) ??
      users.find((user) => user.role === "primary" && user.status === "active") ??
      state.users[0];

    if (!primaryUser) {
      throw new Error("Workspace is missing a primary user.");
    }

    return {
      workspace: state.workspace,
      users,
      memberships,
      primaryUser
    };
  }

  function requireActiveWorkspaceMember(state: PersistentState, workspaceId: string, userId: string) {
    const membership =
      state.workspaceMemberships.find(
        (entry) => entry.workspaceId === workspaceId && entry.userId === userId && entry.status === "active"
      ) ?? null;
    const user = state.users.find((entry) => entry.id === userId && entry.status === "active") ?? null;
    if (!membership || !user) {
      throw new Error("workspace_membership_required");
    }
    return { membership, user };
  }

  function normalizeSupportUserPermissions(
    permissions?: WorkspaceMembershipRecord["permissions"]
  ): WorkspaceMembershipRecord["permissions"] {
    if (!permissions) {
      return [...DEFAULT_SUPPORT_USER_PERMISSIONS];
    }
    return [...new Set(permissions)].sort();
  }

  function requireWorkspacePermission(
    state: PersistentState,
    workspaceId: string,
    userId: string,
    permission: WorkspaceMembershipRecord["permissions"][number]
  ) {
    const { membership } = requireActiveWorkspaceMember(state, workspaceId, userId);
    if (membership.role === "primary") {
      return membership;
    }
    if (!membership.permissions.includes(permission)) {
      throw new Error("workspace_permission_required");
    }
    return membership;
  }

  function buildWorkItemCollaborationThreads(state: PersistentState, workItemId: string) {
    return state.workItemCollaborationThreads
      .filter((thread) => thread.workItemId === workItemId)
      .map((thread) => buildWorkItemCollaborationView(thread, state.workItemCollaborationMessages));
  }

  async function getPendingApprovalsForSession(sessionId: string) {
    const state = await store.read();
    const runIds = new Set(state.runs.filter((run) => run.sessionId === sessionId).map((run) => run.id));
    return state.approvals.filter((approval) => approval.status === "pending" && runIds.has(approval.runId));
  }

  async function getSessionView(sessionId: string): Promise<SessionView | null> {
    const state = await store.read();
    const session = state.sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return null;
    }
    return {
      session,
      messages: state.messages.filter((entry) => entry.sessionId === sessionId),
      latestRun: state.runs.find((entry) => entry.sessionId === sessionId) ?? null,
      clarificationThread: getOpenClarificationForSession(state, sessionId),
      pendingApprovals: state.approvals.filter((approval) => approval.status === "pending" && state.runs.some((run) => run.id === approval.runId && run.sessionId === sessionId)),
      pendingClarifications: (state.clarifications ?? []).filter((clarification) => clarification.sessionId === sessionId && clarification.status === "pending")
    };
  }

  async function createWorkItem(workspaceId: string, title: string, summary: string): Promise<WorkItemRecord> {
    const timestamp = now();
    const item: WorkItemRecord = {
      id: randomUUID(),
      workspaceId,
      title,
      summary,
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await store.write((state) => ({
      ...state,
      workItems: [item, ...state.workItems]
    }));
    return item;
  }

  async function resolveSessionWorkItem(sessionId: string, content: string) {
    const state = await store.read();
    const session = state.sessions.find((entry) => entry.id === sessionId);
    if (!session) {
      return null;
    }

    const anchoredWorkItemId = findSessionAnchorWorkItemId(state, sessionId);
    const existingWorkItem = anchoredWorkItemId ? state.workItems.find((entry) => entry.id === anchoredWorkItemId) ?? null : null;
    if (existingWorkItem) {
      if (session.workItemId !== existingWorkItem.id) {
        await store.write((current) => ({
          ...current,
          sessions: current.sessions.map((entry) => (entry.id === sessionId ? { ...entry, workItemId: existingWorkItem.id, updatedAt: now() } : entry))
        }));

        return {
          session: {
            ...session,
            workItemId: existingWorkItem.id
          },
          workItem: existingWorkItem
        };
      }

      return {
        session,
        workItem: existingWorkItem
      };
    }

    const workItem = await createWorkItem(session.workspaceId, titleFromMessage(content), content);
    await store.write((current) => ({
      ...current,
      sessions: current.sessions.map((entry) => (entry.id === sessionId ? { ...entry, workItemId: workItem.id, updatedAt: now() } : entry))
    }));

    return {
      session: {
        ...session,
        workItemId: workItem.id
      },
      workItem
    };
  }

  async function createPlan(sessionId: string, content: string) {
    const timestamp = now();
    const anchor = await resolveSessionWorkItem(sessionId, content);
    if (!anchor) {
      return null;
    }
    const state = await store.read();
    const planDraft = await provider.createPlan(buildPlanDraftInput(anchor.session, content, state.messages));
    const nextVersion = state.plans.filter((plan) => plan.sessionId === sessionId).length + 1;
    const plan: PlanRecord = {
      id: randomUUID(),
      sessionId,
      workItemId: anchor.workItem.id,
      version: nextVersion,
      title: planDraft.title.trim() || `Plan v${nextVersion}`,
      summary: planDraft.summary.trim() || content,
      status: "draft",
      lockedAt: null,
      createdAt: timestamp
    };

    const steps = planDraft.steps.map((step, index): PlanStepRecord => ({
      id: randomUUID(),
      planId: plan.id,
      sequence: index + 1,
      title: step.title.trim(),
      description: step.description.trim(),
      status: "pending",
      required: step.required,
      createdAt: timestamp,
      updatedAt: timestamp
    }));

    await store.write((current) => ({
      ...current,
      plans: [plan, ...current.plans],
      planSteps: [...steps, ...current.planSteps]
    }));

    return { plan, steps };
  }

  async function getPlan(planId: string) {
    const state = await store.read();
    const plan = state.plans.find((entry) => entry.id === planId) ?? null;
    if (!plan) {
      return null;
    }
    return {
      plan,
      steps: state.planSteps.filter((entry) => entry.planId === planId)
    };
  }

  async function setTaskStatus(taskId: string, status: TaskRecord["status"]) {
    if (shuttingDown) {
      return;
    }
    await store.write((state) => ({
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              status,
              startedAt: status === "running" && !task.startedAt ? now() : task.startedAt,
              endedAt: ["completed", "failed", "cancelled"].includes(status) ? now() : task.endedAt
            }
          : task
      )
    }));
    await syncTaskRuntimeStatus(taskId, status);
  }

  async function syncTaskRuntimeStatus(taskId: string, status: TaskRecord["status"]) {
    await store.write((state) => {
      const task = state.tasks.find((entry) => entry.id === taskId) ?? null;
      const runtimeId = task?.assignedRuntimeId ?? null;
      if (!runtimeId) {
        return state;
      }

      return {
        ...state,
        agentRuntimes: state.agentRuntimes.map((runtime) =>
          runtime.id === runtimeId
            ? {
                ...runtime,
                status,
                endedAt: ["completed", "failed", "cancelled"].includes(status) ? now() : null
              }
            : runtime
        )
      };
    });
  }

  async function recordTaskExecutionResult(taskId: string, result: TaskExecutionResult) {
    const summary = result.summary.trim();
    const detail = result.detail?.trim() || null;
    await store.write((state) => ({
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              resultSummary: summary,
              resultDetail: detail
            }
          : task
      )
      }));
  }

  async function bindTaskMaterializations(runId: string, materializationsByEntryId: Map<string, MaterializationRecord>) {
    if (materializationsByEntryId.size === 0) {
      return;
    }

    await store.write((state) => ({
      ...state,
      tasks: state.tasks.map((task) => {
        if (task.runId !== runId || !task.assignedAgentId) {
          return task;
        }

        const materialization = materializationsByEntryId.get(task.assignedAgentId);
        if (!materialization) {
          return task;
        }

        return {
          ...task,
          materializationId: materialization.id
        };
      }),
      agentRuntimes: state.agentRuntimes.map((runtime) => {
        if (runtime.runId !== runId || !runtime.agentCatalogEntryId) {
          return runtime;
        }

        const materialization = materializationsByEntryId.get(runtime.agentCatalogEntryId);
        if (!materialization) {
          return runtime;
        }

        return {
          ...runtime,
          agentMaterializationId: materialization.id,
          runtimeMode: "materialized_specialist"
        };
      })
    }));
  }

  async function setRunStatus(runId: string, status: RunRecord["status"]) {
    if (shuttingDown) {
      return;
    }
    await store.write((state) => ({
      ...state,
      runs: state.runs.map((run) =>
        run.id === runId
          ? {
              ...run,
              status,
              endedAt: ["completed", "failed", "cancelled"].includes(status) ? now() : run.endedAt
            }
          : run
      )
    }));
    await syncRunIncident(runId, status);
  }

  async function failRunForProvider(run: RunRecord, failure: ProviderRunError, taskId: string | null = null, jobId: string | null = null) {
    const failureCode: RunnerJobFailureCode =
      failure.code === "provider_unavailable"
        ? "provider_unavailable"
        : failure.code === "provider_auth_stale" || failure.code === "provider_identity_mismatch" || failure.code === "provider_capability_mismatch"
          ? "dispatch_failed"
          : "unknown";

    await store.write((state) => ({
      ...state,
      messages: [
        ...state.messages,
        {
          id: randomUUID(),
          sessionId: run.sessionId,
          authorType: "pa",
          content: `${failure.message} ${failure.remediation}`,
          messageKind: "warning",
          createdAt: now()
        }
      ]
    }));

    await failRun(run.id, jobId, buildRunnerJobFailure(failureCode, failure.message, true, {
      remediation: failure.remediation,
      ...(failure.detail ?? {})
    }), taskId);
  }

  function getRunnerJobForRun(state: PersistentState, runId: string) {
    return state.runnerJobs.find((job) => job.runId === runId) ?? null;
  }

  function defaultControlReason(action: "pause" | "resume" | "cancel") {
    if (action === "pause") {
      return "Paused by operator request.";
    }
    if (action === "resume") {
      return "Resumed by operator request.";
    }
    return "Cancelled by operator request.";
  }

  function runControlError(message: string) {
    return {
      error: {
        code: "run_control_conflict",
        message,
        retryable: false
      }
    };
  }

  function buildRunnerJobFailure(code: RunnerJobFailureCode, message: string, retryable: boolean, detail: Record<string, unknown> = {}): RunnerJobFailure {
    return {
      code,
      message,
      retryable,
      detail,
      reportedAt: now()
    };
  }

  async function transitionRunnerJob(jobId: string, nextStatus: RunnerJobStatus, options: { failure?: RunnerJobFailure | null; runnerId?: string | null } = {}) {
    const state = await store.read();
    const job = state.runnerJobs.find((entry) => entry.id === jobId) ?? null;
    if (!job) {
      return null;
    }
    if (job.status !== nextStatus && !canTransitionRunnerJobStatus(job.status, nextStatus)) {
      return null;
    }

    const timestamp = now();
    const nextJob: RunnerJobRecord = {
      ...job,
      status: nextStatus,
      attemptCount: nextStatus === "claimed" ? job.attemptCount + 1 : job.attemptCount,
      runnerId: options.runnerId === undefined ? job.runnerId : options.runnerId,
      claimedAt: nextStatus === "claimed" ? timestamp : job.claimedAt,
      startedAt: nextStatus === "running" && !job.startedAt ? timestamp : job.startedAt,
      blockedAt: nextStatus === "blocked" ? timestamp : job.blockedAt,
      endedAt: ["completed", "failed", "cancelled"].includes(nextStatus) ? timestamp : job.endedAt,
      lastHeartbeatAt: nextStatus === "running" ? timestamp : job.lastHeartbeatAt,
      failure: options.failure === undefined ? job.failure : options.failure,
      updatedAt: timestamp
    };

    if (nextStatus === "queued") {
      nextJob.runnerId = null;
      nextJob.failure = options.failure ?? null;
    }

    await store.write((current) => ({
      ...current,
      runnerJobs: current.runnerJobs.map((entry) => (entry.id === jobId ? nextJob : entry))
    }));

    return nextJob;
  }

  async function failRun(runId: string, jobId: string | null, failure: RunnerJobFailure, taskId: string | null = null) {
    const state = await store.read();
    const activeTask = taskId
      ? state.tasks.find((task) => task.id === taskId) ?? null
      : state.tasks.find((task) => task.runId === runId && ["running", "blocked", "queued"].includes(task.status)) ?? null;

    if (activeTask) {
      await setTaskStatus(activeTask.id, "failed");
    }

    await setRunStatus(runId, "failed");
    if (jobId) {
      await transitionRunnerJob(jobId, "failed", { failure });
      await appendEvent(runId, "runner.job.failed", {
        jobId,
        code: failure.code,
        retryable: failure.retryable,
        message: failure.message,
        ...failure.detail
      }, activeTask?.id ?? null);
    }
    await appendEvent(runId, "run.failed", {
      runId,
      code: failure.code,
      retryable: failure.retryable,
      message: failure.message,
      ...failure.detail
    }, activeTask?.id ?? null);
  }

  function buildGovernedToolDefinitions(allowSideEffects: boolean): ProviderToolDefinition[] {
    const defs: ProviderToolDefinition[] = [
      {
        name: "inspect_workspace",
        description: "List the entries in a workspace directory. Pass path 'workspace' for the root, or a relative subdirectory path.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative directory path, or 'workspace' for the root." } },
          required: []
        }
      },
      {
        name: "read_file",
        description: "Read a UTF-8 text file from the workspace and return its contents.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative file path." } },
          required: ["path"]
        }
      },
      {
        name: "write_file",
        description: "Create or overwrite a file with the given full contents. This is a governed, recorded change.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative file path." },
            content: { type: "string", description: "The complete new file contents." }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "edit_file",
        description: "Replace the first exact occurrence of `old` with `new` in an existing file. This is a governed, recorded change.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative file path." },
            old: { type: "string", description: "Exact text to find (first occurrence)." },
            new: { type: "string", description: "Replacement text." }
          },
          required: ["path", "old", "new"]
        }
      }
    ];
    if (allowSideEffects) {
      defs.push({
        name: "run_command",
        description: "Run a shell command in the workspace and return its combined stdout/stderr. Use for builds, tests, installs, and other executions. This is an approval-gated side effect.",
        parameters: {
          type: "object",
          properties: { command: { type: "string", description: "The shell command to run." } },
          required: ["command"]
        }
      });
    }
    return defs;
  }

  function safeParseToolArgs(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  async function readActionExecutionEvidence(actionId: string): Promise<{ outcome?: string; payload?: unknown } | null> {
    try {
      const location = actionEvidenceLocation(actionId, "execution-evidence.json");
      const raw = await fs.readFile(location, "utf8");
      const parsed = JSON.parse(raw) as { execution?: { outcome?: string; payload?: unknown } };
      return parsed.execution ?? null;
    } catch {
      return null;
    }
  }

  // Mint an already-approved approval bound to this run/task/tool/target so a
  // class_c tool call can execute. Only ever called when the task itself is
  // approved for side effects (i.e. a human already cleared this task via the
  // task-level approval gate), so each governed action stays individually
  // evidenced without a fresh human round-trip mid-loop.
  async function mintApprovedApproval(run: RunRecord, task: TaskRecord, toolId: string, targetRef: string): Promise<void> {
    const timestamp = now();
    const approval: ApprovalRecord = {
      id: randomUUID(),
      runId: run.id,
      taskId: task.id,
      workItemId: run.workItemId,
      requestedByRuntimeId: "pa-runtime",
      actionSummary: `${toolId} on ${targetRef}`.slice(0, 200),
      impactScope: "real_world",
      actionProposalId: null,
      toolId,
      targetRef,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      status: "approved",
      decisionComment: "Task was granted side-effect approval; auto-approved for governed tool execution.",
      requestedAt: timestamp,
      decidedAt: timestamp
    };
    await store.write((current) => ({
      ...current,
      approvals: [approval, ...current.approvals]
    }));
  }

  type GovernedToolCallOutcome = { ok: boolean; targetRef: string; outcome: string; payload: unknown };

  async function runGovernedToolCall(
    run: RunRecord,
    task: TaskRecord,
    allowSideEffects: boolean,
    toolId: string,
    args: Record<string, unknown>,
    idempotencyKey: string
  ): Promise<GovernedToolCallOutcome> {
    const policy = getToolPolicy(toolId);
    let targetRef: string;
    if (toolId === "run_command") {
      targetRef = typeof args.command === "string" ? args.command : "";
    } else if (toolId === "inspect_workspace") {
      targetRef = typeof args.path === "string" && args.path.trim() ? args.path : "workspace";
    } else {
      targetRef = typeof args.path === "string" ? args.path : "";
    }

    if (!policy) {
      return { ok: false, targetRef, outcome: "tool_not_allowed", payload: { error: `Tool ${toolId} is not permitted by the action policy contract.` } };
    }
    if (!targetRef.trim()) {
      return { ok: false, targetRef, outcome: "missing_argument", payload: { error: `Tool ${toolId} was called without its required path/command argument.` } };
    }

    if (policy.requiresApproval) {
      if (!allowSideEffects) {
        return {
          ok: false,
          targetRef,
          outcome: "approval_required",
          payload: { error: `${toolId} is a side effect that requires approval, which this task has not been granted. Complete the task without it.` }
        };
      }
      await mintApprovedApproval(run, task, toolId, targetRef);
    }

    const proposal = await actions.createProposal({
      workItemId: run.workItemId,
      runId: run.id,
      taskId: task.id,
      toolId,
      actionClass: policy.actionClass,
      targetRef,
      actionSummary: `${toolId} on ${targetRef}`.slice(0, 200),
      idempotencyKey,
      toolPayload: args
    });
    if ("error" in proposal) {
      return { ok: false, targetRef, outcome: "proposal_rejected", payload: { error: proposal.error.message } };
    }

    const execResult = await actions.execute(proposal.id);
    if (!execResult || "error" in execResult) {
      const message = execResult && "error" in execResult ? execResult.error.message : "Action execution failed.";
      return { ok: false, targetRef, outcome: "execution_failed", payload: { error: message } };
    }

    const evidence = await readActionExecutionEvidence(proposal.id);
    const outcome = typeof evidence?.outcome === "string" ? evidence.outcome : "completed";
    const ok = !outcome.includes("failed");
    return { ok, targetRef, outcome, payload: evidence?.payload ?? {} };
  }

  // The governed tool loop: task execution that actually ACTS. A materialized
  // specialist reads/writes/runs in the real workspace by proposing tool calls;
  // the runtime executes each one through its governed action machinery
  // (proposal -> policy check -> approval gate -> executor -> evidence) and feeds
  // the result back until the specialist stops calling tools and returns its
  // final summary. class_a/class_b tools run autonomously; class_c (run_command)
  // is only offered when the task is approved for side effects.
  async function executeTaskWithGovernedTools(
    input: TaskExecutionInput,
    run: RunRecord,
    task: TaskRecord
  ): Promise<TaskExecutionResult> {
    const allowSideEffects = input.task.approvedForSideEffects;
    const tools = buildGovernedToolDefinitions(allowSideEffects);

    const specialistPrompt = input.materializedSpecialist?.systemPrompt?.trim() || "You are a governed commons-crew specialist.";
    const specialistInstructions = input.materializedSpecialist?.instructions?.trim() ?? "";
    const systemPrompt = [
      specialistPrompt,
      specialistInstructions,
      "You are executing a single task by USING TOOLS to act on a real workspace — not by describing what should be done.",
      "Inspect and read what you need, then make the actual changes with write_file / edit_file, and (when available) run_command.",
      allowSideEffects
        ? "run_command is available for this task; use it for builds, tests, and other executions."
        : "run_command is NOT available for this task. Do all work with file reads/writes and do not rely on executing commands.",
      "Every tool call is governed and recorded as evidence. Make real, minimal, correct changes.",
      "When the task is fully complete, reply with a final plain-text message (and NO tool calls) that summarizes exactly what you changed."
    ]
      .filter(Boolean)
      .join("\n\n");

    const priorText = input.priorCompletedTasks.length
      ? `Prior completed tasks in this run:\n${input.priorCompletedTasks.map((entry) => `- ${entry.name}: ${entry.summary}`).join("\n")}`
      : "No prior tasks have completed in this run yet.";
    const userContent = [
      `Run objective: ${input.run.summary}`,
      `Your task: ${input.task.name}`,
      input.task.description ? `Task details: ${input.task.description}` : "",
      priorText,
      "The workspace root is the current directory; use relative paths."
    ]
      .filter(Boolean)
      .join("\n\n");

    const messages: ProviderToolLoopMessage[] = [{ role: "user", content: userContent }];
    const actionsTaken: string[] = [];
    let finalText: string | null = null;
    const maxSteps = 24;

    for (let step = 0; step < maxSteps; step++) {
      const response = await provider.proposeToolCalls({ systemPrompt, messages, tools });
      if (!response.toolCalls.length) {
        finalText = response.content;
        break;
      }

      messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });

      for (const call of response.toolCalls) {
        const args = safeParseToolArgs(call.arguments);
        const idempotencyKey = `${task.id}:${step}:${call.id}`;
        const result = await runGovernedToolCall(run, task, allowSideEffects, call.name, args, idempotencyKey);
        actionsTaken.push(`${call.name} ${result.targetRef} -> ${result.outcome}`);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: JSON.stringify({ ok: result.ok, outcome: result.outcome, ...(result.payload as Record<string, unknown>) }).slice(0, 8000)
        });
        await appendEvent(
          run.id,
          "task.tool_call",
          { taskId: task.id, tool: call.name, targetRef: result.targetRef, outcome: result.outcome, ok: result.ok },
          task.id
        );
      }
    }

    const summary =
      finalText?.trim() ||
      (actionsTaken.length ? `Completed the task via ${actionsTaken.length} governed tool action(s).` : "Task completed with no changes required.");
    const detail = actionsTaken.length ? actionsTaken.join("\n") : finalText?.trim() ? null : "No tools were used.";
    return { summary, detail };
  }

  async function executeRun(runId: string, jobId: string) {
    if (shuttingDown) {
      return;
    }
    const state = await store.read();
    const run = state.runs.find((entry) => entry.id === runId);
    const job = state.runnerJobs.find((entry) => entry.id === jobId);
    if (!run || !job || terminalRunStatuses.has(run.status) || run.status === "awaiting_clarification") {
      return;
    }

    if (run.status === "paused") {
      return;
    }

    const hasProviderBindingEvent = state.runEvents.some((event) => event.runId === runId && event.eventType === "run.provider_snapshot.bound");
    if (!hasProviderBindingEvent) {
      await appendEvent(
        runId,
        "run.provider_snapshot.bound",
        {
          providerId: run.providerSnapshot.providerId,
          model: run.providerSnapshot.model,
          authenticated: run.providerSnapshot.authenticated,
          diagnostics: run.providerSnapshot.diagnostics,
          capturedAt: run.providerSnapshot.capturedAt
        },
        null,
        "full"
      );
    }

    const tasks = sortExecutionTasks(state.tasks.filter((task) => task.runId === runId));
    const nextTask = tasks.find((task) => task.status === "queued" || task.status === "blocked");

    if (!nextTask) {
      const catalogEntries = await ensureCatalog();
      const synthesisInput = buildRunResultSynthesisInput(await store.read(), runId, catalogEntries);
      if (!synthesisInput) {
        throw new Error(`Unable to synthesize final result for missing run ${runId}.`);
      }
      const synthesizedResult = await provider.synthesizeRunResult(synthesisInput);
      await store.write((current) => ({
        ...current,
        runs: current.runs.map((entry) =>
          entry.id === runId
            ? {
                ...entry,
                summary: synthesizedResult.summary
              }
            : entry
        ),
        runnerJobs: current.runnerJobs.map((entry) =>
          entry.id === jobId
            ? {
                ...entry,
                payload: {
                  ...entry.payload,
                  summary: synthesizedResult.summary
                },
                updatedAt: now()
              }
            : entry
        )
      }));
      if (shuttingDown) {
        return;
      }
      await transitionRunnerJob(jobId, "completed", { runnerId: job.runnerId });
      if (shuttingDown) {
        return;
      }
      await appendEvent(runId, "runner.job.completed", { jobId, runnerId: job.runnerId, traceId: job.payload.traceId });
      if (shuttingDown) {
        return;
      }
      await appendEvent(runId, "run.completed", {
        runId,
        summary: synthesizedResult.summary,
        delegationPlan: buildTaskDelegationPlan(tasks, catalogEntries)
      });
      if (shuttingDown) {
        return;
      }
      await setRunStatus(runId, "completed");
      if (shuttingDown) {
        return;
      }
      const assistantMessage: MessageRecord = {
        id: randomUUID(),
        sessionId: run.sessionId,
        authorType: "pa",
        content: synthesizedResult.content,
        messageKind: "result",
        createdAt: now()
      };
      await store.write((current) => ({
        ...current,
        messages: [...current.messages, assistantMessage]
      }));
      return;
    }

    const providerStatus = await provider.getStatus();
    const providerValidationError = getProviderValidationError(run, providerStatus);
    if (providerValidationError) {
      await failRunForProvider(run, providerValidationError, nextTask.id, jobId);
      return;
    }

    if (nextTask.approvalRequired) {
      const pendingApproval = state.approvals.find((approval) => approval.taskId === nextTask.id && approval.status === "pending");
      const approved = state.approvals.find((approval) => approval.taskId === nextTask.id && approval.status === "approved");
      if (pendingApproval) {
        if (shuttingDown) {
          return;
        }
        await setTaskStatus(nextTask.id, "blocked");
        if (shuttingDown) {
          return;
        }
        await setRunStatus(runId, "blocked");
        await transitionRunnerJob(jobId, "blocked", { runnerId: job.runnerId });
        await appendEvent(runId, "runner.job.blocked", { jobId, approvalId: pendingApproval.id, traceId: job.payload.traceId }, nextTask.id);
        if (shuttingDown) {
          return;
        }
        await appendEvent(runId, "run.blocked_for_approval", { approvalId: pendingApproval.id }, nextTask.id);
        return;
      }
      const deniedApproval = state.approvals.find((approval) => approval.taskId === nextTask.id && approval.status === "denied");
      if (deniedApproval) {
        await setTaskStatus(nextTask.id, "blocked");
        await setRunStatus(runId, "blocked");
        await transitionRunnerJob(jobId, "blocked", { runnerId: job.runnerId });
        await appendEvent(runId, "runner.job.blocked", { jobId, approvalId: deniedApproval.id, traceId: job.payload.traceId }, nextTask.id);
        await appendEvent(runId, "run.blocked_for_denial", { approvalId: deniedApproval.id, taskId: nextTask.id }, nextTask.id);
        return;
      }
      if (!approved) {
        const approval: ApprovalRecord = {
          id: randomUUID(),
          runId,
          taskId: nextTask.id,
          workItemId: run.workItemId,
          requestedByRuntimeId: "pa-runtime",
          actionSummary: nextTask.description,
          impactScope: "real_world",
          actionProposalId: null,
          toolId: null,
          targetRef: null,
          expiresAt: null,
          status: "pending",
          decisionComment: null,
          requestedAt: now(),
          decidedAt: null
        };
        await store.write((current) => ({
          ...current,
          approvals: [approval, ...current.approvals]
        }));
        if (shuttingDown) {
          return;
        }
        await setTaskStatus(nextTask.id, "blocked");
        if (shuttingDown) {
          return;
        }
        await setRunStatus(runId, "blocked");
        await transitionRunnerJob(jobId, "blocked", { runnerId: job.runnerId });
        await appendEvent(runId, "runner.job.blocked", { jobId, approvalId: approval.id, traceId: job.payload.traceId }, nextTask.id);
        if (shuttingDown) {
          return;
        }
        await appendEvent(runId, "approval.requested", { approvalId: approval.id, taskId: nextTask.id }, nextTask.id);
        return;
      }
    }

    if (shuttingDown) {
      return;
    }
    await setRunStatus(runId, "running");
    if (shuttingDown) {
      return;
    }
    await setTaskStatus(nextTask.id, "running");
    if (shuttingDown) {
      return;
    }
    const catalogEntries = await ensureCatalog();
    const session = state.sessions.find((entry) => entry.id === run.sessionId) ?? null;
    if (!session) {
      await failRun(runId, jobId, buildRunnerJobFailure("execution_error", "Runner execution failed because the session context is missing.", false, { runId }), nextTask.id);
      return;
    }
    const assignedEntry = nextTask.assignedAgentId ? catalogEntries.find((entry) => entry.id === nextTask.assignedAgentId) ?? null : null;
    await appendEvent(runId, "task.started", {
      taskId: nextTask.id,
      name: nextTask.name,
      assignedAgentId: nextTask.assignedAgentId,
      assignedRuntimeId: nextTask.assignedRuntimeId ?? null,
      materializationId: nextTask.materializationId ?? null,
      assignedAgentName: assignedEntry?.name ?? null,
      assignedAgentDomain: assignedEntry?.manifest.identity.boundary.domain ?? null,
      handoffContext: nextTask.description
    }, nextTask.id);
    if (shuttingDown) {
      return;
    }
    const taskExecutionInput = await buildTaskExecutionInput(state, session, run, nextTask, catalogEntries);
    const taskJob = (async () => {
      const specialistExecutionMode = resolveSpecialistExecutionMode(config, taskExecutionInput);
      const executionResult =
        specialistExecutionMode === "worker_container"
          ? await executeTaskInWorkerContainer(config, taskExecutionInput)
          : specialistExecutionMode === "isolated_subprocess"
            ? await executeTaskInSubprocess(config, taskExecutionInput)
            : await executeTaskWithGovernedTools(taskExecutionInput, run, nextTask);
      if (shuttingDown) {
        return;
      }

      await recordTaskExecutionResult(nextTask.id, executionResult);
      await setTaskStatus(nextTask.id, "completed");
      if (shuttingDown) {
        return;
      }

      await appendEvent(runId, "task.completed", {
        taskId: nextTask.id,
        name: nextTask.name,
        assignedAgentId: nextTask.assignedAgentId,
        assignedRuntimeId: nextTask.assignedRuntimeId ?? null,
        materializationId: nextTask.materializationId ?? null,
        assignedAgentName: assignedEntry?.name ?? null,
        assignedAgentDomain: assignedEntry?.manifest.identity.boundary.domain ?? null,
        handoffContext: nextTask.description,
        executionSummary: executionResult.summary,
        executionDetail: executionResult.detail
      }, nextTask.id);
      if (shuttingDown) {
        return;
      }

      const refreshedRun = (await store.read()).runs.find((entry) => entry.id === runId) ?? null;
      if (!refreshedRun || refreshedRun.status === "paused" || terminalRunStatuses.has(refreshedRun.status)) {
        return;
      }

      await executeRun(runId, jobId);
    })();

    trackRunJob(taskJob.catch(async (error) => {
      const failure = buildRunnerJobFailure("execution_error", error instanceof Error ? error.message : "Runner execution failed.", true, { taskId: nextTask.id });
      await failRun(runId, jobId, failure, nextTask.id);
    }));
  }

  async function restoreActiveRuns() {
    const initialState = await store.read();
    const interruptedTasks = initialState.tasks.filter((task) => task.status === "running");
    const interruptedRuns = initialState.runs.filter((run) => run.status === "running");
    const interruptedJobs = (initialState.runnerJobs ?? []).filter((job) => ["claimed", "running"].includes(job.status));
    if (shuttingDown) {
      return;
    }
    await store.write((state) => ({
      ...state,
      tasks: state.tasks.map((task) =>
        task.status === "running"
          ? {
              ...task,
              status: "queued",
              startedAt: null
            }
          : task
      ),
      runs: state.runs.map((run) =>
        run.status === "running"
          ? {
              ...run,
              status: "queued"
            }
          : run
      ),
      runnerJobs: (state.runnerJobs ?? []).map((job) =>
        ["claimed", "running"].includes(job.status)
          ? {
              ...job,
              status: "queued",
              runnerId: null,
              updatedAt: now()
            }
            : job
      )
    }));

    for (const task of interruptedTasks) {
      await appendEvent(
        task.runId,
        "task.interrupted",
        {
          taskId: task.id,
          recoveryOrigin: "runner_restart",
          recoveryStrategy: "requeue_from_start"
        },
        task.id
      );
    }

    for (const run of interruptedRuns) {
      await appendEvent(run.id, "run.recovered", {
        runId: run.id,
        recoveryOrigin: "runner_restart",
        recoveryStrategy: "resume_from_queued_work",
        interruptedTaskIds: interruptedTasks.filter((task) => task.runId === run.id).map((task) => task.id)
      });
    }

    for (const job of interruptedJobs) {
      await appendEvent(job.runId, "runner.job.requeued", {
        jobId: job.id,
        recoveryOrigin: "runner_restart",
        recoveryStrategy: "requeue_for_claim",
        traceId: job.payload.traceId
      });
    }

    // queued runner jobs are resumed when a runner explicitly claims them
  }

  async function resolveRunPlanAndWorkItem(sessionId: string, content: string) {
    const state = await store.read();
    const activePlan = state.plans.find((plan) => plan.sessionId === sessionId && plan.status === "locked") ?? null;
    if (activePlan) {
      return {
        plan: activePlan,
        workItemId: activePlan.workItemId
      };
    }

    const workItem = await createWorkItem(state.workspace.id, titleFromMessage(content), content);
    return {
      plan: null,
      workItemId: workItem.id
    };
  }

  async function createClarificationThread(sessionId: string, runId: string | null, blockingReason: string) {
    const state = await store.read();
    const session = state.sessions.find((entry) => entry.id === sessionId);
    const run = runId ? state.runs.find((entry) => entry.id === runId) : null;
    const plan = run?.planId ? state.plans.find((entry) => entry.id === run.planId) ?? null : null;
    const timestamp = now();

    const thread: ClarificationThreadRecord = {
      id: randomUUID(),
      sessionId,
      planId: plan?.id ?? null,
      runId: run?.id ?? null,
      title: runId ? `Clarification required for run ${runId}` : "Clarification required for request",
      state: "open",
      status: "open",
      blockingReason,
      createdAt: timestamp,
      openedAt: timestamp,
      resolvedAt: null,
      sessionStatusBefore: session?.status ?? "active",
      planStatusBefore: plan?.status ?? null,
      runStatusBefore: run?.status ?? null
    };

    await store.write((current) => ({
      ...current,
      clarificationThreads: [thread, ...current.clarificationThreads],
      sessions: current.sessions.map((entry) =>
        entry.id === sessionId
          ? {
              ...entry,
              status: "awaiting_clarification",
              updatedAt: timestamp
            }
          : entry
      ),
      runs: run
        ? current.runs.map((entry) =>
            entry.id === run.id
              ? {
                  ...entry,
                  status: "awaiting_clarification"
                }
              : entry
          )
        : current.runs
    }));

    return thread;
  }

  async function closeClarificationThread(threadId: string) {
    await store.write((state) => ({
      ...state,
      clarificationThreads: state.clarificationThreads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              state: "resolved",
              status: "resolved",
              resolvedAt: now()
            }
          : thread
      )
    }));
  }

  async function createRunFromRequest(
    session: SessionRecord,
    request: RequestRecord,
    content: string,
    specialistSelection: {
      selectedEntries: CatalogEntry[];
      candidatesByEntryId: Map<string, IntakeSpecialistCandidate>;
    },
    options: {
      blockedForClarification?: boolean;
      blockingReason?: string | null;
      traceId?: string;
      planIdOverride?: string | null;
      workItemIdOverride?: string | null;
      rerunSourceRunId?: string | null;
      rerunTriggeredBy?: "operator" | null;
    } = {}
  ) {
    const blockedForClarification = options.blockedForClarification ?? false;
    const providerStatus = await provider.getStatus();
    const selectedCatalogEntries = specialistSelection.selectedEntries;
    const pinnedCatalogSync = await resolveCatalogSyncForRunCreation();
    const resolvedBudgetProfile = resolveBudgetProfileForRun();
    const stateForProvider = await store.read();
    const activeProviderProfile = getActiveProviderProfile(stateForProvider, providerStatus);
    const anchor = options.workItemIdOverride
      ? {
          workItem: (stateForProvider.workItems.find((entry) => entry.id === options.workItemIdOverride) ?? null)
        }
      : await resolveSessionWorkItem(session.id, content);
    if (!anchor || !pinnedCatalogSync) {
      return null;
    }
    if (!anchor.workItem) {
      return null;
    }
    const workItem = anchor.workItem;
    const stateForPlan = await store.read();
    const activePlan = options.planIdOverride
      ? stateForPlan.plans.find((plan) => plan.id === options.planIdOverride) ?? null
      : stateForPlan.plans.find((plan) => plan.sessionId === session.id && plan.status === "locked" && plan.workItemId === workItem.id) ?? null;
    const runId = randomUUID();
    const providerSnapshotId = randomUUID();
    const providerSnapshot = createProviderSnapshot(
      providerStatus,
      activeProviderProfile?.id ?? null,
      runId,
      providerSnapshotId
    );
    const artifactRootPath = runArtifactRootPath(runId);
    const workspacePath = runWorkspacePath(runId);
    await ensureSharedWritableDirectory(artifactRootPath);
    await ensureSharedWritableDirectory(workspacePath);
    const run: RunRecord = {
      id: runId,
      workspaceId: session.workspaceId,
      workItemId: workItem.id,
      sessionId: session.id,
      requestId: request.id,
      traceId: options.traceId ?? randomUUID(),
      planId: activePlan?.id ?? null,
      catalogSyncRunId: pinnedCatalogSync.id,
      budgetProfileId: resolvedBudgetProfile.id,
      rerunSourceRunId: options.rerunSourceRunId ?? null,
      rerunTriggeredBy: options.rerunTriggeredBy ?? null,
      workspacePath,
      artifactRootPath,
      status: blockedForClarification ? "awaiting_clarification" : "queued",
      mode: selectRunMode(selectedCatalogEntries, providerSnapshot),
      summary: renderPromptTemplate(promptArtifacts.pa.templates.runSummary, { content }),
      providerProfileId: activeProviderProfile?.id ?? null,
      providerCapabilitySnapshotId: providerSnapshotId,
      providerIdentity: providerSnapshot.capabilities.providerIdentity,
      providerSnapshot,
      startedAt: now(),
      endedAt: null
    };

    const taskTemplates = buildExecutionTasksFromArtifacts(promptArtifacts.specialist, content);
    const selectedTasks = buildExecutionTasksForSelectedAgents(content, taskTemplates, selectedCatalogEntries);
    const runtimes: AgentRuntimeRecord[] = [];
    let tasks = selectedTasks.map((task): TaskRecord => {
      const taskRecord: TaskRecord = {
        id: randomUUID(),
        runId: run.id,
        parentTaskId: null,
        name: task.name,
        description: task.description,
        status: "queued",
        assignedAgentId: task.assignedAgentId,
        assignedRuntimeId: null,
        materializationId: null,
        taskKind: task.taskKind,
        approvalRequired: task.approvalRequired,
        resultSummary: null,
        resultDetail: null,
        startedAt: null,
        endedAt: null
      };
      const runtime = buildTaskRuntimeRecord(run, taskRecord);
      runtimes.push(runtime);
      taskRecord.assignedRuntimeId = runtime.id;
      return taskRecord;
    });
    const delegationDecisions = buildDelegationDecisions(
      run.id,
      content,
      selectedCatalogEntries,
      specialistSelection.candidatesByEntryId,
      promptArtifacts.specialist.templates.delegationReasonSummary
    );

    const links: TaskPlanLinkRecord[] = activePlan
      ? (await getPlan(activePlan.id))!.steps.slice(0, tasks.length).map((step, index) => ({
          id: randomUUID(),
          taskId: tasks[index].id,
          planStepId: step.id,
          linkType: "fulfills",
          createdAt: now()
        }))
      : [];

    const runnerJob: RunnerJobRecord = {
      id: randomUUID(),
      runId: run.id,
      queueName: "runner",
      status: blockedForClarification ? "blocked" : "queued",
      payload: {
        contractVersion: "runner_job.v1",
        runId: run.id,
        requestId: request.id,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workItemId: workItem.id,
        traceId: run.traceId,
        catalogSyncRunId: run.catalogSyncRunId,
        budgetProfileId: run.budgetProfileId,
        workspacePath: run.workspacePath,
        artifactRootPath: run.artifactRootPath,
        providerIdentity: run.providerIdentity,
        mode: run.mode,
        summary: run.summary,
        createdAt: now()
      },
      attemptCount: 0,
      maxAttempts: resolvedBudgetProfile.retryCeiling,
      runnerId: null,
      claimedAt: null,
      startedAt: null,
      blockedAt: blockedForClarification ? now() : null,
      endedAt: null,
      lastHeartbeatAt: null,
      failure: null,
      createdAt: now(),
      updatedAt: now()
    };

    await store.write((state) => ({
      ...state,
      providerCapabilitySnapshots: [providerSnapshot, ...state.providerCapabilitySnapshots],
      runs: [run, ...state.runs],
      tasks: [...tasks, ...state.tasks],
      agentRuntimes: [...runtimes, ...state.agentRuntimes],
      taskPlanLinks: [...links, ...state.taskPlanLinks],
      runnerJobs: [runnerJob, ...state.runnerJobs],
      delegationDecisions: [
        ...delegationDecisions,
        ...state.delegationDecisions
      ]
    }));

    let materializationFailure: MaterializationRecord | null = null;
    const materializationsByEntryId = new Map<string, MaterializationRecord>();
    for (const entry of selectedCatalogEntries.filter((catalogEntry) => catalogEntry.readinessState === "definition_only")) {
      const materialization = await createMaterialization(entry.id, run.id);
      if (materialization) {
        materializationsByEntryId.set(entry.id, materialization);
      }
      if (materialization?.status === "failed") {
        materializationFailure = materialization;
        break;
      }
    }
    if (materializationsByEntryId.size > 0) {
      tasks = tasks.map((task) => ({
        ...task,
        materializationId: task.assignedAgentId ? materializationsByEntryId.get(task.assignedAgentId)?.id ?? null : null
      }));
      await bindTaskMaterializations(run.id, materializationsByEntryId);
    }
    const delegationPlan = buildTaskDelegationPlan(tasks, selectedCatalogEntries);

    const promptState = (await store.read()).promptGovernance;
    logEvent("run.created", buildRunCorrelation(await store.read(), run.id), {
      mode: run.mode,
      taskCount: tasks.length,
      runnerJobId: runnerJob.id
    });
    await appendEvent(run.id, "run.created", {
      runId: run.id,
      mode: run.mode,
      runnerJobId: runnerJob.id,
      rerunSourceRunId: run.rerunSourceRunId,
      rerunTriggeredBy: run.rerunTriggeredBy,
      catalogSyncRunId: run.catalogSyncRunId,
      budgetProfileId: run.budgetProfileId,
      budgetProfile: {
        id: resolvedBudgetProfile.id,
        name: resolvedBudgetProfile.name,
        retryCeiling: resolvedBudgetProfile.retryCeiling,
        materializationCeiling: resolvedBudgetProfile.materializationCeiling,
        wallClockBudgetMinutes: resolvedBudgetProfile.wallClockBudgetMinutes,
        concurrencyCeiling: resolvedBudgetProfile.concurrencyCeiling,
        providerUsageBudget: resolvedBudgetProfile.providerUsageBudget
      },
      catalogSync: {
        id: pinnedCatalogSync.id,
        resolvedRef: pinnedCatalogSync.resolvedRef,
        resolvedCommit: pinnedCatalogSync.resolvedCommit
      },
      providerSnapshot: run.providerSnapshot,
      selectedAgents: selectedCatalogEntries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        readinessState: entry.readinessState,
        domain: entry.manifest.identity.boundary.domain,
        materializationId: materializationsByEntryId.get(entry.id)?.id ?? null
      })),
      delegationPlan,
      promptArtifactVersions: promptState.artifactVersions,
      promptReevaluationPending: promptState.reevaluationPending,
      promptReevaluationChecks: promptState.reevaluationChecks
    }, null, "full");
    if (materializationFailure) {
      await store.write((state) => ({
        ...state,
        runs: state.runs.map((candidate) =>
          candidate.id === run.id
            ? {
                ...candidate,
                status: "blocked"
              }
            : candidate
        ),
        tasks: state.tasks.map((task) =>
          task.id === tasks[0]?.id
            ? {
                ...task,
                status: "blocked"
              }
            : task
        ),
        runnerJobs: state.runnerJobs.map((job) =>
          job.id === runnerJob.id
            ? {
                ...job,
                status: "blocked",
                blockedAt: now(),
                updatedAt: now()
              }
            : job
        )
      }));
      await appendEvent(run.id, "runner.job.blocked", {
        jobId: runnerJob.id,
        reason: materializationFailure.recoveryAction ?? "Materialization recovery is required before execution can continue.",
        traceId: runnerJob.payload.traceId
      });
      await appendEvent(run.id, "run.blocked_for_materialization_recovery", {
        runId: run.id,
        materializationId: materializationFailure.id,
        failureCode: materializationFailure.failureCode,
        failureDetail: materializationFailure.failureDetail,
        retryable: materializationFailure.retryable,
        recoveryAction: materializationFailure.recoveryAction
      });
    } else if (!blockedForClarification) {
      await appendEvent(run.id, "runner.job.queued", {
        jobId: runnerJob.id,
        queueName: runnerJob.queueName,
        traceId: runnerJob.payload.traceId
      });
    } else {
      await appendEvent(run.id, "runner.job.blocked", {
        jobId: runnerJob.id,
        reason: options.blockingReason ?? "Clarification is required before execution.",
        traceId: runnerJob.payload.traceId
      });
      await appendEvent(run.id, "run.blocked_for_clarification", {
        runId: run.id,
        blockingReason: options.blockingReason ?? "Clarification is required before execution."
      });
    }
    return { run, runnerJob };
  }

  async function createMaterialization(agentCatalogEntryId: string, runId: string | null) {
    let state = await store.read();
    let entry = state.catalogEntries.find((candidate) => candidate.id === agentCatalogEntryId) ?? null;
    if (!entry) {
      await syncCatalogIntoState();
      state = await store.read();
      entry = state.catalogEntries.find((candidate) => candidate.id === agentCatalogEntryId) ?? null;
    }
    if (!entry) {
      return null;
    }

    const run = runId ? state.runs.find((candidate) => candidate.id === runId) ?? null : null;
    const pinnedCatalogSync = run ? state.catalogSyncs.find((candidate) => candidate.id === run.catalogSyncRunId) ?? null : null;
    let manifestRecord = await catalog.getManifestRecord(agentCatalogEntryId);
    if (!manifestRecord) {
      await syncCatalogIntoState();
      state = await store.read();
      entry = state.catalogEntries.find((candidate) => candidate.id === agentCatalogEntryId) ?? entry;
      manifestRecord = await catalog.getManifestRecord(agentCatalogEntryId);
    }

    const id = randomUUID();
    const generatedPath = path.join(config.paths.artifactsRoot, "materializations", id);
    const catalogResolvedRef = manifestRecord?.resolvedRef ?? pinnedCatalogSync?.resolvedRef ?? state.catalogSyncs[0]?.resolvedRef ?? "unknown";
    const catalogResolvedCommit =
      manifestRecord?.resolvedCommit ?? pinnedCatalogSync?.resolvedCommit ?? state.catalogSyncs[0]?.resolvedCommit ?? "unknown";
    const materialization: MaterializationRecord = {
      id,
      agentCatalogEntryId,
      runId,
      workItemId: run?.workItemId ?? null,
      status: "building",
      generatedPath,
      sourceCommitOrRef: catalogResolvedCommit !== "unknown" ? catalogResolvedCommit : catalogResolvedRef,
      catalogSourcePath: manifestRecord?.manifestPath ?? entry.manifestPath,
      catalogResolvedRef,
      catalogResolvedCommit,
      provenanceNotes: renderPromptTemplate(promptArtifacts.specialist.templates.materializationProvenance, { sourcePath: entry.sourcePath }),
      failureCode: null,
      failureDetail: null,
      retryable: false,
      recoveryAction: null,
      diagnostics: [],
      validationChecks: [],
      failureReasons: entry.validationWarnings.map((issue) => issue.message),
      lastAttemptedAt: now(),
      createdAt: now(),
      readyAt: null
    };

    await store.write((current) => ({
      ...current,
      materializations: [materialization, ...current.materializations]
    }));

    if (runId) {
      await appendEvent(runId, "materialization.started", { materializationId: id, agentCatalogEntryId });
    }

    try {
      await fs.mkdir(generatedPath, { recursive: true });
      materialization.validationChecks.push({
        name: "workspace.created",
        ok: true,
        details: `Workspace created at ${generatedPath}`
      });

      let materializationManifest = manifestRecord?.manifest ?? null;
      const manifestSourcePath = manifestRecord?.manifestPath ?? entry.manifestPath;
      let manifestPayload = manifestRecord?.rawManifest ?? null;

      try {
        if (!manifestPayload) {
          manifestPayload = await fs.readFile(manifestSourcePath, "utf8");
        }
        if (!manifestPayload) {
          throw new Error("Manifest content was empty or unavailable.");
        }

        materializationManifest = parseSpecialistManifest(manifestPayload, manifestSourcePath);
        await fs.writeFile(path.join(generatedPath, "manifest.yaml"), manifestPayload, "utf8");
        materialization.validationChecks.push({
          name: "manifest.recorded",
          ok: true,
          details: `Manifest copied from ${materialization.catalogSourcePath}`
        });
      } catch (error) {
        const reason =
          error instanceof ManifestValidationError
            ? `Manifest validation failed for ${manifestSourcePath}: ${error.issues.map((issue) => issue.message).join("; ")}`
            : error instanceof Error
              ? error.message
              : "Validated manifest was not available from the current catalog sync.";
        recordMaterializationFailure(materialization, "invalid_manifest", reason);
        materialization.validationChecks.push({
          name: "manifest.contract",
          ok: false,
          details: reason
        });
      }

      if (materializationManifest) {
        const contractFailures = checkMaterializationManifestContract(materializationManifest);
        if (contractFailures.length > 0) {
          const reason = `Manifest contract validation failed: ${contractFailures.join("; ")}`;
          const code: MaterializationFailureCode = materialization.failureCode ?? "invalid_manifest";
          recordMaterializationFailure(materialization, code, reason);
          materialization.validationChecks.push({
            name: "manifest.contract",
            ok: false,
            details: reason
          });
        } else {
          materialization.validationChecks.push({
            name: "manifest.contract",
            ok: true,
            details: "Manifest contract checks passed."
          });
        }
      }

      const provenancePayload = {
        materializationId: id,
        agentCatalogEntryId,
        catalogSourcePath: materialization.catalogSourcePath,
        catalogResolvedRef: materialization.catalogResolvedRef,
        catalogResolvedCommit: materialization.catalogResolvedCommit,
        sourceCommitOrRef: materialization.sourceCommitOrRef,
        createdAt: materialization.createdAt
      };
      await fs.writeFile(path.join(generatedPath, "provenance.json"), JSON.stringify(provenancePayload, null, 2), "utf8");
      materialization.validationChecks.push({
        name: "provenance.recorded",
        ok: true,
        details: `Provenance recorded for ${materialization.catalogSourcePath}`
      });

      if (materializationManifest) {
        const generatedArtifactsRoot = path.join(generatedPath, "generated-specialist");
        const startupChecks = materializationManifest.startupChecks;
        const generatedAt = now();
        const systemPrompt = renderMaterializedSpecialistSystemPrompt(materializationManifest, promptArtifacts.specialist);
        const startupVerificationPath = path.join(generatedPath, "startup-verification.json");
        const failureEvidencePath = path.join(generatedPath, "failure-evidence.json");
        const runtimeBundlePath = path.join(generatedArtifactsRoot, "runtime-bundle.json");
        const executionContractPath = path.join(generatedArtifactsRoot, "execution-contract.json");
        const ioContractPath = path.join(generatedArtifactsRoot, "io-contract.json");
        const packageManifestPath = path.join(generatedArtifactsRoot, "package-manifest.json");
        const generatedRuntimeBundle = {
          contractVersion: MATERIALIZED_SPECIALIST_RUNTIME_BUNDLE_VERSION,
          materializationId: id,
          agentCatalogEntryId,
          identity: materializationManifest.identity,
          supportedTasks: materializationManifest.supportedTasks,
          inputs: materializationManifest.inputs,
          outputs: materializationManifest.outputs,
          permissions: materializationManifest.permissions,
          startupChecks: materializationManifest.startupChecks,
          provenance: provenancePayload
        };
        const generatedIoContract = {
          contractVersion: MATERIALIZED_SPECIALIST_IO_CONTRACT_VERSION,
          inputs: materializationManifest.inputs,
          outputs: materializationManifest.outputs
        };
        const executionContract = {
          contractVersion: MATERIALIZED_SPECIALIST_EXECUTION_CONTRACT_VERSION,
          runtime: "api_specialist",
          specialistId: materializationManifest.identity.slug,
          materializationId: id,
          agentCatalogEntryId,
          promptFiles: {
            instructionsRef: "instructions.md",
            systemPromptRef: "system-prompt.md"
          },
          ioContract: {
            ref: "io-contract.json",
            inputs: materializationManifest.inputs,
            outputs: materializationManifest.outputs
          },
          executionExpectations: {
            workspaceMode: "isolated_artifact_workspace",
            approvalRequired: materializationManifest.permissions.approvalRequired,
            supportedTasks: materializationManifest.supportedTasks,
            requiredOutputNames: materializationManifest.outputs.map((output) => output.name),
            startupChecks,
            runtimeRequirements: buildRuntimeExecutionExpectationsFromArtifacts(promptArtifacts.specialist)
          },
          governance: {
            promptArtifactId: "specialist.orchestration",
            promptArtifactVersion: promptArtifacts.specialist.version
          }
        };
        const startupVerificationChecks = startupChecks.map((check) => ({
          id: check.id,
          kind: check.kind,
          target: check.target,
          required: check.required,
          ok: null as boolean | null,
          details: `Declared startup check ${check.kind}:${check.target}`,
          command: isShellStartupCheck(check.kind) ? check.target : null,
          exitCode: null as number | null,
          stdout: "",
          stderr: "",
          startedAt: null as string | null,
          finishedAt: null as string | null
        }));

        await fs.mkdir(generatedArtifactsRoot, { recursive: true });
        await fs.writeFile(
          path.join(generatedArtifactsRoot, "instructions.md"),
          renderMaterializedSpecialistInstructions(materializationManifest, promptArtifacts.specialist),
          "utf8"
        );
        await fs.writeFile(path.join(generatedArtifactsRoot, "system-prompt.md"), `${systemPrompt}\n`, "utf8");
        await fs.writeFile(runtimeBundlePath, JSON.stringify(generatedRuntimeBundle, null, 2), "utf8");
        await fs.writeFile(executionContractPath, JSON.stringify(executionContract, null, 2), "utf8");
        await fs.writeFile(ioContractPath, JSON.stringify(generatedIoContract, null, 2), "utf8");
        materialization.validationChecks.push({
          name: "generated.bundle",
          ok: true,
          details: `Generated runtime bundle at ${generatedArtifactsRoot}`
        });
        materialization.diagnostics.push(`Generated specialist bundle at ${generatedArtifactsRoot}`);

      if (!materialization.failureCode) {
        const startupChecks = materializationManifest?.startupChecks ?? [];
        const startupShell = await resolveStartupShell();
        for (const [index, check] of startupChecks.entries()) {
          const startupVerificationCheck = startupVerificationChecks[index];
          if (!startupVerificationCheck) {
            continue;
          }
          if (!isShellStartupCheck(check.kind)) {
            startupVerificationCheck.ok = true;
            materialization.validationChecks.push({
              name: `startup.${check.kind}.${check.id}`,
              ok: true,
              details: `Declared startup check ${check.kind}:${check.target}`
            });
            continue;
          }

          const startedAt = now();
          startupVerificationCheck.startedAt = startedAt;
          try {
            await execFileAsync(startupShell, ["-lc", check.target], { cwd: generatedPath });
            startupVerificationCheck.ok = true;
            startupVerificationCheck.details = `Startup self-check passed: ${check.target}`;
            startupVerificationCheck.finishedAt = now();
            materialization.validationChecks.push({
              name: `startup.selfCheck.${index + 1}`,
              ok: true,
              details: `Startup self-check passed: ${check.target}`
            });
            materialization.diagnostics.push(`Startup self-check passed: ${check.target}`);
          } catch (error) {
            const reason = `Startup self-check failed: ${check.target}`;
            const detail = error instanceof Error && error.message ? `${reason} (${error.message})` : reason;
            const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout ?? "") : "";
            const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr ?? "") : "";
            const exitCode =
              typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : null;
            startupVerificationCheck.ok = false;
            startupVerificationCheck.details = detail;
            startupVerificationCheck.exitCode = exitCode;
            startupVerificationCheck.stdout = stdout;
            startupVerificationCheck.stderr = stderr;
            startupVerificationCheck.finishedAt = now();
            recordMaterializationFailure(materialization, "self_check_failed", detail);
            materialization.validationChecks.push({
              name: `startup.selfCheck.${index + 1}`,
              ok: false,
              details: detail
            });
          }
        }

        const startupVerification = {
          contractVersion: MATERIALIZED_SPECIALIST_STARTUP_VERIFICATION_VERSION,
          materializationId: id,
          status: materialization.failureCode ? "failed" : "ready",
          generatedAt,
          workspace: {
            generatedPath
          },
          retryable: materialization.retryable,
          recoveryAction: materialization.recoveryAction,
          failureCode: materialization.failureCode,
          failureDetail: materialization.failureDetail,
          checks: startupVerificationChecks
        };
        await fs.writeFile(startupVerificationPath, JSON.stringify(startupVerification, null, 2), "utf8");

        const failureEvidence = {
          contractVersion: MATERIALIZED_SPECIALIST_FAILURE_EVIDENCE_VERSION,
          materializationId: id,
          status: materialization.failureCode ? "failed" : "ready",
          generatedAt,
          unusable: Boolean(materialization.failureCode),
          failureCode: materialization.failureCode,
          failureDetail: materialization.failureDetail,
          retryable: materialization.retryable,
          recoveryAction: materialization.recoveryAction,
          failureReasons: materialization.failureReasons,
          diagnostics: materialization.diagnostics,
          startupVerificationRef: "startup-verification.json",
          generatedArtifactRefs: [
            "generated-specialist/instructions.md",
            "generated-specialist/system-prompt.md",
            "generated-specialist/runtime-bundle.json",
            "generated-specialist/execution-contract.json",
            "generated-specialist/io-contract.json",
            "generated-specialist/package-manifest.json"
          ],
          evidence: startupVerificationChecks
            .filter((check) => check.kind === "shell_command" || check.kind === "command" || check.kind === "script")
            .map((check) => ({
              kind: "startup_check" as const,
              id: check.id,
              target: check.target,
              exitCode: check.exitCode,
              stdout: check.stdout,
              stderr: check.stderr
            }))
        };
        await fs.writeFile(failureEvidencePath, JSON.stringify(failureEvidence, null, 2), "utf8");

        const packageManifest = {
          contractVersion: MATERIALIZED_SPECIALIST_PACKAGE_VERSION,
          materializationId: id,
          specialistId: materializationManifest.identity.slug,
          generatedAt,
          manifestRef: "../manifest.yaml",
          provenanceRef: "../provenance.json",
          startupVerificationRef: "../startup-verification.json",
          failureEvidenceRef: "../failure-evidence.json",
          artifacts: await Promise.all([
            describeGeneratedArtifact(path.join(generatedArtifactsRoot, "instructions.md"), "Materialized specialist instructions."),
            describeGeneratedArtifact(path.join(generatedArtifactsRoot, "system-prompt.md"), "Materialized specialist system prompt."),
            describeGeneratedArtifact(runtimeBundlePath, "Runtime bundle for the materialized specialist."),
            describeGeneratedArtifact(executionContractPath, "Execution contract for governed specialist runtime."),
            describeGeneratedArtifact(ioContractPath, "IO contract for specialist inputs and outputs.")
          ])
        };
        await fs.writeFile(packageManifestPath, JSON.stringify(packageManifest, null, 2), "utf8");
      }
      }

      if (materializationManifest) {
        materialization.validationChecks.push({
          name: "permissions.approval",
          ok: materializationManifest.permissions.approvalRequired,
          details: materializationManifest.permissions.approvalRequired
            ? "Approval protection declared."
            : "Approval protection disabled in manifest."
        });
      } else {
        materialization.validationChecks.push({
          name: "permissions.approval",
          ok: false,
          details: "Approval protection status unavailable."
        });
      }

      materialization.status = materialization.failureReasons.length > 0 ? "failed" : "ready";
      materialization.readyAt = materialization.status === "ready" ? now() : null;

      await fs.writeFile(
        path.join(generatedPath, "validation.json"),
        JSON.stringify(
          {
            materializationId: id,
            status: materialization.status,
            validationChecks: materialization.validationChecks,
            failureCode: materialization.failureCode,
            failureDetail: materialization.failureDetail,
            failureReasons: materialization.failureReasons,
            diagnostics: materialization.diagnostics,
            retryable: materialization.retryable,
            recoveryAction: materialization.recoveryAction,
            readyAt: materialization.readyAt,
            startupVerificationRef: "startup-verification.json",
            failureEvidenceRef: "failure-evidence.json"
          },
          null,
          2
        ),
        "utf8"
      );

      await fs.writeFile(
        path.join(generatedPath, "materialization.json"),
        JSON.stringify(
          {
            materializationId: id,
            status: materialization.status,
            failureCode: materialization.failureCode,
            failureDetail: materialization.failureDetail,
            retryable: materialization.retryable,
            recoveryAction: materialization.recoveryAction,
            catalogSourcePath: materialization.catalogSourcePath,
            catalogResolvedRef: materialization.catalogResolvedRef,
            catalogResolvedCommit: materialization.catalogResolvedCommit,
            materializedAgentName: entry.name,
            selfChecks: materialization.validationChecks.filter((check) => check.name.startsWith("startup.")),
            diagnostics: materialization.diagnostics,
            startupVerificationRef: "startup-verification.json",
            failureEvidenceRef: "failure-evidence.json"
          },
          null,
          2
        ),
        "utf8"
      );
    } catch (error) {
      const detail = error instanceof Error && error.message ? error.message : "Unknown materialization I/O error.";
      materialization.status = "failed";
      const failureCode: MaterializationFailureCode = materialization.failureCode ?? "materialization_io_error";
      if (!materialization.failureCode) {
        recordMaterializationFailure(materialization, failureCode, detail);
      } else {
        materialization.failureReasons.push(detail);
        materialization.diagnostics.push(detail);
      }
    }

    const materializationArtifact = runId
      ? createArtifactRecord(
          runId,
          null,
          "materialization_bundle",
          path.join(generatedPath, "materialization.json"),
          `Materialization ${id} ${materialization.status} for ${entry.name}.`
        )
      : null;

    await store.write((current) => ({
      ...current,
      materializations: current.materializations.map((candidate) => (candidate.id === id ? materialization : candidate)),
      artifacts: materializationArtifact ? [materializationArtifact, ...current.artifacts] : current.artifacts
    }));

    if (runId) {
      await appendEvent(runId, `materialization.${materialization.status}`, {
        materializationId: id,
        agentCatalogEntryId,
        failureCode: materialization.failureCode,
        failureDetail: materialization.failureDetail,
        failureReasons: materialization.failureReasons,
        recoveryAction: materialization.recoveryAction,
        retryable: materialization.retryable,
        catalogSourcePath: materialization.catalogSourcePath,
        catalogResolvedRef: materialization.catalogResolvedRef,
        catalogResolvedCommit: materialization.catalogResolvedCommit,
        sourceCommitOrRef: materialization.sourceCommitOrRef
      });
    }

    return materialization;
  }

  async function resolveClarification(
    session: SessionRecord,
    clarification: ClarificationRecord,
    responseMessage: MessageRecord,
    responseContent: string
  ) {
    const state = await store.read();
    const request = state.requests.find((entry) => entry.id === clarification.requestId) ?? null;
    if (!request) {
      return await getSessionView(session.id);
    }

    const clarifiedContent = combineClarifiedRequest(clarification.originalContent, responseContent);

    await store.write((current) => ({
      ...current,
      clarifications: (current.clarifications ?? []).map((entry) =>
        entry.id === clarification.id
          ? {
              ...entry,
              status: "resolved",
              resolvedByMessageId: responseMessage.id,
              resolutionSummary: normalizeContent(responseContent),
              resolvedAt: now()
            }
          : entry
      ),
      requests: current.requests.map((entry) =>
        entry.id === clarification.requestId
          ? {
              ...entry,
              status: "accepted"
            }
          : entry
      ),
      sessions: current.sessions.map((entry) => (entry.id === session.id ? { ...entry, status: "active", updatedAt: now() } : entry))
    }));

    const resumedRequest: RequestRecord = {
      ...request,
      status: "accepted"
    };

    let assistantContent = "Clarification received.";
    let assistantKind: MessageRecord["messageKind"] = "chat";
    try {
      const intake = await decideIntake(session, clarifiedContent);

      if (intake.decision.needsClarification && intake.decision.requestType !== "chat") {
        const clarificationRequestType = intake.decision.requestType as Exclude<RequestRecord["requestType"], "chat">;
        const prompt = intake.decision.clarificationQuestion?.trim() || buildClarificationPrompt(clarifiedContent, clarificationRequestType);
        const clarificationMessage: MessageRecord = {
          id: randomUUID(),
          sessionId: session.id,
          authorType: "pa",
          content: prompt,
          messageKind: "clarification",
          createdAt: now()
        };
        const followUpClarification: ClarificationRecord = {
          id: randomUUID(),
          sessionId: session.id,
          requestId: resumedRequest.id,
          userMessageId: responseMessage.id,
          assistantMessageId: clarificationMessage.id,
          requestType: clarificationRequestType,
          originalContent: clarifiedContent,
          prompt,
          status: "pending",
          resolvedByMessageId: null,
          resolutionSummary: null,
          createdAt: now(),
          resolvedAt: null
        };

        await store.write((current) => ({
          ...current,
          messages: [...current.messages, clarificationMessage],
          clarifications: [followUpClarification, ...(current.clarifications ?? [])],
          requests: current.requests.map((entry) =>
            entry.id === resumedRequest.id
              ? {
                  ...entry,
                  requestType: clarificationRequestType,
                  status: "clarification_required"
                }
              : entry
          ),
          sessions: current.sessions.map((entry) =>
            entry.id === session.id
              ? {
                  ...entry,
                  status: "awaiting_clarification",
                  updatedAt: now()
                }
              : entry
          )
        }));
        if (intake.decision.requestType === "execution" && intake.decision.clarificationReason) {
          await createClarificationThread(session.id, null, intake.decision.clarificationReason);
        }

        return await getSessionView(session.id);
      }

      if (intake.decision.requestType === "planning") {
        const createdPlan = await createPlan(session.id, clarifiedContent);
        if (!createdPlan) {
          return null;
        }
        const { plan } = createdPlan;
        assistantContent = `Clarification received. PA drafted plan ${plan.id}. Review it and lock it when you are ready to execute.`;
        assistantKind = "plan";
      } else if (intake.decision.requestType === "execution") {
        const queued = await createRunFromRequest(session, resumedRequest, clarifiedContent, intake.selection);
        assistantContent = queued
          ? `Clarification received. PA queued run ${queued.run.id} as runner job ${queued.runnerJob.id}.`
          : "Clarification received, but PA could not start a run from the updated request.";
      }
    } catch {
      assistantContent = "Clarification received, but PA could not evaluate the updated request because intake decisioning is unavailable.";
      assistantKind = "warning";
    }

    const paMessage: MessageRecord = {
      id: randomUUID(),
      sessionId: session.id,
      authorType: "pa",
      content: assistantContent,
      messageKind: assistantKind,
      createdAt: now()
    };

    await store.write((current) => ({
      ...current,
      messages: [...current.messages, paMessage],
      sessions: current.sessions.map((entry) => (entry.id === session.id ? { ...entry, updatedAt: now() } : entry))
    }));

    return await getSessionView(session.id);
  }

  const pa = {
    async createSession(surface: Surface, title: string): Promise<SessionView> {
      const timestamp = now();
      const session: SessionRecord = {
        id: randomUUID(),
        workspaceId: createDefaultState().workspace.id,
        workItemId: null,
        surface,
        title,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp
      };

      await store.write((state) => ({
        ...state,
        sessions: [session, ...state.sessions]
      }));

      return {
        session,
        messages: [],
        latestRun: null,
        clarificationThread: null,
        pendingApprovals: [],
        pendingClarifications: []
      };
    },

    async getSession(sessionId: string) {
      return await getSessionView(sessionId);
    },

    async postMessage(sessionId: string, content: string, options: { traceId?: string } = {}) {
      const state = await store.read();
      const session = state.sessions.find((entry) => entry.id === sessionId);
      if (!session) {
        return null;
      }

      const normalizedContent = normalizeContent(content);
      const pendingClarification = (state.clarifications ?? []).find(
        (clarification) => clarification.sessionId === sessionId && clarification.status === "pending"
      ) ?? null;
      const openClarification = getOpenClarificationForSession(state, sessionId);
      if (openClarification) {
        const clarificationMessage: MessageRecord = {
          id: randomUUID(),
          sessionId,
          authorType: "user",
          content: normalizedContent,
          messageKind: "clarification",
          createdAt: now()
        };

        await closeClarificationThread(openClarification.id);
        await store.write((current) => ({
          ...current,
          messages: [...current.messages, clarificationMessage],
          sessions: current.sessions.map((entry) =>
            entry.id === session.id
              ? {
                  ...entry,
                  status: openClarification.sessionStatusBefore ?? entry.status,
                  updatedAt: now()
                }
              : entry
          )
        }));
        if (pendingClarification) {
          return await resolveClarification(session, pendingClarification, clarificationMessage, normalizedContent);
        }
        if (openClarification.runId) {
          await appendEvent(openClarification.runId, "run.clarification.received", {
            clarificationThreadId: openClarification.id,
            runId: openClarification.runId
          });
        }

        const targetRun = openClarification.runId
          ? (await store.read()).runs.find((entry) => entry.id === openClarification.runId)
          : null;
        if (targetRun && openClarification.runId && (targetRun.status === "blocked" || targetRun.status === "awaiting_clarification")) {
          await setRunStatus(openClarification.runId, "queued");
          const runnerJob = getRunnerJobForRun(await store.read(), openClarification.runId);
          if (runnerJob?.status === "blocked") {
            await transitionRunnerJob(runnerJob.id, "queued");
            await appendEvent(openClarification.runId, "runner.job.queued", { jobId: runnerJob.id, reason: "clarification_received", traceId: runnerJob.payload.traceId });
          }
        }

        const assistantMessage: MessageRecord = {
          id: randomUUID(),
          sessionId,
          authorType: "pa",
          content: "PA received your clarification and resumed execution.",
          messageKind: "chat",
          createdAt: now()
        };

        await store.write((current) => ({
          ...current,
          messages: [...current.messages, assistantMessage],
          sessions: current.sessions.map((entry) => (entry.id === session.id ? { ...entry, updatedAt: now() } : entry))
        }));

        return await getSessionView(sessionId);
      }

      const userMessage: MessageRecord = {
        id: randomUUID(),
        sessionId,
        authorType: "user",
        content: normalizedContent,
        messageKind: "chat",
        createdAt: now()
      };

      await store.write((current) => ({
        ...current,
        messages: [...current.messages, userMessage],
        sessions: current.sessions.map((entry) => (entry.id === session.id ? { ...entry, updatedAt: now() } : entry))
      }));

      if (pendingClarification) {
        return await resolveClarification(session, pendingClarification, userMessage, normalizedContent);
      }

      let intakeDecision: IntakeDecision;
      let specialistSelection: { selectedEntries: CatalogEntry[]; candidatesByEntryId: Map<string, IntakeSpecialistCandidate> };
      try {
        const intake = await decideIntake(session, normalizedContent);
        intakeDecision = intake.decision;
        specialistSelection = intake.selection;
      } catch {
        const warningMessage: MessageRecord = {
          id: randomUUID(),
          sessionId,
          authorType: "pa",
          content: "PA could not evaluate this request because provider-backed intake decisioning is unavailable. Restore provider readiness and retry.",
          messageKind: "warning",
          createdAt: now()
        };

        await store.write((current) => ({
          ...current,
          messages: [...current.messages, warningMessage],
          sessions: current.sessions.map((entry) => (entry.id === session.id ? { ...entry, updatedAt: now() } : entry))
        }));
        return await getSessionView(sessionId);
      }

      const requestType = intakeDecision.requestType;
      const clarificationReason = intakeDecision.clarificationReason;
      const clarificationRequired = requestType !== "chat" && intakeDecision.needsClarification;
      const request: RequestRecord = {
        id: randomUUID(),
        sessionId,
        messageId: userMessage.id,
        requestType,
        status: clarificationRequired ? "clarification_required" : "accepted",
        createdAt: now()
      };

      await store.write((current) => ({
        ...current,
        requests: [request, ...current.requests]
      }));

      if (clarificationRequired) {
        const clarificationRequestType = requestType as Exclude<RequestRecord["requestType"], "chat">;
        const prompt = intakeDecision.clarificationQuestion?.trim() || buildClarificationPrompt(normalizedContent, clarificationRequestType);
        const clarificationMessage: MessageRecord = {
          id: randomUUID(),
          sessionId,
          authorType: "pa",
          content: prompt,
          messageKind: "clarification",
          createdAt: now()
        };
        const clarification: ClarificationRecord = {
          id: randomUUID(),
          sessionId,
          requestId: request.id,
          userMessageId: userMessage.id,
          assistantMessageId: clarificationMessage.id,
          requestType: clarificationRequestType,
          originalContent: normalizedContent,
          prompt,
          status: "pending",
          resolvedByMessageId: null,
          resolutionSummary: null,
          createdAt: now(),
          resolvedAt: null
        };

        await store.write((current) => ({
          ...current,
          messages: [...current.messages, clarificationMessage],
          clarifications: [clarification, ...(current.clarifications ?? [])],
          sessions: current.sessions.map((entry) => (entry.id === session.id ? { ...entry, updatedAt: now() } : entry))
        }));
        if (requestType === "execution" && clarificationReason) {
          await createClarificationThread(session.id, null, clarificationReason);
        }

        return await getSessionView(sessionId);
      }

      let assistantContent = `PA recognized this as ${summarizeMode(promptArtifacts.pa, requestType)}.`;
      let assistantKind: MessageRecord["messageKind"] = "chat";

      if (requestType === "planning") {
        const createdPlan = await createPlan(sessionId, normalizedContent);
        if (!createdPlan) {
          return null;
        }
        const { plan } = createdPlan;
        assistantContent = renderPromptTemplate(promptArtifacts.pa.templates.planningAcknowledgement, { planId: plan.id });
        assistantKind = "plan";
      } else if (requestType === "execution") {
        const queued = await createRunFromRequest(session, request, normalizedContent, specialistSelection, {
          blockedForClarification: false,
          blockingReason: null,
          traceId: options.traceId
        });
        if (!queued) {
          return null;
        }
        assistantContent = `PA queued run ${queued.run.id} as runner job ${queued.runnerJob.id}. Inspect the job, then let a runner claim and execute it.`;
      } else {
        try {
          const chatAnswer = await answerChat(session, normalizedContent);
          const content = chatAnswer.content.trim();
          if (!content) {
            throw new Error("provider returned an empty chat answer");
          }
          assistantContent = content;
        } catch {
          const warningMessage: MessageRecord = {
            id: randomUUID(),
            sessionId,
            authorType: "pa",
            content: "PA could not answer this chat request because provider-backed response generation is unavailable. Restore provider readiness and retry.",
            messageKind: "warning",
            createdAt: now()
          };

          await store.write((current) => ({
            ...current,
            messages: [...current.messages, warningMessage],
            sessions: current.sessions.map((entry) => (entry.id === session.id ? { ...entry, updatedAt: now() } : entry))
          }));
          return await getSessionView(sessionId);
        }
      }

      const paMessage: MessageRecord = {
        id: randomUUID(),
        sessionId,
        authorType: "pa",
        content: assistantContent,
        messageKind: assistantKind,
        createdAt: now()
      };

      await store.write((current) => ({
        ...current,
        messages: [...current.messages, paMessage],
        sessions: current.sessions.map((entry) => (entry.id === session.id ? { ...entry, updatedAt: now() } : entry))
      }));

      return await getSessionView(sessionId);
    },

    async createWorkItem(title: string, summary: string) {
      const state = await store.read();
      return await createWorkItem(state.workspace.id, title, summary);
    },

    async getWorkItem(workItemId: string): Promise<WorkItemView | null> {
      const state = await store.read();
      const workItem = state.workItems.find((entry) => entry.id === workItemId) ?? null;
      if (!workItem) {
        return null;
      }
      const sessionIds = new Set([
        ...state.plans.filter((plan) => plan.workItemId === workItemId).map((plan) => plan.sessionId),
        ...state.runs.filter((run) => run.workItemId === workItemId).map((run) => run.sessionId)
      ]);
      const runsForWorkItem = state.runs.filter((run) => run.workItemId === workItemId);
      const runIds = new Set(runsForWorkItem.map((run) => run.id));
      return {
        workItem,
        sessions: state.sessions.filter((session) => sessionIds.has(session.id)),
        plans: state.plans.filter((plan) => plan.workItemId === workItemId),
        runs: runsForWorkItem,
        approvals: state.approvals.filter((approval) => approval.workItemId === workItemId || (approval.runId && runIds.has(approval.runId))),
        artifacts: state.artifacts.filter((artifact) => artifact.runId !== null && runIds.has(artifact.runId)),
        materializations: state.materializations.filter((artifact) => artifact.runId !== null && runIds.has(artifact.runId)),
        collaborationThreads: buildWorkItemCollaborationThreads(state, workItemId)
      };
    },

    async createPlanFromSession(sessionId: string, summary: string) {
      const state = await store.read();
      if (!state.sessions.some((entry) => entry.id === sessionId)) {
        return null;
      }
      const latestMessage = state.messages.filter((entry) => entry.sessionId === sessionId).at(-1);
      const content = summary || latestMessage?.content || "Plan requested";
      return await createPlan(sessionId, content);
    },

    async getPlan(planId: string) {
      return await getPlan(planId);
    },

    async lockPlan(planId: string) {
      await store.write((state) => ({
        ...state,
        plans: state.plans.map((plan) =>
          plan.id === planId
            ? {
                ...plan,
                status: "locked",
                lockedAt: now()
              }
            : plan
        )
      }));
      return await getPlan(planId);
    },

    async createPlanChange(runId: string, reason: string) {
      const state = await store.read();
      const run = state.runs.find((entry) => entry.id === runId);
      if (!run?.planId) {
        return null;
      }
      const record: PlanChangeRequestRecord = {
        id: randomUUID(),
        planId: run.planId,
        runId,
        reason,
        status: "pending_approval",
        requestedByType: "pa",
        requestedAt: now(),
        decidedAt: null
      };
      await store.write((current) => ({
        ...current,
        planChangeRequests: [record, ...current.planChangeRequests]
      }));
      await appendEvent(runId, "plan_change.requested", { planChangeRequestId: record.id, reason });
      return record;
    }
  };

  const collaboration = {
    async getWorkspace(): Promise<WorkspaceIdentityView> {
      return buildWorkspaceIdentityView(await store.read());
    },

    async createUser(input: {
      emailOrLogin: string;
      displayName: string;
      role?: UserRecord["role"];
      status?: UserRecord["status"];
    }): Promise<UserRecord> {
      const timestamp = now();
      const user: UserRecord = {
        id: randomUUID(),
        emailOrLogin: input.emailOrLogin.trim(),
        displayName: input.displayName.trim(),
        role: input.role ?? "supporting",
        status: input.status ?? "active",
        createdAt: timestamp,
        lastSeenAt: null
      };

      await store.write((state) => {
        if (!user.emailOrLogin || !user.displayName) {
          throw new Error("user_identity_required");
        }
        if (state.users.some((entry) => entry.emailOrLogin.toLowerCase() === user.emailOrLogin.toLowerCase())) {
          throw new Error("user_identity_conflict");
        }
        if (user.role === "primary" && state.users.some((entry) => entry.role === "primary" && entry.status === "active")) {
          throw new Error("primary_user_already_exists");
        }

        return {
          ...state,
          users: [...state.users, user]
        };
      });

      return user;
    },

    async addWorkspaceMembership(input: {
      workspaceId: string;
      userId: string;
      role?: WorkspaceMembershipRecord["role"];
      permissions?: WorkspaceMembershipRecord["permissions"];
      actorUserId: string;
    }): Promise<WorkspaceIdentityView> {
      const state = await store.read();
      if (state.workspace.id !== input.workspaceId) {
        throw new Error("workspace_not_found");
      }

      const actorMembership =
        state.workspaceMemberships.find(
          (membership) =>
            membership.workspaceId === input.workspaceId &&
            membership.userId === input.actorUserId &&
            membership.role === "primary" &&
            membership.status === "active"
        ) ?? null;
      const actorIsWorkspaceOwner =
        state.workspace.ownerUserId === input.actorUserId &&
        state.users.some((entry) => entry.id === input.actorUserId && entry.role === "primary" && entry.status === "active");
      if (!actorMembership && !actorIsWorkspaceOwner) {
        throw new Error("primary_user_required");
      }

      const user = state.users.find((entry) => entry.id === input.userId) ?? null;
      if (!user || user.status !== "active") {
        throw new Error("user_not_found");
      }

      const role = input.role ?? user.role;
      if (role === "primary") {
        throw new Error("primary_membership_locked");
      }
      const permissions = role === "supporting" ? normalizeSupportUserPermissions(input.permissions) : [];

      const existingMembership =
        state.workspaceMemberships.find((membership) => membership.workspaceId === input.workspaceId && membership.userId === input.userId) ?? null;
      if (existingMembership && existingMembership.status === "active") {
        throw new Error("workspace_membership_exists");
      }

      const timestamp = now();
      const membership: WorkspaceMembershipRecord = {
        id: existingMembership?.id ?? randomUUID(),
        workspaceId: input.workspaceId,
        userId: input.userId,
        role,
        permissions,
        status: "active",
        addedByUserId: input.actorUserId,
        createdAt: existingMembership?.createdAt ?? timestamp,
        updatedAt: timestamp
      };

      const hasSupportingMembers = state.workspaceMemberships.some(
        (entry) => entry.workspaceId === input.workspaceId && entry.role === "supporting" && entry.status === "active"
      );

      await store.write((current) => ({
        ...current,
        workspace: {
          ...current.workspace,
          mode: hasSupportingMembers || membership.role === "supporting" ? "collaborative" : current.workspace.mode
        },
        workspaceMemberships: existingMembership
          ? current.workspaceMemberships.map((entry) => (entry.id === existingMembership.id ? membership : entry))
          : [...current.workspaceMemberships, membership]
      }));

      return buildWorkspaceIdentityView(await store.read());
    },

    async updateWorkspaceMembershipPermissions(input: {
      workspaceId: string;
      userId: string;
      actorUserId: string;
      permissions: WorkspaceMembershipRecord["permissions"];
    }): Promise<WorkspaceIdentityView> {
      const state = await store.read();
      if (state.workspace.id !== input.workspaceId) {
        throw new Error("workspace_not_found");
      }

      const actorMembership =
        state.workspaceMemberships.find(
          (membership) =>
            membership.workspaceId === input.workspaceId &&
            membership.userId === input.actorUserId &&
            membership.role === "primary" &&
            membership.status === "active"
        ) ?? null;
      const actorIsWorkspaceOwner =
        state.workspace.ownerUserId === input.actorUserId &&
        state.users.some((entry) => entry.id === input.actorUserId && entry.role === "primary" && entry.status === "active");
      if (!actorMembership && !actorIsWorkspaceOwner) {
        throw new Error("primary_user_required");
      }

      const membership =
        state.workspaceMemberships.find(
          (entry) => entry.workspaceId === input.workspaceId && entry.userId === input.userId && entry.status === "active"
        ) ?? null;
      if (!membership) {
        throw new Error("workspace_membership_not_found");
      }
      if (membership.role !== "supporting") {
        throw new Error("supporting_membership_required");
      }

      const updatedMembership: WorkspaceMembershipRecord = {
        ...membership,
        permissions: normalizeSupportUserPermissions(input.permissions),
        updatedAt: now()
      };

      await store.write((current) => ({
        ...current,
        workspaceMemberships: current.workspaceMemberships.map((entry) => (entry.id === membership.id ? updatedMembership : entry))
      }));

      return buildWorkspaceIdentityView(await store.read());
    },

    async listWorkItemThreads(workItemId: string): Promise<WorkItemCollaborationThreadView[] | null> {
      const state = await store.read();
      const workItem = state.workItems.find((entry) => entry.id === workItemId) ?? null;
      if (!workItem) {
        return null;
      }
      return buildWorkItemCollaborationThreads(state, workItemId);
    },

    async createWorkItemThread(input: {
      workItemId: string;
      actorUserId: string;
      title: string;
      message: string;
    }): Promise<WorkItemCollaborationThreadView | null> {
      const state = await store.read();
      const workItem = state.workItems.find((entry) => entry.id === input.workItemId) ?? null;
      if (!workItem) {
        return null;
      }
      requireWorkspacePermission(state, workItem.workspaceId, input.actorUserId, "work_item_collaboration");

      const timestamp = now();
      const thread: WorkItemCollaborationThreadRecord = {
        id: randomUUID(),
        workItemId: workItem.id,
        workspaceId: workItem.workspaceId,
        title: input.title.trim() || "Collaboration",
        status: "open",
        createdByUserId: input.actorUserId,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const message: WorkItemCollaborationMessageRecord = {
        id: randomUUID(),
        threadId: thread.id,
        workItemId: workItem.id,
        workspaceId: workItem.workspaceId,
        authorUserId: input.actorUserId,
        content: input.message.trim(),
        createdAt: timestamp
      };

      await store.write((current) => ({
        ...current,
        workItemCollaborationThreads: [thread, ...current.workItemCollaborationThreads],
        workItemCollaborationMessages: [...current.workItemCollaborationMessages, message],
        workItems: current.workItems.map((entry) =>
          entry.id === workItem.id
            ? {
                ...entry,
                updatedAt: timestamp
              }
            : entry
        )
      }));

      return buildWorkItemCollaborationView(thread, [message]);
    },

    async postWorkItemThreadMessage(input: {
      workItemId: string;
      threadId: string;
      actorUserId: string;
      content: string;
    }): Promise<WorkItemCollaborationThreadView | null> {
      const state = await store.read();
      const workItem = state.workItems.find((entry) => entry.id === input.workItemId) ?? null;
      if (!workItem) {
        return null;
      }
      requireWorkspacePermission(state, workItem.workspaceId, input.actorUserId, "work_item_collaboration");

      const thread = state.workItemCollaborationThreads.find((entry) => entry.id === input.threadId && entry.workItemId === input.workItemId) ?? null;
      if (!thread) {
        return null;
      }

      const timestamp = now();
      const message: WorkItemCollaborationMessageRecord = {
        id: randomUUID(),
        threadId: thread.id,
        workItemId: workItem.id,
        workspaceId: workItem.workspaceId,
        authorUserId: input.actorUserId,
        content: input.content.trim(),
        createdAt: timestamp
      };
      const updatedThread: WorkItemCollaborationThreadRecord = {
        ...thread,
        updatedAt: timestamp
      };

      await store.write((current) => ({
        ...current,
        workItemCollaborationThreads: current.workItemCollaborationThreads.map((entry) => (entry.id === thread.id ? updatedThread : entry)),
        workItemCollaborationMessages: [...current.workItemCollaborationMessages, message],
        workItems: current.workItems.map((entry) =>
          entry.id === workItem.id
            ? {
                ...entry,
                updatedAt: timestamp
              }
            : entry
        )
      }));

      return buildWorkItemCollaborationView(updatedThread, [
        ...state.workItemCollaborationMessages.filter((entry) => entry.threadId === thread.id),
        message
      ]);
    }
  };

  const runs = {
    async get(runId: string): Promise<RunView | null> {
      const state = await store.read();
      const run = state.runs.find((entry) => entry.id === runId) ?? null;
      if (!run) {
        return null;
      }
      return {
        run,
        tasks: sortExecutionTasks(state.tasks.filter((entry) => entry.runId === runId)),
        runtimes: state.agentRuntimes.filter((entry) => entry.runId === runId),
        delegationDecisions: state.delegationDecisions.filter((entry) => entry.runId === runId),
        approvals: state.approvals.filter((entry) => entry.runId === runId),
        planChangeRequests: state.planChangeRequests.filter((entry) => entry.runId === runId),
        runnerJob: getRunnerJobForRun(state, runId)
      };
    },

    async tasks(runId: string) {
      const state = await store.read();
      return sortExecutionTasks(state.tasks.filter((task) => task.runId === runId));
    },

    async events(runId: string) {
      const state = await store.read();
      return state.runEvents.filter((event) => event.runId === runId);
    },

    async replayEvents(runId: string) {
      const state = await store.read();
      const run = state.runs.find((entry) => entry.id === runId) ?? null;
      if (!run) {
        return null;
      }
      const existingEvents = state.runEvents.filter((event) => event.runId === runId);
      if (!REPLAY_SAFE_RUN_STATUSES.includes(run.status)) {
        return {
          error: {
            code: "run_replay_conflict",
            message: `Run ${runId} is ${run.status} and cannot be replayed until it is paused or reaches a terminal state.`,
            retryable: false
          }
        };
      }
      await appendEvent(runId, "run.replay_requested", {
        runId,
        reason: "Operator requested run event replay for diagnostics.",
        requestedBy: "operator",
        replayedEventCount: existingEvents.length
      });
      return {
        replayed: existingEvents.length,
        safe: true,
        reason: "Replay is allowed because the run is paused or has already stopped changing state."
      };
    },

    async rerun(runId: string): Promise<RunRerunView | ActionPolicyError | null> {
      const state = await store.read();
      const sourceRun = state.runs.find((entry) => entry.id === runId) ?? null;
      if (!sourceRun) {
        return null;
      }
      if (!["failed", "blocked"].includes(sourceRun.status)) {
        return {
          error: {
            code: "run_replay_conflict",
            message: `Only failed or blocked runs can be rerun through the operator workflow. Current status is ${sourceRun.status}.`,
            retryable: false,
            runId
          }
        };
      }

      const session = state.sessions.find((entry) => entry.id === sourceRun.sessionId) ?? null;
      const request = state.requests.find((entry) => entry.id === sourceRun.requestId) ?? null;
      if (!session || !request) {
        return {
          error: {
            code: "run_replay_conflict",
            message: "The source run is missing its bound session or request context and cannot be rerun safely.",
            retryable: false,
            runId
          }
        };
      }

      const requestContent = resolveRequestContentForRerun(state, sourceRun);
      if (!requestContent) {
        return {
          error: {
            code: "run_replay_conflict",
            message: "The source run no longer has recoverable request content for a controlled rerun.",
            retryable: false,
            runId
          }
        };
      }

      const rerunRequest: RequestRecord = {
        id: randomUUID(),
        sessionId: session.id,
        messageId: request.messageId,
        requestType: request.requestType,
        status: "accepted",
        createdAt: now()
      };

      await store.write((current) => ({
        ...current,
        requests: [rerunRequest, ...current.requests]
      }));

      const rerunSelection = buildRerunSpecialistSelection(state, sourceRun.id, state.catalogEntries);
      const created = await createRunFromRequest(session, rerunRequest, requestContent, rerunSelection, {
        traceId: randomUUID(),
        planIdOverride: sourceRun.planId,
        workItemIdOverride: sourceRun.workItemId,
        rerunSourceRunId: sourceRun.id,
        rerunTriggeredBy: "operator"
      });

      if (!created) {
        return {
          error: {
            code: "run_replay_conflict",
            message: "PA could not create a controlled rerun from the stored source run context.",
            retryable: true,
            runId
          }
        };
      }

      const rerunNotice: MessageRecord = {
        id: randomUUID(),
        sessionId: session.id,
        authorType: "pa",
        content: `Operator requested a controlled rerun of run ${sourceRun.id}. PA queued rerun ${created.run.id}.`,
        messageKind: "warning",
        createdAt: now()
      };
      await store.write((current) => ({
        ...current,
        messages: [...current.messages, rerunNotice]
      }));
      await appendEvent(sourceRun.id, "run.rerun_requested", {
        sourceRunId: sourceRun.id,
        rerunRunId: created.run.id,
        requestedBy: "operator"
      });
      await appendEvent(created.run.id, "run.rerun_created", {
        sourceRunId: sourceRun.id,
        rerunRunId: created.run.id,
        requestedBy: "operator"
      });

      const rerunView = await runs.get(created.run.id);
      const sessionView = await getSessionView(session.id);
      if (!rerunView || !sessionView) {
        return {
          error: {
            code: "run_replay_conflict",
            message: "The rerun was created but could not be reloaded for operator inspection.",
            retryable: true,
            runId: created.run.id
          }
        };
      }

      return {
        sourceRunId: sourceRun.id,
        rerunRequestedBy: "operator",
        rerun: rerunView,
        session: sessionView
      };
    },

    subscribe(runId: string, listener: EventListener) {
      const existing = listeners.get(runId) ?? new Set<EventListener>();
      existing.add(listener);
      listeners.set(runId, existing);
      return () => {
        const next = listeners.get(runId);
        next?.delete(listener);
      };
    },

    async control(runId: string, action: "pause" | "resume" | "cancel", reason?: string) {
      const state = await store.read();
      const run = state.runs.find((entry) => entry.id === runId) ?? null;
      if (!run) {
        return null;
      }
      const runnerJob = getRunnerJobForRun(state, runId);
      const trimmedReason = reason?.trim() || defaultControlReason(action);
      if (action === "pause") {
        if (run.status === "paused") {
          return await runs.get(runId);
        }
        if (!["queued", "running"].includes(run.status)) {
          return runControlError(`Only queued or running work can be paused safely. Current run status is ${run.status}.`);
        }
        const timer = runTimers.get(runId);
        if (timer) {
          clearTimeout(timer);
          runTimers.delete(runId);
        }
        await setRunStatus(runId, "paused");
        if (runnerJob && ["queued", "claimed", "running"].includes(runnerJob.status)) {
          await transitionRunnerJob(runnerJob.id, "paused", { runnerId: runnerJob.runnerId });
        }
        await appendEvent(runId, "run.paused", { runId, reason: trimmedReason, requestedBy: "operator" });
      }
      if (action === "resume") {
        if (run.status !== "paused") {
          return runControlError(`Only explicitly paused work can be resumed. Current run status is ${run.status}.`);
        }
        await setRunStatus(runId, "queued");
        if (runnerJob?.status === "paused") {
          await transitionRunnerJob(runnerJob.id, "queued");
        }
        await appendEvent(runId, "run.resumed", { runId, reason: trimmedReason, requestedBy: "operator" });
      }
      if (action === "cancel") {
        if (run.status === "cancelled") {
          return await runs.get(runId);
        }
        if (["completed", "failed"].includes(run.status)) {
          return runControlError(`Completed or failed work cannot be cancelled. Current run status is ${run.status}.`);
        }
        const timer = runTimers.get(runId);
        if (timer) {
          clearTimeout(timer);
          runTimers.delete(runId);
        }
        await setRunStatus(runId, "cancelled");
        if (runnerJob && !["completed", "failed", "cancelled"].includes(runnerJob.status)) {
          await transitionRunnerJob(runnerJob.id, "cancelled", {
            runnerId: runnerJob.runnerId,
            failure: buildRunnerJobFailure("cancelled", "Run was cancelled by operator request.", false, { runId })
          });
          await appendEvent(runId, "runner.job.cancelled", { jobId: runnerJob.id, reason: trimmedReason, requestedBy: "operator" });
        }
        await appendEvent(runId, "run.cancelled", { runId, reason: trimmedReason, requestedBy: "operator" });
      }
      return await runs.get(runId);
    }
  };

  const runner = {
    async list() {
      const state = await store.read();
      return [...state.runnerJobs].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },

    async get(jobId: string) {
      const state = await store.read();
      return state.runnerJobs.find((job) => job.id === jobId) ?? null;
    },

    async claimNext(runnerId: string) {
      const state = await store.read();
      const candidate = [...state.runnerJobs]
        .filter((job) => job.status === "queued" && state.runs.some((run) => run.id === job.runId && run.status === "queued"))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

      if (!candidate) {
        return null;
      }

      const claimed = await transitionRunnerJob(candidate.id, "claimed", { runnerId });
      if (!claimed) {
        return null;
      }

      await appendEvent(candidate.runId, "runner.job.claimed", { jobId: candidate.id, runnerId, traceId: candidate.payload.traceId });
      return claimed;
    },

    async start(jobId: string, runnerId: string) {
      const job = await runner.get(jobId);
      if (!job) {
        return null;
      }
      if (job.status !== "claimed" || job.runnerId !== runnerId) {
        return {
          error: {
            code: "runner_job_conflict",
            message: "Runner job must be claimed by the same runner before execution starts.",
            retryable: true
          }
        };
      }

      await setRunStatus(job.runId, "running");
      const started = await transitionRunnerJob(jobId, "running", { runnerId });
      if (!started) {
        return {
          error: {
            code: "runner_job_conflict",
            message: "Runner job could not transition to running.",
            retryable: true
          }
        };
      }

      await appendEvent(job.runId, "runner.job.started", { jobId, runnerId, traceId: job.payload.traceId });
      startRunExecution(job.runId, jobId);
      return started;
    },

    async fail(jobId: string, runnerId: string, input: { code: RunnerJobFailureCode; message: string; retryable: boolean; detail?: Record<string, unknown> }) {
      const job = await runner.get(jobId);
      if (!job) {
        return null;
      }
      if (!["claimed", "running", "blocked", "paused"].includes(job.status) || job.runnerId !== runnerId) {
        return {
          error: {
            code: "runner_job_conflict",
            message: "Runner job must be owned by the reporting runner while in-flight.",
            retryable: true
          }
        };
      }

      await failRun(job.runId, jobId, buildRunnerJobFailure(input.code, input.message, input.retryable, input.detail ?? {}));
      return await runner.get(jobId);
    }
  };

  const approvals = {
    async list() {
      const state = await store.read();
      return state.approvals.filter((approval) => approval.status === "pending");
    },

    async decide(approvalId: string, decision: "approved" | "denied", comment?: string, actorUserId?: string) {
      if (!actorUserId) {
        throw new Error("workspace_membership_required");
      }
      const currentState = await store.read();
      const currentApproval = currentState.approvals.find((approval) => approval.id === approvalId) ?? null;
      if (!currentApproval) {
        return null;
      }
      const run = currentState.runs.find((entry) => entry.id === currentApproval.runId) ?? null;
      if (!run) {
        return null;
      }
      requireWorkspacePermission(currentState, run.workspaceId, actorUserId, "approval_decision");

      let affectedRunId: string | null = null;
      let affectedTaskId: string | null = null;
      const decisionComment = comment ?? null;
      await store.write((state) => ({
        ...state,
        approvals: state.approvals.map((approval) => {
          if (approval.id !== approvalId) {
            return approval;
          }
          affectedRunId = approval.runId;
          affectedTaskId = approval.taskId;
          return {
            ...approval,
            status: decision,
            decisionComment,
            decidedAt: now()
          };
        }),
        actionProposals: state.actionProposals.map((proposal) =>
          proposal.approval.approvalId === approvalId
            ? {
                ...proposal,
                approval: {
                  ...proposal.approval,
                  status: decision
                },
                updatedAt: now()
              }
            : proposal
        ),
        actionExecutions: state.actionExecutions.map((execution) =>
          execution.approval.approvalId === approvalId
            ? {
                ...execution,
                approval: {
                  ...execution.approval,
                  status: decision
                }
              }
            : execution
        )
      }));

      if (affectedRunId) {
        const state = await store.read();
        const run = state.runs.find((entry) => entry.id === affectedRunId);
        const runnerJob = getRunnerJobForRun(state, affectedRunId);
        await appendEvent(affectedRunId, `approval.${decision}`, { approvalId, decision, taskId: affectedTaskId }, affectedTaskId);
        if (decision === "approved") {
          await setRunStatus(affectedRunId, "queued");
          if (affectedTaskId) {
            await setTaskStatus(affectedTaskId, "queued");
          }
          if (runnerJob?.status === "blocked") {
            await transitionRunnerJob(runnerJob.id, "queued");
            await appendEvent(affectedRunId, "runner.job.queued", { jobId: runnerJob.id, reason: "approval_approved", traceId: runnerJob.payload.traceId });
          }
        } else {
          await appendEvent(affectedRunId, "run.blocked_for_denial", { approvalId, taskId: affectedTaskId }, affectedTaskId);
          await failRun(
            affectedRunId,
            runnerJob?.id ?? null,
            buildRunnerJobFailure("approval_denied", comment?.trim() || "Approval was denied.", false, { approvalId }),
            affectedTaskId
          );
          if (run?.planId) {
            await pa.createPlanChange(affectedRunId, "Execution was denied; run should be reprioritized before retry.");
          }
        }
      }

      const state = await store.read();
      return state.approvals.find((approval) => approval.id === approvalId) ?? null;
    }
  };

  const clarifications = {
    async create(input: {
      sessionId: string;
      title: string;
      message: string;
      planId?: string | null;
      runId?: string | null;
      authorType?: ClarificationMessageRecord["authorType"];
    }): Promise<ClarificationThreadView | null> {
      const state = await store.read();
      const session = state.sessions.find((entry) => entry.id === input.sessionId);
      if (!session) {
        return null;
      }

      const plan = input.planId ? state.plans.find((entry) => entry.id === input.planId && entry.sessionId === input.sessionId) ?? null : null;
      const run = input.runId ? state.runs.find((entry) => entry.id === input.runId && entry.sessionId === input.sessionId) ?? null : null;
      if (input.planId && !plan) {
        return null;
      }
      if (input.runId && !run) {
        return null;
      }

      const timestamp = now();
      const thread: ClarificationThreadRecord = {
        id: randomUUID(),
        sessionId: input.sessionId,
        planId: plan?.id ?? null,
        runId: run?.id ?? null,
        title: input.title,
        state: "open",
        status: "open",
        blockingReason: null,
        createdAt: timestamp,
        openedAt: timestamp,
        resolvedAt: null,
        sessionStatusBefore: session.status,
        planStatusBefore: plan?.status ?? null,
        runStatusBefore: run?.status ?? null
      };
      const message: ClarificationMessageRecord = {
        id: randomUUID(),
        threadId: thread.id,
        authorType: input.authorType ?? "pa",
        content: input.message,
        createdAt: timestamp
      };

      const timer = run ? runTimers.get(run.id) : undefined;
      if (timer && run) {
        clearTimeout(timer);
        runTimers.delete(run.id);
      }

      await store.write((current) => ({
        ...current,
        clarificationThreads: [thread, ...current.clarificationThreads],
        clarificationMessages: [...current.clarificationMessages, message],
        sessions: current.sessions.map((entry) =>
          entry.id === input.sessionId
            ? {
                ...entry,
                status: "awaiting_clarification",
                updatedAt: timestamp
              }
            : entry
        ),
        plans: plan
          ? current.plans.map((entry) =>
              entry.id === plan.id
                ? {
                    ...entry,
                    status: "awaiting_clarification"
                  }
                : entry
            )
          : current.plans,
        runs: run
          ? current.runs.map((entry) =>
              entry.id === run.id
                ? {
                    ...entry,
                    status: "awaiting_clarification"
                  }
                : entry
            )
          : current.runs
      }));

      if (run) {
        await appendEvent(run.id, "run.awaiting_clarification", { clarificationThreadId: thread.id, title: thread.title });
      }

      return buildClarificationView(thread, [message]);
    },

    async list(sessionId: string): Promise<ClarificationThreadView[] | null> {
      const state = await store.read();
      const sessionExists = state.sessions.some((entry) => entry.id === sessionId);
      if (!sessionExists) {
        return null;
      }

      return state.clarificationThreads
        .filter((thread) => thread.sessionId === sessionId)
        .map((thread) => buildClarificationView(thread, state.clarificationMessages));
    },

    async resolve(threadId: string, resolution?: { content?: string; authorType?: ClarificationMessageRecord["authorType"] }): Promise<ClarificationThreadView | null> {
      const state = await store.read();
      const thread = state.clarificationThreads.find((entry) => entry.id === threadId);
      if (!thread) {
        return null;
      }
      if (isClarificationResolved(thread)) {
        return buildClarificationView(thread, state.clarificationMessages);
      }

      const timestamp = now();
      const resolutionMessage = resolution?.content?.trim()
        ? ({
            id: randomUUID(),
            threadId,
            authorType: resolution.authorType ?? "user",
            content: resolution.content.trim(),
            createdAt: timestamp
          } as ClarificationMessageRecord)
        : null;

      const resolvedThread: ClarificationThreadRecord = {
        ...thread,
        status: "resolved",
        state: "resolved",
        resolvedAt: timestamp
      };

      await store.write((current) => ({
        ...current,
        clarificationThreads: current.clarificationThreads.map((entry) => (entry.id === threadId ? resolvedThread : entry)),
        clarificationMessages: resolutionMessage ? [...current.clarificationMessages, resolutionMessage] : current.clarificationMessages,
        sessions: current.sessions.map((entry) =>
          entry.id === thread.sessionId && entry.status === "awaiting_clarification" && thread.sessionStatusBefore
            ? {
                ...entry,
                status: thread.sessionStatusBefore,
                updatedAt: timestamp
              }
            : entry
        ),
        plans: thread.planId && thread.planStatusBefore
          ? current.plans.map((entry) =>
              entry.id === thread.planId && entry.status === "awaiting_clarification"
                ? {
                    ...entry,
                    status: thread.planStatusBefore!
                  }
                : entry
            )
          : current.plans,
        runs: thread.runId && thread.runStatusBefore
          ? current.runs.map((entry) =>
              entry.id === thread.runId && entry.status === "awaiting_clarification"
                ? {
                    ...entry,
                    status: thread.runStatusBefore!
                  }
                : entry
            )
          : current.runs
      }));

      if (thread.runId) {
        await appendEvent(thread.runId, "clarification.resolved", { clarificationThreadId: threadId });
        if (
          thread.runStatusBefore === "queued" ||
          thread.runStatusBefore === "running" ||
          thread.runStatusBefore === "blocked" ||
          thread.runStatusBefore === "awaiting_clarification"
        ) {
          const runnerJob = getRunnerJobForRun(await store.read(), thread.runId);
          if (runnerJob?.status === "blocked" || runnerJob?.status === "paused") {
            await transitionRunnerJob(runnerJob.id, "queued");
            await appendEvent(thread.runId, "runner.job.queued", { jobId: runnerJob.id, reason: "clarification_resolved", traceId: runnerJob.payload.traceId });
          }
        }
      }

      return buildClarificationView(resolvedThread, [
        ...state.clarificationMessages.filter((entry) => entry.threadId === threadId),
        ...(resolutionMessage ? [resolutionMessage] : [])
      ]);
    }
  };

  const actions = {
    async createProposal(input: {
      workItemId: string;
      runId: string | null;
      taskId: string | null;
      toolId: string;
      actionClass: "class_a" | "class_b" | "class_c";
      targetRef: string;
      actionSummary?: string;
      idempotencyKey: string;
      toolPayload?: Record<string, unknown> | null;
    }): Promise<ActionProposalRecord | ActionPolicyError> {
      const toolPolicy = getToolPolicy(input.toolId);
      if (!toolPolicy) {
        return {
          error: {
            code: "unsafe_action_blocked",
            message: `Tool ${input.toolId} is not allowed by the action policy contract.`,
            retryable: false,
            runId: input.runId
          }
        };
      }

      if (!input.workItemId.trim() || !input.targetRef.trim() || !input.idempotencyKey.trim()) {
        return {
          error: {
            code: "action_preflight_failed",
            message: "Action proposals require workItemId, targetRef, and idempotencyKey.",
            retryable: false,
            runId: input.runId
          }
        };
      }

      if (toolPolicy.actionClass !== input.actionClass) {
        return {
          error: {
            code: "unsafe_action_blocked",
            message: `Tool ${input.toolId} is classified as ${toolPolicy.actionClass}, not ${input.actionClass}.`,
            retryable: false,
            runId: input.runId
          }
        };
      }

      if (toolPolicy.requiresApproval && (!input.runId || !input.taskId)) {
        return {
          error: {
            code: "approval_required",
            message: "Class C actions must be bound to a specific run and task.",
            retryable: false,
            runId: input.runId
          }
        };
      }

      const state = await store.read();
      if (toolPolicy.requiresApproval) {
        const deniedBinding = state.approvals.some(
          (approval) =>
            approval.status === "denied" &&
            approval.runId === input.runId &&
            approval.taskId === input.taskId
        );
        if (deniedBinding) {
          return {
            error: {
              code: "approval_required",
              message: "Action execution was previously denied for this run/task; replan before creating new actions.",
              retryable: false,
              runId: input.runId
            }
          };
        }
      }

      const approvalRecord = toolPolicy.requiresApproval
        ? state.approvals.find((approval) => approval.runId === input.runId && approval.taskId === input.taskId) ?? null
        : null;

      const proposalId = randomUUID();
      const approvalExpiry = toolPolicy.requiresApproval ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null;

      if (approvalRecord?.actionProposalId && approvalRecord.actionProposalId !== proposalId) {
        return {
          error: {
            code: "approval_required",
            message: "The existing approval is already bound to a different action proposal. Request a new approval before proceeding.",
            retryable: false,
            runId: input.runId
          }
        };
      }

      if (
        approvalRecord &&
        ((approvalRecord.toolId && approvalRecord.toolId !== input.toolId) ||
          (approvalRecord.targetRef && approvalRecord.targetRef !== input.targetRef))
      ) {
        return {
          error: {
            code: "approval_required",
            message: "The existing approval does not cover this exact tool and target surface.",
            retryable: false,
            runId: input.runId
          }
        };
      }

      const duplicateAction = state.actionProposals.find((proposal) =>
        proposal.idempotency.key === input.idempotencyKey &&
        proposal.idempotency.scope === toolPolicy.idempotencyScope &&
        proposal.runId === input.runId &&
        proposal.taskId === input.taskId &&
        ["proposed", "approved", "executing"].includes(proposal.status)
      );

      if (duplicateAction) {
        const detectedAt = now();
        const collisionRef = actionEvidenceUri(duplicateAction.id, "idempotency-collision.json");
        const collisionPath = actionEvidenceLocation(duplicateAction.id, "idempotency-collision.json");
        await fs.mkdir(path.dirname(collisionPath), { recursive: true });
        await fs.writeFile(
          collisionPath,
          JSON.stringify(
            {
              blockingActionProposalId: duplicateAction.id,
              blockingStatus: duplicateAction.status,
              runId: duplicateAction.runId,
              taskId: duplicateAction.taskId,
              idempotencyKey: input.idempotencyKey,
              idempotencyScope: toolPolicy.idempotencyScope,
              detectedAt,
              reason: "A later proposal attempt reused an active idempotency key for the same run/task binding."
            },
            null,
            2
          )
        );

        await store.write((current) => ({
          ...current,
          actionProposals: current.actionProposals.map((proposal) =>
            proposal.id === duplicateAction.id
              ? {
                  ...proposal,
                  idempotency: {
                    ...proposal.idempotency,
                    checkedAt: detectedAt,
                    collision: {
                      blockingActionProposalId: duplicateAction.id,
                      blockingActionExecutionId: current.actionExecutions.find((entry) => entry.actionProposalId === duplicateAction.id)?.id ?? null,
                      blockingStatus: duplicateAction.status,
                      reason: "A later proposal attempt reused an active idempotency key for the same run/task binding.",
                      detectedAt,
                      evidenceRef: collisionRef
                    }
                  },
                  evidenceRefs: [
                    createActionEvidenceRef("idempotency_collision", "Idempotency collision", collisionRef, detectedAt),
                    ...proposal.evidenceRefs.filter((entry) => entry.ref !== collisionRef)
                  ],
                  updatedAt: detectedAt
                }
              : proposal
          )
        }));

        return {
          error: {
            code: "action_idempotency_conflict",
            message: `A matching action has already been proposed with idempotency key ${input.idempotencyKey}.`,
            retryable: false,
            runId: input.runId
          }
        };
      }

      const proposalApproval = toolPolicy.requiresApproval
        ? buildApprovalBinding(
            input.workItemId,
            input.runId,
            input.taskId,
            true,
            approvalRecord?.id ?? null,
            approvalRecord?.status ?? "not_requested",
            proposalId,
            input.toolId,
            input.targetRef,
            approvalRecord?.expiresAt ?? approvalExpiry
          )
        : buildApprovalBinding(input.workItemId, input.runId, input.taskId, false);

      const proposal: ActionProposalRecord = {
        id: proposalId,
        workItemId: input.workItemId,
        runId: input.runId,
        taskId: input.taskId,
        toolId: input.toolId,
        actionClass: input.actionClass,
        actionSummary: input.actionSummary ?? `${input.actionClass} ${input.toolId} on ${input.targetRef}`,
        targetRef: input.targetRef,
        toolPayload: input.toolPayload ?? null,
        readOnly: toolPolicy.readOnly,
        supportsDryRun: toolPolicy.supportsDryRun,
        supportsPreflight: toolPolicy.supportsPreflight,
        supportsRollback: toolPolicy.supportsRollback,
        approval: proposalApproval,
        idempotency: {
          scope: toolPolicy.idempotencyScope,
          key: input.idempotencyKey,
          checkedAt: now(),
          collision: null
        },
        requiredPermissions: toolPolicy.requiredPermissions,
        evidenceShape: toolPolicy.evidenceShape,
        dryRun: buildActionCheck({
          supported: toolPolicy.supportsDryRun,
          outputRef: toolPolicy.supportsDryRun ? actionEvidenceUri(input.workItemId, "pending") : null,
          unavailableReason: toolPolicy.supportsDryRun ? null : "Dry-run is not supported for this tool."
        }),
        preflight: buildActionCheck({
          supported: !toolPolicy.supportsDryRun && toolPolicy.supportsPreflight,
          unavailableReason: !toolPolicy.supportsDryRun && toolPolicy.supportsPreflight ? null : "Preflight is not required for this tool."
        }),
        rollback: buildRollbackRecord({
          supported: toolPolicy.supportsRollback,
          unavailableReason: toolPolicy.supportsRollback ? null : "Rollback metadata unavailable for this action."
        }),
        evidenceRefs: [],
        status: "proposed",
        createdAt: now(),
        updatedAt: now()
      };
      proposal.dryRun = buildActionCheck({
        supported: toolPolicy.supportsDryRun,
        outputRef: toolPolicy.supportsDryRun ? actionEvidenceUri(proposal.id, "dry-run-result.json") : null,
        unavailableReason: toolPolicy.supportsDryRun ? null : "Dry-run is not supported for this tool."
      });
      proposal.preflight = buildActionCheck({
        supported: !toolPolicy.supportsDryRun && toolPolicy.supportsPreflight,
        outputRef: !toolPolicy.supportsDryRun && toolPolicy.supportsPreflight
          ? actionEvidenceUri(proposal.id, "preflight-result.json")
          : null,
        unavailableReason: !toolPolicy.supportsDryRun && toolPolicy.supportsPreflight ? null : "Preflight is not required for this tool."
      });
      proposal.rollback = buildRollbackRecord({
        supported: toolPolicy.supportsRollback,
        instructionsRef: toolPolicy.supportsRollback ? actionEvidenceUri(proposal.id, "rollback.md") : null,
        metadataRef: toolPolicy.supportsRollback ? actionEvidenceUri(proposal.id, "rollback.json") : null,
        unavailableReason: toolPolicy.supportsRollback ? null : "Rollback metadata unavailable for this action."
      });
      await store.write((current) => ({
        ...current,
        approvals: toolPolicy.requiresApproval && approvalRecord
          ? current.approvals.map((approval) =>
              approval.id === approvalRecord.id
                ? {
                    ...approval,
                    actionProposalId: proposal.id,
                    toolId: input.toolId,
                    targetRef: input.targetRef,
                    expiresAt: approval.expiresAt ?? approvalExpiry
                  }
                : approval
            )
          : current.approvals,
        actionProposals: [proposal, ...current.actionProposals]
      }));
      return proposal;
    },

    async execute(actionId: string) {
      const state = await store.read();
      const proposal = state.actionProposals.find((entry) => entry.id === actionId);
      if (!proposal) {
        return null;
      }
      const toolPolicy = getToolPolicy(proposal.toolId);
      if (!toolPolicy) {
        return {
          error: {
            code: "unsafe_action_blocked",
            message: `Tool ${proposal.toolId} is no longer allowed by policy.`,
            retryable: false,
            runId: proposal.runId
          }
        };
      }

      if (proposal.actionClass !== toolPolicy.actionClass) {
        return {
          error: {
            code: "unsafe_action_blocked",
            message: `Action policy mismatch for tool ${proposal.toolId}.`,
            retryable: false,
            runId: proposal.runId
          }
        };
      }

      const existingExecution = state.actionExecutions.find((entry) => entry.actionProposalId === actionId);
      if (existingExecution && proposal.status === "completed") {
        return existingExecution;
      }
      if (proposal.status === "executing") {
        return {
          error: {
            code: "action_idempotency_conflict",
            message: "Action execution is already in progress.",
            retryable: true,
            runId: proposal.runId
          }
        };
      }

      if (proposal.actionClass === "class_c") {
        const approvalId = proposal.approval.approvalId;
        const approvedBinding = approvalId
          ? state.approvals.find((approval) => approval.id === approvalId) ?? null
          : null;

        if (!approvedBinding || approvedBinding.status !== "approved") {
          const deniedBinding = state.approvals.some(
            (approval) =>
              approval.id === approvalId ||
              (
                approval.status === "denied" &&
                approval.runId === proposal.runId &&
                approval.taskId === proposal.taskId
              )
          );
          if (deniedBinding) {
            return {
              error: {
                code: "approval_required",
                message: "Class C action execution cannot proceed after a denied approval.",
                retryable: false,
                runId: proposal.runId
              }
            };
          }

          return {
            error: {
              code: "approval_required",
              message: "Class C actions require an approved approval bound to the same proposal, tool, and target surface.",
              retryable: false
            }
          };
        }

        const exactBindingMatches =
          approvedBinding.runId === proposal.runId &&
          approvedBinding.taskId === proposal.taskId &&
          approvedBinding.workItemId === proposal.workItemId &&
          approvedBinding.actionProposalId === proposal.id &&
          approvedBinding.toolId === proposal.toolId &&
          approvedBinding.targetRef === proposal.targetRef;

        if (!exactBindingMatches) {
          return {
            error: {
              code: "approval_required",
              message: "Approved approval is not bound to this exact proposal, tool, and target surface.",
              retryable: false,
              runId: proposal.runId
            }
          };
        }

        if (approvedBinding.expiresAt && Date.parse(approvedBinding.expiresAt) <= Date.now()) {
          const expiredAt = now();
          await store.write((current) => ({
            ...current,
            approvals: current.approvals.map((approval) =>
              approval.id === approvedBinding.id
                ? {
                    ...approval,
                    status: "expired",
                    decidedAt: approval.decidedAt ?? expiredAt
                  }
                : approval
            ),
            actionProposals: current.actionProposals.map((entry) =>
              entry.id === proposal.id
                ? {
                    ...entry,
                    approval: {
                      ...entry.approval,
                      status: "expired"
                    },
                    updatedAt: expiredAt
                  }
                : entry
            )
          }));
          return {
            error: {
              code: "approval_required",
              message: "Class C action approval expired before execution. Request a fresh approval.",
              retryable: false,
              runId: proposal.runId
            }
          };
        }
      }

      const approvalRecord = proposal.actionClass === "class_c" && proposal.approval.approvalId
        ? state.approvals.find((approval) => approval.id === proposal.approval.approvalId) ?? null
        : null;
      const precheckAt = now();
      const evidenceRef = actionEvidenceUri(actionId, "execution-evidence.json");
      const evidencePath = actionEvidenceLocation(actionId, "execution-evidence.json");
      const dryRunRef = toolPolicy.supportsDryRun ? actionEvidenceUri(actionId, "dry-run-result.json") : null;
      const preflightRef = !toolPolicy.supportsDryRun && toolPolicy.supportsPreflight
        ? actionEvidenceUri(actionId, "preflight-result.json")
        : null;
      const rollbackInstructionsRef = toolPolicy.supportsRollback ? actionEvidenceUri(actionId, "rollback.md") : null;
      const rollbackInstructionsPath = toolPolicy.supportsRollback ? actionEvidenceLocation(actionId, "rollback.md") : null;
      const rollbackMetadataRef = toolPolicy.supportsRollback ? actionEvidenceUri(actionId, "rollback.json") : null;
      const rollbackMetadataPath = toolPolicy.supportsRollback ? actionEvidenceLocation(actionId, "rollback.json") : null;
      const proposalApproval = buildApprovalBindingFromRecord(approvalRecord, {
        workItemId: proposal.workItemId,
        runId: proposal.runId,
        taskId: proposal.taskId,
        required: proposal.actionClass === "class_c"
      });

      if (proposal.runId) {
        await appendEvent(proposal.runId, "action.prechecks_started", {
          actionId,
          toolId: proposal.toolId,
          precheckType: toolPolicy.supportsDryRun ? "dry_run" : "preflight_or_not_available"
        });
      }

      await store.write((current) => ({
        ...current,
        actionProposals: current.actionProposals.map((entry) =>
          entry.id === actionId
            ? {
                ...entry,
                status: "executing",
                approval: proposalApproval,
                idempotency: {
                  ...entry.idempotency,
                  checkedAt: precheckAt
                },
                dryRun: buildActionCheck({
                  supported: toolPolicy.supportsDryRun,
                  outputRef: dryRunRef,
                  unavailableReason: toolPolicy.supportsDryRun ? null : "Dry-run is not supported for this tool."
                }),
                preflight: buildActionCheck({
                  supported: !toolPolicy.supportsDryRun && toolPolicy.supportsPreflight,
                  outputRef: preflightRef,
                  unavailableReason: !toolPolicy.supportsDryRun && toolPolicy.supportsPreflight ? null : "Preflight is not required for this tool."
                }),
                rollback: buildRollbackRecord({
                  supported: toolPolicy.supportsRollback,
                  instructionsRef: rollbackInstructionsRef,
                  metadataRef: rollbackMetadataRef,
                  unavailableReason: toolPolicy.supportsRollback ? null : "Rollback metadata unavailable for this action."
                }),
                evidenceRefs: [],
                updatedAt: now()
              }
            : entry
        )
      }));

      try {
        const adapterResult: ActionToolExecutionResult = await actionExecutor.execute({
          actionId,
          proposal,
          policy: toolPolicy
        });
        const executedAt = now();
        const dryRunExecutedAt = adapterResult.dryRun ? precheckAt : null;
        const preflightExecutedAt = adapterResult.preflight ? precheckAt : null;
        const dryRunEvidenceRefs = dryRunRef && adapterResult.dryRun
          ? [createActionEvidenceRef("dry_run_output", "Dry-run output", dryRunRef, dryRunExecutedAt)]
          : [];
        const preflightEvidenceRefs = preflightRef && adapterResult.preflight
          ? [createActionEvidenceRef("preflight_output", "Preflight output", preflightRef, preflightExecutedAt)]
          : [];
        const executionEvidenceRefs = [createActionEvidenceRef("execution_output", "Execution evidence", evidenceRef, executedAt)];
        const rollbackEvidenceRefs = rollbackInstructionsRef && rollbackMetadataRef && adapterResult.rollback
          ? [
              createActionEvidenceRef("rollback_instructions", "Rollback instructions", rollbackInstructionsRef, executedAt),
              createActionEvidenceRef("rollback_metadata", "Rollback metadata", rollbackMetadataRef, executedAt)
            ]
          : [];

        if (dryRunRef && adapterResult.dryRun) {
          await writeActionEvidenceArtifact(actionEvidenceLocation(actionId, "dry-run-result.json"), {
            actionId,
            checkType: "dry_run",
            executedAt: dryRunExecutedAt,
            outcome: adapterResult.dryRun.outcome,
            payload: adapterResult.dryRun.payload
          });
        }

        if (preflightRef && adapterResult.preflight) {
          await writeActionEvidenceArtifact(actionEvidenceLocation(actionId, "preflight-result.json"), {
            actionId,
            checkType: "preflight",
            executedAt: preflightExecutedAt,
            outcome: adapterResult.preflight.outcome,
            payload: adapterResult.preflight.payload
          });
        }

        if (rollbackInstructionsPath && adapterResult.rollback?.instructions) {
          await writeActionEvidenceArtifact(rollbackInstructionsPath, adapterResult.rollback.instructions);
        }

        if (rollbackMetadataPath && adapterResult.rollback?.metadata) {
          await writeActionEvidenceArtifact(rollbackMetadataPath, adapterResult.rollback.metadata);
        }

        await writeActionEvidenceArtifact(evidencePath, {
          actionProposalId: actionId,
          actionSummary: proposal.actionSummary,
          actor: adapterResult.actor,
          toolId: proposal.toolId,
          targetRef: proposal.targetRef,
          runId: proposal.runId,
          taskId: proposal.taskId,
          approval: proposalApproval,
          idempotency: proposal.idempotency,
          precheck: {
            executedAt: precheckAt,
            dryRun: adapterResult.dryRun
              ? {
                  executedAt: dryRunExecutedAt,
                  outcome: adapterResult.dryRun.outcome,
                  evidenceRef: dryRunRef
                }
              : null,
            preflight: adapterResult.preflight
              ? {
                  executedAt: preflightExecutedAt,
                  outcome: adapterResult.preflight.outcome,
                  evidenceRef: preflightRef
                }
              : null
          },
          execution: {
            executedAt,
            outcome: adapterResult.execution.outcome,
            payload: adapterResult.execution.payload
          }
        });

        const execution: ActionExecutionRecord = {
          id: randomUUID(),
          actionProposalId: actionId,
          approval: proposalApproval,
          actor: adapterResult.actor,
          toolUsed: proposal.toolId,
          targetRef: proposal.targetRef,
          requestedAction: proposal.actionSummary,
          idempotency: {
            ...proposal.idempotency,
            checkedAt: executedAt
          },
          evidenceRefs: [
            ...executionEvidenceRefs,
            ...dryRunEvidenceRefs,
            ...preflightEvidenceRefs,
            ...rollbackEvidenceRefs
          ],
          dryRun: buildActionCheck({
            supported: toolPolicy.supportsDryRun,
            status: adapterResult.dryRun ? "completed" : "unavailable",
            executedAt: dryRunExecutedAt,
            outcome: adapterResult.dryRun?.outcome ?? null,
            outputRef: dryRunRef,
            unavailableReason: toolPolicy.supportsDryRun ? null : "Dry-run is not supported for this tool.",
            evidenceRefs: dryRunEvidenceRefs
          }),
          preflight: buildActionCheck({
            supported: !toolPolicy.supportsDryRun && toolPolicy.supportsPreflight,
            status: adapterResult.preflight ? "completed" : "unavailable",
            executedAt: preflightExecutedAt,
            outcome: adapterResult.preflight?.outcome ?? null,
            outputRef: preflightRef,
            unavailableReason: !toolPolicy.supportsDryRun && toolPolicy.supportsPreflight ? null : "Preflight is not required for this tool.",
            evidenceRefs: preflightEvidenceRefs
          }),
          rollback: buildRollbackRecord({
            supported: toolPolicy.supportsRollback,
            preparedAt: adapterResult.rollback ? executedAt : null,
            instructionsRef: rollbackInstructionsRef,
            metadataRef: rollbackMetadataRef,
            unavailableReason: toolPolicy.supportsRollback ? null : "Rollback metadata unavailable for this action.",
            evidenceRefs: rollbackEvidenceRefs
          }),
          startedAt: executedAt,
          endedAt: executedAt,
          outcome: `${adapterResult.execution.outcome}: ${proposal.toolId} -> ${proposal.targetRef}`
        };

        const artifactRecords = proposal.runId
          ? [
              createArtifactRecord(
                proposal.runId,
                proposal.taskId,
                "action_execution_evidence",
                evidencePath,
                `Execution evidence for ${proposal.toolId} on ${proposal.targetRef}.`
              ),
              ...(dryRunRef
                ? [
                    createArtifactRecord(
                      proposal.runId,
                      proposal.taskId,
                      "action_dry_run_output",
                      actionEvidenceLocation(actionId, "dry-run-result.json"),
                      `Dry-run output for ${proposal.toolId} on ${proposal.targetRef}.`
                    )
                  ]
                : []),
              ...(preflightRef
                ? [
                    createArtifactRecord(
                      proposal.runId,
                      proposal.taskId,
                      "action_preflight_output",
                      actionEvidenceLocation(actionId, "preflight-result.json"),
                      `Preflight output for ${proposal.toolId} on ${proposal.targetRef}.`
                    )
                  ]
                : []),
              ...(rollbackInstructionsPath
                ? [
                    createArtifactRecord(
                      proposal.runId,
                      proposal.taskId,
                      "action_rollback_instructions",
                      rollbackInstructionsPath,
                      `Rollback instructions for ${proposal.toolId} on ${proposal.targetRef}.`
                    )
                  ]
                : []),
              ...(rollbackMetadataPath
                ? [
                    createArtifactRecord(
                      proposal.runId,
                      proposal.taskId,
                      "action_rollback_metadata",
                      rollbackMetadataPath,
                      `Rollback metadata for ${proposal.toolId} on ${proposal.targetRef}.`
                    )
                  ]
                : [])
            ]
          : [];

        await store.write((current) => ({
          ...current,
          actionProposals: current.actionProposals.map((entry) =>
            entry.id === actionId
              ? {
                  ...entry,
                  status: "completed",
                  approval: proposalApproval,
                  idempotency: {
                    ...entry.idempotency,
                    checkedAt: executedAt
                  },
                  dryRun: execution.dryRun,
                  preflight: execution.preflight,
                  rollback: execution.rollback,
                  evidenceRefs: execution.evidenceRefs,
                  updatedAt: now()
                }
              : entry
          ),
          actionExecutions: [execution, ...current.actionExecutions],
          artifacts: [...artifactRecords, ...current.artifacts]
        }));

        if (proposal.runId) {
          await appendEvent(proposal.runId, "action.executed", {
            actionId,
            executionId: execution.id,
            evidenceRef,
            rollbackRef: rollbackInstructionsRef
          });
        }
        return execution;
      } catch (error) {
        const failedAt = now();
        await store.write((current) => ({
          ...current,
          actionProposals: current.actionProposals.map((entry) =>
            entry.id === actionId
              ? {
                  ...entry,
                  status: "failed",
                  updatedAt: failedAt
                }
              : entry
          )
        }));

        if (proposal.runId) {
          await appendEvent(proposal.runId, "action.execution_failed", {
            actionId,
            toolId: proposal.toolId,
            error: error instanceof Error ? error.message : "Unknown action execution error"
          });
        }
        return {
          error: {
            code: "action_preflight_failed",
            message: "Action execution failed before completion.",
            retryable: false,
            runId: proposal.runId
          }
        };
      }
    },

    async get(actionId: string) {
      const state = await store.read();
      const proposalRecord = state.actionProposals.find((entry) => entry.id === actionId) ?? null;
      const execution = state.actionExecutions.find((entry) => entry.actionProposalId === actionId) ?? null;
      if (!proposalRecord) {
        return null;
      }

      const currentApproval = proposalRecord.actionClass === "class_c"
        ? (
            proposalRecord.approval.approvalId
              ? state.approvals.find((approval) => approval.id === proposalRecord.approval.approvalId) ?? null
              : state.approvals.find((approval) => approval.runId === proposalRecord.runId && approval.taskId === proposalRecord.taskId) ?? null
          )
        : null;
      const proposal = {
        ...proposalRecord,
        approval: currentApproval
          ? buildApprovalBindingFromRecord(currentApproval, {
              workItemId: proposalRecord.workItemId,
              runId: proposalRecord.runId,
              taskId: proposalRecord.taskId,
              required: proposalRecord.actionClass === "class_c"
            })
          : proposalRecord.approval
      };

      return { proposal, execution };
    }
  };

  const materials = {
    async create(agentCatalogEntryId: string, runId: string | null) {
      return await createMaterialization(agentCatalogEntryId, runId);
    },

    async get(materializationId: string) {
      const state = await store.read();
      return state.materializations.find((entry) => entry.id === materializationId) ?? null;
    }
  };

  const incidents = {
    async list(filters?: { runId?: string; serviceRef?: string; status?: IncidentStatus }) {
      const state = await store.read();
      return state.incidents.filter((incident) => {
        if (filters?.runId && incident.runId !== filters.runId) {
          return false;
        }
        if (filters?.serviceRef && incident.serviceRef !== filters.serviceRef) {
          return false;
        }
        if (filters?.status && incident.status !== filters.status) {
          return false;
        }
        return true;
      });
    },

    async get(incidentId: string) {
      const state = await store.read();
      return state.incidents.find((entry) => entry.id === incidentId) ?? null;
    },

    async create(input: {
      runId?: string | null;
      serviceRef?: string | null;
      severity: IncidentSeverity;
      summary: string;
    }) {
      return await createIncidentRecord({
        runId: input.runId ?? null,
        serviceRef: input.serviceRef ?? null,
        severity: input.severity,
        summary: input.summary
      });
    },

    async transition(incidentId: string, status: IncidentStatus, summary: string) {
      return await transitionIncidentRecord(incidentId, status, summary);
    }
  };

  const evaluations = {
    async create(profile: string) {
      const startedAt = now();
      const evaluationRunId = randomUUID();
      const artifactDir = path.join(config.paths.artifactsRoot, "evaluations", evaluationRunId);
      const artifactPath = path.join(artifactDir, "decision-quality.json");
      await fs.mkdir(artifactDir, { recursive: true });

      const harness = await createEvaluationHarness(config, evaluationRunId);
      try {
        const scenarios = await runDecisionQualityEvaluation(harness);
        const decisionPoints = summarizeEvaluationDecisionPoints(scenarios);
        const overallScore =
          scenarios.length === 0 ? 0 : Number((scenarios.filter((scenario) => scenario.passed).length / scenarios.length).toFixed(2));
        const record: EvaluationRunRecord = {
          id: evaluationRunId,
          profile,
          status: "completed",
          summary: `Decision quality ${Math.round(overallScore * 100)}% across routing, clarification, and specialist selection.`,
          decisionPoints,
          scenarios,
          overallScore,
          artifactPath,
          startedAt,
          endedAt: now()
        };

        await fs.writeFile(
          artifactPath,
          JSON.stringify(
            {
              evaluationRunId: record.id,
              profile: record.profile,
              summary: record.summary,
              overallScore: record.overallScore,
              decisionPoints: record.decisionPoints,
              scenarios: record.scenarios,
              startedAt: record.startedAt,
              endedAt: record.endedAt
            },
            null,
            2
          ),
          "utf8"
        );

        await store.write((current) => ({
          ...current,
          artifacts: [
            createArtifactRecord(
              null,
              null,
              "evaluation_result",
              artifactPath,
              `Decision quality evaluation output for profile ${record.profile}.`,
              record.id
            ),
            ...current.artifacts
          ],
          evaluationRuns: [record, ...current.evaluationRuns]
        }));
        return record;
      } finally {
        await harness.cleanup();
      }
    },

    async get(evaluationRunId: string) {
      const state = await store.read();
      return state.evaluationRuns.find((entry) => entry.id === evaluationRunId) ?? null;
    }
  };

  const diagnostics = {
    async getMetrics() {
      const providerStatus = await provider.getStatus();
      const state = await store.read();
      return buildRuntimeMetricsSnapshot({
        serviceName,
        processStartsTotal: 1,
        startedAt: serviceStartedAt,
        providerStatus,
        state
      });
    },

    async getDiagnostics(): Promise<DiagnosticsSnapshot> {
      const providerStatus = await provider.getStatus();
      const state = await store.read();
      return buildDiagnosticsSnapshot({
        config,
        providerStatus,
        state,
        promptArtifacts
      });
    },

    async getRunDiagnostics(runId: string): Promise<RunDiagnosticsView | null> {
      const state = await store.read();
      const run = state.runs.find((entry) => entry.id === runId) ?? null;
      if (!run) {
        return null;
      }
      const catalogSync = state.catalogSyncs.find((entry) => entry.id === run.catalogSyncRunId) ?? null;
      const budgetProfile = findBudgetProfileById(run.budgetProfileId);
      const runEvents = state.runEvents.filter((entry) => entry.runId === runId);
      const latestEvent = [...runEvents].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
      const pendingApprovalIds = state.approvals
        .filter((entry) => entry.runId === runId && entry.status === "pending")
        .map((entry) => entry.id);
      const degradedRun = buildDiagnosticsSnapshot({
        config,
        providerStatus: await provider.getStatus(),
        state,
        promptArtifacts
      }).degradedRuns.find((entry) => entry.runId === runId) ?? null;
      const activeIncident = state.incidents.find((entry) => entry.runId === runId && entry.status !== "resolved") ?? null;
      const latestEvaluation = state.evaluationRuns[0] ?? null;
      const incidentEvidenceRefs = activeIncident?.evidenceRefs ?? buildIncidentEvidenceRefs(
        state,
        runId,
        serviceName,
        run.summary,
        activeIncident?.status ?? "open"
      );
      const controlDecisions = [...runEvents]
        .filter((entry) => CONTROL_REASON_EVENT_TYPES.has(entry.eventType))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 6)
        .map((entry) => ({
          eventType: entry.eventType,
          createdAt: entry.createdAt,
          reason:
            typeof entry.payload.reason === "string"
              ? entry.payload.reason
              : typeof entry.payload.recoveryStrategy === "string"
                ? entry.payload.recoveryStrategy
                : null
        }));
      const replaySafety = {
        safe: REPLAY_SAFE_RUN_STATUSES.includes(run.status),
        reason: REPLAY_SAFE_RUN_STATUSES.includes(run.status)
          ? "Run is not active and its stored events can be replayed safely for diagnostics."
          : `Run is still active or waiting on operator input (${run.status}); replay is blocked until it reaches a paused or terminal state.`,
        replayableEvents: runEvents.length
      };
      const runnerJob = state.runnerJobs.find((entry) => entry.runId === runId) ?? null;
      const materializationsUsed = state.materializations.filter((entry) => entry.runId === runId).length;
      const budgetReasons: string[] = [];
      const retriesUsed = runnerJob?.attemptCount ?? 0;
      if (budgetProfile && retriesUsed >= budgetProfile.retryCeiling) {
        budgetReasons.push(
          `Retry ceiling reached (${retriesUsed}/${budgetProfile.retryCeiling}).`
        );
      }
      if (budgetProfile && materializationsUsed > budgetProfile.materializationCeiling) {
        budgetReasons.push(
          `Materialization ceiling exceeded (${materializationsUsed}/${budgetProfile.materializationCeiling}).`
        );
      }
      const autonomousReleaseGate = buildAutonomousReleaseGate(
        promptArtifacts,
        latestEvaluation,
        state.promptGovernance.reevaluationPending
      );
      const operatorActions =
        run.status === "paused"
          ? [
              "Confirm the pause reason trail and only resume once the operator is ready for work to continue.",
              "Review replay safety before replaying stored events or resuming execution."
            ]
          : run.status === "blocked" && pendingApprovalIds.length > 0
          ? [
              "Review the pending approval and confirm whether the blocked action should proceed.",
              "Inspect the run event stream to confirm the transition into the blocked state."
            ]
          : run.status === "failed"
            ? [
                "Review the retained log, metric, trace, and event evidence before rerunning the work.",
                "Confirm provider, runner, and materialization diagnostics before recovery."
              ]
            : degradedRun
              ? [
                  "Use the trace and log references to correlate the degraded run across services.",
                  "Check operator diagnostics and recent run events before changing runtime state."
                ]
              : [
                  "Use the trace and diagnostics references to review the completed runtime path.",
                  "Confirm the provider snapshot timing and event count if further audit evidence is needed."
                ];
      return {
        run,
        catalogSync,
        budgetProfile,
        runtimes: state.agentRuntimes.filter((entry) => entry.runId === runId),
        taskCount: state.tasks.filter((entry) => entry.runId === runId).length,
        eventCount: runEvents.length,
        providerSnapshot: run.providerSnapshot,
        lastEvent: latestEvent ? { eventType: latestEvent.eventType, createdAt: latestEvent.createdAt } : null,
        pendingApprovalIds,
        degradedReason: degradedRun?.reason ?? null,
        activeIncident,
        incidentEvidenceRefs,
        trace: {
          traceId: run.traceId,
          requestId: run.requestId,
          sessionId: run.sessionId,
          workItemId: run.workItemId,
          correlationHeaders: Object.values(CORRELATION_HEADER_NAMES),
          logRef: `log://runs/${runId}?traceId=${encodeURIComponent(run.traceId)}`,
          metricRef: `metric://runs/${runId}?traceId=${encodeURIComponent(run.traceId)}`,
          traceRef: `trace://runs/${runId}?traceId=${encodeURIComponent(run.traceId)}`,
          diagnosticsRef: `/api/admin/runs/${runId}/diagnostics`
        },
        latestEvaluation: latestEvaluation
          ? {
              id: latestEvaluation.id,
              profile: latestEvaluation.profile,
              overallScore: latestEvaluation.overallScore,
              summary: latestEvaluation.summary,
              artifactPath: latestEvaluation.artifactPath,
              endedAt: latestEvaluation.endedAt
            }
          : null,
        controlDecisions,
        replaySafety,
        autonomousBudget: {
          profile: budgetProfile?.name ?? run.budgetProfileId,
          concurrencyCeiling: budgetProfile?.concurrencyCeiling ?? AUTONOMOUS_BUDGET_POLICY.concurrencyCeiling,
          wallClockBudgetMinutes: budgetProfile?.wallClockBudgetMinutes ?? AUTONOMOUS_BUDGET_POLICY.wallClockBudgetMinutes,
          retryCeiling: budgetProfile?.retryCeiling ?? AUTONOMOUS_BUDGET_POLICY.retryCeiling,
          retriesUsed,
          materializationCeiling: budgetProfile?.materializationCeiling ?? AUTONOMOUS_BUDGET_POLICY.materializationCeiling,
          materializationsUsed,
          providerUsageBudget: budgetProfile?.providerUsageBudget ?? AUTONOMOUS_BUDGET_POLICY.providerUsageBudget,
          withinBudget: budgetReasons.length === 0,
          reasons: budgetReasons
        },
        autonomousReleaseGate,
        operatorActions
      };
    },

    async verifyBackup() {
      const state = await store.read();
      if (config.storage.mode === "postgres") {
        return await verifyPostgresBackup(config, state);
      }

      const backupPath = path.join(config.paths.backupsRoot, `state-${Date.now()}.json`);
      await fs.writeFile(backupPath, JSON.stringify(state, null, 2));
      const verifiedAt = new Date().toISOString();
      const evidencePath = await writeBackupVerificationEvidence(config, {
        schemaVersion: "backup_verification.v1",
        verifiedAt,
        storageMode: "memory",
        ok: true,
        restoreVerified: false,
        backupPath,
        restoreSchema: null,
        sourceSchema: null
      });
      return {
        ok: true,
        restoreVerified: false,
        backupPath,
        evidencePath,
        drillEvidencePath: evidencePath
      };
    }
  };

  await restoreActiveRuns();

  const configValidator = {
    validate() {
      return validateConfig(config);
    }
  };

  return {
    pa,
    collaboration,
    provider,
    catalog: {
      sync: async () => (await syncCatalogIntoState()).sync,
      listEntries: async () => (await store.read()).catalogEntries,
      getEntry: async (agentId: string) => (await store.read()).catalogEntries.find((entry) => entry.id === agentId) ?? null,
      getSync: async (syncId: string) => (await store.read()).catalogSyncs.find((entry) => entry.id === syncId) ?? null
    },
    materials,
    incidents,
    runs,
    runner,
    clarifications,
    approvals,
    actions,
    evaluations,
    diagnostics,
    configValidator,
    async shutdown() {
      shuttingDown = true;
      for (const timer of runTimers.values()) {
        clearTimeout(timer);
      }
      runTimers.clear();
      await Promise.allSettled(activeRunJobs);
      await store.flush();
      await store.close?.();
      listeners.clear();
    }
  };
}
