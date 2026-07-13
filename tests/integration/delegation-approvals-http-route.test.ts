import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createApiApp } from "../../apps/crew-api/src/create-app";
import { loadConfigOrThrow } from "../../packages/config/src/index";

describe("POST /api/runs/:runId/delegation-approvals", () => {
  let tempRoot: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commons-crew-delegation-approvals-http-"));
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

  async function createChair(chairRole: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/chairs",
      payload: { orgContext: "board-acme-widgets", chairRole, surface: "web", title: `${chairRole} chair` }
    });
    return response.json().run.id as string;
  }

  it("returns the seeded pending approval on first request (idempotent with registration)", async () => {
    const runId = await createChair("finance");
    const response = await app.inject({ method: "POST", url: `/api/runs/${runId}/delegation-approvals` });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.runId).toBe(runId);
    expect(body.status).toBe("pending");
  });

  it("returns a fresh approval after the first one is consumed by an executed delegation", async () => {
    const runId = await createChair("legal");

    const firstApprovalResp = await app.inject({ method: "POST", url: `/api/runs/${runId}/delegation-approvals` });
    const firstApproval = firstApprovalResp.json();

    const decideResp = await app.inject({
      method: "POST",
      url: `/api/approvals/${firstApproval.id}/decision`,
      payload: { decision: "approved", comment: "test", actorUserId: "user_primary" }
    });
    expect(decideResp.statusCode).toBe(200);

    const runResp = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
    const runBody = runResp.json();

    const proposalResp = await app.inject({
      method: "POST",
      url: "/api/actions/proposals",
      payload: {
        workItemId: runBody.run.workItemId,
        runId,
        taskId: firstApproval.taskId,
        toolId: "delegate_to_child",
        actionClass: "class_c",
        targetRef: "http-route first dispatch",
        idempotencyKey: `http-route-dispatch-1-${firstApproval.taskId}`
      }
    });
    const proposal = proposalResp.json();
    const executeResp = await app.inject({ method: "POST", url: `/api/actions/${proposal.id}/execute` });
    expect(executeResp.statusCode).toBe(200);

    const secondApprovalResp = await app.inject({ method: "POST", url: `/api/runs/${runId}/delegation-approvals` });
    expect(secondApprovalResp.statusCode).toBe(201);
    const secondApproval = secondApprovalResp.json();
    expect(secondApproval.id).not.toBe(firstApproval.id);
    expect(secondApproval.status).toBe("pending");
  });

  it("returns 422 for a run that does not exist", async () => {
    const response = await app.inject({ method: "POST", url: "/api/runs/not-a-real-run/delegation-approvals" });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain("not found");
  });
});
