import { promises as fs } from "node:fs";
import path from "node:path";
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

async function prepareWorkspaceFile(config: AppConfig, actionId: string, targetRef: string) {
  const relativeTarget = sanitizeRelativePath(targetRef);
  const workspaceRoot = actionWorkspaceRoot(config, actionId);
  const workspacePath = path.join(workspaceRoot, relativeTarget);
  const sourcePath = path.join(config.paths.repoRoot, relativeTarget);
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  if (!(await pathExists(workspacePath)) && (await pathExists(sourcePath))) {
    await fs.copyFile(sourcePath, workspacePath);
  }
  return {
    relativeTarget,
    workspaceRoot,
    workspacePath,
    sourcePath
  };
}

function commentLineForTarget(targetRef: string, message: string) {
  const extension = path.extname(targetRef).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".java", ".c", ".cc", ".cpp", ".cs"].includes(extension)) {
    return `// ${message}`;
  }
  if ([".md", ".html", ".xml"].includes(extension)) {
    return `<!-- ${message} -->`;
  }
  return `# ${message}`;
}

export function createDefaultActionToolExecutor(config: AppConfig): ActionToolExecutor {
  return {
    async execute(input) {
      const { actionId, policy, proposal } = input;
      const actor = "action-tool-executor";

      if (proposal.toolId === "inspect_workspace") {
        const targetPath = proposal.targetRef === "workspace"
          ? config.paths.repoRoot
          : path.join(config.paths.repoRoot, sanitizeRelativePath(proposal.targetRef));
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
        const targetPath = path.join(config.paths.repoRoot, sanitizeRelativePath(proposal.targetRef));
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
        const prepared = await prepareWorkspaceFile(config, actionId, proposal.targetRef);
        const sourceExists = await pathExists(prepared.sourcePath);
        const existingContent = await pathExists(prepared.workspacePath)
          ? await fs.readFile(prepared.workspacePath, "utf8")
          : "";
        const marker = `${proposal.toolId} via ${proposal.actionSummary}`;
        const nextContent = proposal.toolId === "write_file"
          ? `${commentLineForTarget(proposal.targetRef, marker)}\n`
          : [existingContent.trimEnd(), commentLineForTarget(proposal.targetRef, marker)].filter(Boolean).join("\n") + "\n";

        await fs.writeFile(prepared.workspacePath, nextContent, "utf8");

        return {
          actor,
          dryRun: policy.supportsDryRun
            ? {
                outcome: proposal.toolId === "write_file" ? "file_write_ready" : "file_edit_ready",
                payload: {
                  sourcePath: sourceExists ? prepared.sourcePath : null,
                  workspacePath: prepared.workspacePath,
                  bytesBefore: Buffer.byteLength(existingContent),
                  bytesAfter: Buffer.byteLength(nextContent)
                }
              }
            : null,
          preflight: null,
          execution: {
            outcome: proposal.toolId === "write_file" ? "file_written" : "file_edited",
            payload: {
              sourcePath: sourceExists ? prepared.sourcePath : null,
              workspacePath: prepared.workspacePath,
              bytesBefore: Buffer.byteLength(existingContent),
              bytesAfter: Buffer.byteLength(nextContent)
            }
          },
          rollback: policy.supportsRollback
            ? {
                instructions: `Restore ${proposal.targetRef} from the preserved source or remove the shadow workspace copy at ${prepared.workspacePath}.`,
                metadata: {
                  sourcePath: sourceExists ? prepared.sourcePath : null,
                  workspacePath: prepared.workspacePath
                }
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

      throw new Error(`No action tool adapter is registered for ${proposal.toolId}.`);
    }
  };
}
