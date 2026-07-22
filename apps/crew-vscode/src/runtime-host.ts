import * as vscode from "vscode";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "./runtime";

// One embedded runtime per (key/model/workspace) signature, cached and rebuilt
// when the relevant settings or the open folder change. Shared by the chat and
// history views so they operate on the same runtime + session store.

export interface CrewSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModels: string[];
  catalogRef: string;
  autoApprove: boolean;
  maxConcurrentLanes: number;
  maxIterations: number;
}

export function readSettings(): CrewSettings {
  const cfg = vscode.workspace.getConfiguration("commonsCrew");
  return {
    apiKey: cfg.get<string>("apiKey", ""),
    baseUrl: cfg.get<string>("baseUrl", "https://api.featherless.ai/v1"),
    model: cfg.get<string>("model", "auto"),
    fallbackModels: cfg.get<string[]>("fallbackModels", []),
    catalogRef: cfg.get<string>("catalogRef", "main"),
    autoApprove: cfg.get<boolean>("autoApprove", false),
    maxConcurrentLanes: cfg.get<number>("maxConcurrentLanes", 4),
    maxIterations: cfg.get<number>("maxIterations", 40)
  };
}

export function currentWorkspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

export class RuntimeHost {
  private cached: { signature: string; runtime: EmbeddedRuntime } | null = null;
  private inflight: Promise<EmbeddedRuntime> | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Boot (or reuse) the embedded runtime for the current settings + workspace. */
  async get(): Promise<EmbeddedRuntime> {
    const settings = readSettings();
    if (!settings.apiKey) {
      throw new Error("no-api-key");
    }
    const workspaceRoot = currentWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("no-workspace");
    }
    const signature = JSON.stringify({
      apiKey: settings.apiKey,
      model: settings.model,
      baseUrl: settings.baseUrl,
      fallbackModels: settings.fallbackModels,
      catalogRef: settings.catalogRef,
      maxConcurrentLanes: settings.maxConcurrentLanes,
      maxIterations: settings.maxIterations,
      workspaceRoot
    });
    if (this.cached && this.cached.signature === signature) {
      return this.cached.runtime;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = (async () => {
      if (this.cached) {
        await this.cached.runtime.services.shutdown().catch(() => undefined);
        this.cached = null;
      }
      const runtime = await createEmbeddedRuntime({
        appRoot: this.context.extensionUri.fsPath,
        workspaceRoot,
        storageRoot: this.context.globalStorageUri.fsPath,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        catalogRef: settings.catalogRef,
        catalogRepoUrl: undefined,
        fallbackModels: settings.fallbackModels,
        maxConcurrentLanes: settings.maxConcurrentLanes,
        maxToolSteps: settings.maxIterations
      });
      this.cached = { signature, runtime };
      return runtime;
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /** The already-booted runtime, if any (no boot). */
  peek(): EmbeddedRuntime | null {
    return this.cached?.runtime ?? null;
  }

  async dispose(): Promise<void> {
    if (this.cached) {
      await this.cached.runtime.services.shutdown().catch(() => undefined);
      this.cached = null;
    }
  }
}
