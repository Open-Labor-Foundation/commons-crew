// Catalog = a live link to labor-commons main.
//
// The catalog is never bundled. On a Node host we keep a shallow git checkout of
// labor-commons (default: main) mirrored into the directory the runtime reads
// specialists from (OLF_AGENTS_ROOT). This is the Node-host provisioning of the
// catalog source; a mobile host would fetch the same specs over HTTP into its
// app sandbox instead. The runtime core itself just reads the directory — it
// doesn't know or care how it got populated.
//
// This is host-layer code (apps/crew-api), so it uses node:* directly; the
// portable runtime core does not.

import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_CATALOG_REPO_URL = "https://github.com/Open-Labor-Foundation/labor-commons.git";
const DEFAULT_CATALOG_REF = "main";

export interface CatalogCheckoutConfig {
  /** Git URL of the catalog repo. Default: Open-Labor-Foundation/labor-commons. */
  repoUrl: string;
  /** Branch/ref to track. Default: main. */
  ref: string;
  /** Local directory to mirror the catalog into (== OLF_AGENTS_ROOT). */
  dir: string;
}

export interface CatalogCheckoutResult {
  ref: string;
  commit: string;
}

/**
 * Resolve catalog-checkout config from the environment. Returns null when
 * auto-sync is not enabled (dev runs against an existing local checkout via
 * OLF_AGENTS_ROOT and manage it themselves).
 */
export function resolveCatalogCheckoutConfig(env: NodeJS.ProcessEnv = process.env): CatalogCheckoutConfig | null {
  const enabled = /^(1|true|yes)$/i.test(String(env.CATALOG_AUTO_SYNC ?? ""));
  if (!enabled) {
    return null;
  }
  const dir = env.OLF_AGENTS_ROOT;
  if (!dir) {
    throw new Error("CATALOG_AUTO_SYNC is set but OLF_AGENTS_ROOT is not — set it to the directory the catalog should be mirrored into.");
  }
  return {
    repoUrl: env.CATALOG_REPO_URL ?? DEFAULT_CATALOG_REPO_URL,
    ref: env.CATALOG_REF ?? DEFAULT_CATALOG_REF,
    dir: path.resolve(dir)
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure `dir` is a shallow checkout of `repoUrl`@`ref`, updated to the tip.
 * Clones on first run, otherwise fetches and hard-resets to the remote ref so
 * the catalog stays a faithful mirror of labor-commons main.
 */
export async function ensureCatalogCheckout(config: CatalogCheckoutConfig): Promise<CatalogCheckoutResult> {
  const gitDir = path.join(config.dir, ".git");
  if (await pathExists(gitDir)) {
    await execFileAsync("git", ["-C", config.dir, "fetch", "--depth", "1", "origin", config.ref]);
    await execFileAsync("git", ["-C", config.dir, "reset", "--hard", `origin/${config.ref}`]);
    await execFileAsync("git", ["-C", config.dir, "clean", "-fd"]);
  } else {
    await mkdir(path.dirname(config.dir), { recursive: true });
    await execFileAsync("git", ["clone", "--depth", "1", "--branch", config.ref, config.repoUrl, config.dir]);
  }
  const { stdout } = await execFileAsync("git", ["-C", config.dir, "rev-parse", "HEAD"]);
  return { ref: config.ref, commit: stdout.trim() };
}
