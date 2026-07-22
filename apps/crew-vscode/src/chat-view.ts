import * as vscode from "vscode";
import { RuntimeHost, readSettings } from "./runtime-host";
import { driveRequest, type RunEvent, type ApprovalAsk } from "./driver";
import { chatWebviewHtml } from "./chat-webview";

// The commons-crew webview provider. Owns one webview that renders the session
// history rail and the chat side by side. Maps the surface-agnostic run driver's
// events/approvals onto the chat UI. One active session at a time; clicking a
// row in the rail swaps which session is loaded.

interface SessionRow {
  id: string;
  title: string;
  updatedAt: string;
}

function nonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function describeEvent(event: RunEvent): { text: string; kind?: "ok" | "err" | "think" } | null {
  const p = event.payload ?? {};
  switch (event.eventType) {
    case "task.started":
      return { text: `▶ ${p.assignedAgentName ?? "Specialist"} — ${p.name ?? "task"}` };
    case "task.reasoning":
      return typeof p.text === "string" && p.text ? { text: `  🤔 ${p.text}`, kind: "think" } : null;
    case "task.tool_call": {
      const ok = p.ok === false ? "✗" : "✓";
      return { text: `  ${ok} ${p.tool} ${p.targetRef ?? ""} — ${p.outcome ?? ""}`, kind: p.ok === false ? "err" : "ok" };
    }
    case "task.completed":
      return p.executionSummary ? { text: `  ↳ ${p.executionSummary}` } : null;
    case "approval.requested":
      return { text: "  ⏸ awaiting approval…" };
    default:
      return null;
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private activeSessionId: string | null = null;
  private activeRunId: string | null = null;
  private readonly approvalResolvers = new Map<string, (decision: "approved" | "denied") => void>();
  private concurrencyCostByModel: Map<string, number | null> | null = null;
  private usageThisTurn = { promptTokens: 0, completionTokens: 0, model: "" };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: RuntimeHost
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    view.webview.html = chatWebviewHtml(nonce(), view.webview.cspSource);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  /** Push the latest session list (newest first) into the rail. */
  async refreshSessions(): Promise<void> {
    const runtime = this.host.peek();
    let sessions: SessionRow[] = [];
    if (runtime) {
      sessions = (await runtime.services.pa.listSessions("cli")) as SessionRow[];
    }
    this.post({
      type: "sessions",
      activeId: this.activeSessionId,
      sessions: sessions.map((s) => ({ id: s.id, title: s.title, when: relativeTime(s.updatedAt) }))
    });
  }

  newChat(): void {
    this.activeSessionId = null;
    this.activeRunId = null;
    this.approvalResolvers.clear();
    this.post({ type: "reset" });
    void this.refreshSessions();
    void vscode.commands.executeCommand("commonsCrew.main.focus");
  }

  /** concurrency_cost for a model id from the provider's live catalog, if it can enumerate one. Cached per runtime boot. */
  private async concurrencyCostFor(modelId: string): Promise<number | null> {
    const runtime = this.host.peek();
    if (!runtime) return null;
    if (!this.concurrencyCostByModel) {
      this.concurrencyCostByModel = new Map();
      try {
        const models = await runtime.services.provider.listModels?.();
        for (const entry of models ?? []) {
          this.concurrencyCostByModel.set(entry.id, entry.concurrencyCost);
        }
      } catch {
        // No catalog available (non-Featherless provider, or offline) — cost just won't show.
      }
    }
    return this.concurrencyCostByModel.get(modelId) ?? null;
  }

  async stopActiveRun(): Promise<void> {
    const runtime = this.host.peek();
    if (!runtime || !this.activeRunId) return;
    await runtime.services.runs.control(this.activeRunId, "cancel", "Stopped by user from the commons-crew chat.");
    this.post({ type: "event", text: "  ⏹ stopped by user", kind: "err" });
  }

  async openSession(sessionId: string): Promise<void> {
    this.activeSessionId = sessionId;
    await vscode.commands.executeCommand("commonsCrew.main.focus");
    const runtime = this.host.peek();
    if (!runtime) {
      // Not booted yet (e.g. no key). The view will show the config CTA on send.
      void this.refreshSessions();
      return;
    }
    const sessionView = await runtime.services.pa.getSession(sessionId);
    const messages = (sessionView?.messages ?? []).map((m: { authorType: string; content: string }) => ({
      role: m.authorType === "user" ? "user" : "assistant",
      text: m.content
    }));
    this.post({ type: "hydrate", messages });
    void this.refreshSessions();
  }

  async deleteSession(sessionId: string): Promise<void> {
    const runtime = this.host.peek();
    if (!runtime) return;
    await runtime.services.pa.archiveSession(sessionId);
    if (this.activeSessionId === sessionId) {
      this.newChat();
    } else {
      void this.refreshSessions();
    }
  }

  private async onMessage(msg: { type: string; text?: string; id?: string; decision?: "approved" | "denied" }): Promise<void> {
    switch (msg.type) {
      case "ready":
        void this.refreshSessions();
        if (this.activeSessionId) void this.openSession(this.activeSessionId);
        return;
      case "newChat":
        this.newChat();
        return;
      case "openSession":
        if (msg.id) void this.openSession(msg.id);
        return;
      case "deleteSession":
        if (msg.id) void this.deleteSession(msg.id);
        return;
      case "openSettings":
        void vscode.commands.executeCommand("workbench.action.openSettings", "commonsCrew");
        return;
      case "approval":
        if (msg.id && msg.decision) {
          this.approvalResolvers.get(msg.id)?.(msg.decision);
          this.approvalResolvers.delete(msg.id);
        }
        return;
      case "send":
        if (msg.text) await this.runTurn(msg.text);
        return;
      case "stop":
        void this.stopActiveRun();
        return;
    }
  }

  private async runTurn(text: string): Promise<void> {
    this.post({ type: "busy", value: true });
    this.usageThisTurn = { promptTokens: 0, completionTokens: 0, model: "" };
    const settings = readSettings();

    let runtime;
    try {
      runtime = await this.host.get();
    } catch (error: any) {
      const reason =
        error?.message === "no-api-key" || error?.message === "no-workspace"
          ? error.message
          : String(error?.message ?? error);
      this.post({ type: "needsConfig", reason });
      return;
    }

    this.post({
      type: "status",
      text: this.activeSessionId ? "Thinking…" : "Booting the runtime and syncing the labor-commons catalog…"
    });

    try {
      const outcome = await driveRequest(
        runtime.services,
        text,
        {
          onStatus: (status) => {
            const label: Record<string, string> = {
              queued: "Queued…",
              running: "Working…",
              blocked: "Waiting for approval…"
            };
            if (label[status]) this.post({ type: "status", text: label[status] });
          },
          onEvent: (event) => {
            if (event.eventType === "task.usage") {
              const p = event.payload as { model?: string; promptTokens?: number; completionTokens?: number };
              this.usageThisTurn.promptTokens += p.promptTokens ?? 0;
              this.usageThisTurn.completionTokens += p.completionTokens ?? 0;
              this.usageThisTurn.model = p.model ?? this.usageThisTurn.model;
              void this.concurrencyCostFor(this.usageThisTurn.model).then((concurrencyCost) => {
                this.post({ type: "usage", ...this.usageThisTurn, concurrencyCost });
              });
              return;
            }
            const line = describeEvent(event);
            if (line) this.post({ type: "event", text: line.text, kind: line.kind });
          },
          onApproval: (approval: ApprovalAsk) => this.requestApproval(approval, settings.autoApprove),
          onRunStarted: (runId) => {
            this.activeRunId = runId;
            this.post({ type: "runActive", value: true });
          }
        },
        { sessionId: this.activeSessionId ?? undefined, sessionTitle: text.slice(0, 80) }
      );

      this.activeSessionId = outcome.sessionId;
      this.post({ type: "assistant", text: outcome.text });
      void this.refreshSessions();
    } catch (error: any) {
      this.post({ type: "error", text: `Run failed: ${error?.message ?? String(error)}` });
    } finally {
      this.activeRunId = null;
      this.post({ type: "runActive", value: false });
      this.post({ type: "busy", value: false });
    }
  }

  private requestApproval(approval: ApprovalAsk, autoApprove: boolean): Promise<"approved" | "denied"> {
    if (autoApprove) {
      this.post({ type: "event", text: `  ✅ auto-approved ${approval.toolId ?? "side effect"} ${approval.targetRef ?? ""}` });
      return Promise.resolve("approved");
    }
    this.post({
      type: "approval",
      id: approval.id,
      summary: approval.actionSummary,
      toolId: approval.toolId,
      targetRef: approval.targetRef
    });
    return new Promise<"approved" | "denied">((resolve) => {
      this.approvalResolvers.set(approval.id, resolve);
    });
  }
}
