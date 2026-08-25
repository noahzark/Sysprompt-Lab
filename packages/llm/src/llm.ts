import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { type LlmConfig, formatLlmTarget } from "./env.js";

export type FetchFn = typeof fetch;

export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImageUrlPart {
  type: "image_url";
  image_url: { url: string };
}

export type ChatContentPart = ChatTextPart | ChatImageUrlPart;

/** OpenAI-compatible chat content: a string or multimodal parts. */
export type ChatMessageContent = string | ChatContentPart[];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatMessageContent;
}

/** Parsed chat/completions body, before latency is attached. */
export interface ParsedChatCompletion {
  /** Visible assistant text (scored). Empty string when the model only returned reasoning. */
  content: string;
  /** Chain-of-thought / thinking, if the API provided it. Never scored. */
  reasoning?: string;
  finish_reason?: string;
  reasoning_tokens?: number;
}

export interface ChatCompletionResult extends ParsedChatCompletion {
  latency_ms: number;
}

export interface ChatCompletionOptions {
  temperature?: number;
  max_tokens?: number;
  fetch?: FetchFn;
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** MIME from a jpeg/png/webp file path (`.mp4.jpg` → jpeg). */
export function imageMimeFromPath(filePath: string): string | undefined {
  return MIME_BY_EXT[extname(filePath).toLowerCase()];
}

/** MIME from jpeg / png / webp magic bytes. */
export function imageMimeFromBytes(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * Read a local jpeg/png/webp file and return an OpenAI-compatible data URL.
 * Detects type from magic bytes, then the file extension.
 */
export function imageFileToDataUrl(filePath: string): string {
  const bytes = readFileSync(filePath);
  const mime = imageMimeFromBytes(bytes) ?? imageMimeFromPath(filePath);
  if (!mime) {
    throw new Error(`Unsupported image type for "${filePath}". Use jpeg, png, or webp.`);
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
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

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (value && typeof value === "object") {
    const obj = value as { content?: unknown; text?: unknown };
    if (typeof obj.content === "string" && obj.content.length > 0) {
      return obj.content;
    }
    if (typeof obj.text === "string" && obj.text.length > 0) {
      return obj.text;
    }
  }
  return undefined;
}

function partType(part: object): string {
  const type = (part as { type?: unknown }).type;
  return typeof type === "string" ? type.toLowerCase() : "";
}

function isReasoningPartType(type: string): boolean {
  return type === "reasoning" || type === "thinking" || type === "thought";
}

function visiblePartText(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  if (!part || typeof part !== "object") {
    return "";
  }
  if (isReasoningPartType(partType(part))) {
    return "";
  }
  const text = (part as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function reasoningPartText(part: unknown): string | undefined {
  if (!part || typeof part !== "object") {
    return undefined;
  }
  if (!isReasoningPartType(partType(part))) {
    return undefined;
  }
  const obj = part as { text?: unknown; thinking?: unknown };
  return asNonEmptyString(obj.text) ?? asNonEmptyString(obj.thinking);
}

function extractVisibleContent(raw: unknown): { text: string; present: boolean } {
  if (typeof raw === "string") {
    return { text: raw, present: true };
  }
  if (Array.isArray(raw)) {
    return { text: raw.map(visiblePartText).join(""), present: true };
  }
  return { text: "", present: false };
}

const MESSAGE_REASONING_KEYS = [
  "reasoning_content",
  "reasoning",
  "thinking",
  "thinking_content",
  "reasoning_text",
] as const;

function extractMessageReasoning(message: Record<string, unknown> | undefined, content: unknown): string | undefined {
  if (message) {
    for (const key of MESSAGE_REASONING_KEYS) {
      const found = asNonEmptyString(message[key]);
      if (found) {
        return found;
      }
    }
  }
  if (Array.isArray(content)) {
    const fromParts = content.map(reasoningPartText).filter((part): part is string => Boolean(part));
    if (fromParts.length > 0) {
      return fromParts.join("");
    }
  }
  return undefined;
}

function extractFinishReason(choice: Record<string, unknown> | undefined): string | undefined {
  if (!choice) {
    return undefined;
  }
  return asNonEmptyString(choice.finish_reason) ?? asNonEmptyString(choice.finishReason);
}

function extractReasoningTokens(data: Record<string, unknown>): number | undefined {
  const usage = data.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const details = record.completion_tokens_details;
  if (details && typeof details === "object") {
    const nested = details as Record<string, unknown>;
    const fromDetails = nested.reasoning_tokens ?? nested.reasoning;
    if (typeof fromDetails === "number" && Number.isFinite(fromDetails)) {
      return fromDetails;
    }
  }
  const top = record.reasoning_tokens;
  if (typeof top === "number" && Number.isFinite(top)) {
    return top;
  }
  return undefined;
}

/**
 * Parse an OpenAI-compatible chat/completions JSON body.
 * Visible `content` is scored; `reasoning` is diagnostic only.
 * Empty content is allowed when reasoning is present (thinking models).
 */
export function parseChatCompletion(data: unknown): ParsedChatCompletion {
  if (!data || typeof data !== "object") {
    throw new Error("LLM chat/completions returned a non-object body");
  }
  const body = data as Record<string, unknown>;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("LLM chat/completions returned no choices");
  }
  const choice = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : undefined;
  const message =
    choice?.message && typeof choice.message === "object"
      ? (choice.message as Record<string, unknown>)
      : undefined;
  const { text, present } = extractVisibleContent(message?.content);
  const reasoning = extractMessageReasoning(message, message?.content);
  if (!present && !reasoning) {
    throw new Error("LLM chat/completions returned empty message content");
  }
  const parsed: ParsedChatCompletion = { content: present ? text : "" };
  if (reasoning) {
    parsed.reasoning = reasoning;
  }
  const finishReason = extractFinishReason(choice);
  if (finishReason) {
    parsed.finish_reason = finishReason;
  }
  const reasoningTokens = extractReasoningTokens(body);
  if (reasoningTokens !== undefined) {
    parsed.reasoning_tokens = reasoningTokens;
  }
  return parsed;
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
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: options.temperature ?? 0,
  };
  if (options.max_tokens !== undefined && options.max_tokens > 0) {
    body.max_tokens = options.max_tokens;
  }
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(body),
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
  return { ...parseChatCompletion(data), latency_ms };
}
