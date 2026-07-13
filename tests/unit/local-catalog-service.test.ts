import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalCatalogService } from "../../packages/catalog/src/index";
import { loadConfigOrThrow } from "../../packages/config/src/index";

function fixtureSpecYaml(slug: string, name: string): string {
  return `schema_version: "1.0"
kind: "agent_definition"
metadata:
  slug: "${slug}"
  name: "${name}"
  domain_family: "test/${slug}"
  specialty_boundary: "Owns exactly one narrow test responsibility and nothing else."
  status: "validated"
purpose:
  summary: "Test fixture specialist for ${name}."
scope:
  supported_tasks:
    - "Do the one test task."
  common_inputs:
    - "test input"
  expected_outputs:
    - "test output"
`;
}

describe("LocalCatalogService", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "commons-crew-catalog-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("finds specialists under both naics-overlays and function-overlays", async () => {
    const naicsDir = path.join(tempRoot, "catalog", "naics-overlays", "some-industry", "naics-test-specialist");
    const functionDir = path.join(tempRoot, "catalog", "function-overlays", "some-function", "function-test-specialist");
    await fs.mkdir(naicsDir, { recursive: true });
    await fs.mkdir(functionDir, { recursive: true });
    await fs.writeFile(path.join(naicsDir, "spec.yaml"), fixtureSpecYaml("naics-test-specialist", "Naics test specialist"));
    await fs.writeFile(path.join(functionDir, "spec.yaml"), fixtureSpecYaml("function-test-specialist", "Function test specialist"));

    const config = loadConfigOrThrow({
      ...process.env,
      NODE_ENV: "test",
      OLF_AGENTS_ROOT: tempRoot
    });
    const service = new LocalCatalogService(config);
    const syncResult = await service.sync();

    expect(syncResult.entriesDiscovered).toBe(2);
    const entries = await service.listEntries();
    const slugs = entries.map((entry) => entry.agentSlug).sort();
    expect(slugs).toEqual(["function-test-specialist", "naics-test-specialist"]);
  });

  it("still works with only naics-overlays present (no function-overlays directory)", async () => {
    const naicsDir = path.join(tempRoot, "catalog", "naics-overlays", "some-industry", "naics-only-specialist");
    await fs.mkdir(naicsDir, { recursive: true });
    await fs.writeFile(path.join(naicsDir, "spec.yaml"), fixtureSpecYaml("naics-only-specialist", "Naics only specialist"));

    const config = loadConfigOrThrow({
      ...process.env,
      NODE_ENV: "test",
      OLF_AGENTS_ROOT: tempRoot
    });
    const service = new LocalCatalogService(config);
    const syncResult = await service.sync();

    expect(syncResult.entriesDiscovered).toBe(1);
  });
});
