import { chat, type InferenceConfig } from "./inference";
import type { CatalogSpecialist } from "./catalog";

// The orchestrator is the chat agent that assembles the team. Given a task and
// the roster of governed specialists, it decides WHICH specialists are needed
// and in what order, and gives each a concrete sub-goal. Simple tasks get one
// specialist; complex tasks get a sequenced team (e.g. architect -> backend ->
// test-automation -> security review). This is the "materialize additional
// agents to fulfil the task" step that defines commons-crew.

export interface PlanStep {
  slug: string;
  subtask: string;
  reason: string;
}

export interface TeamPlan {
  summary: string;
  steps: PlanStep[];
}

function extractJson(text: string): any {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < 0) {
    throw new Error("no JSON object in orchestrator response");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function planTeam(
  config: InferenceConfig,
  specialists: CatalogSpecialist[],
  task: string
): Promise<TeamPlan> {
  const roster = specialists
    .map((s) => {
      const boundary = s.manifest.identity.boundary.constraints[0] ?? s.manifest.identity.description;
      return `- ${s.slug} (${s.manifest.identity.name}): ${String(boundary).slice(0, 200)}`;
    })
    .join("\n");

  const system = [
    "You are the commons-crew orchestrator. You assemble a team of governed software specialists from the roster to complete a coding task, and hand each a concrete sub-goal.",
    "Rules:",
    "- Use the FEWEST specialists that genuinely fit. A small task may need only one. A feature touching design, implementation, tests, and security may need several.",
    "- Order the steps so each specialist can build on the previous one's work (e.g. architecture/design before implementation; implementation before tests; a review/security pass last when warranted).",
    "- Only use slugs from the roster. Each step's subtask must be specific and actionable for that specialist's lane.",
    'Respond with ONLY JSON: {"summary":"<one line: the team + approach>","steps":[{"slug":"<roster-slug>","subtask":"<what this specialist should do>","reason":"<why this specialist>"}]}'
  ].join("\n");

  const result = await chat(
    config,
    [
      { role: "system", content: system },
      { role: "user", content: `Roster:\n${roster}\n\nTask:\n${task}\n\nPlan the team as JSON:` }
    ],
    []
  );

  let plan: TeamPlan;
  try {
    const parsed = extractJson(result.content ?? "");
    const steps: PlanStep[] = Array.isArray(parsed.steps)
      ? parsed.steps
          .map((s: any) => ({ slug: String(s.slug ?? ""), subtask: String(s.subtask ?? ""), reason: String(s.reason ?? "") }))
          .filter((s: PlanStep) => specialists.some((c) => c.slug === s.slug) && s.subtask)
      : [];
    plan = { summary: String(parsed.summary ?? ""), steps };
  } catch {
    plan = { summary: "", steps: [] };
  }

  // Fail safe: if planning produced nothing usable, fall back to the single
  // best-fit specialist working the whole task, so the session still runs.
  if (plan.steps.length === 0) {
    const best = await pickBestFit(config, specialists, task);
    plan = { summary: `Single specialist: ${best.manifest.identity.name}.`, steps: [{ slug: best.slug, subtask: task, reason: "best overall fit" }] };
  }
  return plan;
}

async function pickBestFit(config: InferenceConfig, specialists: CatalogSpecialist[], task: string): Promise<CatalogSpecialist> {
  if (specialists.length === 1) {
    return specialists[0];
  }
  const roster = specialists.map((s) => `${s.slug}: ${s.manifest.identity.name}`).join("\n");
  const result = await chat(
    config,
    [
      { role: "system", content: "Pick the single best-fit specialist for the task. Reply with ONLY the slug." },
      { role: "user", content: `Roster:\n${roster}\n\nTask:\n${task}\n\nSlug:` }
    ],
    []
  );
  const picked = (result.content ?? "").trim().split(/\s+/)[0]?.replace(/[^a-z0-9-]/gi, "");
  return specialists.find((s) => s.slug === picked) ?? specialists[0];
}
