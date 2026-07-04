import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../../config/src/index";
import type { TaskExecutionInput, TaskExecutionResult } from "../../contracts/src/index";

const execFileAsync = promisify(execFile);

const FORWARDED_ENV_KEYS = [
  "NODE_ENV",
  "HOME",
  "PA_CONFIG_PROFILE",
  "PA_RUNNER_PORT",
  "PA_PROVIDER_API_KEY",
  "PA_PROVIDER_BASE_URL",
  "PA_PROVIDER_MODEL",
  "PA_STORAGE_MODE",
  "PA_DATABASE_URL",
  "PA_DATABASE_SCHEMA",
  "OLF_AGENTS_ROOT",
  "PA_ARTIFACTS_ROOT",
  "PA_STATE_FILE",
  "PA_BACKUPS_ROOT"
] as const;

type SpecialistExecutionMode = "shared_runner" | "isolated_subprocess" | "worker_container";

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

function buildWorkerCommandArgs(inputPath: string, outputPath: string) {
  const runnerContainerId = process.env.HOSTNAME?.trim();
  if (!runnerContainerId) {
    throw new Error("Runner container id is unavailable; HOSTNAME is required to launch specialist worker containers.");
  }

  return {
    runnerContainerId,
    inputPath,
    outputPath
  };
}

async function resolveRunnerImageId(runnerContainerId: string) {
  const { stdout } = await execFileAsync(
    "docker",
    ["inspect", "--format", "{{.Image}}", runnerContainerId],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  const imageId = stdout.trim();
  if (!imageId) {
    throw new Error(`Unable to resolve runner image id for container ${runnerContainerId}.`);
  }
  return imageId;
}

function buildDockerRunArgs(
  imageId: string,
  runnerContainerId: string,
  inputPath: string,
  outputPath: string
) {
  const args = [
    "run",
    "--rm",
    "--name",
    `pa-specialist-worker-${Date.now()}`,
    "--volumes-from",
    runnerContainerId,
    "--workdir",
    "/app"
  ];

  for (const key of FORWARDED_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      args.push("-e", `${key}=${value}`);
    }
  }

  args.push("-e", "PA_SPECIALIST_EXECUTION_MODE=shared_runner");

  args.push(
    imageId,
    "/app/node_modules/.bin/tsx",
    "/app/apps/pa-runner/src/specialist-worker.ts",
    inputPath,
    outputPath
  );

  return args;
}

function buildWorkerEnvironment(config: AppConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PA_SPECIALIST_EXECUTION_MODE: "shared_runner"
  };

  for (const key of FORWARDED_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  return env;
}

function buildSubprocessArgs(config: AppConfig, inputPath: string, outputPath: string) {
  return {
    command: path.join(config.paths.repoRoot, "node_modules", ".bin", "tsx"),
    args: [path.join(config.paths.repoRoot, "apps", "crew-runner", "src", "specialist-worker.ts"), inputPath, outputPath]
  };
}

function workerJobRoot(runArtifactRootPath: string, taskId: string) {
  return path.join(runArtifactRootPath, "worker-jobs", taskId);
}

function parseWorkerEnvelope(raw: string, outputPath: string): TaskExecutionResult {
  const envelope = JSON.parse(raw) as WorkerExecutionEnvelope;
  if (!envelope.ok) {
    throw new Error(
      `Specialist worker container reported failure: ${envelope.error.message}${envelope.error.stack ? `\n${envelope.error.stack}` : ""}\nOutput: ${outputPath}`
    );
  }
  return envelope.result;
}

export function resolveSpecialistExecutionMode(config: AppConfig, input: TaskExecutionInput): SpecialistExecutionMode {
  if (input.specialist.id === null) {
    return "shared_runner";
  }

  const mode = process.env.PA_SPECIALIST_EXECUTION_MODE?.trim().toLowerCase();
  if (mode === "shared_runner") {
    return "shared_runner";
  }
  if (mode === "isolated_subprocess") {
    return "isolated_subprocess";
  }
  if (mode === "worker_container") {
    return "worker_container";
  }
  return config.profile.name === "trusted-host" ? "isolated_subprocess" : "shared_runner";
}

async function executeTaskViaWorkerProcess(
  config: AppConfig,
  input: TaskExecutionInput,
  execute: (inputPath: string, outputPath: string) => Promise<void>
): Promise<TaskExecutionResult> {
  const jobRoot = workerJobRoot(input.run.artifactRootPath, input.task.id);
  await fs.mkdir(jobRoot, { recursive: true });
  const inputPath = path.join(jobRoot, "task-input.json");
  const outputPath = path.join(jobRoot, "task-output.json");
  await fs.writeFile(inputPath, JSON.stringify(input, null, 2), "utf8");
  await fs.rm(outputPath, { force: true });

  try {
    await execute(inputPath, outputPath);
  } catch (error) {
    const outputExists = await fs.stat(outputPath).then(() => true).catch(() => false);
    if (!outputExists) {
      throw error;
    }
  }

  const raw = await fs.readFile(outputPath, "utf8");
  return parseWorkerEnvelope(raw, outputPath);
}

export async function executeTaskInSubprocess(config: AppConfig, input: TaskExecutionInput): Promise<TaskExecutionResult> {
  return await executeTaskViaWorkerProcess(config, input, async (inputPath, outputPath) => {
    const subprocess = buildSubprocessArgs(config, inputPath, outputPath);
    await execFileAsync(subprocess.command, subprocess.args, {
      cwd: config.paths.repoRoot,
      env: buildWorkerEnvironment(config),
      maxBuffer: 16 * 1024 * 1024
    });
  });
}

export async function executeTaskInWorkerContainer(config: AppConfig, input: TaskExecutionInput): Promise<TaskExecutionResult> {
  return await executeTaskViaWorkerProcess(config, input, async (inputPath, outputPath) => {
    void config;
    const { runnerContainerId } = buildWorkerCommandArgs(inputPath, outputPath);
    const imageId = await resolveRunnerImageId(runnerContainerId);
    const args = buildDockerRunArgs(imageId, runnerContainerId, inputPath, outputPath);
    await execFileAsync("docker", args, { maxBuffer: 16 * 1024 * 1024 });
  });
}
