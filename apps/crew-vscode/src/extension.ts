import * as vscode from "vscode";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "./runtime";
import { driveRequest, type RunEvent } from "./driver";

// The VS Code surface is a thin shell over the embedded commons-crew runtime.
// It reads settings, boots the real runtime once per workspace/key, and maps the
// surface-agnostic driver's events/approvals onto the chat stream. All the
// substance (materialization, the governed tool loop, real file/command actions)
// lives in the runtime — the extension is "just a use case for commons-crew".

interface RuntimeKey {
  apiKey: string;
  model: string;
  baseUrl: string;
  catalogRef: string;
  workspaceRoot: string;
}

let cached: { key: string; runtime: EmbeddedRuntime } | null = null;

function readConfig() {
  const cfg = vscode.workspace.getConfiguration("commonsCrew");
  return {
    apiKey: cfg.get<string>("apiKey", ""),
    baseUrl: cfg.get<string>("baseUrl", "https://api.featherless.ai/v1"),
    model: cfg.get<string>("model", "Qwen/Qwen3-32B"),
    catalogRef: cfg.get<string>("catalogRef", "main"),
    autoApprove: cfg.get<boolean>("autoApprove", false)
  };
}

async function getRuntime(context: vscode.ExtensionContext, key: RuntimeKey): Promise<EmbeddedRuntime> {
  const signature = JSON.stringify(key);
  if (cached && cached.key === signature) {
    return cached.runtime;
  }
  if (cached) {
    await cached.runtime.services.shutdown().catch(() => undefined);
    cached = null;
  }
  const runtime = await createEmbeddedRuntime({
    appRoot: context.extensionUri.fsPath,
    workspaceRoot: key.workspaceRoot,
    storageRoot: context.globalStorageUri.fsPath,
    apiKey: key.apiKey,
    baseUrl: key.baseUrl,
    model: key.model,
    catalogRef: key.catalogRef
  });
  cached = { key: signature, runtime };
  return runtime;
}

function describeEvent(event: RunEvent): string | null {
  const p = event.payload ?? {};
  switch (event.eventType) {
    case "task.started":
      return `▶ **${p.assignedAgentName ?? "Specialist"}** — ${p.name ?? "task"}`;
    case "task.tool_call": {
      const ok = p.ok === false ? "✗" : "✓";
      return `  ${ok} \`${p.tool}\` ${p.targetRef ?? ""} — ${p.outcome ?? ""}`;
    }
    case "task.completed":
      return p.executionSummary ? `  ↳ ${p.executionSummary}` : null;
    case "approval.requested":
      return "  ⏸ awaiting approval for a side effect…";
    default:
      return null;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
    const cfg = readConfig();
    if (!cfg.apiKey) {
      stream.markdown(
        "No inference key set. Add your API key to **commonsCrew.apiKey** in Settings — the full commons-crew runtime runs locally in this extension and calls your endpoint directly (BYO key)."
      );
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      stream.markdown("Open a folder/workspace first — the runtime acts inside it.");
      return;
    }

    stream.progress("Booting the commons-crew runtime and syncing the labor-commons catalog…");
    let runtime: EmbeddedRuntime;
    try {
      runtime = await getRuntime(context, {
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        catalogRef: cfg.catalogRef,
        workspaceRoot: folder.uri.fsPath
      });
    } catch (error: any) {
      stream.markdown(`Could not start the runtime: ${error?.message ?? String(error)}`);
      return;
    }
    stream.markdown(`Runtime ready — catalog \`labor-commons@${runtime.catalog.ref}\` (${runtime.catalog.commit.slice(0, 7)}).\n\n`);

    const outcome = await driveRequest(
      runtime.services,
      request.prompt.slice(0, 80) || "commons-crew session",
      request.prompt,
      {
        onEvent(event) {
          if (token.isCancellationRequested) {
            return;
          }
          const line = describeEvent(event);
          if (line) {
            stream.markdown(line + "\n\n");
          }
        },
        async onApproval(approval) {
          if (cfg.autoApprove) {
            stream.markdown(`  ✅ auto-approved \`${approval.toolId}\` ${approval.targetRef ?? ""}\n\n`);
            return "approved";
          }
          const pick = await vscode.window.showWarningMessage(
            `commons-crew wants to run a governed side effect: ${approval.actionSummary}`,
            { modal: true },
            "Approve",
            "Deny"
          );
          const decision = pick === "Approve" ? "approved" : "denied";
          stream.markdown(`  ${decision === "approved" ? "✅ approved" : "🚫 denied"} \`${approval.toolId}\` ${approval.targetRef ?? ""}\n\n`);
          return decision;
        }
      }
    );

    if (outcome.kind === "clarification") {
      stream.markdown(`I need a bit more detail before starting:\n\n> ${outcome.text}`);
      return;
    }
    if (outcome.kind === "chat") {
      stream.markdown(outcome.text);
      return;
    }
    stream.markdown(`\n---\n**Run ${outcome.status}.**\n\n${outcome.text}`);
  };

  const participant = vscode.chat.createChatParticipant("commons-crew.chat", handler);
  participant.iconPath = new vscode.ThemeIcon("organization");
  context.subscriptions.push(participant);
}

export function deactivate() {
  if (cached) {
    void cached.runtime.services.shutdown().catch(() => undefined);
    cached = null;
  }
}
