import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createApiApp } from "../../apps/crew-api/src/create-app";
import { loadConfigOrThrow } from "../../packages/config/src/index";

/**
 * The org-autonomy-tier gating logic itself (computeDelegationRequiresApproval)
 * and the full propose->execute wiring are covered by
 * tests/unit/compute-delegation-requires-approval.test.ts and
 * tests/integration/org-autonomy-tier-delegation.test.ts. This file only
 * covers the HTTP wire contract -- the part commons-board actually depends
 * on, since setOrgAutonomyTier has no other way to be reached from outside
 * this process.
 */
describe("PUT/GET /api/orgs/:orgContext/autonomy-tier", () => {
  let tempRoot: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commons-crew-autonomy-tier-http-test-"));
    const config = loadConfigOrThrow({
      ...process.env,
      NODE_ENV: "test",
      PA_STORAGE_MODE: "memory",
      PA_ARTIFACTS_ROOT: path.join(tempRoot, "artifacts"),
      PA_STATE_FILE: path.join(tempRoot, "state.json"),
      PA_BACKUPS_ROOT: path.join(tempRoot, "backups"),
      OLF_AGENTS_ROOT: path.join(tempRoot, "labor-commons-fixture")
    });
    app = await createApiApp(config);
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("defaults an unsynced org to advisor", async () => {
    const response = await app.inject({ method: "GET", url: "/api/orgs/board-never-synced/autonomy-tier" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ orgContext: "board-never-synced", tier: "advisor" });
  });

  it("sets and reads back a tier", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/orgs/board-acme-widgets/autonomy-tier",
      payload: { tier: "autopilot" }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ orgContext: "board-acme-widgets", tier: "autopilot" });

    const get = await app.inject({ method: "GET", url: "/api/orgs/board-acme-widgets/autonomy-tier" });
    expect(get.json()).toMatchObject({ orgContext: "board-acme-widgets", tier: "autopilot" });
  });

  it("upserts idempotently -- a second call overwrites the first, not duplicates it", async () => {
    await app.inject({ method: "PUT", url: "/api/orgs/board-acme-widgets/autonomy-tier", payload: { tier: "orchestrator" } });
    await app.inject({ method: "PUT", url: "/api/orgs/board-acme-widgets/autonomy-tier", payload: { tier: "autopilot" } });

    const get = await app.inject({ method: "GET", url: "/api/orgs/board-acme-widgets/autonomy-tier" });
    expect(get.json().tier).toBe("autopilot");
  });

  it("rejects an unrecognized tier value", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/orgs/board-acme-widgets/autonomy-tier",
      payload: { tier: "godmode" }
    });
    expect(response.statusCode).toBe(400);
  });
});
