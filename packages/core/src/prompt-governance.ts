import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PromptSpecRecord } from "../../contracts/src/index";

type ReevaluationSpec = {
  requiredChecks: string[];
  releaseBlockingThresholds: ReevaluationThreshold[];
  requiredEvidence: string[];
  requiresAdditionalTestCoverage: boolean;
  notes: string;
};

type ReevaluationThreshold = {
  domain: string;
  threshold: string;
};

type PlanningStepTemplate = {
  title: string;
  description: string;
};

type ExecutionTaskTemplate = {
  name: string;
  description: string;
};

type RuntimeExecutionExpectationTemplate = {
  id: string;
  description: string;
  required: boolean;
};

type PaPromptArtifact = {
  id: "pa.orchestration";
  version: string;
  summary: string;
  reevaluation: ReevaluationSpec;
  templates: {
    modeSummaries: Record<"planning" | "execution" | "chat", string>;
    planningSteps: PlanningStepTemplate[];
    planningAcknowledgement: string;
    executionAcknowledgement: string;
    chatAcknowledgement: string;
    runSummary: string;
  };
};

type SpecialistPromptArtifact = {
  id: "specialist.orchestration";
  version: string;
  summary: string;
  reevaluation: ReevaluationSpec;
  templates: {
    executionTasks: ExecutionTaskTemplate[];
    delegationReasonSummary: string;
    materializationProvenance: string;
    instructionsPreface: string;
    systemPrompt: string;
    runtimeContract: {
      executionExpectations: RuntimeExecutionExpectationTemplate[];
    };
  };
};

type MaterializedSpecialistPromptValues = {
  name: string;
  description: string;
  domain: string;
  constraints: string;
  supportedTasks: string;
  requiredOutputs: string;
  approvalRequired: string;
};

export type LoadedPromptArtifacts = {
  pa: PaPromptArtifact;
  specialist: SpecialistPromptArtifact;
  signature: string;
  versions: Record<string, string>;
  reevaluationChecks: string[];
  reevaluationThresholds: ReevaluationThreshold[];
  reevaluationEvidence: string[];
};

export type PromptGovernanceState = {
  artifactSetSignature: string | null;
  artifactVersions: Record<string, string>;
  reevaluationPending: boolean;
  reevaluationChecks: string[];
  reevaluationNotes: string[];
  updatedAt: string | null;
};

export const PROMPT_ARTIFACT_FILES = {
  pa: path.join("governance", "prompts", "pa.orchestration.v1.json"),
  specialist: path.join("governance", "prompts", "specialist.orchestration.v1.json")
} as const;

const PLATFORM_ASSISTANT_SPEC = path.join("catalog", "platform-assistant", "spec.yaml");

export function syncPromptSpecRecords(existing: PromptSpecRecord[], artifacts: LoadedPromptArtifacts, timestamp: string): PromptSpecRecord[] {
  const scopeDefinitions: Array<Pick<PromptSpecRecord, "id" | "scopeType" | "scopeRef" | "version" | "contentRef" | "status">> = [
    {
      id: "prompt-spec:pa:pa.orchestration",
      scopeType: "pa",
      scopeRef: "pa.orchestration",
      version: artifacts.pa.version,
      status: "active",
      contentRef: PROMPT_ARTIFACT_FILES.pa
    },
    {
      id: "prompt-spec:routing:pa.routing-intake",
      scopeType: "routing",
      scopeRef: "pa.routing-intake",
      version: artifacts.pa.version,
      status: "active",
      contentRef: `${PLATFORM_ASSISTANT_SPEC}#platform_prompts.intake`
    },
    {
      id: "prompt-spec:chat:pa.chat-answer",
      scopeType: "chat",
      scopeRef: "pa.chat-answer",
      version: artifacts.pa.version,
      status: "active",
      contentRef: `${PLATFORM_ASSISTANT_SPEC}#platform_prompts.chat`
    },
    {
      id: "prompt-spec:planning:pa.plan-generation",
      scopeType: "planning",
      scopeRef: "pa.plan-generation",
      version: artifacts.pa.version,
      status: "active",
      contentRef: `${PLATFORM_ASSISTANT_SPEC}#platform_prompts.planning`
    },
    {
      id: "prompt-spec:specialist:specialist.orchestration",
      scopeType: "specialist",
      scopeRef: "specialist.orchestration",
      version: artifacts.specialist.version,
      status: "active",
      contentRef: PROMPT_ARTIFACT_FILES.specialist
    },
    {
      id: "prompt-spec:execution:specialist.execution",
      scopeType: "execution",
      scopeRef: "specialist.execution",
      version: artifacts.specialist.version,
      status: "active",
      contentRef: `${PLATFORM_ASSISTANT_SPEC}#platform_prompts.execution`
    },
    {
      id: "prompt-spec:tool-use:specialist.tool-use",
      scopeType: "tool_use",
      scopeRef: "specialist.tool-use",
      version: artifacts.specialist.version,
      status: "active",
      contentRef: `${PLATFORM_ASSISTANT_SPEC}#platform_prompts.toolUse`
    },
    {
      id: "prompt-spec:materialization:specialist.materialization",
      scopeType: "materialization",
      scopeRef: "specialist.materialization",
      version: artifacts.specialist.version,
      status: "active",
      contentRef: PROMPT_ARTIFACT_FILES.specialist
    },
    {
      id: "prompt-spec:evaluation:pa.decision-quality",
      scopeType: "evaluation",
      scopeRef: "pa.decision-quality",
      version: artifacts.pa.version,
      status: "active",
      contentRef: `${PLATFORM_ASSISTANT_SPEC}#platform_prompts.evaluation`
    },
    {
      id: "prompt-spec:final-result:pa.final-result",
      scopeType: "final_result",
      scopeRef: "pa.final-result",
      version: artifacts.pa.version,
      status: "active",
      contentRef: `${PLATFORM_ASSISTANT_SPEC}#platform_prompts.finalResult`
    }
  ];

  const existingById = new Map(existing.map((entry) => [entry.id, entry]));
  return scopeDefinitions.map((definition) => {
    const previous = existingById.get(definition.id);
    return {
      ...definition,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
  });
}

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? "");
}

function dedupe(values: string[]) {
  return [...new Set(values)];
}

function dedupeThresholds(values: ReevaluationThreshold[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.domain}::${value.threshold}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function loadPromptArtifacts(repoRoot: string): Promise<LoadedPromptArtifacts> {
  const paPath = path.join(repoRoot, PROMPT_ARTIFACT_FILES.pa);
  const specialistPath = path.join(repoRoot, PROMPT_ARTIFACT_FILES.specialist);
  const [paRaw, specialistRaw] = await Promise.all([
    fs.readFile(paPath, "utf8"),
    fs.readFile(specialistPath, "utf8")
  ]);

  const pa = JSON.parse(paRaw) as PaPromptArtifact;
  const specialist = JSON.parse(specialistRaw) as SpecialistPromptArtifact;
  const signature = createHash("sha256").update(paRaw).update(specialistRaw).digest("hex");

  return {
    pa,
    specialist,
    signature,
    versions: {
      [pa.id]: pa.version,
      [specialist.id]: specialist.version
    },
    reevaluationChecks: dedupe([
      ...pa.reevaluation.requiredChecks,
      ...specialist.reevaluation.requiredChecks
    ]),
    reevaluationThresholds: dedupeThresholds([
      ...pa.reevaluation.releaseBlockingThresholds,
      ...specialist.reevaluation.releaseBlockingThresholds
    ]),
    reevaluationEvidence: dedupe([
      ...pa.reevaluation.requiredEvidence,
      ...specialist.reevaluation.requiredEvidence
    ])
  };
}

export function initializePromptGovernanceState(artifacts: LoadedPromptArtifacts, timestamp: string): PromptGovernanceState {
  return {
    artifactSetSignature: artifacts.signature,
    artifactVersions: artifacts.versions,
    reevaluationPending: false,
    reevaluationChecks: artifacts.reevaluationChecks,
    reevaluationNotes: [artifacts.pa.reevaluation.notes, artifacts.specialist.reevaluation.notes],
    updatedAt: timestamp
  };
}

export function syncPromptGovernanceState(
  existing: PromptGovernanceState | undefined,
  artifacts: LoadedPromptArtifacts,
  timestamp: string
): PromptGovernanceState {
  if (!existing?.artifactSetSignature) {
    return initializePromptGovernanceState(artifacts, timestamp);
  }

  const changed = existing.artifactSetSignature !== artifacts.signature;
  return {
    artifactSetSignature: artifacts.signature,
    artifactVersions: artifacts.versions,
    reevaluationPending: changed ? true : existing.reevaluationPending,
    reevaluationChecks: artifacts.reevaluationChecks,
    reevaluationNotes: [artifacts.pa.reevaluation.notes, artifacts.specialist.reevaluation.notes],
    updatedAt: timestamp
  };
}

export function summarizeMode(artifact: LoadedPromptArtifacts["pa"], requestType: "planning" | "execution" | "chat") {
  return artifact.templates.modeSummaries[requestType];
}

export function buildPlanningStepsFromArtifacts(artifact: LoadedPromptArtifacts["pa"], content: string) {
  return artifact.templates.planningSteps.map((step) => ({
    title: renderTemplate(step.title, { content }),
    description: renderTemplate(step.description, { content })
  }));
}

export function buildExecutionTasksFromArtifacts(artifact: LoadedPromptArtifacts["specialist"], content: string) {
  return artifact.templates.executionTasks.map((task) => ({
    name: renderTemplate(task.name, { content }),
    description: renderTemplate(task.description, { content })
  }));
}

export function buildRuntimeExecutionExpectationsFromArtifacts(artifact: LoadedPromptArtifacts["specialist"]) {
  return artifact.templates.runtimeContract.executionExpectations.map((expectation) => ({
    id: expectation.id,
    description: expectation.description,
    required: expectation.required
  }));
}

export function renderPromptTemplate(template: string, values: Record<string, string>) {
  return renderTemplate(template, values);
}

export function buildMaterializedSpecialistPromptValues(input: {
  name: string;
  description: string;
  domain: string;
  constraints: string[];
  supportedTasks: string[];
  requiredOutputs: string[];
  approvalRequired: boolean;
}): MaterializedSpecialistPromptValues {
  return {
    name: input.name,
    description: input.description,
    domain: input.domain,
    constraints: input.constraints.join("; ") || "none recorded",
    supportedTasks: input.supportedTasks.join(", "),
    requiredOutputs: input.requiredOutputs.join(", "),
    approvalRequired: input.approvalRequired ? "yes" : "no"
  };
}

export function renderMaterializedSpecialistInstructionsPreface(
  artifact: LoadedPromptArtifacts["specialist"],
  values: MaterializedSpecialistPromptValues
) {
  return renderTemplate(artifact.templates.instructionsPreface, values);
}

export function renderMaterializedSpecialistSystemPromptFromArtifact(
  artifact: LoadedPromptArtifacts["specialist"],
  values: MaterializedSpecialistPromptValues
) {
  return renderTemplate(artifact.templates.systemPrompt, values);
}
