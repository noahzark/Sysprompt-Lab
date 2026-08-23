import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unifiedPromptDiff } from "@sysprompt-lab/core";
import { casesForSplit, formatScoreTable, type ScoreRow } from "@sysprompt-lab/eval";
import { formatLlmTarget, getLlmConfig, readLlmConfig, type LlmConfig } from "@sysprompt-lab/llm";
import { normalizeLlmApiBase } from "@sysprompt-lab/llm";
import { r1PromotionDecision } from "@sysprompt-lab/eval";
import {
  type Candidate,
  type EvalCase,
  type EvalSuite,
  type PromptCard,
  type PromptVersion,
  type Run,
  type Score,
  baselineVersion,
} from "@sysprompt-lab/core";
import {
  type Workspace,
  findRepoRoot,
  loadCard,
  loadSuite,
  newId,
  openWorkspace,
  writeCard,
  writeRun,
} from "@sysprompt-lab/core";

const R2_ENV_BUDGET = "SYSPROMPT_R2_BUDGET";
const R2_ENV_PYTHON = "SYSPROMPT_PYTHON";

export const R2_BUDGET_CALLS = {
  light: 24,
  medium: 60,
  heavy: 150,
} as const;

export type R2BudgetName = keyof typeof R2_BUDGET_CALLS;

export interface R2Budget {
  name: string;
  maxMetricCalls: number;
}

export interface SidecarResult {
  best_prompt: string;
  hypothesis?: string;
  train_score?: number;
  val_score?: number;
  baseline_train?: number;
  baseline_val?: number;
  gepa_val_score?: number;
  total_metric_calls?: number;
  budget?: string;
  max_metric_calls?: number;
  history?: unknown[];
}

export interface R2Job {
  seed_prompt: string;
  metric: EvalSuite["metric"];
  train: EvalCase[];
  val: EvalCase[];
  budget: string;
  max_metric_calls: number;
  student?: { api_base: string; model: string; token: string };
  reflection?: { api_base: string; model: string; token: string };
  tools: PromptCard["tools"];
}

export interface RunR2Options {
  root?: string;
  dryRun?: boolean;
  noEval?: boolean;
  budget?: string | number;
  python?: string;
  sidecar?: (job: R2Job) => Promise<SidecarResult>;
}

export interface RunR2Result {
  card: PromptCard;
  run: Run;
  candidates: Candidate[];
  version: PromptVersion;
  diffPath: string;
  scoresPath?: string;
  candidatesJsonlPath?: string;
  summaryPath?: string;
  sidecarPath?: string;
  scores: Score[];
  promoted: boolean;
  dryRun: boolean;
  table?: string;
  message: string;
  llmTarget?: string;
  budget: R2Budget;
}

function asPositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got "${value}"`);
  }
  return value;
}

/** Flag > env > default `light`. Accepts light|medium|heavy or a max-metric-calls integer. */
export function resolveR2Budget(input?: string | number): R2Budget {
  const raw = input === undefined ? process.env[R2_ENV_BUDGET]?.trim() : String(input).trim();
  if (!raw) {
    return { name: "light", maxMetricCalls: R2_BUDGET_CALLS.light };
  }
  const lower = raw.toLowerCase();
  if (lower === "light" || lower === "medium" || lower === "heavy") {
    return { name: lower, maxMetricCalls: R2_BUDGET_CALLS[lower] };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `--budget for R2 must be light, medium, heavy, or a positive integer (max metric calls), got "${raw}"`,
    );
  }
  return { name: `calls:${n}`, maxMetricCalls: asPositiveInt(n, "--budget") };
}

function llmTargetLine(config: LlmConfig): string {
  return formatLlmTarget({ ...config, apiBase: normalizeLlmApiBase(config.apiBase) });
}

function reflectionConfig(student: LlmConfig): LlmConfig {
  const model = process.env.LLM_REFLECTION_MODEL?.trim();
  return model ? { ...student, model } : student;
}

function markPromoted(card: PromptCard, versionId: string): void {
  for (const version of card.versions) {
    version.promoted = version.id === versionId;
  }
  card.status = "promoted";
}

function assertR2Ready(card: PromptCard): void {
  if (!card.suite_id || card.status === "draft") {
    throw new Error(
      `Card "${card.id}" must be bound to a suite before run --rung R2. Run: sysprompt bind ${card.id} <suite.yaml>`,
    );
  }
}

function pushModel(card: PromptCard, model: string): void {
  if (!card.models.some((item) => item.id === model)) {
    card.models.push({ id: model, provider: "openai-compatible", name: model });
  }
}

function packageRoot(): string {
  return findRepoRoot(dirname(fileURLToPath(import.meta.url)));
}

export function pythonPackageDir(): string {
  const dir = join(packageRoot(), "python");
  if (!existsSync(join(dir, "sysprompt_gepa"))) {
    throw new Error(
      `Could not find python/sysprompt_gepa next to the package (looked in ${dir}). ` +
        `Install from the repo: pip install -r python/requirements.txt`,
    );
  }
  return dir;
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

function pythonCandidates(): string[] {
  const override = process.env[R2_ENV_PYTHON]?.trim();
  if (override) {
    return [override];
  }
  return process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
}

/** Resolve a Python 3.10+ executable. Throws a install-hint error when missing. */
export function resolvePython(explicit?: string): string {
  const names = explicit?.trim() ? [explicit.trim()] : pythonCandidates();
  const errors: string[] = [];
  for (const name of names) {
    try {
      const result = spawnSyncChecked(name, [
        "-c",
        "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 2)",
      ]);
      if (result.status === 0) {
        return name;
      }
      if (result.status === 2) {
        errors.push(`${name} is older than Python 3.10`);
        continue;
      }
      errors.push(`${name} exited ${result.status ?? "unknown"}`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        errors.push(`${name} not found`);
        continue;
      }
      errors.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(missingPythonMessage(errors.join("; ")));
}

function missingPythonMessage(detail?: string): string {
  const extra = detail ? ` (${detail})` : "";
  return (
    `R2 needs Python 3.10+ to wrap GEPA${extra}. Install Python, then:\n` +
    `  pip install -r python/requirements.txt\n` +
    `or: pip install -e python/\n` +
    `Then: npm run sysprompt -- run <card> --rung R2`
  );
}

function missingGepaMessage(stderr: string): string {
  return (
    `R2 Python sidecar could not import gepa. Install the official package (needs network once):\n` +
    `  pip install -r python/requirements.txt\n` +
    `or: pip install -e python/\n` +
    (stderr.trim() ? `Sidecar said: ${stderr.trim().slice(0, 400)}` : "")
  );
}

function spawnSyncChecked(
  command: string,
  args: string[],
): { status: number | null } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15_000 });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status };
}

export function parseSidecarResult(raw: unknown): SidecarResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("R2 sidecar result.json must be an object");
  }
  const data = raw as Record<string, unknown>;
  if (typeof data.best_prompt !== "string" || !data.best_prompt.trim()) {
    throw new Error("R2 sidecar result.json is missing best_prompt");
  }
  const num = (key: string): number | undefined => {
    const value = data[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  return {
    best_prompt: data.best_prompt,
    hypothesis: typeof data.hypothesis === "string" ? data.hypothesis : undefined,
    train_score: num("train_score"),
    val_score: num("val_score"),
    baseline_train: num("baseline_train"),
    baseline_val: num("baseline_val"),
    gepa_val_score: num("gepa_val_score"),
    total_metric_calls: num("total_metric_calls"),
    budget: typeof data.budget === "string" ? data.budget : undefined,
    max_metric_calls: num("max_metric_calls"),
    history: Array.isArray(data.history) ? data.history : undefined,
  };
}

function spawnSidecar(options: {
  python: string;
  pythonPath: string;
  jobDir: string;
  token: string;
}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(options.python, ["-m", "sysprompt_gepa", "--job-dir", options.jobDir], {
      env: {
        ...process.env,
        PYTHONPATH: options.pythonPath
          ? `${options.pythonPath}${process.env.PYTHONPATH ? `${delimiter()}${process.env.PYTHONPATH}` : ""}`
          : process.env.PYTHONPATH,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error(missingPythonMessage(`${options.python} not found`)));
        return;
      }
      reject(new Error(redact(error.message, options.token)));
    });
    child.on("close", (code) => {
      const err = redact(`${stderr}\n${stdout}`.trim(), options.token);
      if (code === 0) {
        resolvePromise();
        return;
      }
      if (/ModuleNotFoundError: No module named ['"]gepa['"]/i.test(err) || /No module named ['"]gepa['"]/i.test(err)) {
        reject(new Error(missingGepaMessage(err)));
        return;
      }
      if (/No module named ['"]sysprompt_gepa['"]/i.test(err)) {
        reject(
          new Error(
            `R2 could not import sysprompt_gepa. Set PYTHONPATH to python/ or run: pip install -e python/\n${err.slice(0, 400)}`,
          ),
        );
        return;
      }
      reject(
        new Error(
          `R2 Python sidecar exited ${code ?? "unknown"}. ${err ? err.slice(0, 800) : "No sidecar output."}`,
        ),
      );
    });
  });
}

function delimiter(): string {
  return process.platform === "win32" ? ";" : ":";
}

async function runOfficialSidecar(job: R2Job, python?: string): Promise<SidecarResult> {
  const exe = resolvePython(python);
  const pythonPath = pythonPackageDir();
  const jobDir = mkdtempSync(join(tmpdir(), "spl-r2-"));
  const token = job.student?.token ?? "";
  try {
    writeFileSync(join(jobDir, "job.json"), `${JSON.stringify(job, null, 2)}\n`, "utf8");
    await spawnSidecar({ python: exe, pythonPath, jobDir, token });
    const raw = JSON.parse(readFileSync(join(jobDir, "result.json"), "utf8")) as unknown;
    return parseSidecarResult(raw);
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
}

function buildSummary(input: {
  runId: string;
  cardId: string;
  budget: R2Budget;
  promoted: boolean;
  message: string;
  table?: string;
  sidecar?: SidecarResult;
  dryRun: boolean;
}): string {
  const lines = [
    `# R2 ${input.runId}`,
    "",
    `- Card: ${input.cardId}`,
    `- Budget: ${input.budget.name} (max_metric_calls=${input.budget.maxMetricCalls})`,
    `- Promoted: ${input.promoted ? "yes" : "no"}`,
    `- Mode: ${input.dryRun ? "dry-run (sidecar skipped)" : "gepa.optimize wrap"}`,
    "",
    "## Decision",
    "",
    input.message,
  ];
  if (input.sidecar?.hypothesis) {
    lines.push("", "## Lineage", "", input.sidecar.hypothesis);
  }
  if (input.sidecar?.history && input.sidecar.history.length > 0) {
    lines.push("", `Candidates explored: ${input.sidecar.history.length}`);
  }
  if (input.table) {
    lines.push("", "## Scores", "", "```", input.table, "```");
  }
  return `${lines.join("\n")}\n`;
}

function scoresFromSidecar(
  sidecar: SidecarResult,
  baselineId: string,
  versionId: string,
  modelId: string,
  metricId: string,
  hasVal: boolean,
): Score[] {
  const scores: Score[] = [];
  const push = (quality: number | undefined, split: "train" | "val", version_id: string) => {
    if (quality === undefined) {
      return;
    }
    scores.push({ quality, split, model_id: modelId, metric_id: metricId, version_id });
  };
  push(sidecar.baseline_train, "train", baselineId);
  push(sidecar.train_score, "train", versionId);
  if (hasVal) {
    push(sidecar.baseline_val, "val", baselineId);
    push(sidecar.val_score, "val", versionId);
  }
  return scores;
}

export async function runR2(cardRef: string, options: RunR2Options = {}): Promise<RunR2Result> {
  const ws = openWorkspace(options.root);
  const card = loadCard(ws, cardRef);
  assertR2Ready(card);
  const baseline = baselineVersion(card);
  const suite = loadSuite(ws, card.suite_id!);
  const train = casesForSplit(suite, "train");
  const val = casesForSplit(suite, "val");
  const hasVal = val.length > 0;
  if (train.length === 0) {
    throw new Error(`Suite "${suite.id}" has no train cases; R2 uses train to mutate.`);
  }
  if (suite.metric.kind === "llm_judge") {
    throw new Error(
      `Metric "${suite.metric.id}" kind llm_judge is not implemented yet. Use exact or custom (string-contains).`,
    );
  }

  const budget = resolveR2Budget(options.budget);

  if (options.dryRun) {
    return runDryR2(ws, card, baseline, budget);
  }

  const llm = getLlmConfig();
  const reflection = reflectionConfig(llm);
  const llmTarget = llmTargetLine(llm);
  const job: R2Job = {
    seed_prompt: baseline.system_prompt,
    metric: suite.metric,
    train,
    val,
    budget: budget.name,
    max_metric_calls: budget.maxMetricCalls,
    student: {
      api_base: normalizeLlmApiBase(llm.apiBase),
      model: llm.model,
      token: llm.token,
    },
    reflection: {
      api_base: normalizeLlmApiBase(reflection.apiBase),
      model: reflection.model,
      token: reflection.token,
    },
    tools: card.tools,
  };

  const sidecar = options.sidecar
    ? await options.sidecar(job)
    : await runOfficialSidecar(job, options.python);
  const parsed = parseSidecarResult(sidecar);

  const version: PromptVersion = {
    id: newId("ver"),
    system_prompt: parsed.best_prompt,
    hypothesis: parsed.hypothesis ?? `GEPA wrap (${budget.name})`,
    is_baseline: false,
    promoted: false,
    parent: baseline.id,
  };
  const candidate: Candidate = {
    id: newId("cand"),
    round: 0,
    pass_streak: 0,
    status: "evaluated",
    version_id: version.id,
  };

  const run: Run = {
    id: newId("run"),
    card_id: card.id,
    rung: "R2",
    status: "completed",
    budget: budget.maxMetricCalls,
  };
  card.versions.push(version);
  card.rung = "R2";
  card.status = "optimizing";
  pushModel(card, llm.model);
  if (reflection.model !== llm.model) {
    pushModel(card, reflection.model);
  }

  const scores = scoresFromSidecar(parsed, baseline.id, version.id, llm.model, suite.metric.id, hasVal);
  const decision = options.noEval
    ? {
        promote: false,
        message: "Rewrite only (--no-eval); skipped auto-promote after the GEPA wrap.",
      }
    : r1PromotionDecision({
        hasVal,
        originalVal: parsed.baseline_val,
        finalVal: parsed.val_score,
        originalTrain: parsed.baseline_train ?? 0,
        finalTrain: parsed.train_score ?? 0,
      });

  if (decision.promote && version.system_prompt !== baseline.system_prompt) {
    markPromoted(card, version.id);
    candidate.status = "promoted";
  } else {
    card.status = "verifying";
  }
  writeCard(ws, card);

  const rows: ScoreRow[] = [];
  if (parsed.baseline_train !== undefined && parsed.train_score !== undefined) {
    rows.push({
      split: "train",
      baselineQuality: parsed.baseline_train,
      candidateQuality: parsed.train_score,
    });
  }
  if (hasVal && parsed.baseline_val !== undefined && parsed.val_score !== undefined) {
    rows.push({
      split: "val",
      baselineQuality: parsed.baseline_val,
      candidateQuality: parsed.val_score,
    });
  }
  const table = rows.length > 0 ? formatScoreTable(rows) : undefined;
  const diff = unifiedPromptDiff(baseline.system_prompt, version.system_prompt);
  const lineage = [
    {
      id: candidate.id,
      round: 0,
      status: candidate.status,
      version_id: version.id,
      hypothesis: version.hypothesis,
      train_quality: parsed.train_score,
      val_quality: parsed.val_score,
      baseline_train: parsed.baseline_train,
      baseline_val: parsed.baseline_val,
      total_metric_calls: parsed.total_metric_calls,
    },
    ...(parsed.history ?? []).map((row, index) => ({ idx: index, ...(row as object) })),
  ];
  const written = writeRun(ws, run, [candidate], {
    diff,
    diffName: "r2.diff",
    scores: scores.length > 0 ? scores : undefined,
    candidatesJsonl: lineage,
    summary: buildSummary({
      runId: run.id,
      cardId: card.id,
      budget,
      promoted: decision.promote && version.system_prompt !== baseline.system_prompt,
      message: decision.message,
      table,
      sidecar: parsed,
      dryRun: false,
    }),
  });
  const sidecarPath = join(ws.runsDir, run.id, "sidecar.json");
  writeFileSync(sidecarPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

  return {
    card,
    run,
    candidates: [candidate],
    version,
    diffPath: written.diffPath!,
    scoresPath: written.scoresPath,
    candidatesJsonlPath: written.candidatesJsonlPath,
    summaryPath: written.summaryPath,
    sidecarPath,
    scores,
    promoted: decision.promote && version.system_prompt !== baseline.system_prompt,
    dryRun: false,
    table,
    message: decision.message,
    llmTarget,
    budget,
  };
}

function runDryR2(ws: Workspace, card: PromptCard, baseline: PromptVersion, budget: R2Budget): RunR2Result {
  const version: PromptVersion = {
    id: newId("ver"),
    system_prompt: `${baseline.system_prompt.replace(/\s+$/g, "")}\n\n[R2 dry-run candidate: GEPA sidecar skipped]`,
    hypothesis: "R2 dry-run (GEPA wrap skipped)",
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
    rung: "R2",
    status: "completed",
    budget: budget.maxMetricCalls,
  };
  card.versions.push(version);
  card.rung = "R2";
  card.status = "optimizing";
  writeCard(ws, card);

  const diff = unifiedPromptDiff(baseline.system_prompt, version.system_prompt);
  const llm = readLlmConfig();
  const message = "R2 dry-run stub (GEPA sidecar skipped, no LLM calls).";
  const written = writeRun(ws, run, [candidate], {
    diff,
    diffName: "r2.diff",
    candidatesJsonl: [
      {
        id: candidate.id,
        round: 0,
        status: "stub",
        version_id: version.id,
        hypothesis: version.hypothesis,
      },
    ],
    summary: buildSummary({
      runId: run.id,
      cardId: card.id,
      budget,
      promoted: false,
      message,
      dryRun: true,
    }),
  });

  return {
    card,
    run,
    candidates: [candidate],
    version,
    diffPath: written.diffPath!,
    candidatesJsonlPath: written.candidatesJsonlPath,
    summaryPath: written.summaryPath,
    scores: [],
    promoted: false,
    dryRun: true,
    message,
    llmTarget: llm ? llmTargetLine(llm) : undefined,
    budget,
  };
}
