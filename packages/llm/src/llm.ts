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

export interface ChatCompletionResult {
  content: string;
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
  return { content: extractContent(data), latency_ms };
}
