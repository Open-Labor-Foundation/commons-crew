import type { HttpHeaders } from "./host";
import type {
  DegradedRunDiagnostic,
  DiagnosticsSnapshot,
  EvaluationRunRecord,
  IncidentRecord,
  IncidentSeverity,
  IncidentStatus,
  OperatorAlert,
  PersistentState,
  ProviderStatus,
  RunStatus,
  RuntimeMetricsSnapshot,
  RunnerJobStatus,
  TaskStatus
} from "../../contracts/src/index";
import type { AppConfig } from "../../config/src/index";
import type { LoadedPromptArtifacts } from "./prompt-governance";

export const LOG_SCHEMA_VERSION = "v1";
export const OBSERVABILITY_CRITICAL_FLOWS = [
  "session_message_to_run_creation",
  "runner_job_dispatch_and_start",
  "approval_wait_and_resume",
  "materialization_validation",
  "incident_detection_and_resolution"
] as const;

export const CORRELATION_HEADER_NAMES = {
  traceId: "x-trace-id",
  workItemId: "x-work-item-id",
  runId: "x-run-id",
  taskId: "x-task-id",
  providerJobId: "x-provider-job-id",
  sessionId: "x-session-id",
  requestId: "x-request-id"
} as const;

export const AUTONOMOUS_BUDGET_POLICY = {
  profile: "bounded_autonomous_default",
  concurrencyCeiling: 1,
  wallClockBudgetMinutes: 30,
  retryCeiling: 3,
  materializationCeiling: 1,
  providerUsageBudget: "operator_review_required_when_available"
} as const;

export type LogCorrelationFields = {
  requestId?: string | null;
  traceId?: string | null;
  sessionId?: string | null;
  workItemId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  providerJobId?: string | null;
  approvalId?: string | null;
  materializationId?: string | null;
  actionId?: string | null;
  planId?: string | null;
};

export type StructuredLogger = {
  info(payload: Record<string, unknown>, message?: string): void;
  warn?(payload: Record<string, unknown>, message?: string): void;
  error?(payload: Record<string, unknown>, message?: string): void;
};

function getHeaderValue(headers: HttpHeaders, name: string) {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export function readCorrelationHeaders(headers: HttpHeaders): LogCorrelationFields {
  return {
    requestId: getHeaderValue(headers, CORRELATION_HEADER_NAMES.requestId),
    traceId: getHeaderValue(headers, CORRELATION_HEADER_NAMES.traceId),
    sessionId: getHeaderValue(headers, CORRELATION_HEADER_NAMES.sessionId),
    workItemId: getHeaderValue(headers, CORRELATION_HEADER_NAMES.workItemId),
    runId: getHeaderValue(headers, CORRELATION_HEADER_NAMES.runId),
    taskId: getHeaderValue(headers, CORRELATION_HEADER_NAMES.taskId),
    providerJobId: getHeaderValue(headers, CORRELATION_HEADER_NAMES.providerJobId)
  };
}

export function resolveTraceId(headers: HttpHeaders, fallback: string) {
  return getHeaderValue(headers, CORRELATION_HEADER_NAMES.traceId) ?? fallback;
}

function normalizeCorrelationFields(fields: LogCorrelationFields = {}) {
  return {
    requestId: fields.requestId ?? null,
    traceId: fields.traceId ?? null,
    sessionId: fields.sessionId ?? null,
    workItemId: fields.workItemId ?? null,
    runId: fields.runId ?? null,
    taskId: fields.taskId ?? null,
    providerJobId: fields.providerJobId ?? null,
    approvalId: fields.approvalId ?? null,
    materializationId: fields.materializationId ?? null,
    actionId: fields.actionId ?? null,
    planId: fields.planId ?? null
  };
}

function findDecisionPoint(
  evaluation: EvaluationRunRecord | null,
  decisionPoint: EvaluationRunRecord["decisionPoints"][number]["decisionPoint"]
) {
  return evaluation?.decisionPoints.find((entry) => entry.decisionPoint === decisionPoint) ?? null;
}

export function buildAutonomousReleaseGate(
  promptArtifacts: LoadedPromptArtifacts,
  evaluation: EvaluationRunRecord | null,
  reevaluationPending: boolean
): DiagnosticsSnapshot["autonomousReleaseGate"] {
  const routing = findDecisionPoint(evaluation, "routing");
  const clarification = findDecisionPoint(evaluation, "clarification");
  const specialistSelection = findDecisionPoint(evaluation, "specialist_selection");
  const evidenceRefs = evaluation?.artifactPath ? [evaluation.artifactPath] : [];
  const thresholds: DiagnosticsSnapshot["autonomousReleaseGate"]["thresholds"] = promptArtifacts.reevaluationThresholds.map((entry) => {
    if (entry.domain === "routing and delegation") {
      return {
        ...entry,
        status: routing ? (routing.score >= 0.9 ? "passed" : "failed") : "not_measured",
        detail: routing
          ? `Latest routing score is ${Math.round(routing.score * 100)}% (${routing.passed}/${routing.total}).`
          : "No retained routing evaluation evidence is available."
      };
    }

    if (entry.domain === "clarification") {
      return {
        ...entry,
        status: clarification ? (clarification.score >= 0.95 ? "passed" : "failed") : "not_measured",
        detail: clarification
          ? `Latest clarification score is ${Math.round(clarification.score * 100)}% (${clarification.passed}/${clarification.total}).`
          : "No retained clarification evaluation evidence is available."
      };
    }

    if (entry.domain === "specialist selection") {
      return {
        ...entry,
        status: specialistSelection ? (specialistSelection.score >= 1 ? "passed" : "failed") : "not_measured",
        detail: specialistSelection
          ? `Latest specialist-selection score is ${Math.round(specialistSelection.score * 100)}% (${specialistSelection.passed}/${specialistSelection.total}).`
          : "No retained specialist-selection evaluation evidence is available."
      };
    }

    return {
      ...entry,
      status: "not_measured" as const,
      detail: "This threshold requires dedicated evidence outside the retained decision-quality record."
    };
  });

  const hasFailedThreshold = thresholds.some((entry) => entry.status === "failed");
  const hasUnmeasuredThreshold = thresholds.some((entry) => entry.status === "not_measured");
  const missingEvaluation = !evaluation?.artifactPath;
  const status: DiagnosticsSnapshot["autonomousReleaseGate"]["status"] =
    !reevaluationPending && !hasFailedThreshold && !hasUnmeasuredThreshold && !missingEvaluation ? "passed" : "blocked";
  const summary = reevaluationPending
    ? "Blocked: governed prompt or orchestration changes still require reevaluation before autonomous tuning can influence release posture."
    : missingEvaluation
      ? "Blocked: no retained evaluation artifact is available for autonomous tuning or self-improvement evidence."
      : hasFailedThreshold
        ? "Blocked: the latest retained evaluation did not satisfy every measured release threshold."
        : hasUnmeasuredThreshold
          ? "Blocked: some release thresholds still require evidence that is not captured in the current retained evaluation record."
          : "Passed: retained evaluation evidence satisfies the current autonomous self-improvement release gate.";

  return {
    status,
    summary,
    evidenceRefs,
    requiredChecks: promptArtifacts.reevaluationChecks,
    requiredEvidence: promptArtifacts.reevaluationEvidence,
    thresholds,
    operatorOverrideOccurred: false
  };
}

export function createStructuredLog(
  service: string,
  event: string,
  fields: LogCorrelationFields = {},
  attributes: Record<string, unknown> = {}
) {
  return {
    logSchemaVersion: LOG_SCHEMA_VERSION,
    service,
    event,
    ...normalizeCorrelationFields(fields),
    ...attributes
  };
}

export function logInfo(
  logger: StructuredLogger | undefined,
  service: string,
  event: string,
  fields: LogCorrelationFields = {},
  attributes: Record<string, unknown> = {}
) {
  logger?.info(createStructuredLog(service, event, fields, attributes), event);
}

const RUN_STATUSES: RunStatus[] = ["queued", "running", "blocked", "completed", "failed", "cancelled", "paused", "awaiting_clarification"];
const INCIDENT_STATUSES: IncidentStatus[] = ["open", "investigating", "monitoring", "resolved"];
const INCIDENT_SEVERITIES: IncidentSeverity[] = ["low", "medium", "high", "critical"];
const RUNNER_JOB_STATUSES: RunnerJobStatus[] = ["queued", "claimed", "running", "blocked", "paused", "completed", "failed", "cancelled"];
const TASK_STATUSES: TaskStatus[] = ["queued", "running", "blocked", "completed", "failed", "cancelled"];
const LONG_RUNNING_THRESHOLD_SECONDS = 300;

function correlationHeadersList() {
  return Object.values(CORRELATION_HEADER_NAMES);
}

function buildRunRef(kind: "log" | "metric" | "trace" | "diagnostic", runId: string, traceId: string) {
  if (kind === "log") {
    return `log://runs/${runId}?traceId=${encodeURIComponent(traceId)}`;
  }
  if (kind === "metric") {
    return `metric://runs/${runId}?traceId=${encodeURIComponent(traceId)}`;
  }
  if (kind === "trace") {
    return `trace://runs/${runId}?traceId=${encodeURIComponent(traceId)}`;
  }
  return `/api/admin/runs/${runId}/diagnostics`;
}

function secondsSince(timestamp: string, generatedAt: Date) {
  return Math.max(0, Math.floor((generatedAt.getTime() - new Date(timestamp).getTime()) / 1000));
}

function oldestAge(items: string[], generatedAt: Date) {
  if (items.length === 0) {
    return null;
  }
  return Math.max(...items.map((timestamp) => secondsSince(timestamp, generatedAt)));
}

function buildRunStatusCounts(state: PersistentState): Record<RunStatus, number> {
  const counts = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<RunStatus, number>;
  for (const run of state.runs) {
    counts[run.status] += 1;
  }
  return counts;
}

function buildTaskStatusCounts(state: PersistentState): Record<TaskStatus, number> {
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
  for (const task of state.tasks) {
    counts[task.status] += 1;
  }
  return counts;
}

function buildIncidentCounts(state: PersistentState, generatedAt: Date) {
  const byStatus = Object.fromEntries(INCIDENT_STATUSES.map((status) => [status, 0])) as Record<IncidentStatus, number>;
  const bySeverity = Object.fromEntries(INCIDENT_SEVERITIES.map((severity) => [severity, 0])) as Record<IncidentSeverity, number>;

  for (const incident of state.incidents) {
    byStatus[incident.status] += 1;
    bySeverity[incident.severity] += 1;
  }

  const openIncidents = state.incidents.filter((incident) => incident.status !== "resolved");
  return {
    total: state.incidents.length,
    byStatus,
    bySeverity,
    openTotal: openIncidents.length,
    oldestOpenAgeSeconds: oldestAge(openIncidents.map((incident) => incident.openedAt), generatedAt),
    openRunIds: Array.from(new Set(openIncidents.map((incident) => incident.runId).filter((runId): runId is string => runId !== null)))
  };
}

function buildRunnerJobCounts(state: PersistentState) {
  const byStatus = Object.fromEntries(RUNNER_JOB_STATUSES.map((status) => [status, 0])) as Record<RunnerJobStatus, number>;
  for (const job of state.runnerJobs) {
    byStatus[job.status] += 1;
  }
  return {
    total: state.runnerJobs.length,
    byStatus,
    activeTotal: state.runnerJobs.filter(
      (job) => ["queued", "claimed", "running", "blocked", "paused"].includes(job.status)
    ).length
  };
}

function buildOperatorAlerts(input: {
  providerStatus: ProviderStatus;
  pendingApprovals: number;
  blockedRuns: number;
  blockedWithoutPendingApproval: number;
  queueAgeSeconds: number | null;
  runStatusCounts: Record<RunStatus, number>;
  degradedRuns: DegradedRunDiagnostic[];
  incidents: ReturnType<typeof buildIncidentCounts>;
  runnerJobs: ReturnType<typeof buildRunnerJobCounts>;
}) {
  const alerts: OperatorAlert[] = [];

  if (!input.providerStatus.installed) {
    alerts.push({
      code: "provider.not_installed",
      severity: "critical",
      source: "provider",
      title: "Provider is not installed",
      summary: "The default LLM provider is not installed, so run execution cannot proceed.",
      action: "Install and enable provider credentials, then restart the service.",
      affectedRunIds: []
    });
  } else if (!input.providerStatus.authenticated) {
    alerts.push({
      code: "provider.not_authenticated",
      severity: "critical",
      source: "provider",
      title: "Provider authentication is degraded",
      summary: "Provider exists but is not authenticated, and outbound run dispatch may fail.",
      action: "Re-authenticate the configured provider and verify auth continuity.",
      affectedRunIds: []
    });
  }

  const queuedRuns = input.runStatusCounts.queued;
  if (queuedRuns > 0) {
    alerts.push({
      code: "runs.queue_backlog",
      severity: queuedRuns >= 3 ? "warning" : "info",
      source: "runs",
      title: "Runs waiting in queue",
      summary: `${queuedRuns} run(s) currently queued awaiting dispatch.`,
      action: "Inspect queue health and runner capacity; scale runners if queue stays elevated.",
      affectedRunIds: []
    });
  }

  if (input.blockedRuns > 0) {
    alerts.push({
      code: "runs.blocked_total",
      severity: input.blockedWithoutPendingApproval > 0 ? "warning" : "info",
      source: "runs",
      title: "Blocked runs require operator review",
      summary: `${input.blockedRuns} run(s) are blocked; ${input.blockedWithoutPendingApproval} without matching pending approvals.`,
      action: "Review each blocked run in /api/admin/runs/:runId/diagnostics and clear root causes.",
      affectedRunIds: []
    });
  }

  if (input.pendingApprovals > 0) {
    alerts.push({
      code: "runs.awaiting_approval",
      severity: "warning",
      source: "runs",
      title: "Pending approvals pending",
      summary: `${input.pendingApprovals} approval(s) still awaiting operator decision.`,
      action: "Review and decide on open approvals to reduce stalled execution.",
      affectedRunIds: []
    });
  }

  if (input.degradedRuns.length > 0) {
    const failed = input.degradedRuns.filter((entry) => entry.reason === "run_failed");
    const longRunning = input.degradedRuns.filter((entry) => entry.reason === "long_running");
    if (failed.length > 0) {
      alerts.push({
        code: "runs.failed",
        severity: "critical",
        source: "runs",
        title: "Run failures detected",
        summary: `${failed.length} run(s) degraded as failed; investigation is recommended.`,
        action: "Open run diagnostics and inspect incident evidence before rerunning.",
        affectedRunIds: failed.map((entry) => entry.runId)
      });
    }
    if (input.degradedRuns.some((entry) => entry.reason === "waiting_for_approval" || entry.reason === "blocked_without_pending_approval")) {
      const approvalBlocked = input.degradedRuns.filter(
        (entry) => entry.reason === "waiting_for_approval" || entry.reason === "blocked_without_pending_approval"
      );
      alerts.push({
        code: "runs.waiting_for_approval",
        severity: "warning",
        source: "runs",
        title: "Approval-blocked runs",
        summary: `${approvalBlocked.length} run(s) are blocked by missing or pending approval signals.`,
        action: "Resolve approvals or escalate if tasks remain blocked.",
        affectedRunIds: approvalBlocked.map((entry) => entry.runId)
      });
    }
    if (longRunning.length > 0) {
      alerts.push({
        code: "runs.long_running",
        severity: "warning",
        source: "runs",
        title: "Long-running runs",
        summary: `${longRunning.length} run(s) have exceeded the running timeout threshold.`,
        action: "Inspect stalled tasks and verify downstream provider or runner responsiveness.",
        affectedRunIds: longRunning.map((entry) => entry.runId)
      });
    }
  }

  if (input.incidents.openTotal > 0) {
    alerts.push({
      code: "incidents.open",
      severity: input.incidents.bySeverity.critical > 0 ? "critical" : "warning",
      source: "incidents",
      title: "Open incidents require operator follow-up",
      summary: `${input.incidents.openTotal} open incident(s) are present in the platform.`,
      action: "Review incident list and close resolved items after confirmation.",
      affectedRunIds: input.incidents.openRunIds
    });
  }

  if (input.incidents.bySeverity.critical > 0) {
    alerts.push({
      code: "incidents.critical",
      severity: "critical",
      source: "incidents",
      title: "Critical incident(s) active",
      summary: `${input.incidents.bySeverity.critical} active incident(s) with critical severity.`,
      action: "Prioritize these incidents and include all linked evidence in the response.",
      affectedRunIds: []
    });
  }

  if (input.runnerJobs.byStatus.failed > 0) {
    alerts.push({
      code: "runner_jobs.failed",
      severity: "warning",
      source: "runner_jobs",
      title: "Runner jobs are failing",
      summary: `${input.runnerJobs.byStatus.failed} runner job(s) have failed and may require retry/recovery.`,
      action: "Inspect runner logs, claims, and heartbeat health before replaying or recreating work.",
      affectedRunIds: []
    });
  }

  if (input.runnerJobs.byStatus.running >= 3 && input.queueAgeSeconds !== null && input.queueAgeSeconds >= 45) {
    alerts.push({
      code: "runner_jobs.backpressure",
      severity: "warning",
      source: "runner_jobs",
      title: "Runner/job contention potential",
      summary: "High active runner job volume while runs are waiting indicates backpressure.",
      action: "Check runner parallelism, job heartbeats, and external dependency health.",
      affectedRunIds: []
    });
  }

  return alerts;
}

function activeIncidentForRun(incidents: IncidentRecord[], runId: string) {
  return incidents.find((incident) => incident.runId === runId && incident.status !== "resolved") ?? null;
}

function buildDegradedRuns(state: PersistentState, generatedAt: Date): DegradedRunDiagnostic[] {
  return state.runs
    .flatMap((run): DegradedRunDiagnostic[] => {
      const approvals = state.approvals.filter((approval) => approval.runId === run.id && approval.status === "pending");
      const blockedTask = state.tasks.find((task) => task.runId === run.id && task.status === "blocked") ?? null;
      const lastEvent = state.runEvents
        .filter((event) => event.runId === run.id)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
      const activeIncident = activeIncidentForRun(state.incidents, run.id);
      const ageSeconds = secondsSince(run.startedAt, generatedAt);

      if (run.status === "blocked") {
        return [{
          runId: run.id,
          traceId: run.traceId,
          status: run.status,
          summary: run.summary,
          reason: approvals.length > 0 ? "waiting_for_approval" : "blocked_without_pending_approval",
          pendingApprovalIds: approvals.map((approval) => approval.id),
          taskId: blockedTask?.id ?? null,
          lastEventType: lastEvent?.eventType ?? null,
          lastEventAt: lastEvent?.createdAt ?? null,
          activeIncidentId: activeIncident?.id ?? null,
          diagnosticsRef: buildRunRef("diagnostic", run.id, run.traceId),
          ageSeconds
        }];
      }

      if (run.status === "queued") {
        return [{
          runId: run.id,
          traceId: run.traceId,
          status: run.status,
          summary: run.summary,
          reason: "queue_backlog",
          pendingApprovalIds: [],
          taskId: null,
          lastEventType: lastEvent?.eventType ?? null,
          lastEventAt: lastEvent?.createdAt ?? null,
          activeIncidentId: activeIncident?.id ?? null,
          diagnosticsRef: buildRunRef("diagnostic", run.id, run.traceId),
          ageSeconds
        }];
      }

      if (run.status === "failed") {
        return [{
          runId: run.id,
          traceId: run.traceId,
          status: run.status,
          summary: run.summary,
          reason: "run_failed",
          pendingApprovalIds: [],
          taskId: null,
          lastEventType: lastEvent?.eventType ?? null,
          lastEventAt: lastEvent?.createdAt ?? null,
          activeIncidentId: activeIncident?.id ?? null,
          diagnosticsRef: buildRunRef("diagnostic", run.id, run.traceId),
          ageSeconds
        }];
      }

      if (run.status === "running" && ageSeconds >= LONG_RUNNING_THRESHOLD_SECONDS) {
        return [{
          runId: run.id,
          traceId: run.traceId,
          status: run.status,
          summary: run.summary,
          reason: "long_running",
          pendingApprovalIds: [],
          taskId: null,
          lastEventType: lastEvent?.eventType ?? null,
          lastEventAt: lastEvent?.createdAt ?? null,
          activeIncidentId: activeIncident?.id ?? null,
          diagnosticsRef: buildRunRef("diagnostic", run.id, run.traceId),
          ageSeconds
        }];
      }

      return [];
    })
    .sort((left, right) => right.ageSeconds - left.ageSeconds);
}

export function buildRuntimeMetricsSnapshot(input: {
  serviceName: string;
  processStartsTotal: number;
  startedAt: string;
  providerStatus: ProviderStatus;
  state: PersistentState;
  generatedAt?: Date;
}): RuntimeMetricsSnapshot {
  const generatedAt = input.generatedAt ?? new Date();
  const runStatusCounts = buildRunStatusCounts(input.state);
  const taskStatusCounts = buildTaskStatusCounts(input.state);
  const pendingApprovals = input.state.approvals.filter((approval) => approval.status === "pending");
  const blockedRuns = input.state.runs.filter((run) => run.status === "blocked");
  const queuedRuns = input.state.runs.filter((run) => run.status === "queued");
  const incidents = buildIncidentCounts(input.state, generatedAt);
  const runnerJobs = buildRunnerJobCounts(input.state);
  const oldestQueuedAgeSeconds = oldestAge(queuedRuns.map((run) => run.startedAt), generatedAt);
  const blockedRunIds = new Set(blockedRuns.map((run) => run.id));
  const blockedWithoutPendingApproval = blockedRuns.filter(
    (run) => !pendingApprovals.some((approval) => approval.runId === run.id)
  );
  const runnerRestartsTotal = input.state.runEvents.filter((event) => event.eventType === "runner.job.requeued").length;
  const degradedRuns = buildDegradedRuns(input.state, generatedAt);
  const alerts = buildOperatorAlerts({
    providerStatus: input.providerStatus,
    pendingApprovals: pendingApprovals.length,
    blockedRuns: blockedRuns.length,
    blockedWithoutPendingApproval: blockedWithoutPendingApproval.length,
    queueAgeSeconds: oldestQueuedAgeSeconds,
    runStatusCounts,
    degradedRuns,
    incidents,
    runnerJobs
  });

  return {
    generatedAt: generatedAt.toISOString(),
    alerts,
    service: {
      name: input.serviceName,
      processStartsTotal: input.processStartsTotal,
      runnerRestartsTotal,
      uptimeSeconds: secondsSince(input.startedAt, generatedAt)
    },
    runs: {
      total: input.state.runs.length,
      byStatus: runStatusCounts,
      throughput: {
        createdTotal: input.state.runs.length,
        completedTotal: runStatusCounts.completed,
        failedTotal: runStatusCounts.failed,
        cancelledTotal: runStatusCounts.cancelled
      },
      blocked: {
        total: blockedRuns.length,
        waitingForApproval: pendingApprovals.filter((approval) => blockedRunIds.has(approval.runId)).length,
        withoutPendingApproval: blockedWithoutPendingApproval.length,
        oldestAgeSeconds: oldestAge(blockedRuns.map((run) => run.startedAt), generatedAt),
        runIds: blockedRuns.map((run) => run.id)
      },
      queued: {
        total: queuedRuns.length,
        oldestAgeSeconds: oldestQueuedAgeSeconds
      }
    },
    incidents: {
      total: incidents.total,
      byStatus: incidents.byStatus,
      bySeverity: incidents.bySeverity,
      openTotal: incidents.openTotal,
      oldestOpenAgeSeconds: incidents.oldestOpenAgeSeconds
    },
    runnerJobs: {
      total: runnerJobs.total,
      byStatus: runnerJobs.byStatus,
      activeTotal: runnerJobs.activeTotal
    },
    tasks: {
      total: input.state.tasks.length,
      byStatus: taskStatusCounts,
      approvalWaitTotal: pendingApprovals.length
    },
    materializations: {
      total: input.state.materializations.length,
      readyTotal: input.state.materializations.filter((materialization) => materialization.status === "ready").length,
      failedTotal: input.state.materializations.filter((materialization) => materialization.status === "failed").length
    },
    provider: {
      installed: input.providerStatus.installed,
      authenticated: input.providerStatus.authenticated,
      failureTotal: input.providerStatus.installed && input.providerStatus.authenticated ? 0 : 1
    },
    observability: {
      logSchemaVersion: LOG_SCHEMA_VERSION,
      correlationHeaders: correlationHeadersList(),
      correlatedRunsTotal: input.state.runs.filter((run) => Boolean(run.traceId)).length,
      criticalFlows: [...OBSERVABILITY_CRITICAL_FLOWS]
    }
  };
}

export function buildDiagnosticsSnapshot(input: {
  config: AppConfig;
  providerStatus: ProviderStatus;
  state: PersistentState;
  promptArtifacts: LoadedPromptArtifacts;
  generatedAt?: Date;
}): DiagnosticsSnapshot {
  const generatedAt = input.generatedAt ?? new Date();
  const pendingApprovals = input.state.approvals.filter((approval) => approval.status === "pending");
  const queuedRuns = input.state.runs.filter((run) => run.status === "queued");
  const blockedRuns = input.state.runs.filter((run) => run.status === "blocked");
  const runningRuns = input.state.runs.filter((run) => run.status === "running");
  const latestEvaluation = input.state.evaluationRuns[0] ?? null;
  const incidents = buildIncidentCounts(input.state, generatedAt);
  const degradedRuns = buildDegradedRuns(input.state, generatedAt);
  const autonomousReleaseGate = buildAutonomousReleaseGate(
    input.promptArtifacts,
    latestEvaluation,
    input.state.promptGovernance.reevaluationPending
  );
  const alerts = buildOperatorAlerts({
    providerStatus: input.providerStatus,
    pendingApprovals: pendingApprovals.length,
    blockedRuns: blockedRuns.length,
    blockedWithoutPendingApproval: blockedRuns.filter(
      (run) => !pendingApprovals.some((approval) => approval.runId === run.id)
    ).length,
    queueAgeSeconds: oldestAge(queuedRuns.map((run) => run.startedAt), generatedAt),
    runStatusCounts: buildRunStatusCounts(input.state),
    degradedRuns,
    incidents,
    runnerJobs: buildRunnerJobCounts(input.state)
  });

  return {
    generatedAt: generatedAt.toISOString(),
    alerts,
    appName: input.config.app.name,
    apiPort: input.config.ports.api,
    runnerPort: input.config.ports.runner,
    olfAgentsRoot: input.config.paths.olfAgentsRoot,
    stateFile: input.config.paths.stateFile,
    storageMode: input.config.storage.mode,
    storageSchema: input.config.database.schema,
    providerInstalled: input.providerStatus.installed,
    providerAuthenticated: input.providerStatus.authenticated,
    activeProviderProfile: input.state.providerProfiles.find((entry) => entry.status === "active" && entry.isDefault) ?? null,
    activeConfigProfile: input.state.configProfiles.find((entry) => entry.status === "active") ?? null,
    featureFlagRecords: input.state.featureFlags,
    promptSpecs: input.state.promptSpecs,
    migrationRecords: input.state.migrationRecords,
    latestRunProviderSnapshotCapturedAt: input.state.runs[0]?.providerSnapshot.capturedAt ?? null,
    promptArtifactVersions: input.state.promptGovernance.artifactVersions,
    promptArtifactSignature: input.state.promptGovernance.artifactSetSignature,
    promptReevaluationPending: input.state.promptGovernance.reevaluationPending,
    promptReevaluationChecks: input.state.promptGovernance.reevaluationChecks,
    autonomousBudgetPolicy: {
      profile: AUTONOMOUS_BUDGET_POLICY.profile,
      concurrencyCeiling: AUTONOMOUS_BUDGET_POLICY.concurrencyCeiling,
      wallClockBudgetMinutes: AUTONOMOUS_BUDGET_POLICY.wallClockBudgetMinutes,
      retryCeiling: AUTONOMOUS_BUDGET_POLICY.retryCeiling,
      materializationCeiling: AUTONOMOUS_BUDGET_POLICY.materializationCeiling,
      providerUsageBudget: AUTONOMOUS_BUDGET_POLICY.providerUsageBudget
    },
    autonomousReleaseGate,
    sessions: input.state.sessions.length,
    runs: input.state.runs.length,
    approvals: pendingApprovals.length,
    backlog: {
      queuedRuns: queuedRuns.length,
      blockedRuns: blockedRuns.length,
      runningRuns: runningRuns.length,
      pendingApprovals: pendingApprovals.length,
      oldestQueuedAgeSeconds: oldestAge(queuedRuns.map((run) => run.startedAt), generatedAt),
      oldestBlockedAgeSeconds: oldestAge(blockedRuns.map((run) => run.startedAt), generatedAt)
    },
    provider: {
      displayName: input.providerStatus.displayName,
      installed: input.providerStatus.installed,
      authenticated: input.providerStatus.authenticated,
      health: input.providerStatus.installed && input.providerStatus.authenticated ? "ok" : "degraded",
      capabilitySummary: {
        supportsStreaming: input.providerStatus.capabilities.supportsStreaming,
        supportsStructuredOutputs: input.providerStatus.capabilities.supportsStructuredOutputs,
        supportsToolCalls: input.providerStatus.capabilities.supportsToolCalls,
        supportsFileIo: input.providerStatus.capabilities.supportsFileIo,
        supportsCancellation: input.providerStatus.capabilities.supportsCancellation
      }
    },
    latestEvaluation: latestEvaluation
      ? {
          id: latestEvaluation.id,
          profile: latestEvaluation.profile,
          overallScore: latestEvaluation.overallScore,
          summary: latestEvaluation.summary,
          artifactPath: latestEvaluation.artifactPath,
          endedAt: latestEvaluation.endedAt,
          decisionPoints: latestEvaluation.decisionPoints
        }
      : null,
    observability: {
      logSchemaVersion: LOG_SCHEMA_VERSION,
      correlationHeaders: correlationHeadersList(),
      criticalFlows: [...OBSERVABILITY_CRITICAL_FLOWS],
      evidenceRetention: {
        durable: "workspace_lifetime",
        summary: "summary_only"
      }
    },
    degradedRuns
  };
}
