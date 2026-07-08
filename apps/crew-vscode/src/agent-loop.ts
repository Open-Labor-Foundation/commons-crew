import * as vscode from "vscode";
import { chat, type ChatMessage, type InferenceConfig } from "./inference";
import { executeTool, toolDefs, type ToolContext } from "./tools";

// The autonomous coding loop. The materialized specialist (its governed system
// prompt) drives a read → edit → run → verify cycle over the real workspace via
// the tools, iterating until it stops calling tools (task done) or the budget
// runs out. Side-effecting tools pass through the approval gate inside the tools.
export async function runAgentLoop(params: {
  config: InferenceConfig;
  systemPrompt: string;
  task: string;
  ctx: ToolContext;
  maxIterations: number;
  token: vscode.CancellationToken;
  progressLabel?: string;
}): Promise<string> {
  const { config, systemPrompt, task, ctx, maxIterations, token, progressLabel } = params;
  const label = progressLabel ?? "";
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task }
  ];

  for (let i = 0; i < maxIterations; i += 1) {
    if (token.isCancellationRequested) {
      ctx.stream.markdown("\n\n_Cancelled._");
      return "(cancelled)";
    }
    ctx.stream.progress(`${label}working (step ${i + 1}/${maxIterations})…`);

    let result;
    try {
      result = await chat(config, messages, toolDefs);
    } catch (err: any) {
      ctx.stream.markdown(`\n\n❌ ${err?.message ?? String(err)}`);
      return `(failed: ${err?.message ?? String(err)})`;
    }

    // No tool calls → the specialist is done and this is its final answer/summary.
    if (!result.toolCalls.length) {
      const summary = result.content ?? "(no summary)";
      ctx.stream.markdown(`\n\n${summary}`);
      return summary;
    }

    // Record the assistant's tool-call turn, then execute each call and feed the
    // results back so the specialist can react.
    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      if (token.isCancellationRequested) {
        return "(cancelled)";
      }
      const output = await executeTool(call, ctx);
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: output });
    }
  }

  ctx.stream.markdown(`\n\n_Reached the ${maxIterations}-step limit for this specialist._`);
  return "(reached step limit before finishing)";
}
