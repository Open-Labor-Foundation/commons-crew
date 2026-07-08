import path from "node:path";
import { promises as fs } from "node:fs";
import { parse as parseYaml } from "yaml";
import type {
  ChatAnswer,
  ChatAnswerInput,
  IntakeDecision,
  IntakeDecisionInput,
  PlanDraft,
  PlanDraftInput,
  PlanStepDraft,
  ProviderAdapter,
  ProviderReadiness,
  ProviderStatus,
  RunResultSynthesisInput,
  RunResultSynthesisResult,
  TaskExecutionInput,
  TaskExecutionResult,
  ToolStepInput,
  ToolStepResult
} from "../../contracts/src/index";
import type { AppConfig } from "../../config/src/index";

type GovernedProviderPromptSection = {
  role: string;
  instructions: string[];
};

type GovernedProviderPrompts = {
  intake: GovernedProviderPromptSection;
  chat: GovernedProviderPromptSection;
  planning: GovernedProviderPromptSection;
  execution: GovernedProviderPromptSection;
  toolUse: GovernedProviderPromptSection;
  finalResult: GovernedProviderPromptSection;
  evaluation: GovernedProviderPromptSection;
};

const PLATFORM_ASSISTANT_SPEC = path.join("catalog", "platform-assistant", "spec.yaml");

const INTAKE_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["requestType", "needsClarification", "clarificationQuestion", "clarificationReason", "specialistCandidates", "decisionConfidence", "reasoningSummary"],
  properties: {
    requestType: { type: "string", enum: ["chat", "planning", "execution"] },
    needsClarification: { type: "boolean" },
    clarificationQuestion: { type: ["string", "null"] },
    clarificationReason: { type: ["string", "null"] },
    specialistCandidates: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["catalogEntryId", "confidence", "reason"],
        properties: {
          catalogEntryId: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          reason: { type: "string" }
        }
      }
    },
    decisionConfidence: { type: "string", enum: ["low", "medium", "high"] },
    reasoningSummary: { type: "string" }
  }
} as const;

const CHAT_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: { content: { type: "string", minLength: 1 } }
} as const;

const PLAN_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "steps"],
  properties: {
    title: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "required"],
        properties: {
          title: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          required: { type: "boolean" }
        }
      }
    }
  }
} as const;

const TASK_EXECUTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "detail"],
  properties: {
    summary: { type: "string", minLength: 1 },
    detail: { type: ["string", "null"] }
  }
} as const;

const RUN_RESULT_SYNTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "content"],
  properties: {
    summary: { type: "string", minLength: 1 },
    content: { type: "string", minLength: 1 }
  }
} as const;

function buildSystemPrompt(section: GovernedProviderPromptSection, schema: unknown): string {
  return [
    section.role,
    ...section.instructions,
    "",
    "You MUST respond with ONLY valid JSON that matches this schema exactly. No markdown, no explanation, no code fences — pure JSON only.",
    "",
    "Required JSON schema:",
    JSON.stringify(schema, null, 2)
  ].join("\n");
}

function buildUserPrompt(input: unknown): string {
  return `Input:\n${JSON.stringify(input, null, 2)}`;
}

function extractJsonFromResponse(content: string): string {
  const trimmed = content.trim();
  // Strip markdown code fences if present
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  // Find the first { or [ and parse from there
  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  const start = firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket);
  if (start > 0) {
    return trimmed.slice(start);
  }
  return trimmed;
}

async function callApi(
  apiKey: string,
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0,
    max_tokens: 4096
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "OpenAI/Python/1.56.1 CPython/3.12"
    },
    body
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(unreadable)");
    throw new Error(`Provider API error ${response.status}: ${text}`);
  }

  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (json.error?.message) {
    throw new Error(`Provider API error: ${json.error.message}`);
  }

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Provider API returned empty response content.");
  }

  return content;
}

async function runStructuredApiCall<T>(
  apiKey: string,
  baseUrl: string,
  model: string,
  schema: unknown,
  systemPrompt: string,
  userPrompt: string,
  maxRetries = 2
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const content = await callApi(apiKey, baseUrl, model, systemPrompt, userPrompt);
      const jsonStr = extractJsonFromResponse(content);
      return JSON.parse(jsonStr) as T;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

function normalizePlanSteps(steps: PlanStepDraft[]) {
  return steps.slice(0, 8);
}

export function createApiProvider(config: AppConfig): ProviderAdapter {
  const { apiKey, baseUrl, model } = config.provider;
  let governedPromptsPromise: Promise<GovernedProviderPrompts> | null = null;

  async function getGovernedPrompts(): Promise<GovernedProviderPrompts> {
    if (!governedPromptsPromise) {
      governedPromptsPromise = (async () => {
        const specPath = path.join(config.paths.repoRoot, PLATFORM_ASSISTANT_SPEC);
        const specRaw = await fs.readFile(specPath, "utf8");
        const spec = parseYaml(specRaw) as { platform_prompts: GovernedProviderPrompts };
        return spec.platform_prompts;
      })();
    }
    return await governedPromptsPromise;
  }

  function resolveReadiness(): ProviderReadiness {
    if (!apiKey) {
      return "missing_api_key";
    }
    return "ready";
  }

  async function getStatus(): Promise<ProviderStatus> {
    const checkedAt = new Date().toISOString();
    const readiness = resolveReadiness();
    return {
      id: "api-provider",
      displayName: "API Provider",
      model,
      installed: true,
      authenticated: Boolean(apiKey),
      authMode: "api_key",
      capabilities: {
        providerIdentity: `${baseUrl} / ${model}`,
        supportsStreaming: false,
        supportsStructuredOutputs: true,
        supportsToolCalls: false,
        supportsFileIo: false,
        supportsCancellation: false
      },
      diagnostics: {
        checkedAt,
        apiKeyConfigured: Boolean(apiKey),
        readiness
      }
    };
  }

  function requireApiKey(): string {
    if (!apiKey) {
      throw new Error("PA_PROVIDER_API_KEY is not configured. Set it in your environment before making provider calls.");
    }
    return apiKey;
  }

  async function decideIntake(input: IntakeDecisionInput): Promise<IntakeDecision> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    return await runStructuredApiCall<IntakeDecision>(
      key, baseUrl, model,
      INTAKE_DECISION_SCHEMA,
      buildSystemPrompt(prompts.intake, INTAKE_DECISION_SCHEMA),
      buildUserPrompt(input)
    );
  }

  async function answerChat(input: ChatAnswerInput): Promise<ChatAnswer> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    return await runStructuredApiCall<ChatAnswer>(
      key, baseUrl, model,
      CHAT_ANSWER_SCHEMA,
      buildSystemPrompt(prompts.chat, CHAT_ANSWER_SCHEMA),
      buildUserPrompt(input)
    );
  }

  async function createPlan(input: PlanDraftInput): Promise<PlanDraft> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    const draft = await runStructuredApiCall<PlanDraft>(
      key, baseUrl, model,
      PLAN_DRAFT_SCHEMA,
      buildSystemPrompt(prompts.planning, PLAN_DRAFT_SCHEMA),
      buildUserPrompt(input)
    );
    return { ...draft, steps: normalizePlanSteps(draft.steps) };
  }

  async function executeTask(input: TaskExecutionInput): Promise<TaskExecutionResult> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    const executionSection: GovernedProviderPromptSection = {
      role: prompts.execution.role,
      instructions: [...prompts.execution.instructions, ...prompts.toolUse.instructions]
    };

    const enrichedInput = {
      ...input,
      ...(input.materializedSpecialist
        ? {
            specialistInstructions: input.materializedSpecialist.instructions,
            specialistSystemPrompt: input.materializedSpecialist.systemPrompt
          }
        : {})
    };

    return await runStructuredApiCall<TaskExecutionResult>(
      key, baseUrl, model,
      TASK_EXECUTION_SCHEMA,
      buildSystemPrompt(executionSection, TASK_EXECUTION_SCHEMA),
      buildUserPrompt(enrichedInput)
    );
  }

  async function synthesizeRunResult(input: RunResultSynthesisInput): Promise<RunResultSynthesisResult> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    return await runStructuredApiCall<RunResultSynthesisResult>(
      key, baseUrl, model,
      RUN_RESULT_SYNTHESIS_SCHEMA,
      buildSystemPrompt(prompts.finalResult, RUN_RESULT_SYNTHESIS_SCHEMA),
      buildUserPrompt(input)
    );
  }

  // One step of the runtime-owned tool loop: a raw chat-completions call with
  // tools. Returns the model's next tool calls or its final text. The runtime
  // executes any tool calls through its governed action machinery and calls back
  // in for the next step.
  async function proposeToolCalls(input: ToolStepInput): Promise<ToolStepResult> {
    const key = requireApiKey();
    const messages = [
      { role: "system", content: input.systemPrompt },
      ...input.messages.map((m) => {
        const base: Record<string, unknown> = { role: m.role, content: m.content ?? "" };
        if (m.role === "tool") {
          base.tool_call_id = m.toolCallId;
        }
        if (m.role === "assistant" && m.toolCalls?.length) {
          base.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments }
          }));
        }
        return base;
      })
    ];
    const tools = input.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));

    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ model, messages, tools: tools.length ? tools : undefined, temperature: 0, max_tokens: 4096 })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable)");
      throw new Error(`Provider API error ${response.status}: ${text}`);
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
      error?: { message?: string };
    };
    if (json.error?.message) {
      throw new Error(`Provider API error: ${json.error.message}`);
    }
    const message = json.choices?.[0]?.message ?? {};
    return {
      content: typeof message.content === "string" ? message.content : null,
      toolCalls: Array.isArray(message.tool_calls)
        ? message.tool_calls.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }))
        : []
    };
  }

  return {
    getStatus,
    decideIntake,
    answerChat,
    createPlan,
    executeTask,
    proposeToolCalls,
    synthesizeRunResult
  };
}
