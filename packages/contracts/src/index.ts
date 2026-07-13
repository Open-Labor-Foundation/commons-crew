export type Surface = "cli" | "web";
export type MessageKind = "chat" | "clarification" | "plan" | "result" | "warning";
export type RequestType = "chat" | "planning" | "execution";
export type ClarificationStatus = "pending" | "resolved";
export type RunStatus = "queued" | "running" | "blocked" | "awaiting_clarification" | "completed" | "failed" | "cancelled" | "paused";
export type TaskStatus = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type ClarificationState = "open" | "resolved" | "abandoned";
export type RunnerJobStatus = "queued" | "claimed" | "running" | "blocked" | "paused" | "completed" | "failed" | "cancelled";
export type RunnerJobFailureCode = "approval_denied" | "dispatch_failed" | "execution_error" | "provider_unavailable" | "runner_unreachable" | "cancelled" | "unknown";

export const API_CONTRACT_VERSION = "1.0";
export const EVENT_CONTRACT_VERSION = "1.0";
export const API_CONTRACT_VERSION_HEADER = "x-pa-api-contract-version";
export const EVENT_CONTRACT_VERSION_HEADER = "x-pa-event-contract-version";

export type ContractGovernance = {
  http: {
    version: string;
    policy: "additive_within_major";
    breakingChangeRequires: "major_version_bump";
  };
  events: {
    version: string;
    policy: "additive_within_major";
    breakingChangeRequires: "major_version_bump";
  };
};

export type VersionedContractDescriptor = {
  version: string;
  policy: "additive_within_major";
  artifact: string;
  breakingChangeRequires: "major_version_bump";
};

export const CONTRACT_GOVERNANCE: ContractGovernance = {
  http: {
    version: API_CONTRACT_VERSION,
    policy: "additive_within_major",
    breakingChangeRequires: "major_version_bump"
  },
  events: {
    version: EVENT_CONTRACT_VERSION,
    policy: "additive_within_major",
    breakingChangeRequires: "major_version_bump"
  }
};

export const RUN_STATUS_VALUES: RunStatus[] = [
  "queued",
  "running",
  "blocked",
  "awaiting_clarification",
  "completed",
  "failed",
  "cancelled",
  "paused"
];

export const TASK_STATUS_VALUES: TaskStatus[] = [
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled"
];

export const APPROVAL_STATUS_VALUES: ApprovalStatus[] = [
  "pending",
  "approved",
  "denied",
  "expired"
];

export const RUNNER_JOB_STATUS_VALUES: RunnerJobStatus[] = [
  "queued",
  "claimed",
  "running",
  "blocked",
  "paused",
  "completed",
  "failed",
  "cancelled"
];

export const AUTONOMOUS_BACKLOG_CONTRACT_VERSION = "pa_autonomous_backlog.v1";
export const AUTONOMOUS_STATE_CONTRACT_VERSION = "pa_autonomous_state.v1";
export const AUTONOMOUS_EVIDENCE_CONTROLS_CONTRACT_VERSION = "pa_autonomous_controls.v1";
export const AUTONOMOUS_BUDGET_GATES_CONTRACT_VERSION = "pa_autonomous_budget_gates.v1";

export type AutonomousIntegrationFieldDescriptor = {
  field: string;
  source: string;
  description: string;
};

export type AutonomousIntegrationInvariant = {
  rule: string;
  description: string;
};

export type AutonomousBacklogExchangeContract = {
  contractVersion: typeof AUTONOMOUS_BACKLOG_CONTRACT_VERSION;
  sourceOfTruth: {
    localBacklogRef: string;
    issueTracker: "github";
    branchIssueSelection: "current_branch_issue";
  };
  requiredFields: AutonomousIntegrationFieldDescriptor[];
  invariants: AutonomousIntegrationInvariant[];
};

export type AutonomousRuntimeStateExchangeContract = {
  contractVersion: typeof AUTONOMOUS_STATE_CONTRACT_VERSION;
  requiredFields: AutonomousIntegrationFieldDescriptor[];
  statusEnums: {
    run: RunStatus[];
    task: TaskStatus[];
    approval: ApprovalStatus[];
    runnerJob: RunnerJobStatus[];
  };
  invariants: AutonomousIntegrationInvariant[];
};

export type AutonomousOperatorControlDescriptor = {
  name: string;
  surface: "api" | "cli";
  target: string;
  description: string;
};

export type BudgetProfile = {
  id: string;
  name: string;
  concurrencyCeiling: number;
  wallClockBudgetMinutes: number;
  retryCeiling: number;
  materializationCeiling: number;
  providerUsageBudget: string;
};

export type ConfigProfileRecord = {
  id: string;
  workspaceId: string;
  name: string;
  environment: string;
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
};

export type FeatureFlagRecord = {
  id: string;
  configProfileId: string;
  flagKey: string;
  flagValue: boolean;
  rolloutState: "enabled" | "disabled";
  createdAt: string;
  updatedAt: string;
};

export type PromptSpecRecord = {
  id: string;
  scopeType:
    | "pa"
    | "routing"
    | "chat"
    | "planning"
    | "specialist"
    | "execution"
    | "tool_use"
    | "final_result"
    | "materialization"
    | "evaluation";
  scopeRef: string;
  version: string;
  status: "draft" | "approved" | "active" | "retired";
  contentRef: string;
  createdAt: string;
  updatedAt: string;
};

export type ProviderProfileRecord = {
  id: string;
  workspaceId: string;
  providerType: string;
  displayName: string;
  transportMode: "cli" | "api";
  isDefault: boolean;
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
};

export type MigrationRecord = {
  id: string;
  migrationKey: string;
  appliedAt: string;
  appliedBy: string;
  status: "applied" | "superseded";
};

export type AutonomousEvidenceAndControlsContract = {
  contractVersion: typeof AUTONOMOUS_EVIDENCE_CONTROLS_CONTRACT_VERSION;
  evidenceFields: AutonomousIntegrationFieldDescriptor[];
  operatorControls: AutonomousOperatorControlDescriptor[];
  replaySafety: {
    safeRunStatuses: RunStatus[];
    blockedRunStatuses: RunStatus[];
    reasonTrailEventTypes: string[];
  };
  invariants: AutonomousIntegrationInvariant[];
};

export type AutonomousBudgetAndReleaseGatingContract = {
  contractVersion: typeof AUTONOMOUS_BUDGET_GATES_CONTRACT_VERSION;
  budgetFields: AutonomousIntegrationFieldDescriptor[];
  releaseGateFields: AutonomousIntegrationFieldDescriptor[];
  defaultBudgetProfile: Omit<BudgetProfile, "id">;
  releaseBlockingThresholds: Array<{
    domain: string;
    threshold: string;
  }>;
  operatorOverride: {
    supported: boolean;
    description: string;
  };
  invariants: AutonomousIntegrationInvariant[];
};

export type AutonomousIntegrationContract = {
  documentationRef: string;
  backlog: AutonomousBacklogExchangeContract;
  runtimeState: AutonomousRuntimeStateExchangeContract;
  evidenceAndControls: AutonomousEvidenceAndControlsContract;
  budgetAndReleaseGating: AutonomousBudgetAndReleaseGatingContract;
};

export const AUTONOMOUS_INTEGRATION_CONTRACT: AutonomousIntegrationContract = {
  documentationRef: "docs/autonomous-integration-contract.md",
  backlog: {
    contractVersion: AUTONOMOUS_BACKLOG_CONTRACT_VERSION,
    sourceOfTruth: {
      localBacklogRef: "docs/phase-2-backlog.md",
      issueTracker: "github",
      branchIssueSelection: "current_branch_issue"
    },
    requiredFields: [
      {
        field: "workItem.id",
        source: "persistentState.workItems[].id",
        description: "Stable work-item identifier mirrored into PA state."
      },
      {
        field: "workItem.title",
        source: "persistentState.workItems[].title",
        description: "Human-readable work-item title used in operator and autonomous views."
      },
      {
        field: "workItem.summary",
        source: "persistentState.workItems[].summary",
        description: "Execution summary carried with the local work-item mirror."
      },
      {
        field: "workItem.status",
        source: "persistentState.workItems[].status",
        description: "Open or closed work-item state used to gate follow-on work."
      },
      {
        field: "issue.number",
        source: "github.issue.number",
        description: "Canonical GitHub issue number resolved from the current branch."
      },
      {
        field: "issue.parentLink",
        source: "github.issue.body",
        description: "Parent or child issue linkage that bounds autonomous execution."
      },
      {
        field: "issue.verifyCommands",
        source: "github.issue.body",
        description: "Verification commands declared in the issue's Verify with section."
      },
      {
        field: "workspace.branch",
        source: "git.branch.current",
        description: "Checked-out branch used for the active autonomous workspace."
      }
    ],
    invariants: [
      {
        rule: "issue_number_and_work_item_id_must_remain_stable",
        description: "Autonomous execution must keep the same issue/work-item identity for the life of a scoped change."
      },
      {
        rule: "verification_commands_must_come_from_the_issue",
        description: "Verification requirements are exchanged explicitly from the issue body rather than inferred from prompts."
      },
      {
        rule: "follow_on_work_requires_explicit_completion_state",
        description: "Autonomous follow-on work depends on an explicit work-item or issue completion state."
      }
    ]
  },
  runtimeState: {
    contractVersion: AUTONOMOUS_STATE_CONTRACT_VERSION,
    requiredFields: [
      {
        field: "workspace.id",
        source: "persistentState.workspace.id",
        description: "Workspace identity shared across PA and autonomous-engine state transitions."
      },
      {
        field: "session.id",
        source: "persistentState.sessions[].id",
        description: "Interactive session identity attached to the active request."
      },
      {
        field: "run.id",
        source: "persistentState.runs[].id",
        description: "Run identifier used to coordinate autonomous progress and evidence."
      },
      {
        field: "run.status",
        source: "persistentState.runs[].status",
        description: "Run lifecycle state that determines whether work continues, waits, or stops."
      },
      {
        field: "run.mode",
        source: "persistentState.runs[].mode",
        description: "Execution mode describing whether PA runs directly or delegates specialist work."
      },
      {
        field: "task.status",
        source: "persistentState.tasks[].status",
        description: "Task lifecycle state attached to the current autonomous step."
      },
      {
        field: "runnerJob.status",
        source: "persistentState.runnerJobs[].status",
        description: "Runner-side execution state used for pause, resume, and replay safety."
      },
      {
        field: "approval.status",
        source: "persistentState.approvals[].status",
        description: "Approval state that blocks or allows autonomous side effects."
      },
      {
        field: "verification.result",
        source: "github.issue.body + runtime evidence attached to the current change set",
        description: "Observed verification outcome for the commands required by the active issue."
      },
      {
        field: "blocking.reason",
        source: "persistentState.clarificationThreads[].blockingReason + runnerJobs[].failure",
        description: "Operator-visible reason explaining why work is paused, blocked, throttled, or failed."
      }
    ],
    statusEnums: {
      run: RUN_STATUS_VALUES,
      task: TASK_STATUS_VALUES,
      approval: APPROVAL_STATUS_VALUES,
      runnerJob: RUNNER_JOB_STATUS_VALUES
    },
    invariants: [
      {
        rule: "state_transitions_must_be_explicit",
        description: "Pause, resume, block, cancel, and completion decisions must be represented in stored runtime state."
      },
      {
        rule: "restart_recovery_uses_persisted_state",
        description: "A resumed runner determines whether to continue from persisted run, task, runner-job, and approval state."
      },
      {
        rule: "blocking_and_pause_reasons_must_be_operator_visible",
        description: "Autonomous-engine must surface a durable reason trail when work cannot continue."
      }
    ]
  },
  evidenceAndControls: {
    contractVersion: AUTONOMOUS_EVIDENCE_CONTROLS_CONTRACT_VERSION,
    evidenceFields: [
      {
        field: "runEvent.eventType",
        source: "persistentState.runEvents[].eventType",
        description: "Stored run events record pause, resume, replay, recovery, and cancellation decisions."
      },
      {
        field: "runEvent.payload.reason",
        source: "persistentState.runEvents[].payload.reason",
        description: "Operator or system reason trail attached to autonomous control and replay decisions."
      },
      {
        field: "runnerJob.failure",
        source: "persistentState.runnerJobs[].failure",
        description: "Runner-side failure evidence used to explain blocked, failed, or replay-sensitive work."
      },
      {
        field: "evaluationRun.artifactPath",
        source: "persistentState.evaluationRuns[].artifactPath",
        description: "Retained evaluation artifact that justifies an autonomous improvement or tuning posture."
      }
    ],
    operatorControls: [
      {
        name: "run_control_api",
        surface: "api",
        target: "POST /api/runs/:runId/control",
        description: "Pause, resume, or cancel autonomous work while preserving a durable reason trail."
      },
      {
        name: "run_diagnostics_api",
        surface: "api",
        target: "GET /api/admin/runs/:runId/diagnostics",
        description: "Inspect operator-visible evidence, control decisions, and replay safety for a run."
      },
      {
        name: "run_replay_api",
        surface: "api",
        target: "POST /api/admin/runs/:runId/replay-events",
        description: "Replay stored run events only when the run is in a replay-safe state."
      },
      {
        name: "run_pause_cli",
        surface: "cli",
        target: "npm run cli -- run:pause <runId> [reason]",
        description: "Pause a run from the operator CLI and attach an optional reason."
      },
      {
        name: "run_resume_cli",
        surface: "cli",
        target: "npm run cli -- run:resume <runId> [reason]",
        description: "Resume a paused run from the operator CLI and attach an optional reason."
      }
    ],
    replaySafety: {
      safeRunStatuses: ["completed", "failed", "cancelled", "paused"],
      blockedRunStatuses: ["queued", "running", "blocked", "awaiting_clarification"],
      reasonTrailEventTypes: ["run.paused", "run.resumed", "run.cancelled", "run.recovered", "runner.job.requeued", "run.replay_requested"]
    },
    invariants: [
      {
        rule: "pause_and_resume_require_reason_trail",
        description: "Pause and resume actions must emit durable evidence that explains why the control changed."
      },
      {
        rule: "replay_requires_non_active_run",
        description: "Replay diagnostics must not run against active autonomous work that is still changing state."
      },
      {
        rule: "autonomous_improvement_evidence_must_reference_retained_artifacts",
        description: "Any autonomous improvement posture must point to retained evaluation evidence rather than transient output."
      }
    ]
  },
  budgetAndReleaseGating: {
    contractVersion: AUTONOMOUS_BUDGET_GATES_CONTRACT_VERSION,
    budgetFields: [
      {
        field: "run.budgetProfile",
        source: "runtime diagnostics derived from bounded autonomous defaults",
        description: "Named budget profile applied to autonomous work for concurrency, retries, wall-clock time, and materialization."
      },
      {
        field: "runnerJob.maxAttempts",
        source: "persistentState.runnerJobs[].maxAttempts",
        description: "Retry ceiling carried with the active autonomous runner job."
      },
      {
        field: "materialization.count",
        source: "persistentState.materializations[].runId",
        description: "Materialization usage counted against the bounded autonomous materialization ceiling."
      }
    ],
    releaseGateFields: [
      {
        field: "promptGovernance.reevaluationPending",
        source: "persistentState.promptGovernance.reevaluationPending",
        description: "Release gate remains blocked while governed prompt or orchestration changes still require reevaluation."
      },
      {
        field: "promptGovernance.reevaluationChecks",
        source: "persistentState.promptGovernance.reevaluationChecks",
        description: "Required verification commands that must be satisfied before self-improvement work can influence release posture."
      },
      {
        field: "evaluationRun.overallScore",
        source: "persistentState.evaluationRuns[].overallScore",
        description: "Retained evaluation score used to judge whether autonomous tuning met release-blocking thresholds."
      },
      {
        field: "evaluationRun.artifactPath",
        source: "persistentState.evaluationRuns[].artifactPath",
        description: "Retained evaluation artifact proving the evidence behind an autonomous tuning or self-improvement decision."
      }
    ],
    defaultBudgetProfile: {
      name: "bounded_autonomous_default",
      concurrencyCeiling: 1,
      wallClockBudgetMinutes: 30,
      retryCeiling: 3,
      materializationCeiling: 1,
      providerUsageBudget: "operator_review_required_when_available"
    },
    releaseBlockingThresholds: [
      {
        domain: "routing and delegation",
        threshold: "at least 90% of applicable acceptance scenarios pass"
      },
      {
        domain: "clarification",
        threshold: "at least 95% of ambiguity scenarios request clarification before execution"
      },
      {
        domain: "approval safety",
        threshold: "100% of side-effecting scenarios stop for explicit approval before execution"
      },
      {
        domain: "specialist selection",
        threshold: "all curated specialist-selection scenarios pass in the retained Phase 2 evaluation fixture"
      }
    ],
    operatorOverride: {
      supported: false,
      description: "This phase exposes blocked autonomous release posture directly; operator overrides are not modeled yet and may not silently bypass the gate."
    },
    invariants: [
      {
        rule: "autonomous_work_uses_bounded_budget_defaults",
        description: "Autonomous execution must stay within explicit concurrency, retry, wall-clock, and materialization ceilings."
      },
      {
        rule: "self_improvement_release_gate_requires_retained_evidence",
        description: "Self-improvement work stays release-blocked until retained evaluation evidence and required checks exist."
      },
      {
        rule: "release_posture_must_record_threshold_outcome",
        description: "Autonomous tuning diagnostics must surface whether each measured release threshold passed, failed, or remains unmeasured."
      }
    ]
  }
};
export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentStatus = "open" | "investigating" | "monitoring" | "resolved";
export type IncidentEvidenceKind = "log" | "metric" | "trace" | "run" | "event_stream" | "diagnostic";
export type UserRole = "primary" | "supporting";
export type UserStatus = "active" | "inactive";
export type WorkspaceMembershipStatus = "active" | "revoked";
export type SupportUserPermission = "work_item_collaboration" | "approval_decision";
export type CollaborationThreadStatus = "open" | "resolved";

export type UserRecord = {
  id: string;
  emailOrLogin: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastSeenAt: string | null;
};

export type WorkspaceMembershipRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  role: UserRole;
  permissions: SupportUserPermission[];
  status: WorkspaceMembershipStatus;
  addedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceRecord = {
  id: string;
  ownerUserId: string;
  name: string;
  mode: "single_user" | "collaborative";
  createdAt: string;
};

export type MessageRecord = {
  id: string;
  sessionId: string;
  authorType: "user" | "pa";
  content: string;
  messageKind: MessageKind;
  createdAt: string;
};

export type SessionRecord = {
  id: string;
  workspaceId: string;
  workItemId: string | null;
  surface: Surface;
  title: string;
  status: "active" | "paused" | "awaiting_clarification" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type WorkItemRecord = {
  id: string;
  workspaceId: string;
  title: string;
  summary: string;
  status: "open" | "closed";
  createdAt: string;
  updatedAt: string;
};

export type WorkItemCollaborationThreadRecord = {
  id: string;
  workItemId: string;
  workspaceId: string;
  title: string;
  status: CollaborationThreadStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkItemCollaborationMessageRecord = {
  id: string;
  threadId: string;
  workItemId: string;
  workspaceId: string;
  authorUserId: string;
  content: string;
  createdAt: string;
};

export type WorkItemCollaborationThreadView = {
  thread: WorkItemCollaborationThreadRecord;
  messages: WorkItemCollaborationMessageRecord[];
};

export type RequestRecord = {
  id: string;
  sessionId: string;
  messageId: string;
  requestType: RequestType;
  status: "accepted" | "clarification_required" | "completed";
  createdAt: string;
};

export type ClarificationRecord = {
  id: string;
  sessionId: string;
  requestId: string;
  userMessageId: string;
  assistantMessageId: string;
  requestType: Exclude<RequestType, "chat">;
  originalContent: string;
  prompt: string;
  status: ClarificationStatus;
  resolvedByMessageId: string | null;
  resolutionSummary: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type PlanRecord = {
  id: string;
  sessionId: string;
  workItemId: string;
  version: number;
  title: string;
  summary: string;
  status: "draft" | "locked" | "awaiting_clarification" | "superseded";
  lockedAt: string | null;
  createdAt: string;
};

export type PlanStepRecord = {
  id: string;
  planId: string;
  sequence: number;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "deferred";
  required: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PlanChangeRequestRecord = {
  id: string;
  planId: string;
  runId: string;
  reason: string;
  status: "pending_approval" | "approved" | "denied" | "applied";
  requestedByType: "pa" | "user";
  requestedAt: string;
  decidedAt: string | null;
};

export type ClarificationThreadRecord = {
  id: string;
  sessionId: string;
  planId: string | null;
  runId: string | null;
  title: string;
  state: ClarificationState;
  status: ClarificationState;
  blockingReason: string | null;
  createdAt: string;
  openedAt: string;
  resolvedAt: string | null;
  sessionStatusBefore: SessionRecord["status"] | null;
  planStatusBefore: PlanRecord["status"] | null;
  runStatusBefore: RunStatus | null;
};

export type ClarificationMessageRecord = {
  id: string;
  threadId: string;
  authorType: "user" | "pa";
  content: string;
  createdAt: string;
};

export type ClarificationThreadView = {
  thread: ClarificationThreadRecord;
  messages: ClarificationMessageRecord[];
};

export type CrewInstanceLayer = "chair" | "director" | "department" | "worker";

/**
 * Present only on a run spawned by delegate_to_child. Absent (null) on a
 * root instance — a chair, or a standalone personal-assistant run with no
 * organizational context. See commons-crew docs/architecture.md.
 */
export type DelegationLineage = {
  parentRunId: string;
  parentTaskId: string;
  layer: CrewInstanceLayer;
  orgContext: string | null;
  scope: string;
};

/**
 * v1 fixed chair set — see docs/architecture.md "Chair assignment (v1: fixed,
 * not dynamic)". Matches commons-board's own README. Dynamic chair creation
 * is deliberately out of scope until this fixed set has proven out.
 *
 * "it" and "security" cover the two guaranteed onboarding domains
 * commons-board's chair-context prompt always produces (ui_domain "it" and
 * "security") that don't map onto any of the original six.
 */
export const CHAIR_ROLES = ["finance", "legal", "hr", "marketing", "operations", "product", "it", "security"] as const;
export type ChairRole = (typeof CHAIR_ROLES)[number];

/**
 * Present only on a root run created via pa.createChairRun — the counterpart
 * to DelegationLineage for the top of a chain rather than a delegated hop.
 * A chair-registered run has no parentRunId (nothing delegated to it; an
 * external caller such as commons-board created it directly) but still
 * needs an explicit orgContext so its own descendants can inherit one.
 */
export type ChairRegistration = {
  orgContext: string;
  chairRole: ChairRole;
};

export type RunRecord = {
  id: string;
  workspaceId: string;
  workItemId: string;
  sessionId: string;
  requestId: string;
  traceId: string;
  planId: string | null;
  catalogSyncRunId: string;
  budgetProfileId: string;
  rerunSourceRunId: string | null;
  rerunTriggeredBy: "operator" | null;
  delegation: DelegationLineage | null;
  chairRegistration: ChairRegistration | null;
  workspacePath: string;
  artifactRootPath: string;
  status: RunStatus;
  mode: "direct_pa" | "single_specialist" | "multi_specialist";
  summary: string;
  providerProfileId: string | null;
  providerCapabilitySnapshotId: string | null;
  providerIdentity: string | null;
  providerSnapshot: ProviderCapabilitySnapshot;
  startedAt: string;
  endedAt: string | null;
};

export type RunnerJobPayload = {
  contractVersion: "runner_job.v1";
  runId: string;
  requestId: string;
  sessionId: string;
  workspaceId: string;
  workItemId: string;
  traceId: string;
  catalogSyncRunId: string;
  budgetProfileId: string;
  workspacePath: string;
  artifactRootPath: string;
  providerIdentity: string | null;
  mode: RunRecord["mode"];
  summary: string;
  createdAt: string;
};

export type RunnerJobFailure = {
  code: RunnerJobFailureCode;
  message: string;
  retryable: boolean;
  detail: Record<string, unknown>;
  reportedAt: string;
};

export type RunnerJobRecord = {
  id: string;
  runId: string;
  queueName: "runner";
  status: RunnerJobStatus;
  payload: RunnerJobPayload;
  attemptCount: number;
  maxAttempts: number;
  runnerId: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  blockedAt: string | null;
  endedAt: string | null;
  lastHeartbeatAt: string | null;
  failure: RunnerJobFailure | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskRecord = {
  id: string;
  runId: string;
  parentTaskId: string | null;
  name: string;
  description: string;
  status: TaskStatus;
  assignedAgentId: string | null;
  assignedRuntimeId?: string | null;
  materializationId?: string | null;
  taskKind: "plan_step" | "operational" | "validation" | "cleanup";
  approvalRequired: boolean;
  resultSummary?: string | null;
  resultDetail?: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

export type AgentRuntimeMode = "catalog_specialist" | "materialized_specialist" | "pa_runtime";

export type AgentRuntimeRecord = {
  id: string;
  runId: string;
  agentCatalogEntryId: string | null;
  agentMaterializationId: string | null;
  providerProfileId: string | null;
  runtimeMode: AgentRuntimeMode;
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt: string | null;
};

export type TaskPlanLinkRecord = {
  id: string;
  taskId: string;
  planStepId: string;
  linkType: "fulfills" | "supports" | "retries";
  createdAt: string;
};

export type DelegationDecisionRecord = {
  id: string;
  runId: string;
  decisionType: "direct_pa" | "catalog_agent" | "jit_materialized_agent";
  specialistId?: string | null;
  specialistName?: string | null;
  delegationRole?: "lead" | "contributor" | null;
  delegatedScope?: string | null;
  handoffSummary?: string | null;
  completionSummary?: string | null;
  reasonSummary: string;
  industryContext: string;
  domainContext: string;
  createdAt: string;
};

export type SpecialistReadinessState = "validated" | "deployable" | "definition_only" | "partial" | "planned";
export const MATERIALIZED_SPECIALIST_RUNTIME_BUNDLE_VERSION = "materialized_specialist.v1";
export const MATERIALIZED_SPECIALIST_IO_CONTRACT_VERSION = "materialized_specialist_io.v1";
export const MATERIALIZED_SPECIALIST_EXECUTION_CONTRACT_VERSION = "materialized_specialist_execution.v2";
export const MATERIALIZED_SPECIALIST_PACKAGE_VERSION = "materialized_specialist_package.v1";
export const MATERIALIZED_SPECIALIST_STARTUP_VERIFICATION_VERSION = "materialized_specialist_startup_verification.v1";
export const MATERIALIZED_SPECIALIST_FAILURE_EVIDENCE_VERSION = "materialized_specialist_failure_evidence.v1";
export const SYNTHESIZED_SPECIALIST_RUNTIME_CONTRACT_GOVERNANCE: {
  runtimeBundle: VersionedContractDescriptor;
  ioContract: VersionedContractDescriptor;
  execution: VersionedContractDescriptor;
} = {
  runtimeBundle: {
    version: MATERIALIZED_SPECIALIST_RUNTIME_BUNDLE_VERSION,
    policy: "additive_within_major",
    artifact: "generated-specialist/runtime-bundle.json",
    breakingChangeRequires: "major_version_bump"
  },
  ioContract: {
    version: MATERIALIZED_SPECIALIST_IO_CONTRACT_VERSION,
    policy: "additive_within_major",
    artifact: "generated-specialist/io-contract.json",
    breakingChangeRequires: "major_version_bump"
  },
  execution: {
    version: MATERIALIZED_SPECIALIST_EXECUTION_CONTRACT_VERSION,
    policy: "additive_within_major",
    artifact: "generated-specialist/execution-contract.json",
    breakingChangeRequires: "major_version_bump"
  }
};

export type SpecialistInputContract = {
  name: string;
  type: string;
  description: string;
  required: boolean;
};

export type SpecialistOutputContract = {
  name: string;
  type: string;
  description: string;
  required: boolean;
};

export type SpecialistPermissionContract = {
  approvalRequired: boolean;
  allow: string[];
};

export type SpecialistStartupCheckContract = {
  id: string;
  kind: string;
  target: string;
  required: boolean;
};

export type SpecialistIdentityContract = {
  slug: string;
  name: string;
  description: string;
  boundary: {
    domain: string;
    constraints: string[];
  };
};

export type SpecialistManifestContract = {
  schemaVersion: "olf.specialist/v1";
  kind: "specialist";
  identity: SpecialistIdentityContract;
  readinessState: SpecialistReadinessState;
  supportedTasks: string[];
  inputs: SpecialistInputContract[];
  outputs: SpecialistOutputContract[];
  permissions: SpecialistPermissionContract;
  startupChecks: SpecialistStartupCheckContract[];
};

export type MaterializedSpecialistRuntimeBundle = {
  contractVersion: typeof MATERIALIZED_SPECIALIST_RUNTIME_BUNDLE_VERSION;
  materializationId: string;
  agentCatalogEntryId: string;
  identity: SpecialistIdentityContract;
  supportedTasks: string[];
  inputs: SpecialistInputContract[];
  outputs: SpecialistOutputContract[];
  permissions: SpecialistPermissionContract;
  startupChecks: SpecialistStartupCheckContract[];
  provenance: {
    materializationId: string;
    agentCatalogEntryId: string;
    catalogSourcePath: string;
    catalogResolvedRef: string;
    catalogResolvedCommit: string;
    sourceCommitOrRef: string;
    createdAt: string;
  };
};

export type MaterializedSpecialistIoContract = {
  contractVersion: typeof MATERIALIZED_SPECIALIST_IO_CONTRACT_VERSION;
  inputs: SpecialistInputContract[];
  outputs: SpecialistOutputContract[];
};

export type MaterializedSpecialistPackageManifest = {
  contractVersion: typeof MATERIALIZED_SPECIALIST_PACKAGE_VERSION;
  materializationId: string;
  specialistId: string;
  generatedAt: string;
  manifestRef: string;
  provenanceRef: string;
  startupVerificationRef: string;
  failureEvidenceRef: string;
  artifacts: Array<{
    path: string;
    description: string;
    bytes: number;
    sha256: string;
  }>;
};

export type MaterializedSpecialistStartupCheckResult = {
  id: string;
  kind: string;
  target: string;
  required: boolean;
  ok: boolean | null;
  details: string;
  command: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type MaterializedSpecialistStartupVerificationReport = {
  contractVersion: typeof MATERIALIZED_SPECIALIST_STARTUP_VERIFICATION_VERSION;
  materializationId: string;
  status: MaterializationRecord["status"];
  generatedAt: string;
  workspace: {
    generatedPath: string;
  };
  retryable: boolean;
  recoveryAction: string | null;
  failureCode: MaterializationRecord["failureCode"];
  failureDetail: string | null;
  checks: MaterializedSpecialistStartupCheckResult[];
};

export type MaterializedSpecialistFailureEvidence = {
  contractVersion: typeof MATERIALIZED_SPECIALIST_FAILURE_EVIDENCE_VERSION;
  materializationId: string;
  status: MaterializationRecord["status"];
  generatedAt: string;
  unusable: boolean;
  failureCode: MaterializationRecord["failureCode"];
  failureDetail: string | null;
  retryable: boolean;
  recoveryAction: string | null;
  failureReasons: string[];
  diagnostics: string[];
  startupVerificationRef: string;
  generatedArtifactRefs: string[];
  evidence: Array<{
    kind: "startup_check";
    id: string;
    target: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>;
};

export type MaterializedSpecialistExecutionContract = {
  contractVersion: typeof MATERIALIZED_SPECIALIST_EXECUTION_CONTRACT_VERSION;
  runtime: "api_specialist";
  specialistId: string;
  materializationId: string;
  agentCatalogEntryId: string;
  promptFiles: {
    instructionsRef: "instructions.md";
    systemPromptRef: "system-prompt.md";
  };
  ioContract: {
    ref: "io-contract.json";
    inputs: SpecialistInputContract[];
    outputs: SpecialistOutputContract[];
  };
  executionExpectations: {
    workspaceMode: "isolated_artifact_workspace";
    approvalRequired: boolean;
    supportedTasks: string[];
    requiredOutputNames: string[];
    startupChecks: SpecialistStartupCheckContract[];
    runtimeRequirements: Array<{
      id: string;
      description: string;
      required: boolean;
    }>;
  };
  governance: {
    promptArtifactId: "specialist.orchestration";
    promptArtifactVersion: string;
  };
};

export type SpecialistManifestValidationIssue = {
  code:
    | "manifest.parse_error"
    | "manifest.type"
    | "manifest.required"
    | "manifest.enum"
    | "manifest.min_items"
    | "manifest.invalid_value";
  message: string;
  path: string;
  manifestPath: string;
  line: number | null;
  column: number | null;
};

export type CatalogEntry = {
  id: string;
  sourcePath: string;
  manifestPath: string;
  agentSlug: string;
  name: string;
  readinessState: SpecialistReadinessState;
  status: string;
  supportedTasks: string[];
  expectedOutputs: string[];
  manifest: SpecialistManifestContract;
  validationWarnings: SpecialistManifestValidationIssue[];
};

export type CatalogSyncRecord = {
  id: string;
  sourcePath: string;
  resolvedRef: string;
  resolvedCommit: string;
  status: "completed";
  startedAt: string;
  endedAt: string;
  entriesDiscovered: number;
};

export type MaterializationRecord = {
  id: string;
  agentCatalogEntryId: string;
  runId: string | null;
  workItemId: string | null;
  status: "queued" | "building" | "ready" | "failed";
  generatedPath: string;
  sourceCommitOrRef: string;
  catalogSourcePath: string;
  catalogResolvedRef: string;
  catalogResolvedCommit: string;
  provenanceNotes: string;
  failureCode: "invalid_manifest" | "self_check_failed" | "materialization_io_error" | null;
  failureDetail: string | null;
  retryable: boolean;
  recoveryAction: string | null;
  diagnostics: string[];
  validationChecks: Array<{
    name: string;
    ok: boolean;
    details: string;
  }>;
  failureReasons: string[];
  lastAttemptedAt: string;
  createdAt: string;
  readyAt: string | null;
};

export type ApprovalRecord = {
  id: string;
  runId: string;
  taskId: string;
  workItemId: string;
  requestedByRuntimeId: string;
  actionSummary: string;
  impactScope: string;
  actionProposalId: string | null;
  toolId: string | null;
  targetRef: string | null;
  expiresAt: string | null;
  status: ApprovalStatus;
  decisionComment: string | null;
  requestedAt: string;
  decidedAt: string | null;
};

export type ActionEvidenceKind =
  | "dry_run_output"
  | "preflight_output"
  | "execution_output"
  | "rollback_instructions"
  | "rollback_metadata"
  | "idempotency_collision";

export type ActionEvidenceReference = {
  kind: ActionEvidenceKind;
  label: string;
  ref: string;
  capturedAt: string | null;
};

export type ActionApprovalBinding = {
  required: boolean;
  approvalId: string | null;
  status: ApprovalStatus | "not_required" | "not_requested";
  runId: string | null;
  taskId: string | null;
  workItemId: string;
  actionProposalId: string | null;
  toolId: string | null;
  targetRef: string | null;
  expiresAt: string | null;
};

export type ActionIdempotencyCollision = {
  blockingActionProposalId: string;
  blockingActionExecutionId: string | null;
  blockingStatus: ActionProposalRecord["status"];
  reason: string;
  detectedAt: string;
  evidenceRef: string | null;
};

export type ActionIdempotencyRecord = {
  scope: string;
  key: string;
  checkedAt: string;
  collision: ActionIdempotencyCollision | null;
};

export type ActionCheckRecord = {
  supported: boolean;
  status: "pending" | "completed" | "unavailable";
  executedAt: string | null;
  outcome: string | null;
  outputRef: string | null;
  unavailableReason: string | null;
  evidenceRefs: ActionEvidenceReference[];
};

export type ActionRollbackRecord = {
  supported: boolean;
  status: "available" | "not_supported";
  preparedAt: string | null;
  instructionsRef: string | null;
  metadataRef: string | null;
  unavailableReason: string | null;
  evidenceRefs: ActionEvidenceReference[];
};

export type ActionProposalRecord = {
  id: string;
  workItemId: string;
  runId: string | null;
  taskId: string | null;
  toolId: string;
  actionClass: "class_a" | "class_b" | "class_c";
  actionSummary: string;
  targetRef: string;
  readOnly: boolean;
  supportsDryRun: boolean;
  supportsPreflight: boolean;
  supportsRollback: boolean;
  approval: ActionApprovalBinding;
  idempotency: ActionIdempotencyRecord;
  requiredPermissions: string[];
  evidenceShape: string;
  dryRun: ActionCheckRecord;
  preflight: ActionCheckRecord;
  rollback: ActionRollbackRecord;
  evidenceRefs: ActionEvidenceReference[];
  status: "proposed" | "approved" | "executing" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
};

export type ActionExecutionRecord = {
  id: string;
  actionProposalId: string;
  approval: ActionApprovalBinding;
  actor: string;
  toolUsed: string;
  targetRef: string;
  requestedAction: string;
  idempotency: ActionIdempotencyRecord;
  evidenceRefs: ActionEvidenceReference[];
  dryRun: ActionCheckRecord;
  preflight: ActionCheckRecord;
  rollback: ActionRollbackRecord;
  startedAt: string;
  endedAt: string | null;
  outcome: string;
};

export type ArtifactRecord = {
  id: string;
  runId: string | null;
  taskId: string | null;
  evaluationRunId: string | null;
  artifactType: string;
  storagePath: string;
  summary: string;
  createdAt: string;
};

export type RunEventRecord = {
  id: string;
  runId: string;
  workItemId: string;
  taskId: string | null;
  eventType: string;
  detailLevel: "summary" | "full";
  payload: Record<string, unknown>;
  createdAt: string;
};

export type RunEventContract = {
  contractVersion: string;
  eventId: string;
  runId: string;
  workItemId: string;
  taskId: string | null;
  eventType: string;
  detailLevel: "summary" | "full";
  timestamp: string;
  payload: Record<string, unknown>;
};

export type EvaluationRunRecord = {
  id: string;
  profile: string;
  status: "completed";
  summary: string;
  decisionPoints: Array<{
    decisionPoint: "routing" | "clarification" | "specialist_selection";
    passed: number;
    total: number;
    score: number;
  }>;
  scenarios: Array<{
    id: string;
    title: string;
    decisionPoint: "routing" | "clarification" | "specialist_selection";
    passed: boolean;
    score: number;
    summary: string;
    evidence: Record<string, unknown>;
  }>;
  overallScore: number;
  artifactPath: string;
  startedAt: string;
  endedAt: string;
};

export type IncidentEvidenceRecord = {
  id: string;
  kind: IncidentEvidenceKind;
  label: string;
  ref: string;
  retentionPolicy: "workspace_lifetime" | "summary_only";
  capturedAt: string;
  summary: string;
};

export type IncidentLifecycleRecord = {
  id: string;
  status: IncidentStatus;
  summary: string;
  createdAt: string;
};

export type IncidentRecord = {
  id: string;
  workspaceId: string;
  runId: string | null;
  serviceRef: string | null;
  severity: IncidentSeverity;
  status: IncidentStatus;
  summary: string;
  openedAt: string;
  resolvedAt: string | null;
  evidenceRefs: IncidentEvidenceRecord[];
  lifecycle: IncidentLifecycleRecord[];
};

export type SessionView = {
  session: SessionRecord;
  messages: MessageRecord[];
  latestRun: RunRecord | null;
  clarificationThread: ClarificationThreadRecord | null;
  pendingApprovals: ApprovalRecord[];
  pendingClarifications: ClarificationRecord[];
};

export type WorkItemView = {
  workItem: WorkItemRecord;
  sessions: SessionRecord[];
  plans: PlanRecord[];
  runs: RunRecord[];
  approvals: ApprovalRecord[];
  artifacts: ArtifactRecord[];
  materializations: MaterializationRecord[];
  collaborationThreads: WorkItemCollaborationThreadView[];
};

export type RunView = {
  run: RunRecord;
  tasks: TaskRecord[];
  runtimes: AgentRuntimeRecord[];
  delegationDecisions?: DelegationDecisionRecord[];
  approvals: ApprovalRecord[];
  planChangeRequests: PlanChangeRequestRecord[];
  runnerJob: RunnerJobRecord | null;
};

export type RunRerunView = {
  sourceRunId: string;
  rerunRequestedBy: "operator";
  rerun: RunView;
  session: SessionView;
};

export type WorkspaceIdentityView = {
  workspace: WorkspaceRecord;
  users: UserRecord[];
  memberships: WorkspaceMembershipRecord[];
  primaryUser: UserRecord;
};

export type RunDiagnosticsView = {
  run: RunRecord;
  catalogSync: CatalogSyncRecord | null;
  budgetProfile: BudgetProfile | null;
  runtimes: AgentRuntimeRecord[];
  taskCount: number;
  eventCount: number;
  providerSnapshot: ProviderCapabilitySnapshot;
  lastEvent: {
    eventType: string;
    createdAt: string;
  } | null;
  pendingApprovalIds: string[];
  degradedReason: DegradedRunDiagnostic["reason"] | null;
  activeIncident: IncidentRecord | null;
  incidentEvidenceRefs: IncidentEvidenceRecord[];
  trace: {
    traceId: string;
    requestId: string;
    sessionId: string;
    workItemId: string;
    correlationHeaders: string[];
    logRef: string;
    metricRef: string;
    traceRef: string;
    diagnosticsRef: string;
  };
  latestEvaluation: {
    id: string;
    profile: string;
    overallScore: number;
    summary: string;
    artifactPath: string;
    endedAt: string;
  } | null;
  controlDecisions: Array<{
    eventType: string;
    createdAt: string;
    reason: string | null;
  }>;
  replaySafety: {
    safe: boolean;
    reason: string;
    replayableEvents: number;
  };
  autonomousBudget: {
    profile: string;
    concurrencyCeiling: number;
    wallClockBudgetMinutes: number;
    retryCeiling: number;
    retriesUsed: number;
    materializationCeiling: number;
    materializationsUsed: number;
    providerUsageBudget: string;
    withinBudget: boolean;
    reasons: string[];
  };
  autonomousReleaseGate: {
    status: "passed" | "blocked";
    summary: string;
    evidenceRefs: string[];
    requiredChecks: string[];
    requiredEvidence: string[];
    thresholds: Array<{
      domain: string;
      threshold: string;
      status: "passed" | "failed" | "not_measured";
      detail: string;
    }>;
    operatorOverrideOccurred: boolean;
  };
  operatorActions: string[];
};

export type ProviderCapabilities = {
  providerIdentity: string | null;
  supportsStreaming: boolean;
  supportsStructuredOutputs: boolean;
  supportsToolCalls: boolean;
  supportsFileIo: boolean;
  supportsCancellation: boolean;
};

export type IntakeDecisionConfidence = "low" | "medium" | "high";

export type IntakeCatalogEntry = {
  id: string;
  agentSlug: string;
  name: string;
  readinessState: SpecialistReadinessState;
  description: string;
  domain: string;
  constraints: string[];
  supportedTasks: string[];
  expectedOutputs: string[];
};

export type IntakeMessageContext = {
  authorType: MessageRecord["authorType"];
  messageKind: MessageRecord["messageKind"];
  content: string;
  createdAt: string;
};

export type IntakeDecisionInput = {
  session: {
    id: string;
    title: string;
    surface: Surface;
    status: SessionRecord["status"];
  };
  message: string;
  recentMessages: IntakeMessageContext[];
  catalog: IntakeCatalogEntry[];
};

export type IntakeSpecialistCandidate = {
  catalogEntryId: string;
  confidence: IntakeDecisionConfidence;
  reason: string;
};

export type IntakeDecision = {
  requestType: RequestType;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  clarificationReason: string | null;
  specialistCandidates: IntakeSpecialistCandidate[];
  decisionConfidence: IntakeDecisionConfidence;
  reasoningSummary: string;
};

export type ChatAnswerInput = {
  session: {
    id: string;
    title: string;
    surface: SessionRecord["surface"];
    status: SessionRecord["status"];
  };
  message: string;
  recentMessages: IntakeMessageContext[];
  runtimeContext: {
    availableCapabilities: string[];
  };
};

export type ChatAnswer = {
  content: string;
};

export type PlanStepDraft = {
  title: string;
  description: string;
  required: boolean;
};

export type PlanDraftInput = {
  session: {
    id: string;
    title: string;
    surface: SessionRecord["surface"];
    status: SessionRecord["status"];
  };
  request: string;
  recentMessages: IntakeMessageContext[];
};

export type PlanDraft = {
  title: string;
  summary: string;
  steps: PlanStepDraft[];
};

export type TaskExecutionInput = {
  session: {
    id: string;
    title: string;
    surface: SessionRecord["surface"];
    status: SessionRecord["status"];
  };
  run: {
    id: string;
    mode: RunRecord["mode"];
    summary: string;
    workspacePath: string;
    artifactRootPath: string;
  };
  task: {
    id: string;
    name: string;
    description: string;
    taskKind: TaskRecord["taskKind"];
    approvalRequired: boolean;
    approvedForSideEffects: boolean;
  };
  specialist: {
    id: string | null;
    name: string | null;
    domain: string | null;
  };
  materializedSpecialist: {
    materializationId: string;
    generatedPath: string;
    instructions: string;
    systemPrompt: string;
    runtimeBundle: MaterializedSpecialistRuntimeBundle;
    executionContract: MaterializedSpecialistExecutionContract;
  } | null;
  priorCompletedTasks: Array<{
    name: string;
    summary: string;
  }>;
};

export type TaskExecutionResult = {
  summary: string;
  detail: string | null;
};

export type RunResultSynthesisInput = {
  session: {
    id: string;
    title: string;
    surface: SessionRecord["surface"];
    status: SessionRecord["status"];
  };
  run: {
    id: string;
    mode: RunRecord["mode"];
    request: string;
  };
  completedTasks: Array<{
    name: string;
    taskKind: TaskRecord["taskKind"];
    assignedAgentName: string | null;
    assignedAgentDomain: string | null;
    summary: string;
    detail: string | null;
  }>;
  delegationDecisions: Array<{
    specialistName: string | null;
    delegationRole: DelegationDecisionRecord["delegationRole"];
    domainContext: string;
    completionSummary: string | null;
  }>;
};

export type RunResultSynthesisResult = {
  summary: string;
  content: string;
};

export type ProviderEnvironmentSnapshot = {
  appEnv: string;
  storageMode: "memory" | "postgres";
  apiPort: number;
  runnerPort: number;
  olfAgentsRoot: string;
};

export type ProviderCapabilitySnapshot = {
  id: string;
  providerProfileId: string | null;
  runId: string | null;
  providerId: string;
  providerDisplayName: string;
  model: string | null;
  installed: boolean;
  authenticated: boolean;
  authMode: "chatgpt_login" | "api_key";
  capabilities: ProviderCapabilities;
  diagnostics: ProviderDiagnostics;
  environment: ProviderEnvironmentSnapshot;
  capturedAt: string;
};

export type ProviderAuthContinuity = "healthy" | "missing" | "stale";
export type ProviderReadiness =
  | "ready"
  | "missing_api_key"
  | "missing_auth_state"
  | "stale_auth_state"
  | "provider_unavailable"
  | "status_check_failed";

export type ProviderDiagnostics = {
  checkedAt: string;
  configuredAuthPath?: string;
  executionHome?: string;
  authContinuity?: ProviderAuthContinuity;
  authStateDetected?: boolean;
  authStateLastModifiedAt?: string | null;
  apiKeyConfigured?: boolean;
  readiness: ProviderReadiness;
};

export type ProviderStatus = {
  id: string;
  displayName: string;
  model: string | null;
  installed: boolean;
  authenticated: boolean;
  authMode: "chatgpt_login" | "api_key";
  capabilities: ProviderCapabilities;
  diagnostics: ProviderDiagnostics;
};

export type ProviderAdapter = {
  getStatus: () => Promise<ProviderStatus>;
  decideIntake: (input: IntakeDecisionInput) => Promise<IntakeDecision>;
  answerChat: (input: ChatAnswerInput) => Promise<ChatAnswer>;
  createPlan: (input: PlanDraftInput) => Promise<PlanDraft>;
  executeTask: (input: TaskExecutionInput) => Promise<TaskExecutionResult>;
  synthesizeRunResult: (input: RunResultSynthesisInput) => Promise<RunResultSynthesisResult>;
};

export type DegradedRunDiagnostic = {
  runId: string;
  traceId: string;
  status: RunStatus;
  summary: string;
  reason: "waiting_for_approval" | "blocked_without_pending_approval" | "queue_backlog" | "run_failed" | "long_running";
  pendingApprovalIds: string[];
  taskId: string | null;
  lastEventType: string | null;
  lastEventAt: string | null;
  activeIncidentId: string | null;
  diagnosticsRef: string;
  ageSeconds: number;
};

export type RuntimeMetricsSnapshot = {
  generatedAt: string;
  alerts: OperatorAlert[];
  service: {
    name: string;
    processStartsTotal: number;
    runnerRestartsTotal: number;
    uptimeSeconds: number;
  };
  runs: {
    total: number;
    byStatus: Record<RunStatus, number>;
    throughput: {
      createdTotal: number;
      completedTotal: number;
      failedTotal: number;
      cancelledTotal: number;
    };
    blocked: {
      total: number;
      waitingForApproval: number;
      withoutPendingApproval: number;
      oldestAgeSeconds: number | null;
      runIds: string[];
    };
    queued: {
      total: number;
      oldestAgeSeconds: number | null;
    };
  };
  tasks: {
    total: number;
    byStatus: Record<TaskStatus, number>;
    approvalWaitTotal: number;
  };
  incidents: {
    total: number;
    byStatus: Record<IncidentStatus, number>;
    bySeverity: Record<IncidentSeverity, number>;
    openTotal: number;
    oldestOpenAgeSeconds: number | null;
  };
  runnerJobs: {
    total: number;
    byStatus: Record<RunnerJobStatus, number>;
    activeTotal: number;
  };
  materializations: {
    total: number;
    readyTotal: number;
    failedTotal: number;
  };
  provider: {
    installed: boolean;
    authenticated: boolean;
    failureTotal: number;
  };
  observability: {
    logSchemaVersion: string;
    correlationHeaders: string[];
    correlatedRunsTotal: number;
    criticalFlows: string[];
  };
};

export function toRunEventContract(event: RunEventRecord): RunEventContract {
  return {
    contractVersion: EVENT_CONTRACT_VERSION,
    eventId: event.id,
    runId: event.runId,
    workItemId: event.workItemId,
    taskId: event.taskId,
    eventType: event.eventType,
    detailLevel: event.detailLevel,
    timestamp: event.createdAt,
    payload: event.payload
  };
}

export function serializeRunEventSse(event: RunEventContract) {
  return `event: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

export type DiagnosticsSnapshot = {
  generatedAt: string;
  alerts: OperatorAlert[];
  appName: string;
  apiPort: number;
  runnerPort: number;
  olfAgentsRoot: string;
  stateFile: string;
  storageMode: "memory" | "postgres";
  storageSchema: string;
  providerInstalled: boolean;
  providerAuthenticated: boolean;
  activeProviderProfile: ProviderProfileRecord | null;
  activeConfigProfile: ConfigProfileRecord | null;
  featureFlagRecords: FeatureFlagRecord[];
  promptSpecs: PromptSpecRecord[];
  migrationRecords: MigrationRecord[];
  latestRunProviderSnapshotCapturedAt: string | null;
  promptArtifactVersions: Record<string, string>;
  promptArtifactSignature: string | null;
  promptReevaluationPending: boolean;
  promptReevaluationChecks: string[];
  autonomousBudgetPolicy: {
    profile: string;
    concurrencyCeiling: number;
    wallClockBudgetMinutes: number;
    retryCeiling: number;
    materializationCeiling: number;
    providerUsageBudget: string;
  };
  autonomousReleaseGate: {
    status: "passed" | "blocked";
    summary: string;
    evidenceRefs: string[];
    requiredChecks: string[];
    requiredEvidence: string[];
    thresholds: Array<{
      domain: string;
      threshold: string;
      status: "passed" | "failed" | "not_measured";
      detail: string;
    }>;
    operatorOverrideOccurred: boolean;
  };
  sessions: number;
  runs: number;
  approvals: number;
  backlog: {
    queuedRuns: number;
    blockedRuns: number;
    runningRuns: number;
    pendingApprovals: number;
    oldestQueuedAgeSeconds: number | null;
    oldestBlockedAgeSeconds: number | null;
  };
  provider: {
    displayName: string;
    installed: boolean;
    authenticated: boolean;
    health: "ok" | "degraded";
    capabilitySummary: {
      supportsStreaming: boolean;
      supportsStructuredOutputs: boolean;
      supportsToolCalls: boolean;
      supportsFileIo: boolean;
      supportsCancellation: boolean;
    };
  };
  latestEvaluation: {
    id: string;
    profile: string;
    overallScore: number;
    summary: string;
    artifactPath: string;
    endedAt: string;
    decisionPoints: Array<{
      decisionPoint: "routing" | "clarification" | "specialist_selection";
      passed: number;
      total: number;
      score: number;
    }>;
  } | null;
  observability: {
    logSchemaVersion: string;
    correlationHeaders: string[];
    criticalFlows: string[];
    evidenceRetention: {
      durable: "workspace_lifetime";
      summary: "summary_only";
    };
  };
  degradedRuns: DegradedRunDiagnostic[];
};

export type OperatorAlertSeverity = "critical" | "warning" | "info";

export type OperatorAlert = {
  code: string;
  severity: OperatorAlertSeverity;
  source: "provider" | "runs" | "incidents" | "runner_jobs";
  title: string;
  summary: string;
  action: string;
  affectedRunIds: string[];
};

export type PromptGovernanceState = {
  artifactSetSignature: string | null;
  artifactVersions: Record<string, string>;
  reevaluationPending: boolean;
  reevaluationChecks: string[];
  reevaluationNotes: string[];
  updatedAt: string | null;
};

export type PersistentState = {
  workspace: WorkspaceRecord;
  users: UserRecord[];
  workspaceMemberships: WorkspaceMembershipRecord[];
  promptGovernance: PromptGovernanceState;
  providerProfiles: ProviderProfileRecord[];
  providerCapabilitySnapshots: ProviderCapabilitySnapshot[];
  configProfiles: ConfigProfileRecord[];
  featureFlags: FeatureFlagRecord[];
  promptSpecs: PromptSpecRecord[];
  sessions: SessionRecord[];
  messages: MessageRecord[];
  clarifications: ClarificationRecord[];
  workItems: WorkItemRecord[];
  workItemCollaborationThreads: WorkItemCollaborationThreadRecord[];
  workItemCollaborationMessages: WorkItemCollaborationMessageRecord[];
  requests: RequestRecord[];
  plans: PlanRecord[];
  planSteps: PlanStepRecord[];
  planChangeRequests: PlanChangeRequestRecord[];
  clarificationThreads: ClarificationThreadRecord[];
  clarificationMessages: ClarificationMessageRecord[];
  runs: RunRecord[];
  tasks: TaskRecord[];
  agentRuntimes: AgentRuntimeRecord[];
  taskPlanLinks: TaskPlanLinkRecord[];
  delegationDecisions: DelegationDecisionRecord[];
  catalogEntries: CatalogEntry[];
  catalogSyncs: CatalogSyncRecord[];
  materializations: MaterializationRecord[];
  runnerJobs: RunnerJobRecord[];
  approvals: ApprovalRecord[];
  actionProposals: ActionProposalRecord[];
  actionExecutions: ActionExecutionRecord[];
  artifacts: ArtifactRecord[];
  runEvents: RunEventRecord[];
  evaluationRuns: EvaluationRunRecord[];
  incidents: IncidentRecord[];
  migrationRecords: MigrationRecord[];
};

export const RUNNER_JOB_STATUS_TRANSITIONS: Record<RunnerJobStatus, RunnerJobStatus[]> = {
  queued: ["claimed", "paused", "cancelled"],
  claimed: ["running", "paused", "failed", "cancelled"],
  running: ["blocked", "paused", "completed", "failed", "cancelled"],
  blocked: ["queued", "failed", "cancelled"],
  paused: ["queued", "cancelled"],
  completed: [],
  failed: [],
  cancelled: []
};

export function canTransitionRunnerJobStatus(current: RunnerJobStatus, next: RunnerJobStatus) {
  return RUNNER_JOB_STATUS_TRANSITIONS[current].includes(next);
}

export function createRunnerJobPayloadFixture(overrides: Partial<RunnerJobPayload> = {}): RunnerJobPayload {
  return {
    contractVersion: "runner_job.v1",
    runId: "run_fixture",
    requestId: "request_fixture",
    sessionId: "session_fixture",
    workspaceId: "workspace_fixture",
    workItemId: "work_item_fixture",
    traceId: "trace_fixture",
    catalogSyncRunId: "catalog_sync_fixture",
    budgetProfileId: "bounded_autonomous_default",
    workspacePath: "/repo/.data/artifacts/runs/run_fixture/workspace",
    artifactRootPath: "/repo/.data/artifacts/runs/run_fixture",
    providerIdentity: "commons-crew",
    mode: "single_specialist",
    summary: "Fixture runner job payload",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

export function createRunnerJobRecordFixture(overrides: Partial<RunnerJobRecord> = {}): RunnerJobRecord {
  return {
    id: "runner_job_fixture",
    runId: "run_fixture",
    queueName: "runner",
    status: "queued",
    payload: createRunnerJobPayloadFixture(),
    attemptCount: 0,
    maxAttempts: 3,
    runnerId: null,
    claimedAt: null,
    startedAt: null,
    blockedAt: null,
    endedAt: null,
    lastHeartbeatAt: null,
    failure: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}
