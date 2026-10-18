import { casesForSplit, formatScoreTable, promotionDecision, type ScoreRow } from "@sysprompt-lab/eval";
import { getLlmConfig } from "@sysprompt-lab/llm";
import { type FetchFn } from "@sysprompt-lab/llm";
import {
  type RewriteMode,
  dryRunPatch,
  resolveAllowFullRewrite,
  resolveEffectiveRewriteMode,
  resolveMaxPatchRatio,
  resolvePatchThreshold,
  rewriteSystemPrompt,
  sectionMapArtifact,
  splitSections,
} from "@sysprompt-lab/rewrite";
import {
  type Candidate,
  type PromptCard,
  type PromptVersion,
  type Run,
  type Score,
  baselineVersion,
} from "@sysprompt-lab/core";
import { type Workspace, loadCard, loadSuite, openWorkspace } from "@sysprompt-lab/core";
import {
  RunSession,
  StudentEval,
  llmTargetLine,
  optionalLlmTarget,
  pushModel,
  scoreRow,
} from "./pipeline.js";

export interface RunR0Options {
  root?: string;
  dryRun?: boolean;
  noEval?: boolean;
  fetch?: FetchFn;
  rewriteMode?: RewriteMode;
  maxPatchRatio?: number;
  allowFullRewrite?: boolean;
  /** Student eval sampling (rewriter stays colder). CLI / suite.temperature override default 0. */
  temperature?: number;
  maxTokens?: number;
  imageDir?: string;
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
  rewriteMode?: "patch" | "full";
  sectionsPath?: string;
  patchPath?: string;
}

export async function runR0(cardRef: string, options: RunR0Options = {}): Promise<RunR0Result> {
  const ws = openWorkspace(options.root);
  const card = loadCard(ws, cardRef);
  const baseline = baselineVersion(card);

  if (options.dryRun) {
    return runDryStub(ws, card, baseline, options);
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
    rewriteMode: options.rewriteMode,
    maxPatchRatio: options.maxPatchRatio,
    allowFullRewrite: options.allowFullRewrite,
  });
  const sections = rewritten.sections ?? splitSections(baseline.system_prompt);
  const effectiveMode = rewritten.mode ?? "full";
  const sectionArtifact = sectionMapArtifact({
    sections,
    rewriteMode: options.rewriteMode ?? "auto",
    effectiveMode,
    maxPatchRatio: resolveMaxPatchRatio(options.maxPatchRatio, "R0"),
    allowFullRewrite: resolveAllowFullRewrite(options.allowFullRewrite, "R0", effectiveMode),
    usedFallback: Boolean(rewritten.usedFallback),
    sourceChars: baseline.system_prompt.length,
  });

  const session = new RunSession(ws, card, "R0");
  const { version, candidate } = session.addCandidate({
    prompt: rewritten.system_prompt,
    hypothesis: rewritten.hypothesis,
    parent: baseline,
    round: 0,
    status: options.noEval ? "rewritten" : "evaluated",
  });
  pushModel(card, config.model);
  session.saveCard();

  const shared = {
    card,
    run: session.run,
    candidate,
    version,
    dryRun: false,
    llmTarget,
    rewriteMode: effectiveMode,
  };

  if (options.noEval) {
    const written = session.write(baseline, version, { sections: sectionArtifact, patch: rewritten.patch });
    return {
      ...shared,
      diffPath: requireDiff(written.diffPath, "R0"),
      scores: [],
      promoted: false,
      message: "Rewrite only (--no-eval); skipped before/after eval and auto-promote.",
      sectionsPath: written.sectionsPath,
      patchPath: written.patchPath,
    };
  }

  const suite = loadSuite(ws, card.suite_id!);
  const student = new StudentEval(session, config, suite, options);
  const rows: ScoreRow[] = [];
  let valBaseline: number | undefined;
  let valCandidate: number | undefined;
  for (const split of ["train", "val"] as const) {
    if (casesForSplit(suite, split).length === 0) {
      continue;
    }
    const baselineEval = await student.evaluate(baseline, split);
    const candidateEval = await student.evaluate(version, split);
    rows.push(scoreRow(split, baselineEval, candidateEval));
    if (split === "val") {
      valBaseline = baselineEval.meanQuality;
      valCandidate = candidateEval.meanQuality;
    }
  }

  const hasVal = casesForSplit(suite, "val").length > 0;
  const decision = promotionDecision({ hasVal, valBaseline, valCandidate });
  session.settle(decision.promote, version.id);
  candidate.status = decision.promote ? "promoted" : "evaluated";
  session.saveCard();

  const written = session.write(baseline, version, {
    scores: session.scores,
    sections: sectionArtifact,
    patch: rewritten.patch,
  });
  return {
    ...shared,
    diffPath: requireDiff(written.diffPath, "R0"),
    scoresPath: written.scoresPath,
    scores: session.scores,
    promoted: decision.promote,
    table: rows.length > 0 ? formatScoreTable(rows) : undefined,
    message: decision.message,
    sectionsPath: written.sectionsPath,
    patchPath: written.patchPath,
  };
}

function requireDiff(path: string | undefined, label: string): string {
  if (!path) {
    throw new Error(`${label} failed to write a unified diff`);
  }
  return path;
}

function runDryStub(
  ws: Workspace,
  card: PromptCard,
  baseline: PromptVersion,
  options: RunR0Options,
): RunR0Result {
  const patched = dryRunPatch(baseline.system_prompt, "[R0 dry-run stub]");
  const session = new RunSession(ws, card, "R0");
  const { version, candidate } = session.addCandidate({
    prompt: patched.prompt,
    hypothesis: "stub",
    parent: baseline,
    round: 0,
    status: "stub",
  });
  session.saveCard();
  const effectiveMode = resolveEffectiveRewriteMode(
    options.rewriteMode ?? "auto",
    baseline.system_prompt,
    resolvePatchThreshold(),
  );
  const written = session.write(baseline, version, {
    sections: sectionMapArtifact({
      sections: patched.sections,
      rewriteMode: options.rewriteMode ?? "auto",
      effectiveMode,
      maxPatchRatio: resolveMaxPatchRatio(options.maxPatchRatio, "R0"),
      allowFullRewrite: resolveAllowFullRewrite(options.allowFullRewrite, "R0", effectiveMode),
      usedFallback: false,
      sourceChars: baseline.system_prompt.length,
    }),
    patch: { hypothesis: "stub", edits: patched.edits, kind: "edits" },
  });
  return {
    card,
    run: session.run,
    candidate,
    version,
    diffPath: requireDiff(written.diffPath, "R0 stub"),
    scores: [],
    promoted: false,
    dryRun: true,
    message: "R0 dry-run stub (no LLM calls).",
    llmTarget: optionalLlmTarget(),
    rewriteMode: effectiveMode,
    sectionsPath: written.sectionsPath,
    patchPath: written.patchPath,
  };
}
