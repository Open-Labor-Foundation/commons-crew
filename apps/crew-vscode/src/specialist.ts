import { chat, type InferenceConfig } from "./inference";
import type { CatalogSpecialist } from "./catalog";

// Compose the governed system prompt for a materialized specialist from its real
// labor-commons contract (identity + boundary + constraints + supported tasks),
// wrapped in the autonomous-coder harness. The boundary/constraints are the same
// governed identity the commons-crew runtime enforces — here they steer an
// in-editor autonomous agent.
export function composeSystemPrompt(specialist: CatalogSpecialist): string {
  const { identity, supportedTasks, outputs } = specialist.manifest;
  const constraints = identity.boundary.constraints.map((c) => `- ${c}`).join("\n");
  const tasks = supportedTasks.map((t) => `- ${t}`).join("\n");
  const outs = outputs.map((o) => `- ${o.name ?? JSON.stringify(o)}`).join("\n");
  return [
    `You are "${identity.name}", a governed software specialist materialized from the labor-commons catalog, working autonomously inside the user's VS Code workspace.`,
    identity.description,
    `Your domain: ${identity.boundary.domain}.`,
    "",
    "Operating boundary and constraints (do not act outside these — hand off or say so if the task drifts out of your lane):",
    constraints || "- (none specified)",
    "",
    "Supported tasks:",
    tasks || "- (general work within the domain)",
    outs ? `\nExpected outputs:\n${outs}` : "",
    "",
    "How you work:",
    "- You are autonomous: use the provided tools to inspect the workspace, read files, make edits, and run commands. Do the work yourself; do not ask the user to make edits you can make.",
    "- Iterate: read the relevant code first, make focused changes, run the tests/build to verify, and fix what you broke. Repeat until the task is genuinely done.",
    "- Prefer the smallest correct change. Explain what you are doing as you go.",
    "- Every file write and command execution is subject to the user's approval gate; propose them via tools and they will be run once approved.",
    "- When the task is complete and verified, stop calling tools and give a short summary of what you changed and how you verified it."
  ]
    .filter(Boolean)
    .join("\n");
}

// Router: pick the best-fit specialist for the task from the catalog. This is the
// "materialize the right specialist" step — a small classification call over the
// real catalog identities.
export async function pickSpecialist(
  config: InferenceConfig,
  specialists: CatalogSpecialist[],
  task: string
): Promise<CatalogSpecialist> {
  if (specialists.length === 1) {
    return specialists[0];
  }
  const roster = specialists
    .map((s) => `${s.slug}: ${s.manifest.identity.name} — ${s.manifest.identity.boundary.domain}`)
    .join("\n");
  const result = await chat(
    config,
    [
      {
        role: "system",
        content:
          "You route a coding task to exactly one software specialist from the roster. Reply with ONLY the specialist's slug (the token before the colon), nothing else."
      },
      { role: "user", content: `Roster:\n${roster}\n\nTask:\n${task}\n\nBest-fit slug:` }
    ],
    []
  );
  const picked = (result.content ?? "").trim().split(/\s+/)[0]?.replace(/[^a-z0-9-]/gi, "");
  return specialists.find((s) => s.slug === picked) ?? specialists[0];
}
