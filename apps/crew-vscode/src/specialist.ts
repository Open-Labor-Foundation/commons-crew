import type { CatalogSpecialist } from "./catalog";

export interface PriorWork {
  name: string;
  subtask: string;
  summary: string;
}

export interface TeamContext {
  overallGoal: string;
  planSummary: string;
  priorWork: PriorWork[];
  subtask: string;
}

// Compose the governed system prompt for a materialized specialist from its real
// labor-commons contract (identity + boundary + constraints + supported tasks),
// wrapped in the autonomous-coder harness. When it's working as part of a team,
// it also gets the shared session context: the overall goal, the plan, and what
// teammates already did — so the team collaborates under one session rather than
// acting in isolation. The boundary/constraints are the same governed identity
// the commons-crew runtime enforces.
export function composeSystemPrompt(specialist: CatalogSpecialist, team: TeamContext): string {
  const { identity, supportedTasks, outputs } = specialist.manifest;
  const constraints = identity.boundary.constraints.map((c) => `- ${c}`).join("\n");
  const tasks = supportedTasks.map((t) => `- ${t}`).join("\n");
  const outs = outputs.map((o) => `- ${o.name ?? JSON.stringify(o)}`).join("\n");

  const priorWorkBlock = team.priorWork.length
    ? team.priorWork.map((p) => `### ${p.name} (did: ${p.subtask})\n${p.summary}`).join("\n\n")
    : "(you are the first specialist on this task)";

  return [
    `You are "${identity.name}", a governed software specialist materialized from the labor-commons catalog, working autonomously inside the user's VS Code workspace as part of a commons-crew team.`,
    identity.description,
    `Your domain: ${identity.boundary.domain}.`,
    "",
    "Operating boundary and constraints (stay in your lane — if the task needs work outside it, do your part and note what should hand off to another specialist, do NOT do their job):",
    constraints || "- (none specified)",
    "",
    "Supported tasks:",
    tasks || "- (general work within the domain)",
    outs ? `\nExpected outputs:\n${outs}` : "",
    "",
    "## Team session",
    `Overall goal: ${team.overallGoal}`,
    team.planSummary ? `Team plan: ${team.planSummary}` : "",
    "",
    "What teammates have already done in this session (build on it — read their changes in the workspace; do not redo or undo them):",
    priorWorkBlock,
    "",
    `## Your assignment in this session`,
    team.subtask,
    "",
    "How you work:",
    "- You are autonomous: use the tools to inspect the workspace, read files, make edits, and run commands. Do the work yourself; do not ask the user to make edits you can make.",
    "- Iterate: read the relevant code (including your teammates' changes) first, make focused changes, run the tests/build to verify, and fix what you broke. Repeat until YOUR assignment is genuinely done.",
    "- Prefer the smallest correct change. Explain what you are doing as you go.",
    "- Every file write and command execution is subject to the user's approval gate.",
    "- When your assignment is complete, stop calling tools and give a short summary of exactly what you changed and how you verified it, so the next specialist can build on it."
  ]
    .filter(Boolean)
    .join("\n");
}
