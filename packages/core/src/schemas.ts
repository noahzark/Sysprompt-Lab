import { z } from "zod";

/** Card lifecycle. Promotion happens only after the same evals say it is better. */
export const CardStatusSchema = z.enum([
  "draft",
  "bound",
  "optimizing",
  "verifying",
  "promoted",
  "rejected",
  "exported",
]);

export const RungSchema = z.enum(["R0", "R1", "R2"]);

export const PromptVersionSchema = z.object({
  id: z.string().min(1),
  system_prompt: z.string(),
  hypothesis: z.string().optional(),
  is_baseline: z.boolean(),
  promoted: z.boolean(),
  parent: z.string().min(1).optional(),
});

export const ToolSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
});

export const ModelSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  name: z.string().min(1),
});

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  gold: z.unknown().optional(),
  feedback: z.string().optional(),
});

export const MetricKindSchema = z.enum(["exact", "llm_judge", "custom"]);

export const MetricSchema = z.object({
  id: z.string().min(1),
  kind: MetricKindSchema,
  returns_feedback: z.boolean(),
});

export const SplitNameSchema = z.enum(["train", "val"]);

export const SplitSchema = z.object({
  name: SplitNameSchema,
  case_ids: z.array(z.string().min(1)),
});

export const EvalSuiteSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cases: z.array(EvalCaseSchema),
  metric: MetricSchema,
  splits: z.object({
    train: SplitSchema,
    val: SplitSchema,
  }),
  /** Student / execution sampling. Rewriters keep their own colder defaults. */
  temperature: z.number().optional(),
  max_tokens: z.number().int().nonnegative().optional(),
});

export const PromptCardSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  rung: RungSchema,
  status: CardStatusSchema,
  versions: z.array(PromptVersionSchema).default([]),
  tools: z.array(ToolSpecSchema).default([]),
  models: z.array(ModelSchema).default([]),
  suite_id: z.string().min(1).optional(),
});

export const RunSchema = z.object({
  id: z.string().min(1),
  card_id: z.string().min(1),
  rung: RungSchema,
  status: z.string().min(1),
  budget: z.number().optional(),
});

export const CandidateSchema = z.object({
  id: z.string().min(1),
  round: z.number().int(),
  pass_streak: z.number().int(),
  status: z.string().min(1),
  version_id: z.string().min(1),
  parent_candidate_id: z.string().min(1).optional(),
});

export const ScoreSchema = z.object({
  quality: z.number(),
  cost: z.number().optional(),
  latency_ms: z.number().optional(),
  split: SplitNameSchema,
  model_id: z.string().min(1),
  metric_id: z.string().min(1),
  version_id: z.string().min(1).optional(),
  case_id: z.string().min(1).optional(),
});

export type CardStatus = z.infer<typeof CardStatusSchema>;
export type Rung = z.infer<typeof RungSchema>;
export type PromptVersion = z.infer<typeof PromptVersionSchema>;
export type ToolSpec = z.infer<typeof ToolSpecSchema>;
export type Model = z.infer<typeof ModelSchema>;
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type MetricKind = z.infer<typeof MetricKindSchema>;
export type Metric = z.infer<typeof MetricSchema>;
export type SplitName = z.infer<typeof SplitNameSchema>;
export type Split = z.infer<typeof SplitSchema>;
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;
export type PromptCard = z.infer<typeof PromptCardSchema>;
export type Run = z.infer<typeof RunSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type Score = z.infer<typeof ScoreSchema>;

/** Named Zod schemas used to emit JSON Schema files. */
export const namedSchemas = {
  "prompt-card": PromptCardSchema,
  "prompt-version": PromptVersionSchema,
  "tool-spec": ToolSpecSchema,
  model: ModelSchema,
  "eval-suite": EvalSuiteSchema,
  "eval-case": EvalCaseSchema,
  metric: MetricSchema,
  split: SplitSchema,
  run: RunSchema,
  candidate: CandidateSchema,
  score: ScoreSchema,
} as const;

export function parseCard(data: unknown): PromptCard {
  return PromptCardSchema.parse(data);
}

export function parseSuite(data: unknown): EvalSuite {
  const suite = EvalSuiteSchema.parse(data);
  assertSuiteSplits(suite);
  return suite;
}

export function parseVersion(data: unknown): PromptVersion {
  return PromptVersionSchema.parse(data);
}

export function parseToolSpec(data: unknown): ToolSpec {
  return ToolSpecSchema.parse(data);
}

export function parseModel(data: unknown): Model {
  return ModelSchema.parse(data);
}

export function parseEvalCase(data: unknown): EvalCase {
  return EvalCaseSchema.parse(data);
}

export function parseMetric(data: unknown): Metric {
  return MetricSchema.parse(data);
}

export function parseSplit(data: unknown): Split {
  return SplitSchema.parse(data);
}

export function parseRun(data: unknown): Run {
  return RunSchema.parse(data);
}

export function parseCandidate(data: unknown): Candidate {
  return CandidateSchema.parse(data);
}

export function parseScore(data: unknown): Score {
  return ScoreSchema.parse(data);
}

const SplitInputSchema = z.union([
  SplitSchema,
  z.array(z.string().min(1)),
]);

const SuiteFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cases: z.array(EvalCaseSchema),
  metric: MetricSchema,
  splits: z.object({
    train: SplitInputSchema,
    val: SplitInputSchema,
  }),
  temperature: z.number().optional(),
  max_tokens: z.number().int().nonnegative().optional(),
});

function asSplit(name: SplitName, value: z.infer<typeof SplitInputSchema>): Split {
  if (Array.isArray(value)) {
    return { name, case_ids: value };
  }
  if (value.name !== name) {
    throw new Error(`splits.${name}.name must be "${name}", got "${value.name}"`);
  }
  return value;
}

export function normalizeSuite(data: unknown): EvalSuite {
  const raw = SuiteFileSchema.parse(data);
  const suite = parseSuite({
    id: raw.id,
    name: raw.name,
    cases: raw.cases,
    metric: raw.metric,
    splits: {
      train: asSplit("train", raw.splits.train),
      val: asSplit("val", raw.splits.val),
    },
    temperature: raw.temperature,
    max_tokens: raw.max_tokens,
  });
  return suite;
}

export function assertSuiteSplits(suite: EvalSuite): void {
  const ids = new Set(suite.cases.map((c) => c.id));
  const seen = new Set<string>();
  for (const split of [suite.splits.train, suite.splits.val]) {
    for (const caseId of split.case_ids) {
      if (!ids.has(caseId)) {
        throw new Error(`Split "${split.name}" references unknown case "${caseId}"`);
      }
      if (seen.has(caseId)) {
        throw new Error(`Case "${caseId}" appears in more than one split`);
      }
      seen.add(caseId);
    }
  }
}

export function baselineVersion(card: PromptCard): PromptVersion {
  const baseline = card.versions.find((v) => v.is_baseline);
  if (!baseline) {
    throw new Error(`Card "${card.id}" has no baseline version`);
  }
  return baseline;
}

export function exportVersion(card: PromptCard): PromptVersion {
  const promoted = card.versions.find((v) => v.promoted);
  return promoted ?? baselineVersion(card);
}
