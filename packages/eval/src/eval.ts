import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ChatCompletionResult, LlmConfig } from "@sysprompt-lab/llm";
import {
  chatCompletion,
  imageFileToDataUrl,
  type ChatMessageContent,
  type FetchFn,
} from "@sysprompt-lab/llm";
import type { EvalCase, EvalSuite, Metric, Score, SplitName } from "@sysprompt-lab/core";
import { scoreNsfwSeverityTag } from "./nsfw.js";

export const DEFAULT_IMAGE_USER_TEXT = "请分析这张照片，并按系统要求仅返回 JSON。";
export const IMAGE_DIR_ENV = "SYSPROMPT_IMAGE_DIR";

export function caseHasImage(input: Record<string, unknown>): boolean {
  return caseImageRef(input) !== undefined;
}

export function caseImageRef(input: Record<string, unknown>): string | undefined {
  for (const key of ["image", "image_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function caseUserText(input: Record<string, unknown>): string {
  for (const key of ["user", "message", "query", "text", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  if (caseHasImage(input)) {
    return DEFAULT_IMAGE_USER_TEXT;
  }
  return JSON.stringify(input);
}

export function goldText(gold: unknown): string {
  if (typeof gold === "string") {
    return gold;
  }
  return JSON.stringify(gold);
}

export interface ImageResolveOptions {
  /** Preferred image root (CLI / card.source / SYSPROMPT_IMAGE_DIR). */
  imageDir?: string;
  /** Directory of the suite file; `input.image` may be relative to it. */
  suiteDir?: string;
}

/**
 * Resolve `input.image` / `input.image_path` against SYSPROMPT_IMAGE_DIR,
 * an explicit imageDir, the suite file directory, then cwd.
 */
export function resolveImagePath(ref: string, options: ImageResolveOptions = {}): string {
  if (isAbsolute(ref) && existsSync(ref)) {
    return ref;
  }
  const envDir = process.env[IMAGE_DIR_ENV]?.trim();
  const roots = [options.imageDir, envDir, options.suiteDir, process.cwd()].filter(
    (dir): dir is string => Boolean(dir),
  );
  const tried: string[] = [];
  for (const root of roots) {
    const resolvedRoot = isAbsolute(root) ? root : resolve(process.cwd(), root);
    for (const candidate of [
      join(resolvedRoot, ref),
      join(resolvedRoot, basename(ref)),
      join(resolvedRoot, "images", basename(ref)),
    ]) {
      tried.push(candidate);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  if (isAbsolute(ref)) {
    tried.unshift(ref);
  }
  throw new Error(
    `Image not found: ${ref}. Copy the file next to the suite or set ${IMAGE_DIR_ENV}. Tried: ${tried.join(", ")}`,
  );
}

function imageUrlForRef(ref: string, options: ImageResolveOptions): string {
  if (ref.startsWith("data:") || /^https?:\/\//i.test(ref)) {
    return ref;
  }
  return imageFileToDataUrl(resolveImagePath(ref, options));
}

/** Build OpenAI-compatible user content (text, or text + image_url). */
export function caseUserContent(
  input: Record<string, unknown>,
  options: ImageResolveOptions = {},
): ChatMessageContent {
  const text = caseUserText(input);
  const imageRef = caseImageRef(input);
  if (!imageRef) {
    return text;
  }
  return [
    { type: "text", text },
    { type: "image_url", image_url: { url: imageUrlForRef(imageRef, options) } },
  ];
}

export function scoreCase(
  metric: Metric,
  output: string,
  gold: unknown,
): { quality: number; note?: string } {
  if (metric.kind === "llm_judge") {
    throw new Error(
      `Metric "${metric.id}" kind llm_judge is not implemented yet. Use exact or custom (string-contains).`,
    );
  }
  if (gold === undefined || gold === null) {
    return { quality: 0, note: "no gold" };
  }
  if (metric.kind === "custom" && metric.id === "nsfw_severity_tag") {
    return scoreNsfwSeverityTag(output, gold);
  }
  const expected = goldText(gold);
  if (metric.kind === "exact") {
    return { quality: output.trim() === expected.trim() ? 1 : 0 };
  }
  // custom: Phase 0/1 string-contains (case-insensitive), as used by support-bot
  return { quality: output.toLowerCase().includes(expected.toLowerCase()) ? 1 : 0 };
}

export function casesForSplit(suite: EvalSuite, name: SplitName): EvalCase[] {
  const split = suite.splits[name];
  if (!split || split.case_ids.length === 0) {
    return [];
  }
  const byId = new Map(suite.cases.map((c) => [c.id, c]));
  return split.case_ids.map((id) => {
    const found = byId.get(id);
    if (!found) {
      throw new Error(`Split "${name}" references unknown case "${id}"`);
    }
    return found;
  });
}

export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

export interface CaseEvalResult {
  evalCase: EvalCase;
  /** Visible student output. This is what the metric scores. */
  output: string;
  quality: number;
  note?: string;
  latency_ms: number;
  /** Model chain-of-thought, if the API returned it. Never scored. */
  reasoning?: string;
  finish_reason?: string;
  reasoning_tokens?: number;
}

export interface SplitEval {
  split: SplitName;
  scores: Score[];
  meanQuality: number;
  meanLatency: number;
  cases: CaseEvalResult[];
}

export interface EvaluatePromptOptions {
  config: LlmConfig;
  systemPrompt: string;
  versionId: string;
  suite: EvalSuite;
  split: SplitName;
  fetch?: FetchFn;
  /** Student sampling. Defaults: suite.temperature ?? 0; suite.max_tokens if set. */
  temperature?: number;
  max_tokens?: number;
  imageDir?: string;
  suiteDir?: string;
}

export function resolveEvalSampling(
  suite: EvalSuite,
  overrides: { temperature?: number; max_tokens?: number } = {},
): { temperature: number; max_tokens?: number } {
  const temperature = overrides.temperature ?? suite.temperature ?? 0;
  const raw = overrides.max_tokens ?? suite.max_tokens;
  return {
    temperature,
    max_tokens: raw !== undefined && raw > 0 ? raw : undefined,
  };
}

/** Diagnostic extras from a student completion. Omitted when the API did not send them. */
export function completionDiagnostics(result: ChatCompletionResult): {
  reasoning?: string;
  finish_reason?: string;
  reasoning_tokens?: number;
} {
  const extras: {
    reasoning?: string;
    finish_reason?: string;
    reasoning_tokens?: number;
  } = {};
  if (result.reasoning) {
    extras.reasoning = result.reasoning;
  }
  if (result.finish_reason) {
    extras.finish_reason = result.finish_reason;
  }
  if (typeof result.reasoning_tokens === "number") {
    extras.reasoning_tokens = result.reasoning_tokens;
  }
  return extras;
}

export async function evaluatePrompt(options: EvaluatePromptOptions): Promise<SplitEval> {
  const cases = casesForSplit(options.suite, options.split);
  const sampling = resolveEvalSampling(options.suite, {
    temperature: options.temperature,
    max_tokens: options.max_tokens,
  });
  const imageOpts: ImageResolveOptions = {
    imageDir: options.imageDir,
    suiteDir: options.suiteDir,
  };
  const scores: Score[] = [];
  const caseResults: CaseEvalResult[] = [];
  for (const evalCase of cases) {
    const result = await chatCompletion(
      options.config,
      [
        { role: "system", content: options.systemPrompt },
        { role: "user", content: caseUserContent(evalCase.input, imageOpts) },
      ],
      { temperature: sampling.temperature, max_tokens: sampling.max_tokens, fetch: options.fetch },
    );
    const { quality, note } = scoreCase(options.suite.metric, result.content, evalCase.gold);
    const diagnostics = completionDiagnostics(result);
    scores.push({
      quality,
      latency_ms: result.latency_ms,
      split: options.split,
      model_id: options.config.model,
      metric_id: options.suite.metric.id,
      version_id: options.versionId,
      case_id: evalCase.id,
      output: result.content,
      ...diagnostics,
    });
    caseResults.push({
      evalCase,
      output: result.content,
      quality,
      note,
      latency_ms: result.latency_ms,
      ...diagnostics,
    });
  }
  return {
    split: options.split,
    scores,
    meanQuality: mean(scores.map((s) => s.quality)),
    meanLatency: mean(scores.map((s) => s.latency_ms ?? 0)),
    cases: caseResults,
  };
}

export function aggregateScore(evalResult: SplitEval, versionId: string, modelId: string, metricId: string): Score {
  return {
    quality: evalResult.meanQuality,
    latency_ms: evalResult.scores.length === 0 ? undefined : evalResult.meanLatency,
    split: evalResult.split,
    model_id: modelId,
    metric_id: metricId,
    version_id: versionId,
  };
}

export interface ScoreRow {
  split: SplitName;
  baselineQuality: number;
  candidateQuality: number;
  baselineLatency?: number;
  candidateLatency?: number;
}

export function formatScoreTable(rows: ScoreRow[]): string {
  const q = (n: number) => n.toFixed(3);
  const lines = ["split   baseline  candidate  delta"];
  for (const row of rows) {
    const delta = row.candidateQuality - row.baselineQuality;
    const sign = delta > 0 ? "+" : "";
    lines.push(
      `${row.split.padEnd(7)} ${q(row.baselineQuality)}    ${q(row.candidateQuality)}     ${sign}${q(delta)}`,
    );
  }
  if (rows.some((row) => row.baselineLatency !== undefined || row.candidateLatency !== undefined)) {
    lines.push("");
    lines.push("split   baseline_ms  candidate_ms");
    for (const row of rows) {
      const b = row.baselineLatency === undefined ? "—" : String(Math.round(row.baselineLatency));
      const c = row.candidateLatency === undefined ? "—" : String(Math.round(row.candidateLatency));
      lines.push(`${row.split.padEnd(7)} ${b.padEnd(12)} ${c}`);
    }
  }
  return lines.join("\n");
}
