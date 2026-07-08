import * as vscode from "vscode";
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ToolCall, ToolDef } from "./inference";

// Governance classes mirror the commons-crew runtime: class_a is read-only
// (auto), class_b mutates the workspace, class_c runs commands (external effect).
// class_b/class_c pass through the approval gate before executing.
type ActionClass = "class_a" | "class_b" | "class_c";

export interface ToolContext {
  workspaceRoot: string;
  autoApprove: boolean;
  stream: vscode.ChatResponseStream;
}

export const toolDefs: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories under a workspace-relative path (default: workspace root).",
      parameters: { type: "object", properties: { path: { type: "string" } } }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a workspace file. Returns its full text.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a workspace file with the given full content.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }
    }
  },
  {
    type: "function",
    function: {
      name: "str_replace",
      description: "Replace the first exact occurrence of `old` with `new` in a workspace file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
        required: ["path", "old", "new"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the workspace root (e.g. run tests, a build, a linter). Returns stdout+stderr.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    }
  }
];

const TOOL_CLASS: Record<string, ActionClass> = {
  list_files: "class_a",
  read_file: "class_a",
  write_file: "class_b",
  str_replace: "class_b",
  run_command: "class_c"
};

function resolveInWorkspace(root: string, rel: string): string {
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path ${rel} escapes the workspace.`);
  }
  return resolved;
}

async function gate(ctx: ToolContext, actionClass: ActionClass, summary: string): Promise<boolean> {
  if (actionClass === "class_a" || ctx.autoApprove) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(summary, { modal: true }, "Approve", "Reject");
  return choice === "Approve";
}

function runShell(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    // Intentional: an autonomous coding agent must run model-proposed shell
    // commands (tests, builds, linters), so the command string is by design
    // model-controlled. This is exactly what CodeQL flags as command injection.
    // The control is not preventing execution — it's the mandatory approval gate
    // in run_command above: every command is shown to the user for explicit
    // Approve/Reject before it reaches here (unless the user opts into
    // commonsCrew.autoApprove). Same posture as every coding agent.
    // codeql[js/command-line-injection]
    exec(command, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
      if (err && !out) {
        resolve(`command failed: ${err.message}`);
      } else {
        resolve(out.slice(0, 12_000) || "(no output)");
      }
    });
  });
}

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<string> {
  const name = call.function.name;
  let args: any = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return `error: could not parse arguments for ${name}`;
  }
  const cls = TOOL_CLASS[name] ?? "class_c";

  try {
    if (name === "list_files") {
      const dir = resolveInWorkspace(ctx.workspaceRoot, args.path ?? ".");
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.slice(0, 200).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)";
    }
    if (name === "read_file") {
      const file = resolveInWorkspace(ctx.workspaceRoot, args.path);
      const content = await fs.readFile(file, "utf8");
      return content.slice(0, 60_000);
    }
    if (name === "write_file") {
      const file = resolveInWorkspace(ctx.workspaceRoot, args.path);
      if (!(await gate(ctx, cls, `commons-crew wants to write ${args.path}. Approve?`))) {
        return "denied: user rejected the file write.";
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(args.content ?? ""), "utf8");
      ctx.stream.markdown(`\n✅ wrote \`${args.path}\`\n`);
      return `wrote ${args.path} (${String(args.content ?? "").length} bytes)`;
    }
    if (name === "str_replace") {
      const file = resolveInWorkspace(ctx.workspaceRoot, args.path);
      const before = await fs.readFile(file, "utf8");
      if (!before.includes(args.old)) {
        return `error: the target text was not found in ${args.path}.`;
      }
      if (!(await gate(ctx, cls, `commons-crew wants to edit ${args.path}. Approve?`))) {
        return "denied: user rejected the edit.";
      }
      await fs.writeFile(file, before.replace(args.old, args.new ?? ""), "utf8");
      ctx.stream.markdown(`\n✏️ edited \`${args.path}\`\n`);
      return `edited ${args.path}`;
    }
    if (name === "run_command") {
      if (!(await gate(ctx, cls, `commons-crew wants to run:\n\n${args.command}\n\nApprove?`))) {
        return "denied: user rejected the command.";
      }
      ctx.stream.markdown(`\n▶️ \`${args.command}\`\n`);
      return await runShell(String(args.command), ctx.workspaceRoot);
    }
    return `error: unknown tool ${name}`;
  } catch (err: any) {
    return `error: ${err?.message ?? String(err)}`;
  }
}
