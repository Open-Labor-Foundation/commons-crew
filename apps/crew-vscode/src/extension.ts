import * as vscode from "vscode";
import { loadCodingSpecialists, type CatalogSpecialist } from "./catalog";
import { composeSystemPrompt, pickSpecialist } from "./specialist";
import { runAgentLoop } from "./agent-loop";
import type { InferenceConfig } from "./inference";

// Cache the materialized catalog per ref so we don't re-fetch on every message.
const catalogCache = new Map<string, CatalogSpecialist[]>();

function readConfig() {
  const cfg = vscode.workspace.getConfiguration("commonsCrew");
  const inference: InferenceConfig = {
    apiKey: cfg.get<string>("apiKey", ""),
    baseUrl: cfg.get<string>("baseUrl", "https://api.featherless.ai/v1"),
    model: cfg.get<string>("model", "Qwen/Qwen3-32B")
  };
  return {
    inference,
    catalogRef: cfg.get<string>("catalogRef", "main"),
    autoApprove: cfg.get<boolean>("autoApprove", false),
    maxIterations: cfg.get<number>("maxIterations", 40)
  };
}

async function getSpecialists(ref: string): Promise<CatalogSpecialist[]> {
  const cached = catalogCache.get(ref);
  if (cached) {
    return cached;
  }
  const specialists = await loadCodingSpecialists(ref);
  catalogCache.set(ref, specialists);
  return specialists;
}

export function activate(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
    const { inference, catalogRef, autoApprove, maxIterations } = readConfig();

    if (!inference.apiKey) {
      stream.markdown(
        "No inference key set. Add your API key to **commonsCrew.apiKey** in Settings (it stays on your machine — the runtime runs locally and calls your endpoint directly)."
      );
      return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      stream.markdown("Open a folder/workspace first — I work autonomously inside it.");
      return;
    }

    stream.progress("Materializing the right specialist from labor-commons…");
    let specialists: CatalogSpecialist[];
    try {
      specialists = await getSpecialists(catalogRef);
    } catch (err: any) {
      stream.markdown(`Could not load the catalog: ${err?.message ?? String(err)}`);
      return;
    }
    if (!specialists.length) {
      stream.markdown("No software specialists were found in the catalog.");
      return;
    }

    const specialist = await pickSpecialist(inference, specialists, request.prompt);
    stream.markdown(
      `**${specialist.manifest.identity.name}** materialized (\`${specialist.slug}\` from labor-commons@${catalogRef}). Working autonomously${autoApprove ? "" : " — I'll ask before writing files or running commands"}…\n`
    );

    await runAgentLoop({
      config: inference,
      systemPrompt: composeSystemPrompt(specialist),
      task: request.prompt,
      ctx: { workspaceRoot: folder.uri.fsPath, autoApprove, stream },
      maxIterations,
      token
    });
  };

  const participant = vscode.chat.createChatParticipant("commons-crew.chat", handler);
  participant.iconPath = new vscode.ThemeIcon("organization");
  context.subscriptions.push(participant);
}

export function deactivate() {
  catalogCache.clear();
}
