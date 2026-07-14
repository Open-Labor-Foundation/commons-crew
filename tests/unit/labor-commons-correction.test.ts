import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { proposeSpecCorrection } from "../../packages/core/src/labor-commons-correction";
import { LocalCatalogService } from "../../packages/catalog/src/index";
import { loadConfigOrThrow } from "../../packages/config/src/index";
import type { CatalogEntry } from "../../packages/contracts/src/index";

const execFileAsync = promisify(execFile);
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

const FIXTURE_SPEC = `schema_version: "1.0"
kind: "agent_definition"
metadata:
  slug: "test-specialist"
  name: "Test specialist"
  domain_family: "test/test-specialist"
  specialty_boundary: "Owns test work."
  status: "validated"
purpose:
  summary: "A specialist that exists only for this test."
scope:
  supported_tasks:
    - "Do the one test task."
  common_inputs:
    - "test input"
  expected_outputs:
    - "test output"
`;

/**
 * Hermetic, same reasoning as commons-board's identical test for its own
 * half of this mechanism: no real GitHub involved. A local bare repo
 * stands in for labor-commons' remote (PA_LABOR_COMMONS_REMOTE_URL), and a
 * local HTTP server stands in for the GitHub API
 * (PA_LABOR_COMMONS_GH_API_BASE). Unlike commons-board, commons-crew's
 * correction mechanism reuses the SAME checkout LocalCatalogService reads
 * from (config.paths.olfAgentsRoot) rather than a second, separate path --
 * that's real production shape, and this test drives catalog discovery
 * through the real LocalCatalogService rather than hand-building a
 * CatalogEntry, so manifestId is exactly what a real autonomous tool call
 * would see on specialist.id.
 */
describe("proposeSpecCorrection", () => {
  let tempRoot: string;
  let bareRepoPath: string;
  let checkoutPath: string;
  let server: Server;
  let apiBaseUrl: string;
  let lastPrRequestBody: Record<string, unknown> | null;
  let catalogEntries: CatalogEntry[];
  let testSpecialistId: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commons-crew-lc-correction-test-"));
    bareRepoPath = path.join(tempRoot, "labor-commons-bare.git");
    checkoutPath = path.join(tempRoot, "labor-commons-checkout");

    await execFileAsync("git", ["init", "--bare", "-b", "main", bareRepoPath]);

    await fs.mkdir(checkoutPath, { recursive: true });
    await git(["init", "-b", "main"], checkoutPath);
    await git(["remote", "add", "origin", bareRepoPath], checkoutPath);

    const specDir = path.join(checkoutPath, "catalog", "naics-overlays", "test-industry", "test-specialist");
    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(path.join(specDir, "spec.yaml"), FIXTURE_SPEC, "utf8");

    await git(["add", "."], checkoutPath);
    await git(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "seed"], checkoutPath);
    await git(["push", "origin", "main"], checkoutPath);

    lastPrRequestBody = null;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        lastPrRequestBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ html_url: "https://github.com/Open-Labor-Foundation/labor-commons/pull/999" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a network address");
    apiBaseUrl = `http://127.0.0.1:${address.port}`;

    const config = loadConfigOrThrow({
      ...process.env,
      NODE_ENV: "test",
      OLF_AGENTS_ROOT: checkoutPath,
      PA_ARTIFACTS_ROOT: path.join(tempRoot, "artifacts"),
      PA_LABOR_COMMONS_GH_TOKEN: "test-token",
      PA_LABOR_COMMONS_REMOTE_URL: bareRepoPath,
      PA_LABOR_COMMONS_GH_API_BASE: apiBaseUrl
    });
    const catalog = new LocalCatalogService(config);
    await catalog.sync();
    catalogEntries = await catalog.listEntries();
    const testEntry = catalogEntries.find((entry) => entry.agentSlug === "test-specialist");
    if (!testEntry) throw new Error("expected LocalCatalogService to discover the seeded test-specialist fixture");
    testSpecialistId = testEntry.id;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function buildConfig(overrides: Record<string, string | undefined> = {}) {
    return loadConfigOrThrow({
      ...process.env,
      NODE_ENV: "test",
      OLF_AGENTS_ROOT: checkoutPath,
      PA_ARTIFACTS_ROOT: path.join(tempRoot, "artifacts"),
      PA_LABOR_COMMONS_GH_TOKEN: "test-token",
      PA_LABOR_COMMONS_REMOTE_URL: bareRepoPath,
      PA_LABOR_COMMONS_GH_API_BASE: apiBaseUrl,
      ...overrides
    });
  }

  it("returns an unavailable result (not a throw) when PA_LABOR_COMMONS_GH_TOKEN is not configured", async () => {
    const config = buildConfig({ PA_LABOR_COMMONS_GH_TOKEN: "" });
    const result = await proposeSpecCorrection(
      config,
      catalogEntries,
      { manifestId: testSpecialistId, fieldPath: ["purpose", "summary"], proposedValue: "x", justification: "x" },
      { actionId: "action-1", runId: null, taskId: null }
    );
    expect(result).toEqual({ ok: false, unavailable: true, reason: "PA_LABOR_COMMONS_GH_TOKEN is not configured on this deployment." });
  });

  it("opens a real branch on the remote with the field correctly changed, rest of the file untouched", async () => {
    const config = buildConfig();
    const result = await proposeSpecCorrection(
      config,
      catalogEntries,
      {
        manifestId: testSpecialistId,
        fieldPath: ["purpose", "summary"],
        proposedValue: "An updated, more accurate summary the specialist itself noticed was wrong.",
        justification: "The old summary didn't mention a real constraint discovered mid-task."
      },
      { actionId: "action-42", runId: "run-42", taskId: "task-42" }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.prUrl).toBe("https://github.com/Open-Labor-Foundation/labor-commons/pull/999");
    expect(result.branch).toMatch(/^correction\/test-specialist-/);

    const pushedContent = await git(["show", `${result.branch}:${testSpecialistId}`], bareRepoPath);
    expect(pushedContent).toMatch(/An updated, more accurate summary the specialist itself noticed was wrong\./);
    expect(pushedContent).toMatch(/slug: "test-specialist"/);
    expect(pushedContent).toMatch(/specialty_boundary:/);

    expect((lastPrRequestBody as { head?: string })?.head).toBe(result.branch);
    expect((lastPrRequestBody as { base?: string })?.base).toBe("main");
    expect((lastPrRequestBody as { body?: string })?.body ?? "").toMatch(/action-42/);
    expect((lastPrRequestBody as { body?: string })?.body ?? "").toMatch(/run-42/);
    expect((lastPrRequestBody as { body?: string })?.body ?? "").toMatch(/real constraint discovered mid-task/);
  });

  it("does not disturb the shared checkout LocalCatalogService reads from, and cleans up its ephemeral worktree", async () => {
    const config = buildConfig();
    const branchBefore = await git(["rev-parse", "--abbrev-ref", "HEAD"], checkoutPath);
    await proposeSpecCorrection(
      config,
      catalogEntries,
      { manifestId: testSpecialistId, fieldPath: ["purpose", "summary"], proposedValue: "changed", justification: "test" },
      { actionId: "action-1", runId: null, taskId: null }
    );
    const branchAfter = await git(["rev-parse", "--abbrev-ref", "HEAD"], checkoutPath);
    expect(branchAfter).toBe(branchBefore);

    const worktrees = await git(["worktree", "list"], checkoutPath);
    expect(worktrees.split("\n").length).toBe(1);
  });

  it("throws for a field path that doesn't exist, without pushing anything", async () => {
    const config = buildConfig();
    await expect(
      proposeSpecCorrection(
        config,
        catalogEntries,
        { manifestId: testSpecialistId, fieldPath: ["metadata", "not_a_real_field"], proposedValue: "x", justification: "x" },
        { actionId: "action-1", runId: null, taskId: null }
      )
    ).rejects.toThrow(/does not exist/);
    expect(lastPrRequestBody).toBeNull();
  });

  it("throws for a manifestId that isn't a real catalog entry", async () => {
    const config = buildConfig();
    await expect(
      proposeSpecCorrection(
        config,
        catalogEntries,
        { manifestId: "catalog/naics-overlays/test-industry/does-not-exist/spec.yaml", fieldPath: ["purpose", "summary"], proposedValue: "x", justification: "x" },
        { actionId: "action-1", runId: null, taskId: null }
      )
    ).rejects.toThrow(/No catalog entry found/);
  });
});
