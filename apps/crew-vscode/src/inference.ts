// OpenAI-compatible inference with tool calling. The runtime runs locally in the
// extension host and calls the user's configured endpoint directly with their
// own key (BYO) — no OLF backend, no key ever leaves the user's machine except
// to the inference provider they chose.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface InferenceConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
}

export async function chat(
  config: InferenceConfig,
  messages: ChatMessage[],
  tools: ToolDef[]
): Promise<ChatResult> {
  if (!config.apiKey) {
    throw new Error("No inference API key configured. Set commonsCrew.apiKey in Settings.");
  }
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: 0.1,
      max_tokens: 2000
    })
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Inference request failed (${res.status}): ${text.slice(0, 400)}`);
  }
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Inference response was not JSON: ${text.slice(0, 200)}`);
  }
  const message = body?.choices?.[0]?.message ?? {};
  return {
    content: typeof message.content === "string" ? message.content : null,
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : []
  };
}
