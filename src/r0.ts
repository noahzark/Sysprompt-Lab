import { unifiedPromptDiff } from "./diff.js";
import { formatScoreTable, evaluatePrompt, aggregateScore, casesForSplit, type ScoreRow } from "./eval.js";
import { formatLlmTarget, getLlmConfig, readLlmConfig, type LlmConfig } from "./env.js";
import { type FetchFn, normalizeLlmApiBase } from "./llm.js";
import { promotionDecision } from "./promote.js";
import { rewriteSystemPrompt } from "./rewrite.js";
import {
  type Candidate,
  type PromptCard,
  type PromptVersion,
  type Run,
  type Score,
  baselineVersion,
} from "./schemas.js";
import {
  type Workspace,
  loadCard,
  loadSuite,
  newId,
  openWorkspace,
  writeCard,
  writeRun,
} from "./workspace.js";

export interface RunR0Options {
  root?: string;
  dryRun?: boolean;
  noEval?: boolean;
  fetch?: FetchFn;
}

export interface RunR0Result {
  card: PromptCard;
  run: Run;
  candidate: Candidate;
  version: PromptVersion;
  diffPath: string;
  scoresPath?: string;
  scores: Score[];
  promoted: boolean;
  dryRun: boolean;
  table?: string;
  message: string;
  llmTarget?: string;
}

function llmTargetLine(config: LlmConfig): string {
  return formatLlmTarget({ ...config, apiBase: normalizeLlmApiBase(config.apiBase) });
}

function markPromoted(card: PromptCard, versionId: string): void {
  for (const version of card.versions) {
    version.promoted = version.id === versionId;
  }
  card.status = "promoted";
}

export async function runR0(cardRef: string, options: RunR0Options = {}): Promise<RunR0Result> {
  const ws = openWorkspace(options.root);
  const card = loadCard(ws, cardRef);
  const baseline = baselineVersion(card);

  if (options.dryRun) {
    return runDryStub(ws, card, baseline);
  }

  const config = getLlmConfig();
  const llmTarget = llmTargetLine(config);
  if (!options.noEval && !card.suite_id) {
    throw new Error(
      `Card "${card.id}" has no bound suite. Bind a suite before run --rung R0, or pass --no-eval / --dry-run.`,
    );
  }
  const rewritten = await rewriteSystemPrompt(config, baseline.system_prompt, {
    tools: card.tools,
    fetch: options.fetch,
  });

  const version: PromptVersion = {
    id: newId("ver"),
    system_prompt: rewritten.system_prompt,
    hypothesis: rewritten.hypothesis,
    is_baseline: false,
    promoted: false,
    parent: baseline.id,
  };
  const candidate: Candidate = {
    id: newId("cand"),
    round: 0,
    pass_streak: 0,
    status: options.noEval ? "rewritten" : "evaluated",
    version_id: version.id,
  };
  const run: Run = {
    id: newId("run"),
    card_id: card.id,
    rung: "R0",
    status: "completed",
  };
  card.versions.push(version);
  card.rung = "R0";
  card.status = "optimizing";
  if (!card.models.some((m) => m.id === config.model)) {
    card.models.push({ id: config.model, provider: "openai-compatible", name: config.model });
  }
  writeCard(ws, card);

  const diff = unifiedPromptDiff(baseline.system_prompt, version.system_prompt);

  if (options.noEval) {
    const written = writeRun(ws, run, [candidate], { diff });
    if (!written.diffPath) {
      throw new Error("R0 failed to write a unified diff");
    }
    return {
      card,
      run,
      candidate,
      version,
      diffPath: written.diffPath,
      scores: [],
      promoted: false,
      dryRun: false,
      message: "Rewrite only (--no-eval); skipped before/after eval and auto-promote.",
      llmTarget,
    };
  }

  const suite = loadSuite(ws, card.suite_id!);
  const splits = (["train", "val"] as const).filter((name) => casesForSplit(suite, name).length > 0);
  const scores: Score[] = [];
  const rows: ScoreRow[] = [];
  let valBaseline: number | undefined;
  let valCandidate: number | undefined;

  for (const split of splits) {
    const baselineEval = await evaluatePrompt({
      config,
      systemPrompt: baseline.system_prompt,
      versionId: baseline.id,
      suite,
      split,
      fetch: options.fetch,
    });
    const candidateEval = await evaluatePrompt({
      config,
      systemPrompt: version.system_prompt,
      versionId: version.id,
      suite,
      split,
      fetch: options.fetch,
    });
    scores.push(
      ...baselineEval.scores,
      aggregateScore(baselineEval, baseline.id, config.model, suite.metric.id),
      ...candidateEval.scores,
      aggregateScore(candidateEval, version.id, config.model, suite.metric.id),
    );
    rows.push({
      split,
      baselineQuality: baselineEval.meanQuality,
      candidateQuality: candidateEval.meanQuality,
      baselineLatency: baselineEval.scores.length === 0 ? undefined : baselineEval.meanLatency,
      candidateLatency: candidateEval.scores.length === 0 ? undefined : candidateEval.meanLatency,
    });
    if (split === "val") {
      valBaseline = baselineEval.meanQuality;
      valCandidate = candidateEval.meanQuality;
    }
  }

  const hasVal = casesForSplit(suite, "val").length > 0;
  const decision = promotionDecision({ hasVal, valBaseline, valCandidate });
  if (decision.promote) {
    markPromoted(card, version.id);
    candidate.status = "promoted";
  } else {
    card.status = "verifying";
    candidate.status = "evaluated";
  }
  writeCard(ws, card);

  const written = writeRun(ws, run, [candidate], { diff, scores });
  if (!written.diffPath) {
    throw new Error("R0 failed to write a unified diff");
  }

  return {
    card,
    run,
    candidate,
    version,
    diffPath: written.diffPath,
    scoresPath: written.scoresPath,
    scores,
    promoted: decision.promote,
    dryRun: false,
    table: rows.length > 0 ? formatScoreTable(rows) : undefined,
    message: decision.message,
    llmTarget,
  };
}

function runDryStub(ws: Workspace, card: PromptCard, baseline: PromptVersion): RunR0Result {
  const version: PromptVersion = {
    id: newId("ver"),
    system_prompt: baseline.system_prompt,
    hypothesis: "stub",
    is_baseline: false,
    promoted: false,
    parent: baseline.id,
  };
  const candidate: Candidate = {
    id: newId("cand"),
    round: 0,
    pass_streak: 0,
    status: "stub",
    version_id: version.id,
  };
  const run: Run = {
    id: newId("run"),
    card_id: card.id,
    rung: "R0",
    status: "completed",
  };
  card.versions.push(version);
  card.rung = "R0";
  card.status = "optimizing";
  writeCard(ws, card);
  const diff = unifiedPromptDiff(baseline.system_prompt, version.system_prompt);
  const written = writeRun(ws, run, [candidate], { diff });
  if (!written.diffPath) {
    throw new Error("R0 stub failed to write a unified diff");
  }
  const llm = readLlmConfig();
  return {
    card,
    run,
    candidate,
    version,
    diffPath: written.diffPath,
    scores: [],
    promoted: false,
    dryRun: true,
    message: "R0 dry-run stub (no LLM calls).",
    llmTarget: llm ? llmTargetLine(llm) : undefined,
  };
}
