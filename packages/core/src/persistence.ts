import type {
  ApprovalRecord,
  ClarificationThreadView,
  PersistentState,
  RunEventRecord,
  RunView,
  SessionView,
  WorkItemCollaborationThreadView,
  WorkItemView
} from "../../contracts/src/index";

export type PersistenceBackendKind = "json" | "postgres";

export interface StateStore {
  readonly kind: PersistenceBackendKind;
  init(): Promise<void>;
  read(): Promise<PersistentState>;
  write(mutator: (state: PersistentState) => PersistentState | Promise<PersistentState>): Promise<void>;
  flush(): Promise<void>;
  close?(): Promise<void>;
}

export interface SessionPersistence {
  getSessionView(sessionId: string): Promise<SessionView | null>;
  listPendingApprovals(sessionId: string): Promise<ApprovalRecord[]>;
}

export interface WorkItemPersistence {
  getWorkItemView(workItemId: string): Promise<WorkItemView | null>;
}

export interface WorkItemCollaborationPersistence {
  listForWorkItem(workItemId: string): Promise<WorkItemCollaborationThreadView[]>;
}

export interface RunPersistence {
  getRunView(runId: string): Promise<RunView | null>;
  listEvents(runId: string): Promise<RunEventRecord[]>;
}

export interface ClarificationPersistence {
  listForSession(sessionId: string): Promise<ClarificationThreadView[]>;
}

export interface PersistenceInterfaces {
  readonly state: StateStore;
  readonly sessions: SessionPersistence;
  readonly workItems: WorkItemPersistence;
  readonly workItemCollaboration: WorkItemCollaborationPersistence;
  readonly runs: RunPersistence;
  readonly clarifications: ClarificationPersistence;
}

export function createPersistenceInterfaces(state: StateStore): PersistenceInterfaces {
  return {
    state,
    sessions: {
      async getSessionView(sessionId) {
        const snapshot = await state.read();
        const session = snapshot.sessions.find((entry) => entry.id === sessionId) ?? null;
        if (!session) {
          return null;
        }
        const clarificationThread =
          snapshot.clarificationThreads.find((thread) => thread.sessionId === sessionId && (thread.state === "open" || thread.status === "open")) ?? null;
        return {
          session,
          messages: snapshot.messages.filter((entry) => entry.sessionId === sessionId),
          latestRun: snapshot.runs.find((entry) => entry.sessionId === sessionId) ?? null,
          clarificationThread,
          pendingClarifications: snapshot.clarifications.filter((entry) => entry.sessionId === sessionId && entry.status === "pending"),
          pendingApprovals: snapshot.approvals.filter(
            (approval) => approval.status === "pending" && snapshot.runs.some((run) => run.id === approval.runId && run.sessionId === sessionId)
          )
        };
      },
      async listPendingApprovals(sessionId) {
        const snapshot = await state.read();
        const runIds = new Set(snapshot.runs.filter((run) => run.sessionId === sessionId).map((run) => run.id));
        return snapshot.approvals.filter((approval) => approval.status === "pending" && runIds.has(approval.runId));
      }
    },
    workItems: {
      async getWorkItemView(workItemId) {
        const snapshot = await state.read();
        const workItem = snapshot.workItems.find((entry) => entry.id === workItemId) ?? null;
        if (!workItem) {
          return null;
        }
        return {
          workItem,
          sessions: snapshot.sessions.filter((entry) => entry.workItemId === workItemId),
          plans: snapshot.plans.filter((entry) => entry.workItemId === workItemId),
          runs: snapshot.runs.filter((entry) => entry.workItemId === workItemId),
          approvals: snapshot.approvals.filter((approval) => snapshot.runs.some((run) => run.id === approval.runId && run.workItemId === workItemId)),
          artifacts: snapshot.artifacts.filter(
            (artifact) => artifact.runId !== null && snapshot.runs.some((run) => run.id === artifact.runId && run.workItemId === workItemId)
          ),
          materializations: snapshot.materializations.filter((entry) => entry.workItemId === workItemId),
          collaborationThreads: snapshot.workItemCollaborationThreads
            .filter((thread) => thread.workItemId === workItemId)
            .map((thread) => ({
              thread,
              messages: snapshot.workItemCollaborationMessages.filter((message) => message.threadId === thread.id)
            }))
        };
      }
    },
    workItemCollaboration: {
      async listForWorkItem(workItemId) {
        const snapshot = await state.read();
        return snapshot.workItemCollaborationThreads
          .filter((thread) => thread.workItemId === workItemId)
          .map((thread) => ({
            thread,
            messages: snapshot.workItemCollaborationMessages.filter((message) => message.threadId === thread.id)
          }));
      }
    },
    runs: {
      async getRunView(runId) {
        const snapshot = await state.read();
        const run = snapshot.runs.find((entry) => entry.id === runId) ?? null;
        if (!run) {
          return null;
        }
        return {
          run,
          tasks: snapshot.tasks.filter((entry) => entry.runId === runId),
          runtimes: snapshot.agentRuntimes.filter((entry) => entry.runId === runId),
          delegationDecisions: snapshot.delegationDecisions.filter((entry) => entry.runId === runId),
          approvals: snapshot.approvals.filter((entry) => entry.runId === runId),
          planChangeRequests: snapshot.planChangeRequests.filter((entry) => entry.runId === runId),
          runnerJob: snapshot.runnerJobs.find((entry) => entry.runId === runId) ?? null
        };
      },
      async listEvents(runId) {
        const snapshot = await state.read();
        return snapshot.runEvents.filter((entry) => entry.runId === runId);
      }
    },
    clarifications: {
      async listForSession(sessionId) {
        const snapshot = await state.read();
        return snapshot.clarificationThreads
          .filter((thread) => thread.sessionId === sessionId)
          .map((thread) => ({
            thread,
            messages: snapshot.clarificationMessages.filter((message) => message.threadId === thread.id)
          }));
      }
    }
  };
}
