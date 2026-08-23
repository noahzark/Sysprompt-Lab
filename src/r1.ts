import { unifiedPromptDiff } from "./diff.js";
import {
  aggregateScore,
  casesForSplit,
  evaluatePrompt,
  formatScoreTable,
  type ScoreRow,
  type SplitEval,
} from "./eval.js";
import { formatLlmTarget, getLlmConfig, readLlmConfig, type LlmConfig } from "./env.js";
import { type FetchFn, normalizeLlmApiBase } from "./llm.js";
import {
  type EffectiveRewriteMode,
  type RewriteMode,
  parseRewriteMode,
  resolveAllowFullRewrite,
  resolveEffectiveRewriteMode,
  resolveMaxPatchRatio,
  resolvePatchThreshold,
  sectionMapArtifact,
  splitSections,
} from "./patch.js";
import { adoptDecision, r1PromotionDecision } from "./promote.js";
import {
  type EvidencePack,
  type SearchHistoryEntry,
  formatEvidence,
  selectEvidenceCases,
} from "./r1-evidence.js";
import {
  type R1Proposal,
  dedupeProposals,
  dryRunProposals,
  promptKey,
  proposeR1Candidates,
} from "./r1-rewrite.js";
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

const R1_ENV = {
  rounds: "SYSPROMPT_R1_ROUNDS",
  candidates: "SYSPROMPT_R1_CANDIDATES",
  passStreak: "SYSPROMPT_R1_PASS_STREAK",
  budget: "SYSPROMPT_R1_BUDGET",
} as const;

export interface R1LoopConfig {
  rounds: number;
  candidates: number;
  passStreak: number;
  budget: number;
}

export interface RunR1Options {
  root?: string;
  dryRun?: boolean;
  noEval?: boolean;
  fetch?: FetchFn;
  rounds?: number;
  candidates?: number;
  passStreak?: number;
  budget?: number;
  rewriteMode?: RewriteMode;
  maxPatchRatio?: number;
  allowFullRewrite?: boolean;
}

export interface R1TriedCandidate {
  id: string;
  round: number;
  pass_streak: number;
  status: string;
  version_id: string;
  parent_candidate_id?: string;
  hypothesis: string;
  prompt: string;
  train_quality?: number;
  val_quality?: number;
  patch?: R1Proposal["patch"];
}

export interface RunR1Result {
  card: PromptCard;
  run: Run;
  candidates: Candidate[];
  version: PromptVersion;
  diffPath: string;
  scoresPath?: string;
  candidatesJsonlPath?: string;
  summaryPath?: string;
  scores: Score[];
  promoted: boolean;
  dryRun: boolean;
  table?: string;
  message: string;
  llmTarget?: string;
  roundsRan: number;
  adoptedCount: number;
  config: R1LoopConfig;
  rewriteMode?: EffectiveRewriteMode;
  sectionsPath?: string;
}

function envInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

function asPositiveInt(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got "${value}"`);
  }
  return value;
}

/** Flag > env > default. Budget defaults to rounds × candidates. */
export function resolveR1Config(options: {
  rounds?: number;
  candidates?: number;
  passStreak?: number;
  budget?: number;
} = {}): R1LoopConfig {
  const rounds = asPositiveInt(options.rounds, "--rounds") ?? envInt(R1_ENV.rounds) ?? 3;
  const candidates = asPositiveInt(options.candidates, "--candidates") ?? envInt(R1_ENV.candidates) ?? 3;
  const passStreak = asPositiveInt(options.passStreak, "--pass-streak") ?? envInt(R1_ENV.passStreak) ?? 1;
  const budget =
    asPositiveInt(options.budget, "--budget") ?? envInt(R1_ENV.budget) ?? rounds * candidates;
  return { rounds, candidates, passStreak, budget };
}

function llmTargetLine(config: LlmConfig): string {
  return formatLlmTarget({ ...config, apiBase: normalizeLlmApiBase(config.apiBase) });
}

function rewriteSettings(prompt: string, options: RunR1Options) {
  const requested = options.rewriteMode ?? parseRewriteMode(process.env.SYSPROMPT_REWRITE_MODE);
  const effective = resolveEffectiveRewriteMode(requested, prompt, resolvePatchThreshold());
  return {
    requested,
    effective,
    maxPatchRatio: resolveMaxPatchRatio(options.maxPatchRatio, "R1"),
    allowFullRewrite: resolveAllowFullRewrite(options.allowFullRewrite, "R1", effective),
    sections: splitSections(prompt),
  };
}

function markPromoted(card: PromptCard, versionId: string): void {
  for (const version of card.versions) {
    version.promoted = version.id === versionId;
  }
  card.status = "promoted";
}

function assertR1Ready(card: PromptCard): void {
  if (!card.suite_id || card.status === "draft") {
    throw new Error(
      `Card "${card.id}" must be bound to a suite before run --rung R1. Run: sysprompt bind ${card.id} <suite.yaml>`,
    );
  }
}

function pushModel(card: PromptCard, model: string): void {
  if (!card.models.some((item) => item.id === model)) {
    card.models.push({ id: model, provider: "openai-compatible", name: model });
  }
}

function collectScores(evalResult: SplitEval, versionId: string, modelId: string, metricId: string): Score[] {
  return [...evalResult.scores, aggregateScore(evalResult, versionId, modelId, metricId)];
}

function buildSummary(input: {
  runId: string;
  cardId: string;
  config: R1LoopConfig;
  roundsRan: number;
  tried: R1TriedCandidate[];
  adoptedCount: number;
  passStreak: number;
  promoted: boolean;
  message: string;
  table?: string;
  stopReason: string;
}): string {
  const lines = [
    `# R1 ${input.runId}`,
    "",
    `- Card: ${input.cardId}`,
    `- Rounds: ${input.roundsRan} / ${input.config.rounds}`,
    `- Candidates / round: ${input.config.candidates}`,
    `- Budget: ${input.config.budget}`,
    `- Pass-streak: ${input.passStreak} / ${input.config.passStreak}`,
    `- Tried: ${input.tried.length}`,
    `- Adopted: ${input.adoptedCount}`,
    `- Promoted: ${input.promoted ? "yes" : "no"}`,
    `- Stop: ${input.stopReason}`,
    "",
    "## Decision",
    "",
    input.message,
  ];
  if (input.table) {
    lines.push("", "## Scores", "", "```", input.table, "```");
  }
  return `${lines.join("\n")}\n`;
}

export async function runR1(cardRef: string, options: RunR1Options = {}): Promise<RunR1Result> {
  const ws = openWorkspace(options.root);
  const card = loadCard(ws, cardRef);
  assertR1Ready(card);
  const config = resolveR1Config(options);
  const baseline = baselineVersion(card);
  const suite = loadSuite(ws, card.suite_id!);
  const hasVal = casesForSplit(suite, "val").length > 0;
  const hasTrain = casesForSplit(suite, "train").length > 0;
  if (!hasTrain) {
    throw new Error(`Suite "${suite.id}" has no train cases; R1 uses train for search.`);
  }

  if (options.dryRun) {
    return runDryR1(ws, card, baseline, config, options);
  }

  const llm = getLlmConfig();
  const llmTarget = llmTargetLine(llm);

  if (options.noEval) {
    return runNoEvalR1(ws, card, baseline, config, llm, llmTarget, options);
  }

  return runEvalLoop(ws, card, baseline, suite, config, llm, llmTarget, hasVal, options);
}

async function runNoEvalR1(
  ws: Workspace,
  card: PromptCard,
  baseline: PromptVersion,
  config: R1LoopConfig,
  llm: LlmConfig,
  llmTarget: string,
  options: RunR1Options,
): Promise<RunR1Result> {
  const settings = rewriteSettings(baseline.system_prompt, options);
  const pack: EvidencePack = {
    currentPrompt: baseline.system_prompt,
    trainMean: 0,
    failures: [],
    successes: [],
    history: [],
    hypotheses: [],
  };
  const proposals = dedupeProposals(
    await proposeR1Candidates(
      llm,
      formatEvidence(pack, config.candidates, {
        rewriteMode: settings.effective,
        sections: settings.sections,
      }),
      {
        tools: card.tools,
        fetch: options.fetch,
        currentPrompt: baseline.system_prompt,
        rewriteMode: settings.effective,
        maxPatchRatio: settings.maxPatchRatio,
        allowFullRewrite: settings.allowFullRewrite,
      },
    ),
    baseline.system_prompt,
    [],
    config.candidates,
  );

  const run: Run = {
    id: newId("run"),
    card_id: card.id,
    rung: "R1",
    status: "completed",
    budget: config.budget,
  };
  const candidates: Candidate[] = [];
  const tried: R1TriedCandidate[] = [];
  let lastVersion = baseline;
  card.rung = "R1";
  card.status = "optimizing";
  pushModel(card, llm.model);

  for (const proposal of proposals) {
    const version: PromptVersion = {
      id: newId("ver"),
      system_prompt: proposal.prompt,
      hypothesis: proposal.hypothesis,
      is_baseline: false,
      promoted: false,
      parent: baseline.id,
    };
    const candidate: Candidate = {
      id: newId("cand"),
      round: 1,
      pass_streak: 0,
      status: "rewritten",
      version_id: version.id,
    };
    card.versions.push(version);
    candidates.push(candidate);
    tried.push({
      id: candidate.id,
      round: 1,
      pass_streak: 0,
      status: "rewritten",
      version_id: version.id,
      hypothesis: proposal.hypothesis,
      prompt: proposal.prompt,
      patch: proposal.patch,
    });
    lastVersion = version;
  }
  writeCard(ws, card);

  const best = lastVersion.id === baseline.id ? baseline : lastVersion;
  const diff = unifiedPromptDiff(baseline.system_prompt, best.system_prompt);
  const message = "Rewrite only (--no-eval); skipped eval loop and auto-promote.";
  const written = writeRun(ws, run, candidates, {
    diff,
    diffName: "r1.diff",
    candidatesJsonl: tried,
    sections: sectionMapArtifact({
      sections: settings.sections,
      rewriteMode: settings.requested,
      effectiveMode: settings.effective,
      maxPatchRatio: settings.maxPatchRatio,
      allowFullRewrite: settings.allowFullRewrite,
      usedFallback: false,
      sourceChars: baseline.system_prompt.length,
    }),
    summary: buildSummary({
      runId: run.id,
      cardId: card.id,
      config,
      roundsRan: proposals.length > 0 ? 1 : 0,
      tried,
      adoptedCount: 0,
      passStreak: 0,
      promoted: false,
      message,
      stopReason: "no-eval",
    }),
  });

  return {
    card,
    run,
    candidates,
    version: best,
    diffPath: written.diffPath!,
    candidatesJsonlPath: written.candidatesJsonlPath,
    summaryPath: written.summaryPath,
    scores: [],
    promoted: false,
    dryRun: false,
    message,
    llmTarget,
    roundsRan: proposals.length > 0 ? 1 : 0,
    adoptedCount: 0,
    config,
    rewriteMode: settings.effective,
    sectionsPath: written.sectionsPath,
  };
}

function runDryR1(
  ws: Workspace,
  card: PromptCard,
  baseline: PromptVersion,
  config: R1LoopConfig,
  options: RunR1Options,
): RunR1Result {
  const run: Run = {
    id: newId("run"),
    card_id: card.id,
    rung: "R1",
    status: "completed",
    budget: config.budget,
  };
  const candidates: Candidate[] = [];
  const tried: R1TriedCandidate[] = [];
  let lastVersion = baseline;
  card.rung = "R1";
  card.status = "optimizing";

  const rounds = Math.min(config.rounds, Math.ceil(config.budget / config.candidates) || 1);
  for (let round = 1; round <= rounds; round += 1) {
    const remaining = config.budget - tried.length;
    if (remaining <= 0) {
      break;
    }
    const proposals = dryRunProposals(
      lastVersion.system_prompt,
      Math.min(config.candidates, remaining),
      round,
    );
    for (const proposal of proposals) {
      const version: PromptVersion = {
        id: newId("ver"),
        system_prompt: proposal.prompt,
        hypothesis: proposal.hypothesis,
        is_baseline: false,
        promoted: false,
        parent: lastVersion.id,
      };
      const candidate: Candidate = {
        id: newId("cand"),
        round,
        pass_streak: 0,
        status: "stub",
        version_id: version.id,
      };
      card.versions.push(version);
      candidates.push(candidate);
      tried.push({
        id: candidate.id,
        round,
        pass_streak: 0,
        status: "stub",
        version_id: version.id,
        hypothesis: proposal.hypothesis,
        prompt: proposal.prompt,
        patch: proposal.patch,
      });
      lastVersion = version;
    }
  }
  writeCard(ws, card);

  const best = lastVersion.id === baseline.id ? baseline : lastVersion;
  const diff = unifiedPromptDiff(baseline.system_prompt, best.system_prompt);
  const llm = readLlmConfig();
  const message = "R1 dry-run stub (fake candidates, no LLM calls).";
  const settings = rewriteSettings(baseline.system_prompt, options);
  const written = writeRun(ws, run, candidates, {
    diff,
    diffName: "r1.diff",
    candidatesJsonl: tried,
    sections: sectionMapArtifact({
      sections: settings.sections,
      rewriteMode: settings.requested,
      effectiveMode: settings.effective,
      maxPatchRatio: settings.maxPatchRatio,
      allowFullRewrite: settings.allowFullRewrite,
      usedFallback: false,
      sourceChars: baseline.system_prompt.length,
    }),
    summary: buildSummary({
      runId: run.id,
      cardId: card.id,
      config,
      roundsRan: rounds,
      tried,
      adoptedCount: 0,
      passStreak: 0,
      promoted: false,
      message,
      stopReason: "dry-run",
    }),
  });

  return {
    card,
    run,
    candidates,
    version: best,
    diffPath: written.diffPath!,
    candidatesJsonlPath: written.candidatesJsonlPath,
    summaryPath: written.summaryPath,
    scores: [],
    promoted: false,
    dryRun: true,
    message,
    llmTarget: llm ? llmTargetLine(llm) : undefined,
    roundsRan: rounds,
    adoptedCount: 0,
    config,
    rewriteMode: settings.effective,
    sectionsPath: written.sectionsPath,
  };
}

async function runEvalLoop(
  ws: Workspace,
  card: PromptCard,
  baseline: PromptVersion,
  suite: ReturnType<typeof loadSuite>,
  config: R1LoopConfig,
  llm: LlmConfig,
  llmTarget: string,
  hasVal: boolean,
  options: RunR1Options,
): Promise<RunR1Result> {
  const run: Run = {
    id: newId("run"),
    card_id: card.id,
    rung: "R1",
    status: "completed",
    budget: config.budget,
  };
  card.rung = "R1";
  card.status = "optimizing";
  pushModel(card, llm.model);
  writeCard(ws, card);

  const scores: Score[] = [];
  const candidates: Candidate[] = [];
  const tried: R1TriedCandidate[] = [];
  const seenPrompts = new Set<string>([promptKey(baseline.system_prompt)]);
  const history: SearchHistoryEntry[] = [];
  const hypotheses: string[] = [];
  const fetch = options.fetch;
  const seedSettings = rewriteSettings(baseline.system_prompt, options);

  const baselineTrain = await evaluatePrompt({
    config: llm,
    systemPrompt: baseline.system_prompt,
    versionId: baseline.id,
    suite,
    split: "train",
    fetch,
  });
  scores.push(...collectScores(baselineTrain, baseline.id, llm.model, suite.metric.id));
  let baselineVal: SplitEval | undefined;
  if (hasVal) {
    baselineVal = await evaluatePrompt({
      config: llm,
      systemPrompt: baseline.system_prompt,
      versionId: baseline.id,
      suite,
      split: "val",
      fetch,
    });
    scores.push(...collectScores(baselineVal, baseline.id, llm.model, suite.metric.id));
  }

  let currentVersion = baseline;
  let currentTrain = baselineTrain;
  let currentVal = baselineVal;
  let currentCandidateId: string | undefined;
  let passStreak = 0;
  let adoptedCount = 0;
  let roundsRan = 0;
  let stopReason = "rounds";
  let evalsUsed = 0;

  for (let round = 1; round <= config.rounds; round += 1) {
    if (evalsUsed >= config.budget) {
      stopReason = "budget";
      break;
    }

    const trainEvidence = selectEvidenceCases(currentTrain.cases);
    const settings = rewriteSettings(currentVersion.system_prompt, options);
    const evidence = formatEvidence(
      {
        currentPrompt: currentVersion.system_prompt,
        trainMean: currentTrain.meanQuality,
        valMean: currentVal?.meanQuality,
        failures: trainEvidence.failures,
        successes: trainEvidence.successes,
        history,
        hypotheses,
      },
      config.candidates,
      { rewriteMode: settings.effective, sections: settings.sections },
    );

    const raw = await proposeR1Candidates(llm, evidence, {
      tools: card.tools,
      fetch,
      currentPrompt: currentVersion.system_prompt,
      rewriteMode: settings.effective,
      maxPatchRatio: settings.maxPatchRatio,
      allowFullRewrite: settings.allowFullRewrite,
    });
    const remaining = config.budget - evalsUsed;
    const proposals = dedupeProposals(raw, currentVersion.system_prompt, seenPrompts, Math.min(config.candidates, remaining));
    if (proposals.length === 0) {
      stopReason = "no-new-candidates";
      break;
    }

    roundsRan = round;
    const roundTried: Array<{
      proposal: R1Proposal;
      version: PromptVersion;
      candidate: Candidate;
      train: SplitEval;
      val?: SplitEval;
      record: R1TriedCandidate;
    }> = [];

    for (const proposal of proposals) {
      const version: PromptVersion = {
        id: newId("ver"),
        system_prompt: proposal.prompt,
        hypothesis: proposal.hypothesis,
        is_baseline: false,
        promoted: false,
        parent: currentVersion.id,
      };
      const candidate: Candidate = {
        id: newId("cand"),
        round,
        pass_streak: passStreak,
        status: "evaluated",
        version_id: version.id,
        parent_candidate_id: currentCandidateId,
      };
      card.versions.push(version);
      candidates.push(candidate);
      seenPrompts.add(promptKey(proposal.prompt));
      hypotheses.push(proposal.hypothesis);

      const train = await evaluatePrompt({
        config: llm,
        systemPrompt: proposal.prompt,
        versionId: version.id,
        suite,
        split: "train",
        fetch,
      });
      evalsUsed += 1;
      scores.push(...collectScores(train, version.id, llm.model, suite.metric.id));
      let val: SplitEval | undefined;
      if (hasVal) {
        val = await evaluatePrompt({
          config: llm,
          systemPrompt: proposal.prompt,
          versionId: version.id,
          suite,
          split: "val",
          fetch,
        });
        scores.push(...collectScores(val, version.id, llm.model, suite.metric.id));
      }

      const record: R1TriedCandidate = {
        id: candidate.id,
        round,
        pass_streak: passStreak,
        status: "evaluated",
        version_id: version.id,
        parent_candidate_id: candidate.parent_candidate_id,
        hypothesis: proposal.hypothesis,
        prompt: proposal.prompt,
        train_quality: train.meanQuality,
        val_quality: val?.meanQuality,
        patch: proposal.patch,
      };
      tried.push(record);
      roundTried.push({ proposal, version, candidate, train, val, record });
    }

    let best = roundTried[0]!;
    for (const item of roundTried.slice(1)) {
      const better = adoptDecision({
        hasVal,
        currentVal: best.val?.meanQuality,
        candidateVal: item.val?.meanQuality,
        currentTrain: best.train.meanQuality,
        candidateTrain: item.train.meanQuality,
      });
      if (better.adopt) {
        best = item;
      }
    }

    const vsCurrent = adoptDecision({
      hasVal,
      currentVal: currentVal?.meanQuality,
      candidateVal: best.val?.meanQuality,
      currentTrain: currentTrain.meanQuality,
      candidateTrain: best.train.meanQuality,
    });

    if (vsCurrent.adopt) {
      currentVersion = best.version;
      currentTrain = best.train;
      currentVal = best.val;
      currentCandidateId = best.candidate.id;
      passStreak += 1;
      adoptedCount += 1;
      best.candidate.status = "adopted";
      best.candidate.pass_streak = passStreak;
      best.record.status = "adopted";
      best.record.pass_streak = passStreak;
      for (const item of roundTried) {
        if (item !== best) {
          item.candidate.status = "rejected";
          item.record.status = "rejected";
        }
      }
      history.push({
        round,
        hypothesis: best.proposal.hypothesis,
        train: best.train.meanQuality,
        val: best.val?.meanQuality,
        adopted: true,
      });
      writeCard(ws, card);
      if (passStreak >= config.passStreak) {
        stopReason = "pass-streak";
        break;
      }
    } else {
      passStreak = 0;
      for (const item of roundTried) {
        item.candidate.status = "rejected";
        item.record.status = "rejected";
      }
      history.push({
        round,
        hypothesis: best.proposal.hypothesis,
        train: best.train.meanQuality,
        val: best.val?.meanQuality,
        adopted: false,
      });
    }
  }

  const decision = r1PromotionDecision({
    hasVal,
    originalVal: baselineVal?.meanQuality,
    finalVal: currentVal?.meanQuality,
    originalTrain: baselineTrain.meanQuality,
    finalTrain: currentTrain.meanQuality,
  });

  if (decision.promote && currentVersion.id !== baseline.id) {
    markPromoted(card, currentVersion.id);
    const adopted = candidates.find((item) => item.version_id === currentVersion.id);
    if (adopted) {
      adopted.status = "promoted";
    }
    const record = tried.find((item) => item.version_id === currentVersion.id);
    if (record) {
      record.status = "promoted";
    }
  } else {
    card.status = "verifying";
  }
  writeCard(ws, card);

  const rows: ScoreRow[] = [
    {
      split: "train",
      baselineQuality: baselineTrain.meanQuality,
      candidateQuality: currentTrain.meanQuality,
      baselineLatency: baselineTrain.scores.length === 0 ? undefined : baselineTrain.meanLatency,
      candidateLatency: currentTrain.scores.length === 0 ? undefined : currentTrain.meanLatency,
    },
  ];
  if (hasVal && baselineVal && currentVal) {
    rows.push({
      split: "val",
      baselineQuality: baselineVal.meanQuality,
      candidateQuality: currentVal.meanQuality,
      baselineLatency: baselineVal.scores.length === 0 ? undefined : baselineVal.meanLatency,
      candidateLatency: currentVal.scores.length === 0 ? undefined : currentVal.meanLatency,
    });
  }
  const table = formatScoreTable(rows);
  const diff = unifiedPromptDiff(baseline.system_prompt, currentVersion.system_prompt);
  const written = writeRun(ws, run, candidates, {
    diff,
    diffName: "r1.diff",
    scores,
    candidatesJsonl: tried,
    sections: sectionMapArtifact({
      sections: seedSettings.sections,
      rewriteMode: seedSettings.requested,
      effectiveMode: seedSettings.effective,
      maxPatchRatio: seedSettings.maxPatchRatio,
      allowFullRewrite: seedSettings.allowFullRewrite,
      usedFallback: false,
      sourceChars: baseline.system_prompt.length,
    }),
    summary: buildSummary({
      runId: run.id,
      cardId: card.id,
      config,
      roundsRan,
      tried,
      adoptedCount,
      passStreak,
      promoted: decision.promote && currentVersion.id !== baseline.id,
      message: decision.message,
      table,
      stopReason,
    }),
  });

  return {
    card,
    run,
    candidates,
    version: currentVersion,
    diffPath: written.diffPath!,
    scoresPath: written.scoresPath,
    candidatesJsonlPath: written.candidatesJsonlPath,
    summaryPath: written.summaryPath,
    scores,
    promoted: decision.promote && currentVersion.id !== baseline.id,
    dryRun: false,
    table,
    message: decision.message,
    llmTarget,
    roundsRan,
    adoptedCount,
    config,
    rewriteMode: seedSettings.effective,
    sectionsPath: written.sectionsPath,
  };
}
