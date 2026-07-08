import { fs, path, execFileAsync } from "./host";
import type { ActionProposalRecord } from "../../contracts/src/index";
import type { AppConfig } from "../../config/src/index";

export type ActionToolPolicy = {
  actionClass: ActionProposalRecord["actionClass"];
  readOnly: boolean;
  supportsDryRun: boolean;
  supportsPreflight: boolean;
  supportsRollback: boolean;
  requiresApproval: boolean;
  idempotencyScope: string;
  requiredPermissions: string[];
  evidenceShape: string;
};

export type ActionToolExecutionResult = {
  actor: string;
  dryRun: {
    outcome: string;
    payload: unknown;
  } | null;
  preflight: {
    outcome: string;
    payload: unknown;
  } | null;
  execution: {
    outcome: string;
    payload: unknown;
  };
  rollback: {
    instructions: string | null;
    metadata: unknown | null;
  } | null;
};

export type ActionToolExecutionInput = {
  actionId: string;
  proposal: ActionProposalRecord;
  policy: ActionToolPolicy;
};

export type ActionToolExecutor = {
  execute(input: ActionToolExecutionInput): Promise<ActionToolExecutionResult>;
};

function sanitizeRelativePath(targetRef: string) {
  const normalized = path.posix.normalize(targetRef.replace(/\\/g, "/"));
  const trimmed = normalized.replace(/^\/+/, "");
  if (!trimmed || trimmed === "." || trimmed.startsWith("../") || trimmed.includes("/../")) {
    throw new Error(`Target ${targetRef} is outside the allowed workspace.`);
  }
  return trimmed;
}

async function pathExists(location: string) {
  try {
    await fs.access(location);
    return true;
  } catch {
    return false;
  }
}

function actionWorkspaceRoot(config: AppConfig, actionId: string) {
  return path.join(config.paths.artifactsRoot, "action-tool-workspaces", actionId);
}

export function createDefaultActionToolExecutor(config: AppConfig): ActionToolExecutor {
  return {
    async execute(input) {
      const { actionId, policy, proposal } = input;
      const actor = "action-tool-executor";
      // The workspace the runtime acts on. Distinct from repoRoot (the app/
      // governance root) so embedding surfaces write to the user's folder.
      const workspaceRoot = config.paths.workspaceRoot ?? config.paths.repoRoot;

      if (proposal.toolId === "inspect_workspace") {
        const targetPath = proposal.targetRef === "workspace"
          ? workspaceRoot
          : path.join(workspaceRoot, sanitizeRelativePath(proposal.targetRef));
        const entries = await fs.readdir(targetPath, { withFileTypes: true });
        const listing = entries.slice(0, 50).map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
        }));
        return {
          actor,
          dryRun: policy.supportsDryRun
            ? {
                outcome: "workspace_inspection_ready",
                payload: {
                  targetPath,
                  entryCount: entries.length,
                  sample: listing
                }
              }
            : null,
          preflight: null,
          execution: {
            outcome: "workspace_inspected",
            payload: {
              targetPath,
              entryCount: entries.length,
              sample: listing
            }
          },
          rollback: null
        };
      }

      if (proposal.toolId === "read_file") {
        const targetPath = path.join(workspaceRoot, sanitizeRelativePath(proposal.targetRef));
        const content = await fs.readFile(targetPath, "utf8");
        return {
          actor,
          dryRun: policy.supportsDryRun
            ? {
                outcome: "file_read_prepared",
                payload: {
                  targetPath,
                  sizeBytes: Buffer.byteLength(content),
                  preview: content.slice(0, 2000)
                }
              }
            : null,
          preflight: null,
          execution: {
            outcome: "file_read_completed",
            payload: {
              targetPath,
              sizeBytes: Buffer.byteLength(content),
              preview: content.slice(0, 4000)
            }
          },
          rollback: null
        };
      }

      if (proposal.toolId === "write_file" || proposal.toolId === "edit_file") {
        // Real write to the real workspace, using the tool payload (the actual
        // content / edit). write_file replaces the whole file with `content`;
        // edit_file replaces the first exact `old` with `new`.
        const targetPath = path.join(workspaceRoot, sanitizeRelativePath(proposal.targetRef));
        const payload = (proposal.toolPayload ?? {}) as { content?: string; old?: string; new?: string };
        const existed = await pathExists(targetPath);
        const existingContent = existed ? await fs.readFile(targetPath, "utf8") : "";

        let nextContent: string;
        if (proposal.toolId === "write_file") {
          nextContent = typeof payload.content === "string" ? payload.content : "";
        } else if (typeof payload.old === "string") {
          if (!existingContent.includes(payload.old)) {
            return {
              actor,
              dryRun: null,
              preflight: null,
              execution: { outcome: "file_edit_failed", payload: { targetPath, reason: "target text not found" } },
              rollback: null
            };
          }
          nextContent = existingContent.replace(payload.old, payload.new ?? "");
        } else {
          // edit_file with a full content replacement.
          nextContent = typeof payload.content === "string" ? payload.content : existingContent;
        }

        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, nextContent, "utf8");

        return {
          actor,
          dryRun: null,
          preflight: null,
          execution: {
            outcome: proposal.toolId === "write_file" ? "file_written" : "file_edited",
            payload: {
              targetPath,
              bytesBefore: Buffer.byteLength(existingContent),
              bytesAfter: Buffer.byteLength(nextContent)
            }
          },
          rollback: policy.supportsRollback
            ? {
                instructions: existed
                  ? `Restore ${proposal.targetRef} to its prior ${Buffer.byteLength(existingContent)} bytes.`
                  : `Delete ${proposal.targetRef} (it did not exist before this action).`,
                metadata: { targetPath, existedBefore: existed }
              }
            : null
        };
      }

      if (proposal.toolId === "deploy") {
        const workspaceRoot = actionWorkspaceRoot(config, actionId);
        const receiptPath = path.join(workspaceRoot, "deployment-receipt.json");
        await fs.mkdir(workspaceRoot, { recursive: true });
        const receipt = {
          targetRef: proposal.targetRef,
          actionSummary: proposal.actionSummary,
          requestedPermissions: policy.requiredPermissions,
          receiptPath
        };
        await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2));
        return {
          actor,
          dryRun: policy.supportsDryRun
            ? {
                outcome: "deployment_dry_run_ready",
                payload: {
                  targetRef: proposal.targetRef,
                  receiptPath,
                  impact: "external_change_log"
                }
              }
            : null,
          preflight: null,
          execution: {
            outcome: "deployment_receipt_recorded",
            payload: receipt
          },
          rollback: null
        };
      }

      if (proposal.toolId === "run_command") {
        // The command string is carried in targetRef. This is the runtime's
        // governed execution capability (class_c, approval-gated). It runs in the
        // run's workspace via a shell. A host without a shell (e.g. mobile)
        // supplies its own executor that reports run_command as unavailable.
        const payload = (proposal.toolPayload ?? {}) as { command?: string };
        const command = typeof payload.command === "string" && payload.command.trim() ? payload.command : proposal.targetRef;
        const cwd = workspaceRoot;
        let outcome = "command_succeeded";
        let output = "";
        try {
          const { stdout, stderr } = await execFileAsync("/bin/sh", ["-lc", command], {
            cwd,
            timeout: 120_000,
            maxBuffer: 8 * 1024 * 1024
          });
          output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        } catch (error: any) {
          outcome = "command_failed";
          output = `${error?.stdout ?? ""}${error?.stderr ?? ""}${error?.message ?? ""}`.trim();
        }
        return {
          actor,
          dryRun: null,
          preflight: null,
          execution: {
            outcome,
            payload: { command, cwd, output: output.slice(0, 16_000) || "(no output)" }
          },
          rollback: null
        };
      }

      throw new Error(`No action tool adapter is registered for ${proposal.toolId}.`);
    }
  };
}
