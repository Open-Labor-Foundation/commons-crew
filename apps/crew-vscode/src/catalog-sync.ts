// Catalog provisioning for the VS Code host.
//
// The catalog is never bundled. On this Node host we keep a shallow git checkout
// of labor-commons mirrored into the directory the embedded runtime reads
// specialists from (OLF_AGENTS_ROOT). The runtime core just reads the directory
// — it doesn't know or care how it got populated. Host-layer code, so it uses
// node:* directly.
import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_CATALOG_REPO_URL = "https://github.com/Open-Labor-Foundation/labor-commons.git";

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export interface CatalogSyncOptions {
  dir: string;
  ref: string;
  repoUrl?: string;
}

/**
 * Ensure `dir` is a shallow checkout of labor-commons@`ref`, updated to the tip.
 * Clones on first run, otherwise fetches and hard-resets so the catalog stays a
 * faithful mirror. Returns the resolved commit.
 */
export async function ensureCatalog(options: CatalogSyncOptions): Promise<{ ref: string; commit: string }> {
  const repoUrl = options.repoUrl ?? DEFAULT_CATALOG_REPO_URL;
  const gitDir = path.join(options.dir, ".git");
  if (await pathExists(gitDir)) {
    await execFileAsync("git", ["-C", options.dir, "fetch", "--depth", "1", "origin", options.ref]);
    await execFileAsync("git", ["-C", options.dir, "reset", "--hard", `origin/${options.ref}`]);
    await execFileAsync("git", ["-C", options.dir, "clean", "-fd"]);
  } else {
    await mkdir(path.dirname(options.dir), { recursive: true });
    await execFileAsync("git", ["clone", "--depth", "1", "--branch", options.ref, repoUrl, options.dir]);
  }
  const { stdout } = await execFileAsync("git", ["-C", options.dir, "rev-parse", "HEAD"]);
  return { ref: options.ref, commit: stdout.trim() };
}
