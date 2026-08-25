import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseJsonObjectFromModelOutput, severityTagsIn } from "@sysprompt-lab/eval";

export const RUN_FILE_NAMES = ["report.json", "scores.json"] as const;
const RUN_FILE_NAME_SET = new Set<string>(RUN_FILE_NAMES);

export class RunArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunArtifactError";
  }
}

export type RunArtifactKind = "scores" | "report";
export type PredictionStatus = "ok" | "miss" | "error" | "none";
export type RunSplitName = "train" | "val";

export interface RunCaseRow {
  id: string;
  split?: RunSplitName;
  output?: string;
  quality?: number;
  note?: string;
  error?: string;
  reasoning?: string;
  finish_reason?: string;
  reasoning_tokens?: number;
}

export interface ParsedRunArtifact {
  kind: RunArtifactKind;
  path?: string;
  model?: string;
  temperature?: number;
  metricId?: string;
  versionId?: string;
  meanQuality?: number;
  splitMeans?: Partial<Record<RunSplitName, number>>;
  cases: RunCaseRow[];
}

export interface JoinedCasePrediction {
  status: PredictionStatus;
  output?: string;
  predictedLabel?: string;
  quality?: number;
  note?: string;
  error?: string;
  reasoning?: string;
  finish_reason?: string;
  reasoning_tokens?: number;
  runSplit?: RunSplitName;
}

export interface RunListItem {
  path: string;
  label: string;
  name: string;
}

export interface RunOverlaySummary {
  path?: string;
  kind: RunArtifactKind;
  model?: string;
  temperature?: number;
  metricId?: string;
  versionId?: string;
  meanQuality?: number;
  splitMeans?: Partial<Record<RunSplitName, number>>;
  hitCount: number;
  missCount: number;
  errorCount: number;
  noneCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optSplit(value: unknown): RunSplitName | undefined {
  return value === "train" || value === "val" ? value : undefined;
}

function mean(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function predictionStatus(row: RunCaseRow | undefined): PredictionStatus {
  if (!row) {
    return "none";
  }
  if (nonEmptyString(row.error)) {
    return "error";
  }
  if (row.quality === 1) {
    return "ok";
  }
  return "miss";
}

/** Display label: NSFW `tags[]` severity when parseable, otherwise raw output. */
export function predictedDisplayLabel(output: string | undefined, nsfw: boolean): string | undefined {
  if (output === undefined) {
    return undefined;
  }
  if (!nsfw) {
    return output;
  }
  const obj = parseJsonObjectFromModelOutput(output);
  if (!obj) {
    return undefined;
  }
  const tags = severityTagsIn(obj.tags);
  return tags.length > 0 ? tags.join("+") : undefined;
}

function rowFromUnknown(raw: unknown): RunCaseRow | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = nonEmptyString(raw.id) ?? nonEmptyString(raw.case_id);
  if (!id) {
    return undefined;
  }
  const row: RunCaseRow = { id };
  const split = optSplit(raw.split);
  if (split) {
    row.split = split;
  }
  if ("output" in raw && typeof raw.output === "string") {
    row.output = raw.output;
  }
  const quality = optFiniteNumber(raw.quality);
  if (quality !== undefined) {
    row.quality = quality;
  }
  const note = nonEmptyString(raw.note);
  if (note) {
    row.note = note;
  }
  const error = nonEmptyString(raw.error);
  if (error) {
    row.error = error;
  }
  const reasoning = optString(raw.reasoning);
  if (reasoning !== undefined && reasoning.length > 0) {
    row.reasoning = reasoning;
  }
  const finishReason = nonEmptyString(raw.finish_reason) ?? nonEmptyString(raw.finishReason);
  if (finishReason) {
    row.finish_reason = finishReason;
  }
  const reasoningTokens = optFiniteNumber(raw.reasoning_tokens) ?? optFiniteNumber(raw.reasoningTokens);
  if (reasoningTokens !== undefined) {
    row.reasoning_tokens = reasoningTokens;
  }
  return row;
}

function lastWinsById(rows: RunCaseRow[]): RunCaseRow[] {
  const map = new Map<string, RunCaseRow>();
  for (const row of rows) {
    map.set(row.id, row);
  }
  return [...map.values()];
}

function parseScoresRows(rows: unknown[], extras: Partial<ParsedRunArtifact> = {}): ParsedRunArtifact {
  const caseRows: RunCaseRow[] = [];
  const splitMeans: Partial<Record<RunSplitName, number>> = { ...extras.splitMeans };
  let model = extras.model;
  let metricId = extras.metricId;
  let versionId = extras.versionId;

  for (const raw of rows) {
    if (!isRecord(raw)) {
      continue;
    }
    const caseId = nonEmptyString(raw.case_id) ?? nonEmptyString(raw.id);
    if (!caseId) {
      const split = optSplit(raw.split);
      const quality = optFiniteNumber(raw.quality);
      if (split && quality !== undefined) {
        splitMeans[split] = quality;
      }
      if (!model) {
        model = nonEmptyString(raw.model_id) ?? nonEmptyString(raw.model);
      }
      if (!metricId) {
        metricId = nonEmptyString(raw.metric_id);
      }
      if (!versionId) {
        versionId = nonEmptyString(raw.version_id);
      }
      continue;
    }
    const row = rowFromUnknown(raw);
    if (!row) {
      continue;
    }
    caseRows.push(row);
    model = nonEmptyString(raw.model_id) ?? nonEmptyString(raw.model) ?? model;
    metricId = nonEmptyString(raw.metric_id) ?? metricId;
    versionId = nonEmptyString(raw.version_id) ?? versionId;
  }

  const cases = lastWinsById(caseRows);
  const qualities = cases.map((item) => item.quality).filter((n): n is number => n !== undefined);
  return {
    kind: "scores",
    model,
    metricId,
    versionId,
    temperature: extras.temperature,
    meanQuality: extras.meanQuality ?? mean(qualities),
    splitMeans: Object.keys(splitMeans).length > 0 ? splitMeans : undefined,
    cases,
  };
}

function parseSplitCases(raw: unknown, split: RunSplitName): { meanQuality?: number; cases: RunCaseRow[] } {
  if (!isRecord(raw)) {
    return { cases: [] };
  }
  const cases: RunCaseRow[] = [];
  if (Array.isArray(raw.cases)) {
    for (const item of raw.cases) {
      const row = rowFromUnknown(item);
      if (row) {
        cases.push({ ...row, split: row.split ?? split });
      }
    }
  }
  return {
    meanQuality: optFiniteNumber(raw.meanQuality) ?? optFiniteNumber(raw.mean_quality),
    cases,
  };
}

function parseBaselineReport(raw: Record<string, unknown>): ParsedRunArtifact {
  const splitsRaw = raw.splits;
  if (!isRecord(splitsRaw)) {
    throw new RunArtifactError("Baseline report is missing splits.train / splits.val");
  }
  const train = parseSplitCases(splitsRaw.train, "train");
  const val = parseSplitCases(splitsRaw.val, "val");
  const cases = lastWinsById([...train.cases, ...val.cases]);
  const splitMeans: Partial<Record<RunSplitName, number>> = {};
  if (train.meanQuality !== undefined) {
    splitMeans.train = train.meanQuality;
  }
  if (val.meanQuality !== undefined) {
    splitMeans.val = val.meanQuality;
  }
  const qualities = cases.map((item) => item.quality).filter((n): n is number => n !== undefined);
  const reportedMeans = [train.meanQuality, val.meanQuality].filter((n): n is number => n !== undefined);
  return {
    kind: "report",
    model: nonEmptyString(raw.model) ?? nonEmptyString(raw.model_id),
    temperature: optFiniteNumber(raw.temperature),
    metricId: nonEmptyString(raw.metric_id) ?? nonEmptyString(raw.metricId),
    meanQuality: reportedMeans.length > 0 ? mean(reportedMeans) : mean(qualities),
    splitMeans: Object.keys(splitMeans).length > 0 ? splitMeans : undefined,
    cases,
  };
}

/**
 * Parse a scores.json array (or `{ scores: [...] }`) or a baseline report.json.
 * Aggregate score rows (no case id) are used for split means only.
 */
export function parseRunArtifact(raw: unknown): ParsedRunArtifact {
  if (Array.isArray(raw)) {
    const parsed = parseScoresRows(raw);
    if (parsed.cases.length === 0 && raw.length > 0) {
      throw new RunArtifactError("scores.json has no case rows (case_id / id)");
    }
    return parsed;
  }
  if (!isRecord(raw)) {
    throw new RunArtifactError("Run artifact must be a JSON object or a scores array");
  }
  if (Array.isArray(raw.scores)) {
    return parseScoresRows(raw.scores, {
      model: nonEmptyString(raw.model) ?? nonEmptyString(raw.model_id),
      temperature: optFiniteNumber(raw.temperature),
      metricId: nonEmptyString(raw.metric_id),
      versionId: nonEmptyString(raw.version_id),
      meanQuality: optFiniteNumber(raw.meanQuality) ?? optFiniteNumber(raw.mean_quality),
    });
  }
  if (isRecord(raw.splits)) {
    return parseBaselineReport(raw);
  }
  if (nonEmptyString(raw.case_id) || nonEmptyString(raw.id)) {
    return parseScoresRows([raw]);
  }
  throw new RunArtifactError(
    "Unrecognized run artifact. Expected scores.json rows (case_id + output) or a baseline report.json with splits.*.cases",
  );
}

export function loadRunArtifactFromFile(path: string): ParsedRunArtifact {
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new RunArtifactError(`Run file not found: ${resolved}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    throw new RunArtifactError(`Run file is not valid JSON: ${resolved}`);
  }
  const parsed = parseRunArtifact(data);
  parsed.path = resolved;
  return parsed;
}

export function joinRunToSuite(
  suiteCaseIds: readonly string[],
  artifact: ParsedRunArtifact,
  nsfw: boolean,
): Map<string, JoinedCasePrediction> {
  const byId = new Map(artifact.cases.map((row) => [row.id, row]));
  const joined = new Map<string, JoinedCasePrediction>();
  for (const id of suiteCaseIds) {
    const row = byId.get(id);
    if (!row) {
      joined.set(id, { status: "none" });
      continue;
    }
    const prediction: JoinedCasePrediction = {
      status: predictionStatus(row),
    };
    if (row.output !== undefined) {
      prediction.output = row.output;
    }
    const label = predictedDisplayLabel(row.output, nsfw);
    if (label !== undefined) {
      prediction.predictedLabel = label;
    }
    if (row.quality !== undefined) {
      prediction.quality = row.quality;
    }
    if (row.note) {
      prediction.note = row.note;
    }
    if (row.error) {
      prediction.error = row.error;
    }
    if (row.reasoning) {
      prediction.reasoning = row.reasoning;
    }
    if (row.finish_reason) {
      prediction.finish_reason = row.finish_reason;
    }
    if (row.reasoning_tokens !== undefined) {
      prediction.reasoning_tokens = row.reasoning_tokens;
    }
    if (row.split) {
      prediction.runSplit = row.split;
    }
    joined.set(id, prediction);
  }
  return joined;
}

export function summarizeJoinedRun(
  artifact: ParsedRunArtifact,
  joined: Map<string, JoinedCasePrediction>,
): RunOverlaySummary {
  let hitCount = 0;
  let missCount = 0;
  let errorCount = 0;
  let noneCount = 0;
  for (const prediction of joined.values()) {
    if (prediction.status === "ok") {
      hitCount += 1;
    } else if (prediction.status === "miss") {
      missCount += 1;
    } else if (prediction.status === "error") {
      errorCount += 1;
    } else {
      noneCount += 1;
    }
  }
  return {
    path: artifact.path,
    kind: artifact.kind,
    model: artifact.model,
    temperature: artifact.temperature,
    metricId: artifact.metricId,
    versionId: artifact.versionId,
    meanQuality: artifact.meanQuality,
    splitMeans: artifact.splitMeans,
    hitCount,
    missCount,
    errorCount,
    noneCount,
  };
}

function walkRunFiles(dir: string, depth: number, maxDepth: number, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && RUN_FILE_NAME_SET.has(entry.name)) {
      out.push(full);
      continue;
    }
    if (
      entry.isDirectory() &&
      depth < maxDepth &&
      entry.name !== "node_modules" &&
      !entry.name.startsWith(".")
    ) {
      walkRunFiles(full, depth + 1, maxDepth, out);
    }
  }
}

/** List `report.json` / `scores.json` under a folder (shallow, max 3 levels). */
export function listRunArtifacts(dir: string, maxDepth = 3): RunListItem[] {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new RunArtifactError(`Runs directory not found: ${root}`);
  }
  const files: string[] = [];
  walkRunFiles(root, 0, maxDepth, files);
  files.sort((a, b) => a.localeCompare(b));
  return files.map((path) => {
    const rel = relative(root, path);
    return {
      path,
      name: basename(path),
      label: rel || basename(path),
    };
  });
}

export function resolveRunPath(path: string, cwd = process.cwd()): string {
  return resolve(cwd, path);
}
