import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createApiApp } from "../../apps/crew-api/src/create-app";
import { loadConfigOrThrow } from "../../packages/config/src/index";

/**
 * pa.createChairRun itself is covered end to end by
 * tests/integration/chair-registration.test.ts. This file only covers the
 * HTTP wire contract on top of it (POST /api/chairs) -- the part an external
 * caller like commons-board actually depends on, since createChairRun has no
 * other way to be reached from outside this process.
 */
describe("POST /api/chairs", () => {
  let tempRoot: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commons-crew-chairs-http-test-"));
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

  it("registers a chair and returns the session and run", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chairs",
      payload: { orgContext: "board-acme-widgets", chairRole: "finance", surface: "web", title: "Finance Chair" }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.session.id).toBeTruthy();
    expect(body.run.chairRegistration).toMatchObject({ orgContext: "board-acme-widgets", chairRole: "finance" });
  });

  it("accepts the two newly added roles (it, security)", async () => {
    for (const chairRole of ["it", "security"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/chairs",
        payload: { orgContext: "board-acme-widgets", chairRole, surface: "web", title: `${chairRole} chair` }
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().run.chairRegistration.chairRole).toBe(chairRole);
    }
  });

  it("returns 422 for a chair role outside the fixed v1 set", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chairs",
      payload: { orgContext: "board-acme-widgets", chairRole: "engineering", surface: "web", title: "Bogus chair" }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain("not a recognized chair role");
  });

  it("returns 422 for a missing orgContext", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chairs",
      payload: { chairRole: "hr", surface: "web", title: "HR chair" }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain("orgContext is required");
  });
});
