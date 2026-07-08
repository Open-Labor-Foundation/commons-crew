import * as vscode from "vscode";
import type { InferenceConfig } from "./inference";
import type { CatalogSpecialist } from "./catalog";
import type { TeamPlan } from "./orchestrator";
import { composeSystemPrompt, type PriorWork } from "./specialist";
import { runAgentLoop } from "./agent-loop";
import type { ToolContext } from "./tools";

// Run the planned team under ONE session: each specialist is materialized in
// turn, works its assignment autonomously in the shared workspace, and hands its
// summary to the next — so the team collaborates (architect -> implementer ->
// tests -> review) rather than acting in isolation. Governance (the approval
// gate in the tools) applies throughout.
export async function runSession(params: {
  config: InferenceConfig;
  plan: TeamPlan;
  specialistsBySlug: Map<string, CatalogSpecialist>;
  overallGoal: string;
  ctx: ToolContext;
  maxIterations: number;
  token: vscode.CancellationToken;
}): Promise<void> {
  const { config, plan, specialistsBySlug, overallGoal, ctx, maxIterations, token } = params;

  const roster = plan.steps
    .map((s, i) => `${i + 1}. **${specialistsBySlug.get(s.slug)?.manifest.identity.name ?? s.slug}** — ${s.subtask}`)
    .join("\n");
  ctx.stream.markdown(`### Team plan\n${plan.summary ? `_${plan.summary}_\n\n` : ""}${roster}\n`);

  const priorWork: PriorWork[] = [];

  for (let i = 0; i < plan.steps.length; i += 1) {
    if (token.isCancellationRequested) {
      ctx.stream.markdown("\n\n_Session cancelled._");
      return;
    }
    const step = plan.steps[i];
    const specialist = specialistsBySlug.get(step.slug);
    if (!specialist) {
      continue;
    }
    const name = specialist.manifest.identity.name;
    ctx.stream.markdown(`\n\n---\n\n## ${i + 1}/${plan.steps.length} · ${name}\n_${step.subtask}_\n`);

    const systemPrompt = composeSystemPrompt(specialist, {
      overallGoal,
      planSummary: plan.summary,
      priorWork: [...priorWork],
      subtask: step.subtask
    });

    const summary = await runAgentLoop({
      config,
      systemPrompt,
      task: `Your assignment: ${step.subtask}\n\n(This is part of the overall goal: ${overallGoal})`,
      ctx,
      maxIterations,
      token,
      progressLabel: `${name}: `
    });

    priorWork.push({ name, subtask: step.subtask, summary });
  }

  if (plan.steps.length > 1) {
    ctx.stream.markdown(
      `\n\n---\n\n### Session complete\nThe team worked the task under one session:\n` +
        priorWork.map((p) => `- **${p.name}** — ${p.subtask}`).join("\n")
    );
  }
}
