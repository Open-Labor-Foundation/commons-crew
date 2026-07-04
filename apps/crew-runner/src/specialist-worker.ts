import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfigOrThrow } from "../../../packages/config/src/index";
import type { TaskExecutionInput, TaskExecutionResult } from "../../../packages/contracts/src/index";
import { createApiProvider } from "../../../packages/provider-api/src/index";

type WorkerExecutionEnvelope =
  | {
      ok: true;
      result: TaskExecutionResult;
    }
  | {
      ok: false;
      error: {
        message: string;
        stack: string | null;
      };
    };

async function writeEnvelope(outputPath: string, envelope: WorkerExecutionEnvelope) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(envelope, null, 2), "utf8");
}

export async function runSpecialistWorker(inputPath: string, outputPath: string) {
  const raw = await fs.readFile(inputPath, "utf8");
  const input = JSON.parse(raw) as TaskExecutionInput;
  await fs.mkdir(input.run.workspacePath, { recursive: true });
  process.chdir(input.run.workspacePath);
  const config = loadConfigOrThrow();
  const provider = createApiProvider(config);
  const result = await provider.executeTask(input);
  await writeEnvelope(outputPath, { ok: true, result });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , inputPath, outputPath] = process.argv;

  if (!inputPath || !outputPath) {
    console.error("Usage: specialist-worker.ts <inputPath> <outputPath>");
    process.exit(1);
  }

  try {
    await runSpecialistWorker(inputPath, outputPath);
  } catch (error) {
    const normalized = error instanceof Error
      ? {
          message: error.message,
          stack: error.stack ?? null
        }
      : {
          message: String(error),
          stack: null
        };
    await writeEnvelope(outputPath, { ok: false, error: normalized });
    process.exit(1);
  }
}
