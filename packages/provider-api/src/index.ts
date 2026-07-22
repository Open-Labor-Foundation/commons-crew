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
  ModelCatalogEntry,
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
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

export const AUTO_MODEL_SENTINEL = "auto";
const MODEL_CATALOG_TTL_MS = 10 * 60 * 1000;
// How many ranked candidates to keep as the primary + fallback chain in auto
// mode. Bounded so a bad/expensive tail model is never silently reached.
const AUTO_MODEL_CHAIN_LENGTH = 6;

async function fetchModelCatalog(apiKey: string, baseUrl: string): Promise<ModelCatalogEntry[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      // Some gateways in front of this API 404 generic Node fetch User-Agents;
      // postChatCompletion below hits the same wall. Match it here.
      "User-Agent": "OpenAI/Python/1.56.1 CPython/3.12"
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "(unreadable)");
    throw new Error(`Model catalog fetch failed ${response.status}: ${text}`);
  }
  const json = (await response.json()) as {
    data?: Array<{
      id: string;
      context_length?: number;
      concurrency_cost?: number;
      max_completion_tokens?: number;
      available_on_current_plan?: boolean;
      features?: { tool_use?: boolean };
    }>;
  };
  return (json.data ?? []).map((entry) => ({
    id: entry.id,
    contextLength: entry.context_length ?? 8192,
    supportsToolCalling: entry.features?.tool_use ?? false,
    concurrencyCost: typeof entry.concurrency_cost === "number" ? entry.concurrency_cost : null,
    availableOnPlan: entry.available_on_current_plan ?? true,
    maxCompletionTokens: typeof entry.max_completion_tokens === "number" ? entry.max_completion_tokens : null
  }));
}

// Featherless hosts ~20K+ community HuggingFace uploads alongside frontier
// releases, with no curation flag in the API to tell them apart — an
// unqualified id (e.g. a random "...-Uncensored-Heretic..." finetune) reports
// the same tool_use/available_on_plan flags as a flagship release. The two
// signals that actually separate them: the id's namespace is a frontier lab,
// and Featherless bothered to set an explicit max_completion_tokens (which in
// practice only shows up on models they've configured as real served
// endpoints, not auto-listed community uploads).
const TRUSTED_MODEL_PUBLISHERS = new Set([
  "Qwen", "deepseek-ai", "moonshotai", "nvidia", "mistralai", "meta-llama",
  "zai-org", "thudm", "google", "microsoft", "01-ai", "allenai", "openai", "ai21labs"
]);

function isTrustedPublisher(modelId: string): boolean {
  return TRUSTED_MODEL_PUBLISHERS.has(modelId.split("/")[0] ?? "");
}

// Rough parameter count parsed from the model id (e.g. "Qwen3-30B-A3B" -> 30,
// taking the largest "<N>B" found so MoE "total/active" naming doesn't
// under-count). Filters out the small distilled/base variants a trusted lab
// still publishes alongside its flagship releases — those tie on cost and
// context with the flagship (both defaults) but are meaningfully weaker at
// the structured-JSON intake/planning decisions this runtime depends on.
function estimateParamSizeB(modelId: string): number {
  const matches = [...modelId.matchAll(/(\d+(?:\.\d+)?)[bB](?![a-zA-Z])/g)];
  return matches.length ? Math.max(...matches.map((m) => parseFloat(m[1]))) : 0;
}
const AUTO_MODEL_MIN_SIZE_B = 14;

// Rank the catalog for auto-selection: eligible candidates must support tool
// calling (this runtime always drives a tool-calling loop) and be available
// on the account's plan. Among those, prefer the cheaper concurrency_cost —
// the account's plan-wide concurrency budget is a hard ceiling shared across
// every in-flight request, so an expensive model risks 429s well before a
// cheap one does (there's no per-token $ pricing in this API to rank on
// instead). Context length breaks ties. Three tiers, each a fallback for the
// last: (1) trusted + well-configured + >=14B, (2) trusted + well-configured
// of any size, (3) the unfiltered tool-calling pool.
function rankModels(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const eligible = catalog.filter((entry) => entry.supportsToolCalling && entry.availableOnPlan);
  const byCostThenContext = (a: ModelCatalogEntry, b: ModelCatalogEntry) => {
    const costA = a.concurrencyCost ?? 99;
    const costB = b.concurrencyCost ?? 99;
    if (costA !== costB) return costA - costB;
    return b.contextLength - a.contextLength;
  };
  const curated = eligible.filter((entry) => isTrustedPublisher(entry.id) && entry.maxCompletionTokens != null);
  const curatedSizedUp = curated.filter((entry) => estimateParamSizeB(entry.id) >= AUTO_MODEL_MIN_SIZE_B);
  if (curatedSizedUp.length) return curatedSizedUp.sort(byCostThenContext);
  if (curated.length) return curated.sort(byCostThenContext);
  return eligible.sort(byCostThenContext);
}

/**
 * POST a chat completion, trying each model in order. Each model gets a couple
 * of same-model retries on a *transient* error (the model is momentarily busy).
 * A non-transient error (bad request, per-model serving quirk) is not worth
 * retrying on the same model, but IS worth trying on the next one when
 * `aggressiveFailover` is set — that's auto mode's "find the next appropriate
 * model" behavior. In manual mode (aggressiveFailover=false, normally a
 * one-model list anyway) a non-transient error still fails fast, matching the
 * user's explicit choice. The winning model's raw JSON is returned.
 */
async function postChatCompletion(
  apiKey: string,
  baseUrl: string,
  models: string[],
  bodyWithoutModel: Record<string, unknown>,
  sameModelRetries = 2,
  aggressiveFailover = false
): Promise<{ json: ChatCompletionJson; modelUsed: string }> {
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
        return { json, modelUsed: models[m] };
      } catch (error) {
        lastError = error;
        const transient = isTransientProviderError(error);
        if (!transient && !aggressiveFailover) {
          throw error;
        }
        const moreAttemptsOnThisModel = transient && attempt < sameModelRetries;
        if (moreAttemptsOnThisModel) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          continue;
        }
        if (isLastModel) {
          throw error;
        }
        break; // move to the next model
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
  userPrompt: string,
  aggressiveFailover = false
): Promise<string> {
  const { json } = await postChatCompletion(
    apiKey,
    baseUrl,
    models,
    {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0,
      max_tokens: 4096
    },
    2,
    aggressiveFailover
  );

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
  maxRetries = 2,
  aggressiveFailover = false
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const content = await callApi(apiKey, baseUrl, models, systemPrompt, userPrompt, aggressiveFailover);
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
  const isAutoModel = model === AUTO_MODEL_SENTINEL;
  let governedPromptsPromise: Promise<GovernedProviderPrompts> | null = null;
  let catalogPromise: Promise<ModelCatalogEntry[]> | null = null;
  let catalogFetchedAt = 0;
  let lastResolvedModels: string[] | null = null;

  async function getCatalog(): Promise<ModelCatalogEntry[]> {
    if (!catalogPromise || Date.now() - catalogFetchedAt > MODEL_CATALOG_TTL_MS) {
      catalogFetchedAt = Date.now();
      catalogPromise = fetchModelCatalog(requireApiKey(), baseUrl).catch((error) => {
        catalogPromise = null;
        throw error;
      });
    }
    return catalogPromise;
  }

  // The ordered chain tried for every provider call: primary model first,
  // then fallbacks. In auto mode this chain is derived from the live model
  // catalog (ranked by capability), refreshed periodically, instead of a
  // fixed manual list — and re-derived on every call, so a model that drops
  // off the plan or loses tool-use support falls out of the chain on its own.
  async function resolveModels(): Promise<string[]> {
    if (!isAutoModel) {
      return [...new Set([model, ...(config.provider.fallbackModels ?? [])].filter(Boolean))];
    }
    const catalog = await getCatalog();
    const ranked = rankModels(catalog).slice(0, AUTO_MODEL_CHAIN_LENGTH).map((entry) => entry.id);
    if (!ranked.length) {
      throw new Error(
        "Auto model selection found no tool-calling-capable models available on this provider account. Set commonsCrew.model explicitly."
      );
    }
    lastResolvedModels = ranked;
    return ranked;
  }

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
    const effectiveModel = isAutoModel ? (lastResolvedModels?.[0] ?? "auto (unresolved)") : model;
    return {
      id: "api-provider",
      displayName: "API Provider",
      model: effectiveModel,
      installed: true,
      authenticated: Boolean(apiKey),
      authMode: "api_key",
      capabilities: {
        providerIdentity: `${baseUrl} / ${effectiveModel}`,
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
      key, baseUrl, await resolveModels(),
      INTAKE_DOMAIN_SELECTION_SCHEMA,
      system,
      buildUserPrompt(input),
      2, isAutoModel
    );
  }

  async function decideIntake(input: IntakeDecisionInput): Promise<IntakeDecision> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    return await runStructuredApiCall<IntakeDecision>(
      key, baseUrl, await resolveModels(),
      INTAKE_DECISION_SCHEMA,
      buildSystemPrompt(prompts.intake, INTAKE_DECISION_SCHEMA),
      buildUserPrompt(input),
      2, isAutoModel
    );
  }

  async function answerChat(input: ChatAnswerInput): Promise<ChatAnswer> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    return await runStructuredApiCall<ChatAnswer>(
      key, baseUrl, await resolveModels(),
      CHAT_ANSWER_SCHEMA,
      buildSystemPrompt(prompts.chat, CHAT_ANSWER_SCHEMA),
      buildUserPrompt(input),
      2, isAutoModel
    );
  }

  async function createPlan(input: PlanDraftInput): Promise<PlanDraft> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    const draft = await runStructuredApiCall<PlanDraft>(
      key, baseUrl, await resolveModels(),
      PLAN_DRAFT_SCHEMA,
      buildSystemPrompt(prompts.planning, PLAN_DRAFT_SCHEMA),
      buildUserPrompt(input),
      2, isAutoModel
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
      key, baseUrl, await resolveModels(),
      TASK_EXECUTION_SCHEMA,
      buildSystemPrompt(executionSection, TASK_EXECUTION_SCHEMA),
      buildUserPrompt(enrichedInput),
      2, isAutoModel
    );
  }

  async function synthesizeRunResult(input: RunResultSynthesisInput): Promise<RunResultSynthesisResult> {
    const key = requireApiKey();
    const prompts = await getGovernedPrompts();
    return await runStructuredApiCall<RunResultSynthesisResult>(
      key, baseUrl, await resolveModels(),
      RUN_RESULT_SYNTHESIS_SCHEMA,
      buildSystemPrompt(prompts.finalResult, RUN_RESULT_SYNTHESIS_SCHEMA),
      buildUserPrompt(input),
      2, isAutoModel
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

    const { json, modelUsed } = await postChatCompletion(
      key,
      baseUrl,
      await resolveModels(),
      {
        messages,
        tools: tools.length ? tools : undefined,
        temperature: 0,
        max_tokens: 4096
      },
      2,
      isAutoModel
    );
    const message = json.choices?.[0]?.message ?? {};
    return {
      content: typeof message.content === "string" ? message.content : null,
      toolCalls: Array.isArray(message.tool_calls)
        ? message.tool_calls.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }))
        : [],
      usage: json.usage
        ? { model: modelUsed, promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 }
        : undefined
    };
  }

  async function listModels(): Promise<ModelCatalogEntry[]> {
    return await getCatalog();
  }

  return {
    getStatus,
    selectIntakeDomains,
    decideIntake,
    answerChat,
    createPlan,
    listModels,
    executeTask,
    proposeToolCalls,
    synthesizeRunResult
  };
}
