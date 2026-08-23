import type { LlmConfig } from "./env.js";
import { type ChatMessage, chatCompletion, type FetchFn } from "./llm.js";
import { type PatchEdit, applyPromptPatch, dryRunPatch, parseEdits, PatchError } from "./patch.js";
import { shortHypothesis, stripFences } from "./rewrite.js";
import type { ToolSpec } from "./schemas.js";

export const R1_REWRITE_SYSTEM = `You are a system-prompt engineer for Sysprompt Lab (R1 eval-loop).
You will receive the current system prompt, scored train examples (failures and successes), prior search history, and hypotheses already tried.
Propose a small number of FULL system-prompt rewrites that preserve the original intent, domain, language, safety rules, and any tool obligations.
Each candidate must be a complete system prompt (not a patch, diff, or fragment).
Return JSON only with this shape:
{
  "candidates": [
    { "hypothesis": "one short sentence, max 120 characters", "prompt": "the complete rewritten system prompt" }
  ]
}
Do not include commentary, markdown fences, or any other keys.`;

export const R1_REWRITE_PATCH_SYSTEM = `You are a system-prompt engineer for Sysprompt Lab (R1 eval-loop).
You will receive the current system prompt (with a section map), scored train examples (failures and successes), prior search history, and hypotheses already tried.
Propose a small number of PATCHES — structured edits or unified diffs — that address the failures.
Do not rewrite the entire prompt; patch only what the failures implicate.
Preserve the original intent, domain, language, safety rules, and any tool obligations.
Return JSON only with this shape:
{
  "candidates": [
    { "hypothesis": "one short sentence, max 120 characters", "edits": [ { "op": "replace_section", "section_id": "s3", "content": "..." } ] }
  ]
}
Each candidate may use "edits" or "diff" (unified diff against the full prompt). Do not return a full "prompt" / "system_prompt".
Do not include commentary, markdown fences, or any other keys.`;

export interface R1Proposal {
  hypothesis: string;
  prompt: string;
  patch?: { edits?: PatchEdit[]; diff?: string };
}

export interface R1RawCandidate {
  hypothesis: string;
  prompt?: string;
  edits?: PatchEdit[];
  diff?: string;
}

function hypothesisOf(raw: { hypothesis?: unknown }, fallback: string): string {
  return typeof raw.hypothesis === "string" && raw.hypothesis.trim()
    ? shortHypothesis(raw.hypothesis)
    : shortHypothesis(fallback);
}

function fromCandidate(value: unknown): R1Proposal | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as { hypothesis?: unknown; prompt?: unknown; system_prompt?: unknown };
  const prompt =
    typeof raw.prompt === "string" && raw.prompt.trim()
      ? raw.prompt
      : typeof raw.system_prompt === "string" && raw.system_prompt.trim()
        ? raw.system_prompt
        : "";
  if (!prompt) {
    return null;
  }
  return { hypothesis: hypothesisOf(raw, prompt), prompt };
}

function fromRawCandidate(value: unknown): R1RawCandidate | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as {
    hypothesis?: unknown;
    prompt?: unknown;
    system_prompt?: unknown;
    edits?: unknown;
    diff?: unknown;
  };
  const prompt =
    typeof raw.prompt === "string" && raw.prompt.trim()
      ? raw.prompt
      : typeof raw.system_prompt === "string" && raw.system_prompt.trim()
        ? raw.system_prompt
        : undefined;
  let edits: PatchEdit[] | undefined;
  if (raw.edits !== undefined) {
    edits = parseEdits(raw.edits);
  }
  const diff = typeof raw.diff === "string" && raw.diff.trim() ? raw.diff : undefined;
  if (!prompt && !edits && !diff) {
    return null;
  }
  return {
    hypothesis: hypothesisOf(raw, prompt ?? "patch"),
    prompt,
    edits,
    diff,
  };
}

function parseCandidatesPayload(text: string, mapper: (item: unknown) => R1Proposal | R1RawCandidate | null): unknown[] | null {
  const stripped = stripFences(text);
  const tryObj = (value: unknown): unknown[] | null => {
    if (!value || typeof value !== "object") {
      return null;
    }
    const list = (value as { candidates?: unknown }).candidates;
    if (!Array.isArray(list)) {
      return null;
    }
    const out: unknown[] = [];
    for (const item of list) {
      const parsed = mapper(item);
      if (parsed) {
        out.push(parsed);
      }
    }
    return out;
  };
  try {
    const parsed = tryObj(JSON.parse(stripped));
    if (parsed) {
      return parsed;
    }
  } catch {
    // fall through
  }
  const embedded = stripped.match(/\{[\s\S]*\}/);
  if (embedded) {
    try {
      return tryObj(JSON.parse(embedded[0]));
    } catch {
      return null;
    }
  }
  return null;
}

/** Parse rewriter output into full-prompt candidates. */
export function parseR1Candidates(text: string): R1Proposal[] {
  const parsed = parseCandidatesPayload(text, fromCandidate);
  if (parsed) {
    return parsed as R1Proposal[];
  }
  throw new Error("R1 rewriter returned no JSON candidates array ({ candidates: [{ hypothesis, prompt }] })");
}

/** Parse rewriter output that may include edits / diff instead of a full prompt. */
export function parseR1RawCandidates(text: string): R1RawCandidate[] {
  const parsed = parseCandidatesPayload(text, fromRawCandidate);
  if (parsed) {
    return parsed as R1RawCandidate[];
  }
  throw new Error(
    "R1 rewriter returned no JSON candidates array ({ candidates: [{ hypothesis, edits|diff|prompt }] })",
  );
}

export function materializeR1Proposals(
  raw: R1RawCandidate[],
  currentPrompt: string,
  options: { maxPatchRatio: number; allowFullRewrite: boolean },
): R1Proposal[] {
  const out: R1Proposal[] = [];
  const errors: string[] = [];
  for (const item of raw) {
    try {
      if ((item.edits && item.edits.length > 0) || item.diff?.trim()) {
        const applied = applyPromptPatch(
          currentPrompt,
          { edits: item.edits, diff: item.diff },
          { maxPatchRatio: options.maxPatchRatio },
        );
        out.push({
          hypothesis: item.hypothesis,
          prompt: applied.prompt,
          patch: { edits: item.edits, diff: item.diff },
        });
      } else if (item.prompt?.trim()) {
        if (!options.allowFullRewrite) {
          errors.push(`${item.hypothesis}: full prompt returned but full rewrite is disabled`);
          continue;
        }
        out.push({ hypothesis: item.hypothesis, prompt: item.prompt });
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (out.length === 0 && errors.length > 0) {
    throw new PatchError(errors.join("; "), "materialize");
  }
  return out;
}

export function promptKey(prompt: string): string {
  return prompt.replace(/\s+$/g, "").trim();
}

export function dedupeProposals(
  proposals: R1Proposal[],
  currentPrompt: string,
  seen: Iterable<string> = [],
  limit?: number,
): R1Proposal[] {
  const used = new Set<string>([promptKey(currentPrompt), ...seen].map((key) => promptKey(key)));
  const out: R1Proposal[] = [];
  for (const proposal of proposals) {
    const key = promptKey(proposal.prompt);
    if (!key || used.has(key)) {
      continue;
    }
    used.add(key);
    out.push({
      hypothesis: proposal.hypothesis,
      prompt: proposal.prompt,
      patch: proposal.patch,
    });
    if (limit !== undefined && out.length >= limit) {
      break;
    }
  }
  return out;
}

export function buildR1RewriteMessages(
  evidence: string,
  tools: ToolSpec[] = [],
  mode: "patch" | "full" = "full",
  retryError?: string,
): ChatMessage[] {
  const toolBlock =
    tools.length === 0
      ? ""
      : `\n\nTools the agent may use (keep these obligations):\n${tools
          .map((t) => `- ${t.name}: ${t.description}`)
          .join("\n")}`;
  const retry = retryError
    ? `Your previous patch could not be applied:\n${retryError}\n\nReturn a corrected JSON object with "candidates" using "edits" or "diff". Do not rewrite the entire prompt.\n\n`
    : "";
  return [
    { role: "system", content: mode === "patch" ? R1_REWRITE_PATCH_SYSTEM : R1_REWRITE_SYSTEM },
    { role: "user", content: `${retry}${evidence}${toolBlock}` },
  ];
}

export interface ProposeR1Options {
  tools?: ToolSpec[];
  fetch?: FetchFn;
  currentPrompt?: string;
  rewriteMode?: "patch" | "full";
  maxPatchRatio?: number;
  allowFullRewrite?: boolean;
}

export async function proposeR1Candidates(
  config: LlmConfig,
  evidence: string,
  options: ProposeR1Options = {},
): Promise<R1Proposal[]> {
  const mode = options.rewriteMode ?? "full";
  const ask = async (retryError?: string): Promise<R1Proposal[]> => {
    const result = await chatCompletion(config, buildR1RewriteMessages(evidence, options.tools, mode, retryError), {
      temperature: 0.6,
      fetch: options.fetch,
    });
    if (mode === "full") {
      return parseR1Candidates(result.content);
    }
    if (!options.currentPrompt) {
      throw new Error("proposeR1Candidates in patch mode requires currentPrompt");
    }
    return materializeR1Proposals(parseR1RawCandidates(result.content), options.currentPrompt, {
      maxPatchRatio: options.maxPatchRatio ?? 0.5,
      allowFullRewrite: options.allowFullRewrite ?? false,
    });
  };

  if (mode === "full") {
    return ask();
  }

  try {
    return await ask();
  } catch (first) {
    const detail = first instanceof Error ? first.message : String(first);
    try {
      return await ask(detail);
    } catch (second) {
      if (options.allowFullRewrite) {
        const result = await chatCompletion(config, buildR1RewriteMessages(evidence, options.tools, "full"), {
          temperature: 0.6,
          fetch: options.fetch,
        });
        return parseR1Candidates(result.content);
      }
      throw second;
    }
  }
}

export function dryRunProposals(currentPrompt: string, count: number, round: number): R1Proposal[] {
  const n = Math.max(0, count);
  return Array.from({ length: n }, (_, i) => {
    const note = `[R1 dry-run candidate ${round}.${i + 1}]`;
    const patched = dryRunPatch(currentPrompt, note);
    return {
      hypothesis: `dry-run stub r${round} c${i + 1}`,
      prompt: patched.prompt,
      patch: { edits: patched.edits },
    };
  });
}
