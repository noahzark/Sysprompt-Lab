import type { LlmConfig } from "./env.js";
import { type ChatMessage, chatCompletion, type FetchFn } from "./llm.js";
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

export interface R1Proposal {
  hypothesis: string;
  prompt: string;
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
  const hypothesis =
    typeof raw.hypothesis === "string" && raw.hypothesis.trim()
      ? shortHypothesis(raw.hypothesis)
      : shortHypothesis(prompt);
  return { hypothesis, prompt };
}

function fromPayload(value: unknown): R1Proposal[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const list = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(list)) {
    return null;
  }
  const out: R1Proposal[] = [];
  for (const item of list) {
    const parsed = fromCandidate(item);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

/** Parse rewriter output into full-prompt candidates. */
export function parseR1Candidates(text: string): R1Proposal[] {
  const stripped = stripFences(text);
  try {
    const parsed = fromPayload(JSON.parse(stripped));
    if (parsed) {
      return parsed;
    }
  } catch {
    // fall through
  }
  const embedded = stripped.match(/\{[\s\S]*\}/);
  if (embedded) {
    try {
      const parsed = fromPayload(JSON.parse(embedded[0]));
      if (parsed) {
        return parsed;
      }
    } catch {
      // fall through
    }
  }
  throw new Error("R1 rewriter returned no JSON candidates array ({ candidates: [{ hypothesis, prompt }] })");
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
    out.push({ hypothesis: proposal.hypothesis, prompt: proposal.prompt });
    if (limit !== undefined && out.length >= limit) {
      break;
    }
  }
  return out;
}

export function buildR1RewriteMessages(
  evidence: string,
  tools: ToolSpec[] = [],
): ChatMessage[] {
  const toolBlock =
    tools.length === 0
      ? ""
      : `\n\nTools the agent may use (keep these obligations):\n${tools
          .map((t) => `- ${t.name}: ${t.description}`)
          .join("\n")}`;
  return [
    { role: "system", content: R1_REWRITE_SYSTEM },
    { role: "user", content: `${evidence}${toolBlock}` },
  ];
}

export async function proposeR1Candidates(
  config: LlmConfig,
  evidence: string,
  options: { tools?: ToolSpec[]; fetch?: FetchFn } = {},
): Promise<R1Proposal[]> {
  const result = await chatCompletion(config, buildR1RewriteMessages(evidence, options.tools), {
    temperature: 0.6,
    fetch: options.fetch,
  });
  return parseR1Candidates(result.content);
}

export function dryRunProposals(currentPrompt: string, count: number, round: number): R1Proposal[] {
  const n = Math.max(0, count);
  return Array.from({ length: n }, (_, i) => ({
    hypothesis: `dry-run stub r${round} c${i + 1}`,
    prompt: `${currentPrompt.replace(/\s+$/g, "")}\n\n[R1 dry-run candidate ${round}.${i + 1}]`,
  }));
}
