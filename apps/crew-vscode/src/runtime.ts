// The embedded commons-crew runtime.
//
// This is NOT a reimplementation of commons-crew — it is the real runtime.
// `createAppServices` (the same entry the container and API use) runs in-process
// inside the VS Code extension host, with:
//   - the user's BYO inference key (provider calls go straight to their endpoint),
//   - a file-backed json store under the extension's storage dir,
//   - the live labor-commons catalog mirrored locally,
//   - repoRoot = the bundled runtime (governance/prompts), and
//   - workspaceRoot = the user's open folder (where the runtime reads/writes/runs).
//
// The default action executor already acts on workspaceRoot, so a VS Code-open
// folder becomes the runtime's real workspace with no reimplemented tool layer.
import * as path from "node:path";
import { createAppServices } from "../../../packages/core/src/index";
import { loadConfig } from "../../../packages/config/src/index";
import { ensureCatalog } from "./catalog-sync";

export type CrewServices = Awaited<ReturnType<typeof createAppServices>>;

export interface RuntimeOptions {
  /** Bundled app/governance root (the extension install dir). */
  appRoot: string;
  /** The user's open folder — what the runtime acts on. */
  workspaceRoot: string;
  /** Writable per-install storage (json state, artifacts, catalog checkout). */
  storageRoot: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModels?: string[];
  catalogRef: string;
  catalogRepoUrl?: string;
  maxConcurrentLanes?: number;
  /** Maximum tool-loop iterations per task (maps to PA_MAX_TOOL_STEPS). */
  maxToolSteps?: number;
}

export interface EmbeddedRuntime {
  services: CrewServices;
  catalog: { ref: string; commit: string };
}

/**
 * Provision the catalog and boot the embedded runtime. Callers should cache the
 * result and rebuild when the key/model/workspace changes.
 */
export async function createEmbeddedRuntime(options: RuntimeOptions): Promise<EmbeddedRuntime> {
  const catalogDir = path.join(options.storageRoot, "catalog");
  const catalog = await ensureCatalog({
    dir: catalogDir,
    ref: options.catalogRef,
    repoUrl: options.catalogRepoUrl
  });

  const config = loadConfig({
    PA_CONFIG_PROFILE: "local",
    PA_PROVIDER_API_KEY: options.apiKey,
    PA_PROVIDER_BASE_URL: options.baseUrl,
    PA_PROVIDER_MODEL: options.model,
    PA_PROVIDER_FALLBACK_MODELS: (options.fallbackModels ?? []).join(","),
    PA_MAX_CONCURRENT_RUNS: String(options.maxConcurrentLanes ?? 4),
    PA_MAX_TOOL_STEPS: String(options.maxToolSteps ?? 40),
    OLF_AGENTS_ROOT: catalogDir,
    PA_WORKSPACE_ROOT: options.workspaceRoot,
    PA_ARTIFACTS_ROOT: path.join(options.storageRoot, "artifacts"),
    PA_STATE_FILE: path.join(options.storageRoot, "state.json"),
    PA_BACKUPS_ROOT: path.join(options.storageRoot, "backups")
  } as NodeJS.ProcessEnv);

  // repoRoot carries the bundled governance/prompts; workspaceRoot (set above)
  // is the user's folder. loadConfig resolves repoRoot from cwd, so pin it to
  // the extension install dir where governance/ is packaged.
  (config.paths as { repoRoot: string }).repoRoot = options.appRoot;

  const services = await createAppServices(config, {});
  await services.catalog.sync();
  return { services, catalog };
}
