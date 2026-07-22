// Drives one request through the embedded runtime, surface-agnostically.
//
// A surface (VS Code chat, a CLI, a test harness) supplies handlers for events,
// approvals, and the final result; this module owns the mechanics: create a
// session, post the message, pump the in-process runner, stream new run events,
// and pause for approvals at the class_c governance gate. No vscode imports, so
// it can be verified headlessly against the real runtime.
import type { CrewServices } from "./runtime";

export type DriveOutcome =
  | { kind: "chat"; sessionId: string; text: string }
  | { kind: "clarification"; sessionId: string; text: string }
  | { kind: "run"; sessionId: string; runId: string; status: string; text: string };

export interface RunEvent {
  id: string;
  runId: string;
  eventType: string;
  taskId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ApprovalAsk {
  id: string;
  toolId: string | null;
  targetRef: string | null;
  actionSummary: string;
  taskId: string | null;
}

export interface DriveHandlers {
  onEvent?(event: RunEvent): void | Promise<void>;
  /** Return "approved" or "denied" for a pending class_c approval. */
  onApproval?(approval: ApprovalAsk): Promise<"approved" | "denied">;
  onStatus?(status: string): void | Promise<void>;
  /** Fired once a run is created, before the polling loop starts — lets a host offer a Stop control immediately. */
  onRunStarted?(runId: string): void;
}

export interface DriveOptions {
  actorUserId?: string;
  runnerId?: string;
  pollMs?: number;
  timeoutMs?: number;
  /** Continue this existing session (multi-turn chat). If absent, a new one is created. */
  sessionId?: string;
  /** Title used when a new session is created. */
  sessionTitle?: string;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Claim and start every queued runner job until the queue is drained. */
async function pump(services: CrewServices, runnerId: string): Promise<void> {
  for (;;) {
    const job = await services.runner.claimNext(runnerId);
    if (!job) {
      return;
    }
    await services.runner.start(job.id, runnerId);
  }
}

export async function driveRequest(
  services: CrewServices,
  prompt: string,
  handlers: DriveHandlers = {},
  options: DriveOptions = {}
): Promise<DriveOutcome> {
  const actorUserId = options.actorUserId ?? "user_primary";
  const runnerId = options.runnerId ?? "vscode-runtime";
  const pollMs = options.pollMs ?? 400;
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;

  // Continue an existing chat session, or open a new one.
  const sessionId = options.sessionId
    ?? (await services.pa.createSession("cli", options.sessionTitle ?? (prompt.slice(0, 80) || "commons-crew chat"))).session.id;
  const view = await services.pa.postMessage(sessionId, prompt);
  if (!view) {
    return { kind: "chat", sessionId, text: "The runtime could not continue this session." };
  }

  const lastMessageText = () => {
    const messages = view.messages ?? [];
    return messages.length ? messages[messages.length - 1].content : "";
  };

  if (!view.latestRun) {
    if ((view.pendingClarifications?.length ?? 0) > 0) {
      return { kind: "clarification", sessionId, text: lastMessageText() };
    }
    return { kind: "chat", sessionId, text: lastMessageText() };
  }

  const runId = view.latestRun.id;
  handlers.onRunStarted?.(runId);
  await pump(services, runnerId);

  const seenEvents = new Set<string>();
  const handledApprovals = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";

  for (;;) {
    if (Date.now() > deadline) {
      return { kind: "run", sessionId, runId, status: "timeout", text: "The run exceeded its time budget and was left running." };
    }

    const runView = await services.runs.get(runId);
    if (!runView) {
      return { kind: "run", sessionId, runId, status: "missing", text: "The run record disappeared." };
    }

    // Stream any new events in order.
    const events = (await services.runs.events(runId)) as unknown as RunEvent[];
    for (const event of events) {
      if (seenEvents.has(event.id)) {
        continue;
      }
      seenEvents.add(event.id);
      if (handlers.onEvent) {
        await handlers.onEvent(event);
      }
    }

    const status = runView.run.status;
    if (status !== lastStatus) {
      lastStatus = status;
      if (handlers.onStatus) {
        await handlers.onStatus(status);
      }
    }

    if (status === "blocked") {
      // Gather pending approvals bound to this run and clear them via the gate.
      const pending = runView.approvals.filter(
        (approval) => approval.status === "pending" && !handledApprovals.has(approval.id)
      );
      if (pending.length === 0) {
        // Blocked with no actionable approval (e.g. a denial). Report and stop.
        return { kind: "run", sessionId, runId, status, text: await finalText(services, sessionId) };
      }
      for (const approval of pending) {
        handledApprovals.add(approval.id);
        const decision = handlers.onApproval
          ? await handlers.onApproval({
              id: approval.id,
              toolId: approval.toolId,
              targetRef: approval.targetRef,
              actionSummary: approval.actionSummary,
              taskId: approval.taskId
            })
          : "denied";
        await services.approvals.decide(approval.id, decision, undefined, actorUserId);
      }
      // Approvals re-queue the run+job; pump to resume execution.
      await pump(services, runnerId);
      continue;
    }

    if (TERMINAL.has(status)) {
      return { kind: "run", sessionId, runId, status, text: await finalText(services, sessionId) };
    }

    await sleep(pollMs);
  }
}

/** The PA's final result message for the session, if any. */
async function finalText(services: CrewServices, sessionId: string): Promise<string> {
  const view = await services.pa.getSession(sessionId);
  const messages = view?.messages ?? [];
  const result = [...messages].reverse().find((message) => message.messageKind === "result");
  return result?.content ?? messages[messages.length - 1]?.content ?? "The run finished.";
}
