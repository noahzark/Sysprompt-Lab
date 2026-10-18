import {
  adoptDecision,
  casesForSplit,
  formatScoreTable,
  r1PromotionDecision,
  type ScoreRow,
  type SplitEval,
} from "@sysprompt-lab/eval";
import { getLlmConfig, type LlmConfig } from "@sysprompt-lab/llm";
import { type FetchFn } from "@sysprompt-lab/llm";
import {
  type EffectiveRewriteMode,
  type R1Proposal,
  type RewriteMode,
  dedupeProposals,
  dryRunProposals,
  parseRewriteMode,
  promptKey,
  proposeR1Candidates,
  resolveAllowFullRewrite,
  resolveEffectiveRewriteMode,
  resolveMaxPatchRatio,
  resolvePatchThreshold,
  sectionMapArtifact,
  splitSections,
} from "@sysprompt-lab/rewrite";
import {
  type EvidencePack,
  type SearchHistoryEntry,
  formatEvidence,
  selectEvidenceCases,
} from "./r1-evidence.js";
import {
  type Candidate,
  type EvalSuite,
  type PromptCard,
  type PromptVersion,
  type Run,
  type Score,
  baselineVersion,
} from "@sysprompt-lab/core";
import { type Workspace, loadCard, loadSuite, openWorkspace } from "@sysprompt-lab/core";
import {
  type AddedCandidate,
  type CandidateRecord,
  RunSession,
  StudentEval,
  assertBound,
  llmTargetLine,
  optionalLlmTarget,
  pushModel,
  scoreRow,
} from "./pipeline.js";

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
  /** Student eval sampling (rewriter stays colder). CLI / suite.temperature override default 0. */
  temperature?: number;
  maxTokens?: number;
  imageDir?: string;
}

/** One `candidates.jsonl` row; same shape as every rung's lineage. */
export interface R1TriedCandidate extends CandidateRecord {
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

type R1RewriteSettings = ReturnType<typeof rewriteSettings>;

function sectionsArtifact(settings: R1RewriteSettings, sourcePrompt: string) {
  return sectionMapArtifact({
    sections: settings.sections,
    rewriteMode: settings.requested,
    effectiveMode: settings.effective,
    maxPatchRatio: settings.maxPatchRatio,
    allowFullRewrite: settings.allowFullRewrite,
    usedFallback: false,
    sourceChars: sourcePrompt.length,
  });
}

function buildSummary(input: {
  runId: string;
  cardId: string;
  config: R1LoopConfig;
  roundsRan: number;
  tried: CandidateRecord[];
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
  assertBound(card, "R1");
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

/** Write r1.diff / candidates / sections / summary and build the result. Shared by every R1 path. */
function finishR1(input: {
  session: RunSession;
  baseline: PromptVersion;
  best: PromptVersion;
  settings: R1RewriteSettings;
  config: R1LoopConfig;
  dryRun: boolean;
  llmTarget?: string;
  roundsRan: number;
  adoptedCount: number;
  passStreak: number;
  promoted: boolean;
  message: string;
  stopReason: string;
  table?: string;
  scores?: Score[];
}): RunR1Result {
  const { session } = input;
  const written = session.write(input.baseline, input.best, {
    diffName: "r1.diff",
    scores: input.scores,
    candidatesJsonl: session.records,
    sections: sectionsArtifact(input.settings, input.baseline.system_prompt),
    summary: buildSummary({
      runId: session.run.id,
      cardId: session.card.id,
      config: input.config,
      roundsRan: input.roundsRan,
      tried: session.records,
      adoptedCount: input.adoptedCount,
      passStreak: input.passStreak,
      promoted: input.promoted,
      message: input.message,
      table: input.table,
      stopReason: input.stopReason,
    }),
  });
  return {
    card: session.card,
    run: session.run,
    candidates: session.candidates,
    version: input.best,
    diffPath: written.diffPath!,
    scoresPath: written.scoresPath,
    candidatesJsonlPath: written.candidatesJsonlPath,
    summaryPath: written.summaryPath,
    scores: input.scores ?? [],
    promoted: input.promoted,
    dryRun: input.dryRun,
    table: input.table,
    message: input.message,
    llmTarget: input.llmTarget,
    roundsRan: input.roundsRan,
    adoptedCount: input.adoptedCount,
    config: input.config,
    rewriteMode: input.settings.effective,
    sectionsPath: written.sectionsPath,
  };
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

  const session = new RunSession(ws, card, "R1", config.budget);
  pushModel(card, llm.model);
  let best = baseline;
  for (const proposal of proposals) {
    best = session.addCandidate({
      prompt: proposal.prompt,
      hypothesis: proposal.hypothesis,
      parent: baseline,
      round: 1,
      status: "rewritten",
      patch: proposal.patch,
    }).version;
  }
  session.saveCard();

  return finishR1({
    session,
    baseline,
    best,
    settings,
    config,
    dryRun: false,
    llmTarget,
    roundsRan: proposals.length > 0 ? 1 : 0,
    adoptedCount: 0,
    passStreak: 0,
    promoted: false,
    message: "Rewrite only (--no-eval); skipped eval loop and auto-promote.",
    stopReason: "no-eval",
  });
}

function runDryR1(
  ws: Workspace,
  card: PromptCard,
  baseline: PromptVersion,
  config: R1LoopConfig,
  options: RunR1Options,
): RunR1Result {
  const session = new RunSession(ws, card, "R1", config.budget);
  let lastVersion = baseline;
  const rounds = Math.min(config.rounds, Math.ceil(config.budget / config.candidates) || 1);
  for (let round = 1; round <= rounds; round += 1) {
    const remaining = config.budget - session.records.length;
    if (remaining <= 0) {
      break;
    }
    const proposals = dryRunProposals(
      lastVersion.system_prompt,
      Math.min(config.candidates, remaining),
      round,
    );
    for (const proposal of proposals) {
      lastVersion = session.addCandidate({
        prompt: proposal.prompt,
        hypothesis: proposal.hypothesis,
        parent: lastVersion,
        round,
        status: "stub",
        patch: proposal.patch,
      }).version;
    }
  }
  session.saveCard();

  return finishR1({
    session,
    baseline,
    best: lastVersion,
    settings: rewriteSettings(baseline.system_prompt, options),
    config,
    dryRun: true,
    llmTarget: optionalLlmTarget(),
    roundsRan: rounds,
    adoptedCount: 0,
    passStreak: 0,
    promoted: false,
    message: "R1 dry-run stub (fake candidates, no LLM calls).",
    stopReason: "dry-run",
  });
}

interface RoundCandidate {
  item: AddedCandidate;
  proposal: R1Proposal;
  train: SplitEval;
  val?: SplitEval;
}

/** Best of a round by the adopt rule (val first, train as a val-tie break). */
function bestOfRound(round: RoundCandidate[], hasVal: boolean): RoundCandidate {
  let best = round[0]!;
  for (const item of round.slice(1)) {
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
  return best;
}

async function runEvalLoop(
  ws: Workspace,
  card: PromptCard,
  baseline: PromptVersion,
  suite: EvalSuite,
  config: R1LoopConfig,
  llm: LlmConfig,
  llmTarget: string,
  hasVal: boolean,
  options: RunR1Options,
): Promise<RunR1Result> {
  const session = new RunSession(ws, card, "R1", config.budget);
  pushModel(card, llm.model);
  session.saveCard();

  const student = new StudentEval(session, llm, suite, options);
  const seenPrompts = new Set<string>([promptKey(baseline.system_prompt)]);
  const history: SearchHistoryEntry[] = [];
  const hypotheses: string[] = [];
  const seedSettings = rewriteSettings(baseline.system_prompt, options);

  const baselineTrain = await student.evaluate(baseline, "train");
  const baselineVal = hasVal ? await student.evaluate(baseline, "val") : undefined;

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
      fetch: options.fetch,
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
    const roundTried: RoundCandidate[] = [];
    for (const proposal of proposals) {
      const item = session.addCandidate({
        prompt: proposal.prompt,
        hypothesis: proposal.hypothesis,
        parent: currentVersion,
        round,
        status: "evaluated",
        passStreak,
        parentCandidateId: currentCandidateId,
        patch: proposal.patch,
      });
      seenPrompts.add(promptKey(proposal.prompt));
      hypotheses.push(proposal.hypothesis);

      const train = await student.evaluate(item.version, "train");
      evalsUsed += 1;
      const val = hasVal ? await student.evaluate(item.version, "val") : undefined;
      item.record.train_quality = train.meanQuality;
      item.record.val_quality = val?.meanQuality;
      roundTried.push({ item, proposal, train, val });
    }

    const best = bestOfRound(roundTried, hasVal);
    const vsCurrent = adoptDecision({
      hasVal,
      currentVal: currentVal?.meanQuality,
      candidateVal: best.val?.meanQuality,
      currentTrain: currentTrain.meanQuality,
      candidateTrain: best.train.meanQuality,
    });
    history.push({
      round,
      hypothesis: best.proposal.hypothesis,
      train: best.train.meanQuality,
      val: best.val?.meanQuality,
      adopted: vsCurrent.adopt,
    });

    if (vsCurrent.adopt) {
      currentVersion = best.item.version;
      currentTrain = best.train;
      currentVal = best.val;
      currentCandidateId = best.item.candidate.id;
      passStreak += 1;
      adoptedCount += 1;
      session.setStatus(best.item, "adopted", passStreak);
      for (const other of roundTried) {
        if (other !== best) {
          session.setStatus(other.item, "rejected");
        }
      }
      session.saveCard();
      if (passStreak >= config.passStreak) {
        stopReason = "pass-streak";
        break;
      }
    } else {
      passStreak = 0;
      for (const other of roundTried) {
        session.setStatus(other.item, "rejected");
      }
    }
  }

  const decision = r1PromotionDecision({
    hasVal,
    originalVal: baselineVal?.meanQuality,
    finalVal: currentVal?.meanQuality,
    originalTrain: baselineTrain.meanQuality,
    finalTrain: currentTrain.meanQuality,
  });
  const promoted = decision.promote && currentVersion.id !== baseline.id;
  session.settle(promoted, currentVersion.id);
  if (promoted) {
    const index = session.candidates.findIndex((item) => item.version_id === currentVersion.id);
    if (index >= 0) {
      session.candidates[index]!.status = "promoted";
      session.records[index]!.status = "promoted";
    }
  }
  session.saveCard();

  const rows: ScoreRow[] = [scoreRow("train", baselineTrain, currentTrain)];
  if (hasVal && baselineVal && currentVal) {
    rows.push(scoreRow("val", baselineVal, currentVal));
  }

  return finishR1({
    session,
    baseline,
    best: currentVersion,
    settings: seedSettings,
    config,
    dryRun: false,
    llmTarget,
    roundsRan,
    adoptedCount,
    passStreak,
    promoted,
    message: decision.message,
    stopReason,
    table: formatScoreTable(rows),
    scores: session.scores,
  });
}
