import { type LlmConfig, formatLlmTarget } from "./env.js";

export type FetchFn = typeof fetch;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionResult {
  content: string;
  latency_ms: number;
}

export interface ChatCompletionOptions {
  temperature?: number;
  fetch?: FetchFn;
}

/** Strip trailing slashes; append `/v1` when the base has no `/v1` suffix. */
export function normalizeLlmApiBase(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function chatCompletionsUrl(apiBase: string): string {
  return `${normalizeLlmApiBase(apiBase)}/chat/completions`;
}

function redactSecret(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

function extractContent(data: unknown): string {
  if (!data || typeof data !== "object") {
    throw new Error("LLM chat/completions returned a non-object body");
  }
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("LLM chat/completions returned no choices");
  }
  const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
  const raw = message?.content;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    const text = raw
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
    if (text) {
      return text;
    }
  }
  throw new Error("LLM chat/completions returned empty message content");
}

/**
 * OpenAI-compatible POST {base}/chat/completions.
 * Errors include the URL and status only — never the raw token.
 */
export async function chatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  options: ChatCompletionOptions = {},
): Promise<ChatCompletionResult> {
  const url = chatCompletionsUrl(config.apiBase);
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("fetch is not available; pass options.fetch or use Node 20+");
  }
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: options.temperature ?? 0,
      }),
    });
  } catch (error) {
    const detail = redactSecret(error instanceof Error ? error.message : String(error), config.token);
    throw new Error(
      `LLM request failed for ${formatLlmTarget({ ...config, apiBase: normalizeLlmApiBase(config.apiBase) })}: ${detail}`,
    );
  }
  const latency_ms = Date.now() - started;
  const bodyText = await response.text();
  if (!response.ok) {
    const snippet = redactSecret(bodyText.replace(/\s+/g, " ").trim().slice(0, 400), config.token);
    throw new Error(
      `LLM chat/completions failed: HTTP ${response.status} at ${url}${snippet ? ` — ${snippet}` : ""}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`LLM chat/completions returned non-JSON at ${url}`);
  }
  return { content: extractContent(data), latency_ms };
}
