import path from "node:path";
import { promises as fs } from "node:fs";
import { parse as parseYaml } from "yaml";
import type {
  ChatAnswer,
  ChatAnswerInput,
  IntakeDecision,
  IntakeDecisionInput,
  IntakeDomainSelection,
  IntakeDomainSelectionInput,
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

const INTAKE_DOMAIN_SELECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["domains"],
  properties: {
    domains: {
      type: "array",
      maxItems: 6,
      items: { type: "string" }
    }
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

// Transient provider failures — the model is momentarily busy/overloaded or the
// gateway returned a 429/5xx. These are worth retrying (same model) and, if they
// persist, worth failing over to a fallback model. Hard errors (400 bad request,
// 401 auth) are not transient and must fail fast.
const TRANSIENT_PROVIDER_ERROR =
  /\b(429|500|502|503|504)\b|busy|overloaded|server_error|completion_error|unavailable|temporarily|rate.?limit|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i;

function isTransientProviderError(error: unknown): boolean {
  return TRANSIENT_PROVIDER_ERROR.test(error instanceof Error ? error.message : String(error));
}

type ChatCompletionJson = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  error?: { message?: string };
};

/**
 * POST a chat completion, trying each model in order. Each model gets a couple of
 * same-model retries on a transient error (the model is often busy for a moment);
 * if it still fails transiently, we fail over to the next model. Non-transient
 * errors fail fast. The winning model's raw JSON is returned.
 */
async function postChatCompletion(
  apiKey: string,
  baseUrl: string,
  models: string[],
  bodyWithoutModel: Record<string, unknown>,
  sameModelRetries = 2
): Promise<ChatCompletionJson> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  let lastError: unknown;
  for (let m = 0; m < models.length; m++) {
    const isLastModel = m === models.length - 1;
    for (let attempt = 0; attempt <= sameModelRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "OpenAI/Python/1.56.1 CPython/3.12"
          },
          body: JSON.stringify({ ...bodyWithoutModel, model: models[m] })
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "(unreadable)");
          throw new Error(`Provider API error ${response.status}: ${text}`);
        }
        const json = (await response.json()) as ChatCompletionJson;
        if (json.error?.message) {
          throw new Error(`Provider API error: ${json.error.message}`);
        }
        return json;
      } catch (error) {
        lastError = error;
        if (!isTransientProviderError(error)) {
          throw error;
        }
        const moreAttemptsOnThisModel = attempt < sameModelRetries;
        const canFailOver = !moreAttemptsOnThisModel && !isLastModel;
        if (!moreAttemptsOnThisModel && isLastModel) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        if (canFailOver) {
          break; // move to the next model
        }
      }
    }
  }
  throw lastError;
}

async function callApi(
  apiKey: string,
  baseUrl: string,
  models: string[],
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const json = await postChatCompletion(apiKey, baseUrl, models, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0,
    max_tokens: 4096
  });

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Provider API returned empty response content.");
  }
  return content;
}

async function runStructuredApiCall<T>(
  apiKey: string,
  baseUrl: string,
  models: string[],
  schema: unknown,
  systemPrompt: string,
  userPrompt: string,
  maxRetries = 2
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const content = await callApi(apiKey, baseUrl, models, systemPrompt, userPrompt);
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
  // Primary model first, then any configured fallbacks (deduped). Transient
  // failures on the primary fail over down this list.
  const models = [...new Set([model, ...(config.provider.fallbackModels ?? [])].filter(Boolean))];
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
        // The runtime drives an OpenAI-compatible tool-calling loop against this
        // provider (verified against Featherless Qwen3/Kimi). File IO is the
        // runtime's, not the provider's.
        supportsToolCalls: true,
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

  async function selectIntakeDomains(input: IntakeDomainSelectionInput): Promise<IntakeDomainSelection> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    const system = buildSystemPrompt(
      {
        role: prompts.intake.role,
        instructions: [
          ...prompts.intake.instructions,
          "You are the first pass of routing. From the list of specialist domains, select ONLY the domains worth inspecting for this request — usually one, at most a few.",
          "Return an empty list when the request is conversational or matches no domain."
        ]
      },
      INTAKE_DOMAIN_SELECTION_SCHEMA
    );
    return await runStructuredApiCall<IntakeDomainSelection>(
      key, baseUrl, models,
      INTAKE_DOMAIN_SELECTION_SCHEMA,
      system,
      buildUserPrompt(input)
    );
  }

  async function decideIntake(input: IntakeDecisionInput): Promise<IntakeDecision> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    return await runStructuredApiCall<IntakeDecision>(
      key, baseUrl, models,
      INTAKE_DECISION_SCHEMA,
      buildSystemPrompt(prompts.intake, INTAKE_DECISION_SCHEMA),
      buildUserPrompt(input)
    );
  }

  async function answerChat(input: ChatAnswerInput): Promise<ChatAnswer> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    return await runStructuredApiCall<ChatAnswer>(
      key, baseUrl, models,
      CHAT_ANSWER_SCHEMA,
      buildSystemPrompt(prompts.chat, CHAT_ANSWER_SCHEMA),
      buildUserPrompt(input)
    );
  }

  async function createPlan(input: PlanDraftInput): Promise<PlanDraft> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    const draft = await runStructuredApiCall<PlanDraft>(
      key, baseUrl, models,
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
      key, baseUrl, models,
      TASK_EXECUTION_SCHEMA,
      buildSystemPrompt(executionSection, TASK_EXECUTION_SCHEMA),
      buildUserPrompt(enrichedInput)
    );
  }

  async function synthesizeRunResult(input: RunResultSynthesisInput): Promise<RunResultSynthesisResult> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    return await runStructuredApiCall<RunResultSynthesisResult>(
      key, baseUrl, models,
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

    const json = await postChatCompletion(key, baseUrl, models, {
      messages,
      tools: tools.length ? tools : undefined,
      temperature: 0,
      max_tokens: 4096
    });
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
    selectIntakeDomains,
    decideIntake,
    answerChat,
    createPlan,
    executeTask,
    proposeToolCalls,
    synthesizeRunResult
  };
}
