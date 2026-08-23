import type { LlmConfig } from "./env.js";
import { type ChatMessage, chatCompletion, type FetchFn } from "./llm.js";
import {
  type ApplyResult,
  type EffectiveRewriteMode,
  type PatchEdit,
  type PromptSection,
  type RewriteMode,
  applyPromptPatch,
  formatSectionMap,
  looksLikeUnifiedDiff,
  parseEdits,
  parseRewriteMode,
  PatchError,
  resolveAllowFullRewrite,
  resolveEffectiveRewriteMode,
  resolveMaxPatchRatio,
  resolvePatchThreshold,
  splitSections,
} from "./patch.js";
import type { ToolSpec } from "./schemas.js";

export const REWRITE_SYSTEM = `You are a system-prompt engineer for Sysprompt Lab.
Rewrite the given system prompt using common best practices: clear role, explicit constraints, consistent structure, and no contradictions.
Preserve the original intent, domain, language, safety rules, and any tool obligations.
Return a JSON object with exactly two string fields:
- "hypothesis": one short sentence (max 120 characters) describing what you changed
- "system_prompt": the complete rewritten system prompt (plain text, no markdown fences)
Do not include any other keys or commentary.`;

export const REWRITE_PATCH_SYSTEM = `You are a system-prompt engineer for Sysprompt Lab.
Edit the given system prompt like code: propose a structured patch, not a full rewrite.
Focus on clarity and structure. Preserve the original intent, domain, language, safety rules, and any tool obligations.
Do not rewrite the entire prompt; patch only what needs to change.

Return a JSON object with:
- "hypothesis": one short sentence (max 120 characters) describing what you changed
- "edits": an array of operations, each one of:
  { "op": "replace_section", "section_id": "s3", "content": "..." }
  { "op": "replace_range", "start_line": 10, "end_line": 20, "content": "..." }
  { "op": "insert_after_section", "section_id": "s2", "content": "..." }
  { "op": "delete_section", "section_id": "s5" }
You may instead return "diff": a unified diff against the full prompt.
Do not include a complete "system_prompt" unless you cannot express the change as a patch.
Do not include commentary or markdown fences.`;

export interface RewriteResult {
  system_prompt: string;
  hypothesis: string;
  mode?: EffectiveRewriteMode;
  sections?: PromptSection[];
  usedFallback?: boolean;
  patch?: { edits?: PatchEdit[]; diff?: string; kind?: ApplyResult["kind"] };
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

export function stripFences(text: string): string {
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

function toolBlock(tools: ToolSpec[] = []): string {
  return tools.length === 0
    ? ""
    : `\n\nTools the agent may use (keep these obligations):\n${tools
        .map((t) => `- ${t.name}: ${t.description}`)
        .join("\n")}`;
}

export function buildRewriteMessages(systemPrompt: string, tools: ToolSpec[] = []): ChatMessage[] {
  return [
    { role: "system", content: REWRITE_SYSTEM },
    {
      role: "user",
      content: `Rewrite this system prompt. Preserve intent.\n\n<system_prompt>\n${systemPrompt}\n</system_prompt>${toolBlock(tools)}`,
    },
  ];
}

export function buildPatchRewriteMessages(
  systemPrompt: string,
  sections: PromptSection[],
  tools: ToolSpec[] = [],
  retryError?: string,
): ChatMessage[] {
  const retry = retryError
    ? `Your previous patch could not be applied:\n${retryError}\n\nReturn a corrected JSON object with "hypothesis" and "edits" (or "diff"). Use the section ids below. Do not rewrite the entire prompt.\n\n`
    : "";
  return [
    { role: "system", content: REWRITE_PATCH_SYSTEM },
    {
      role: "user",
      content: `${retry}Patch this system prompt. Focus on clarity and structure. Preserve intent.\n\n## Section map\n${formatSectionMap(sections)}\n\n<system_prompt>\n${systemPrompt}\n</system_prompt>${toolBlock(tools)}`,
    },
  ];
}

export interface RewriteOptions {
  tools?: ToolSpec[];
  fetch?: FetchFn;
  rewriteMode?: RewriteMode;
  maxPatchRatio?: number;
  allowFullRewrite?: boolean;
  patchThreshold?: number;
}

export interface PatchProposal {
  hypothesis: string;
  edits?: PatchEdit[];
  diff?: string;
  system_prompt?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    const embedded = text.match(/\{[\s\S]*\}/);
    if (!embedded) {
      return null;
    }
    try {
      return asRecord(JSON.parse(embedded[0]));
    } catch {
      return null;
    }
  }
}

/** Parse model output into structured edits, a unified diff, or a full rewrite. */
export function parsePatchResponse(text: string): PatchProposal {
  const stripped = stripFences(text);
  const obj = tryParseJsonObject(stripped);
  if (obj) {
    const rawHyp = obj.hypothesis;
    const hypothesis =
      typeof rawHyp === "string" && rawHyp.trim() ? shortHypothesis(rawHyp) : "patch";
    const proposal: PatchProposal = { hypothesis };
    if (Array.isArray(obj.edits)) {
      proposal.edits = parseEdits(obj.edits);
    }
    if (typeof obj.diff === "string" && obj.diff.trim()) {
      proposal.diff = obj.diff;
    }
    if (typeof obj.system_prompt === "string" && obj.system_prompt.trim()) {
      proposal.system_prompt = obj.system_prompt;
    }
    if (proposal.edits || proposal.diff || proposal.system_prompt) {
      return proposal;
    }
  }
  if (looksLikeUnifiedDiff(stripped)) {
    return { hypothesis: "patch", diff: stripped };
  }
  throw new PatchError("LLM patch response had neither edits, a unified diff, nor a system_prompt", "no_patch");
}

function applyParsedPatch(
  systemPrompt: string,
  proposal: PatchProposal,
  options: { maxPatchRatio: number; sections: PromptSection[]; allowFullRewrite: boolean },
): RewriteResult {
  if (proposal.edits?.length || proposal.diff?.trim()) {
    const applied = applyPromptPatch(
      systemPrompt,
      { edits: proposal.edits, diff: proposal.diff },
      { maxPatchRatio: options.maxPatchRatio, sections: options.sections },
    );
    return {
      system_prompt: applied.prompt,
      hypothesis: proposal.hypothesis,
      mode: "patch",
      sections: options.sections,
      patch: { edits: proposal.edits, diff: proposal.diff, kind: applied.kind },
    };
  }
  if (proposal.system_prompt && options.allowFullRewrite) {
    return {
      system_prompt: proposal.system_prompt,
      hypothesis: proposal.hypothesis,
      mode: "full",
      sections: options.sections,
      usedFallback: true,
    };
  }
  throw new PatchError("expected edits or a unified diff; do not return a full system_prompt", "no_patch");
}

async function rewriteFull(
  config: LlmConfig,
  systemPrompt: string,
  options: RewriteOptions,
  sections: PromptSection[],
  usedFallback: boolean,
): Promise<RewriteResult> {
  const result = await chatCompletion(config, buildRewriteMessages(systemPrompt, options.tools), {
    temperature: 0.3,
    fetch: options.fetch,
  });
  return { ...parseRewriteResponse(result.content), mode: "full", sections, usedFallback };
}

async function rewriteViaPatch(
  config: LlmConfig,
  systemPrompt: string,
  options: RewriteOptions,
  sections: PromptSection[],
  maxPatchRatio: number,
  allowFullRewrite: boolean,
  retryError?: string,
): Promise<RewriteResult> {
  const result = await chatCompletion(
    config,
    buildPatchRewriteMessages(systemPrompt, sections, options.tools, retryError),
    { temperature: 0.3, fetch: options.fetch },
  );
  return applyParsedPatch(systemPrompt, parsePatchResponse(result.content), {
    maxPatchRatio,
    sections,
    allowFullRewrite,
  });
}

export async function rewriteSystemPrompt(
  config: LlmConfig,
  systemPrompt: string,
  options: RewriteOptions = {},
): Promise<RewriteResult> {
  const requested = options.rewriteMode ?? parseEnvRewriteMode();
  const effective = resolveEffectiveRewriteMode(
    requested,
    systemPrompt,
    resolvePatchThreshold(options.patchThreshold),
  );
  const sections = splitSections(systemPrompt);
  const maxPatchRatio = resolveMaxPatchRatio(options.maxPatchRatio, "R0");
  const allowFullRewrite = resolveAllowFullRewrite(options.allowFullRewrite, "R0", effective);

  if (effective === "full") {
    return rewriteFull(config, systemPrompt, options, sections, false);
  }

  try {
    return await rewriteViaPatch(config, systemPrompt, options, sections, maxPatchRatio, allowFullRewrite);
  } catch (first) {
    const detail = first instanceof Error ? first.message : String(first);
    try {
      return await rewriteViaPatch(
        config,
        systemPrompt,
        options,
        sections,
        maxPatchRatio,
        allowFullRewrite,
        detail,
      );
    } catch (second) {
      if (allowFullRewrite) {
        return rewriteFull(config, systemPrompt, options, sections, true);
      }
      throw second;
    }
  }
}

function parseEnvRewriteMode(): RewriteMode {
  return parseRewriteMode(process.env.SYSPROMPT_REWRITE_MODE);
}
