import type { CaseEvalResult } from "./eval.js";
import { type PromptSection, formatSectionMap } from "./patch.js";

const SECRET_KEY =
  /^(token|password|secret|api[_-]?key|authorization|auth|bearer|credential|private[_-]?key)$/i;
const SECRET_VALUE = /sk-[a-zA-Z0-9_-]{8,}|Bearer\s+\S+/gi;

export const DEFAULT_MAX_FAILURES = 6;
export const DEFAULT_MAX_SUCCESSES = 3;
export const DEFAULT_FIELD_CHARS = 240;

export interface SearchHistoryEntry {
  round: number;
  hypothesis: string;
  train: number;
  val?: number;
  adopted: boolean;
}

export interface EvidencePack {
  currentPrompt: string;
  trainMean: number;
  valMean?: number;
  failures: CaseEvalResult[];
  successes: CaseEvalResult[];
  history: SearchHistoryEntry[];
  hypotheses: string[];
}

export function redactSecrets(text: string): string {
  let out = text.replace(SECRET_VALUE, "[redacted]");
  const token = process.env.LLM_API_TOKEN?.trim();
  if (token) {
    out = out.split(token).join("[redacted]");
  }
  return out;
}

export function truncateText(text: string, max = DEFAULT_FIELD_CHARS): string {
  const cleaned = redactSecrets(text).replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) {
    return cleaned;
  }
  return `${cleaned.slice(0, max - 1)}…`;
}

export function sanitizeValue(value: unknown, max = DEFAULT_FIELD_CHARS): unknown {
  if (typeof value === "string") {
    return truncateText(value, max);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeValue(item, max));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitizeValue(nested, max);
    }
    return out;
  }
  return value;
}

export function selectEvidenceCases(
  cases: CaseEvalResult[],
  maxFail = DEFAULT_MAX_FAILURES,
  maxPass = DEFAULT_MAX_SUCCESSES,
): { failures: CaseEvalResult[]; successes: CaseEvalResult[] } {
  return {
    failures: cases.filter((item) => item.quality < 1).slice(0, maxFail),
    successes: cases.filter((item) => item.quality >= 1).slice(0, maxPass),
  };
}

function formatCase(item: CaseEvalResult, label: string, index: number): string {
  const gold =
    item.evalCase.gold === undefined ? "" : `\ngold: ${JSON.stringify(sanitizeValue(item.evalCase.gold))}`;
  const feedback = item.evalCase.feedback
    ? `\nfeedback: ${truncateText(item.evalCase.feedback)}`
    : "";
  return `### ${label} ${index + 1} (${item.evalCase.id}, quality=${item.quality.toFixed(3)})
input: ${JSON.stringify(sanitizeValue(item.evalCase.input))}
output: ${truncateText(item.output)}${gold}${feedback}`;
}

function fmt(n: number): string {
  return n.toFixed(3);
}

export interface FormatEvidenceOptions {
  rewriteMode?: "patch" | "full";
  sections?: PromptSection[];
}

/** Structured evidence for the R1 rewriter. Train cases only (search set). */
export function formatEvidence(
  pack: EvidencePack,
  candidateBudget: number,
  options: FormatEvidenceOptions = {},
): string {
  const valLine = pack.valMean === undefined ? "" : `\nval mean quality: ${fmt(pack.valMean)}`;
  const failBlock =
    pack.failures.length === 0
      ? "(none)"
      : pack.failures.map((item, i) => formatCase(item, "fail", i)).join("\n\n");
  const passBlock =
    pack.successes.length === 0
      ? "(none)"
      : pack.successes.map((item, i) => formatCase(item, "pass", i)).join("\n\n");
  const historyBlock =
    pack.history.length === 0
      ? "(none yet)"
      : pack.history
          .map((entry) => {
            const val = entry.val === undefined ? "" : ` val=${fmt(entry.val)}`;
            return `- round ${entry.round}: "${entry.hypothesis}" train=${fmt(entry.train)}${val} adopted=${entry.adopted ? "yes" : "no"}`;
          })
          .join("\n");
  const hypotheses =
    pack.hypotheses.length === 0 ? "(none yet)" : pack.hypotheses.map((h) => `- ${h}`).join("\n");

  const intro =
    options.rewriteMode === "patch"
      ? `Propose up to ${candidateBudget} patch candidates as JSON (edits or unified diff). Do not rewrite the entire prompt; patch only what the failures implicate.`
      : `Propose up to ${candidateBudget} full-prompt candidates as JSON.`;
  const sectionBlock =
    options.sections && options.sections.length > 0
      ? `\n\n## Section map\n${formatSectionMap(options.sections)}`
      : "";

  return `${intro}

## Current system prompt
<system_prompt>
${pack.currentPrompt}
</system_prompt>${sectionBlock}

## Train scores
mean quality: ${fmt(pack.trainMean)}${valLine}

## Failures (train / search set)
${failBlock}

## Successes (train / search set)
${passBlock}

## Search history
${historyBlock}

## Hypotheses already tried
${hypotheses}`;
}
