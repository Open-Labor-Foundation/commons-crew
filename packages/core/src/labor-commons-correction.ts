/**
 * commons-crew's own side of practitioner corrections into labor-commons --
 * the half of the gap commons-board's labor-commons-correction.ts didn't
 * close: a specialist proposing a correction to its own record from inside
 * a running task, not a human editing it through commons-board's UI. See
 * open-labor-foundation/ARCHITECTURE.md's "Practitioner corrections" note.
 *
 * A correction becomes a real PR against labor-commons, reviewed by a
 * human -- it does not merge itself. GOVERNANCE.md's model applies to it
 * the same as any other catalog change; this module's only job is turning
 * a validated field-level edit into a well-attributed PR, nothing more.
 * Mirrors commons-board's mechanism closely (same ephemeral git worktree
 * pattern, same olf-steward[bot] identity, same "never touch the shared
 * read checkout directly" reasoning -- LocalCatalogService reads
 * config.paths.olfAgentsRoot concurrently for every other request this
 * service serves), adapted to commons-crew's own host abstraction (async
 * fs via ./host, not node:fs sync) and its own identifier scheme: a
 * catalog entry's `id` IS its path relative to olfAgentsRoot (see
 * packages/catalog/src/index.ts's toEntry), so there's no separate
 * sectionSlug/agentSlug pair to resolve here the way commons-board needs.
 */
import { fs, path, execFileAsync, randomUUID } from "./host";
import { parseDocument } from "yaml";
import type { AppConfig } from "../../config/src/index";
import type { CatalogEntry } from "../../contracts/src/index";

export interface SpecCorrectionInput {
  /** A real CatalogEntry.id, e.g. "catalog/naics-overlays/54161/business-consultant/spec.yaml". */
  manifestId: string;
  /** Dot-path into the spec, e.g. ["metadata", "specialty_boundary"]. */
  fieldPath: string[];
  proposedValue: string;
  justification: string;
}

export interface SpecCorrectionAttribution {
  actionId: string;
  runId: string | null;
  taskId: string | null;
}

export type SpecCorrectionResult =
  | { ok: true; prUrl: string; branch: string }
  | { ok: false; unavailable: true; reason: string };

const BOT_NAME = "olf-steward[bot]";
const BOT_EMAIL = "299857430+olf-steward[bot]@users.noreply.github.com";

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { cwd, env: process.env });
  return stdout.trim();
}

// Same defense-in-depth reasoning as commons-board's identical check: entry.id
// is already validated by LocalCatalogService's own directory walk (it can
// only ever be a real relative path it discovered on disk), but this file's
// own path safety shouldn't depend on trusting that guarantee held upstream.
function assertWithinWorktree(worktreeDir: string, candidate: string): string {
  const worktreeRoot = path.resolve(worktreeDir) + path.sep;
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(worktreeRoot)) {
    throw new Error("Resolved correction path escapes the ephemeral worktree -- rejected.");
  }
  return candidate;
}

async function pathExists(location: string): Promise<boolean> {
  try {
    await fs.access(location);
    return true;
  } catch {
    return false;
  }
}

export async function proposeSpecCorrection(
  config: AppConfig,
  catalogEntries: CatalogEntry[],
  input: SpecCorrectionInput,
  attribution: SpecCorrectionAttribution
): Promise<SpecCorrectionResult> {
  const ghToken = config.laborCommons.ghToken;
  if (!ghToken) {
    return { ok: false, unavailable: true, reason: "PA_LABOR_COMMONS_GH_TOKEN is not configured on this deployment." };
  }

  const entry = catalogEntries.find((candidate) => candidate.id === input.manifestId);
  if (!entry) {
    throw new Error(`No catalog entry found for manifestId "${input.manifestId}".`);
  }

  const remoteUrl = config.laborCommons.remoteUrl
    ?? `https://x-access-token:${ghToken}@github.com/Open-Labor-Foundation/labor-commons.git`;
  const ghApiBase = config.laborCommons.ghApiBase;

  const worktreeParent = path.join(config.paths.artifactsRoot, "labor-commons-correction-worktrees");
  await fs.mkdir(worktreeParent, { recursive: true });
  const worktreeDir = path.join(worktreeParent, randomUUID());
  const branch = `correction/${entry.agentSlug}-${randomUUID().slice(0, 8)}`;

  try {
    await run("git", ["fetch", "origin", "main"], config.paths.olfAgentsRoot);
    await run("git", ["worktree", "add", worktreeDir, "-b", branch, "origin/main"], config.paths.olfAgentsRoot);

    const worktreeSpecPath = assertWithinWorktree(worktreeDir, path.join(worktreeDir, input.manifestId));
    if (!(await pathExists(worktreeSpecPath))) {
      throw new Error(`spec.yaml not found at "${input.manifestId}" in the fetched labor-commons worktree.`);
    }

    const raw = await fs.readFile(worktreeSpecPath, "utf8");
    const doc = parseDocument(raw);
    const currentValue = doc.getIn(input.fieldPath);
    if (currentValue === undefined) {
      throw new Error(`Field path "${input.fieldPath.join(".")}" does not exist in ${input.manifestId}.`);
    }
    doc.setIn(input.fieldPath, input.proposedValue);
    await fs.writeFile(worktreeSpecPath, String(doc), "utf8");

    await run("git", ["add", input.manifestId], worktreeDir);

    const attributionLine = [
      `Proposed by commons-crew action ${attribution.actionId}`,
      attribution.runId ? ` (run ${attribution.runId}` : " (",
      attribution.taskId ? `, task ${attribution.taskId}` : "",
      ")."
    ].join("");

    const commitMessage = [
      `Specialist self-correction: ${entry.agentSlug} ${input.fieldPath.join(".")}`,
      "",
      input.justification,
      "",
      attributionLine
    ].join("\n");
    await run(
      "git",
      ["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, "commit", "-m", commitMessage],
      worktreeDir
    );

    await run("git", ["push", remoteUrl, `HEAD:${branch}`], worktreeDir);

    const prBody = [
      `**${attributionLine}**`,
      "",
      "This is a specialist proposing a correction to its own record mid-task -- not a human editing it through commons-board's UI. See open-labor-foundation/ARCHITECTURE.md's \"Practitioner corrections\" section.",
      "",
      `**Field:** \`${input.fieldPath.join(".")}\``,
      "",
      "**Justification:**",
      input.justification,
      "",
      "**Previous value:**",
      "```",
      String(currentValue),
      "```",
      "",
      "**Proposed value:**",
      "```",
      input.proposedValue,
      "```",
      "",
      "This PR must pass labor-commons-curator's certification gate and independent review before merging -- see [open-labor-foundation/GOVERNANCE.md](https://github.com/Open-Labor-Foundation/open-labor-foundation/blob/main/GOVERNANCE.md)."
    ].join("\n");

    const prResp = await fetch(`${ghApiBase}/repos/Open-Labor-Foundation/labor-commons/pulls`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ghToken}`,
        "content-type": "application/json",
        accept: "application/vnd.github+json"
      },
      body: JSON.stringify({
        title: `Specialist self-correction: ${entry.agentSlug} ${input.fieldPath.join(".")}`,
        head: branch,
        base: "main",
        body: prBody
      })
    });
    if (!prResp.ok) {
      const text = await prResp.text().catch(() => "(unreadable)");
      throw new Error(`labor-commons PR creation failed (${prResp.status}): ${text}`);
    }
    const pr = (await prResp.json()) as { html_url?: string };
    if (!pr.html_url) {
      throw new Error("labor-commons PR creation response was missing html_url.");
    }

    return { ok: true, prUrl: pr.html_url, branch };
  } finally {
    try {
      await run("git", ["worktree", "remove", worktreeDir, "--force"], config.paths.olfAgentsRoot);
    } catch {
      await fs.rm(worktreeDir, { recursive: true, force: true });
    }
  }
}
