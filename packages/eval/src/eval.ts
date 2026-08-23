import type { LlmConfig } from "@sysprompt-lab/llm";
import { chatCompletion, type FetchFn } from "@sysprompt-lab/llm";
import type { EvalCase, EvalSuite, Metric, Score, SplitName } from "@sysprompt-lab/core";

export function caseUserText(input: Record<string, unknown>): string {
  for (const key of ["user", "message", "query", "text", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return JSON.stringify(input);
}

export function goldText(gold: unknown): string {
  if (typeof gold === "string") {
    return gold;
  }
  return JSON.stringify(gold);
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
  output: string;
  quality: number;
  note?: string;
  latency_ms: number;
}

export interface SplitEval {
  split: SplitName;
  scores: Score[];
  meanQuality: number;
  meanLatency: number;
  cases: CaseEvalResult[];
}

export async function evaluatePrompt(options: {
  config: LlmConfig;
  systemPrompt: string;
  versionId: string;
  suite: EvalSuite;
  split: SplitName;
  fetch?: FetchFn;
}): Promise<SplitEval> {
  const cases = casesForSplit(options.suite, options.split);
  const scores: Score[] = [];
  const caseResults: CaseEvalResult[] = [];
  for (const evalCase of cases) {
    const result = await chatCompletion(
      options.config,
      [
        { role: "system", content: options.systemPrompt },
        { role: "user", content: caseUserText(evalCase.input) },
      ],
      { temperature: 0, fetch: options.fetch },
    );
    const { quality, note } = scoreCase(options.suite.metric, result.content, evalCase.gold);
    scores.push({
      quality,
      latency_ms: result.latency_ms,
      split: options.split,
      model_id: options.config.model,
      metric_id: options.suite.metric.id,
      version_id: options.versionId,
      case_id: evalCase.id,
    });
    caseResults.push({
      evalCase,
      output: result.content,
      quality,
      note,
      latency_ms: result.latency_ms,
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
