import type { LlmConfig } from "./env.js";
import { type ChatMessage, chatCompletion, type FetchFn } from "./llm.js";
import type { ToolSpec } from "./schemas.js";

export const REWRITE_SYSTEM = `You are a system-prompt engineer for Sysprompt Lab.
Rewrite the given system prompt using common best practices: clear role, explicit constraints, consistent structure, and no contradictions.
Preserve the original intent, domain, language, safety rules, and any tool obligations.
Return a JSON object with exactly two string fields:
- "hypothesis": one short sentence (max 120 characters) describing what you changed
- "system_prompt": the complete rewritten system prompt (plain text, no markdown fences)
Do not include any other keys or commentary.`;

export interface RewriteResult {
  system_prompt: string;
  hypothesis: string;
}

export function shortHypothesis(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return "rewrite";
  }
  if (oneLine.length <= max) {
    return oneLine;
  }
  return `${oneLine.slice(0, max - 1)}…`;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function fromObject(value: unknown): RewriteResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const prompt = (value as { system_prompt?: unknown }).system_prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    return null;
  }
  const rawHyp = (value as { hypothesis?: unknown }).hypothesis;
  const hypothesis =
    typeof rawHyp === "string" && rawHyp.trim() ? shortHypothesis(rawHyp) : shortHypothesis(prompt);
  return { system_prompt: prompt, hypothesis };
}

/** Parse model output into a full system prompt plus a short hypothesis. */
export function parseRewriteResponse(text: string): RewriteResult {
  const stripped = stripFences(text);
  try {
    const parsed = fromObject(JSON.parse(stripped));
    if (parsed) {
      return parsed;
    }
  } catch {
    // fall through
  }
  const embedded = stripped.match(/\{[\s\S]*\}/);
  if (embedded) {
    try {
      const parsed = fromObject(JSON.parse(embedded[0]));
      if (parsed) {
        return parsed;
      }
    } catch {
      // fall through
    }
  }
  const labeled = stripped.match(/^HYPOTHESIS:\s*(.+)\n(?:-+\n)?([\s\S]+)$/i);
  if (labeled) {
    const system_prompt = labeled[2].trim();
    if (system_prompt) {
      return { hypothesis: shortHypothesis(labeled[1]), system_prompt };
    }
  }
  if (!stripped) {
    throw new Error("LLM rewrite returned an empty system prompt");
  }
  return { hypothesis: shortHypothesis(stripped), system_prompt: stripped };
}

export function buildRewriteMessages(systemPrompt: string, tools: ToolSpec[] = []): ChatMessage[] {
  const toolBlock =
    tools.length === 0
      ? ""
      : `\n\nTools the agent may use (keep these obligations):\n${tools
          .map((t) => `- ${t.name}: ${t.description}`)
          .join("\n")}`;
  return [
    { role: "system", content: REWRITE_SYSTEM },
    {
      role: "user",
      content: `Rewrite this system prompt. Preserve intent.\n\n<system_prompt>\n${systemPrompt}\n</system_prompt>${toolBlock}`,
    },
  ];
}

export async function rewriteSystemPrompt(
  config: LlmConfig,
  systemPrompt: string,
  options: { tools?: ToolSpec[]; fetch?: FetchFn } = {},
): Promise<RewriteResult> {
  const result = await chatCompletion(config, buildRewriteMessages(systemPrompt, options.tools), {
    temperature: 0.3,
    fetch: options.fetch,
  });
  return parseRewriteResponse(result.content);
}
