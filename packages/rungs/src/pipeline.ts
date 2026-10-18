import { unifiedPromptDiff } from "@sysprompt-lab/core";
import {
  type Candidate,
  type EvalSuite,
  type PromptCard,
  type PromptVersion,
  type Run,
  type Rung,
  type Score,
  type SplitName,
} from "@sysprompt-lab/core";
import { type Workspace, newId, writeCard, writeRun } from "@sysprompt-lab/core";
import { aggregateScore, evaluatePrompt, type ScoreRow, type SplitEval } from "@sysprompt-lab/eval";
import {
  type FetchFn,
  type LlmConfig,
  formatLlmTarget,
  normalizeLlmApiBase,
  readLlmConfig,
} from "@sysprompt-lab/llm";

/**
 * Shared rung pipeline: run + version/candidate bookkeeping, student eval,
 * the promote step and run artifacts. Rung files keep only their search policy.
 */

/** One row of `candidates.jsonl`, shared by every rung that writes lineage. */
export interface CandidateRecord {
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
  patch?: unknown;
}

export interface StudentEvalOptions {
  fetch?: FetchFn;
  /** Student sampling. CLI / suite.temperature override default 0. */
  temperature?: number;
  maxTokens?: number;
  imageDir?: string;
}

export function llmTargetLine(config: LlmConfig): string {
  return formatLlmTarget({ ...config, apiBase: normalizeLlmApiBase(config.apiBase) });
}

/** LLM target for dry-run output, when env happens to be set. Never required. */
export function optionalLlmTarget(): string | undefined {
  const llm = readLlmConfig();
  return llm ? llmTargetLine(llm) : undefined;
}

export function assertBound(card: PromptCard, rung: Rung): void {
  if (!card.suite_id || card.status === "draft") {
    throw new Error(
      `Card "${card.id}" must be bound to a suite before run --rung ${rung}. Run: sysprompt bind ${card.id} <suite.yaml>`,
    );
  }
}

export function pushModel(card: PromptCard, model: string): void {
  if (!card.models.some((item) => item.id === model)) {
    card.models.push({ id: model, provider: "openai-compatible", name: model });
  }
}

export function scoreRow(split: SplitName, baseline: SplitEval, candidate: SplitEval): ScoreRow {
  return {
    split,
    baselineQuality: baseline.meanQuality,
    candidateQuality: candidate.meanQuality,
    baselineLatency: baseline.scores.length === 0 ? undefined : baseline.meanLatency,
    candidateLatency: candidate.scores.length === 0 ? undefined : candidate.meanLatency,
  };
}

export interface AddCandidateInput {
  prompt: string;
  hypothesis?: string;
  parent: PromptVersion;
  round: number;
  status: string;
  passStreak?: number;
  parentCandidateId?: string;
  patch?: unknown;
}

export interface AddedCandidate {
  version: PromptVersion;
  candidate: Candidate;
  record: CandidateRecord;
}

/** One optimization run on one card: owns the Run, candidates, lineage and scores. */
export class RunSession {
  readonly run: Run;
  readonly candidates: Candidate[] = [];
  readonly records: CandidateRecord[] = [];
  readonly scores: Score[] = [];

  constructor(
    readonly ws: Workspace,
    readonly card: PromptCard,
    rung: Rung,
    budget?: number,
  ) {
    this.run = { id: newId("run"), card_id: card.id, rung, status: "completed" };
    if (budget !== undefined) {
      this.run.budget = budget;
    }
    card.rung = rung;
    card.status = "optimizing";
  }

  /** Push a new version + candidate onto the card and record its lineage row. */
  addCandidate(input: AddCandidateInput): AddedCandidate {
    const version: PromptVersion = {
      id: newId("ver"),
      system_prompt: input.prompt,
      hypothesis: input.hypothesis,
      is_baseline: false,
      promoted: false,
      parent: input.parent.id,
    };
    const passStreak = input.passStreak ?? 0;
    const candidate: Candidate = {
      id: newId("cand"),
      round: input.round,
      pass_streak: passStreak,
      status: input.status,
      version_id: version.id,
    };
    if (input.parentCandidateId !== undefined) {
      candidate.parent_candidate_id = input.parentCandidateId;
    }
    const record: CandidateRecord = {
      id: candidate.id,
      round: input.round,
      pass_streak: passStreak,
      status: input.status,
      version_id: version.id,
      parent_candidate_id: input.parentCandidateId,
      hypothesis: input.hypothesis ?? "",
      prompt: input.prompt,
      // Keep jsonl key order stable: scores land here later, before the patch.
      train_quality: undefined,
      val_quality: undefined,
      patch: input.patch,
    };
    this.card.versions.push(version);
    this.candidates.push(candidate);
    this.records.push(record);
    return { version, candidate, record };
  }

  setStatus(item: AddedCandidate, status: string, passStreak?: number): void {
    item.candidate.status = status;
    item.record.status = status;
    if (passStreak !== undefined) {
      item.candidate.pass_streak = passStreak;
      item.record.pass_streak = passStreak;
    }
  }

  /** Mark the version promoted, or leave the card in `verifying`. */
  settle(promote: boolean, versionId: string): void {
    if (promote) {
      for (const version of this.card.versions) {
        version.promoted = version.id === versionId;
      }
      this.card.status = "promoted";
    } else {
      this.card.status = "verifying";
    }
  }

  saveCard(): void {
    writeCard(this.ws, this.card);
  }

  write(
    baseline: PromptVersion,
    best: PromptVersion,
    extra: Omit<NonNullable<Parameters<typeof writeRun>[3]>, "diff"> = {},
  ): ReturnType<typeof writeRun> {
    return writeRun(this.ws, this.run, this.candidates, {
      diff: unifiedPromptDiff(baseline.system_prompt, best.system_prompt),
      ...extra,
    });
  }
}

/** Student eval bound to one card, suite, model and sampling. Scores land on the session. */
export class StudentEval {
  constructor(
    readonly session: RunSession,
    readonly llm: LlmConfig,
    readonly suite: EvalSuite,
    readonly options: StudentEvalOptions,
  ) {}

  async evaluate(version: PromptVersion, split: SplitName): Promise<SplitEval> {
    const envDir = process.env.SYSPROMPT_IMAGE_DIR?.trim();
    const result = await evaluatePrompt({
      config: this.llm,
      systemPrompt: version.system_prompt,
      versionId: version.id,
      suite: this.suite,
      split,
      fetch: this.options.fetch,
      temperature: this.options.temperature,
      max_tokens: this.options.maxTokens,
      imageDir: this.options.imageDir ?? (envDir || this.session.card.source),
    });
    this.session.scores.push(
      ...result.scores,
      aggregateScore(result, version.id, this.llm.model, this.suite.metric.id),
    );
    return result;
  }
}
