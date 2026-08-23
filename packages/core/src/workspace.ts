import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type Candidate,
  type PromptCard,
  type EvalSuite,
  type Run,
  type Score,
  normalizeSuite,
  parseCandidate,
  parseCard,
  parseRun,
  parseScore,
} from "./schemas.js";

export interface Workspace {
  root: string;
  splDir: string;
  cardsDir: string;
  suitesDir: string;
  runsDir: string;
  exportDir: string;
}

/**
 * Walk upward from `startDir` to the repo root (package.json plus
 * `python/sysprompt_gepa` or `schemas/`). Used by schema emit and the R2 sidecar.
 */
export function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 12; i++) {
    const hasPkg = existsSync(join(dir, "package.json"));
    const hasPython = existsSync(join(dir, "python", "sysprompt_gepa"));
    const hasSchemas = existsSync(join(dir, "schemas"));
    if (hasPkg && (hasPython || hasSchemas)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    `Could not find Sysprompt Lab repo root (looked upward from ${startDir}). ` +
      `Expected package.json plus python/sysprompt_gepa or schemas/.`,
  );
}

export function openWorkspace(root = process.cwd()): Workspace {
  const resolved = resolve(root);
  const splDir = join(resolved, ".spl");
  return {
    root: resolved,
    splDir,
    cardsDir: join(splDir, "cards"),
    suitesDir: join(splDir, "suites"),
    runsDir: join(splDir, "runs"),
    exportDir: join(splDir, "export"),
  };
}

export function ensureWorkspace(ws: Workspace): void {
  for (const dir of [ws.splDir, ws.cardsDir, ws.suitesDir, ws.runsDir, ws.exportDir]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error(`Cannot derive an id from "${value}"`);
  }
  return slug;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function cardPath(ws: Workspace, id: string): string {
  return join(ws.cardsDir, `${id}.json`);
}

export function suitePath(ws: Workspace, id: string): string {
  return join(ws.suitesDir, `${id}.json`);
}

export function runDir(ws: Workspace, id: string): string {
  return join(ws.runsDir, id);
}

export function writeCard(ws: Workspace, card: PromptCard): string {
  ensureWorkspace(ws);
  const path = cardPath(ws, card.id);
  writeJson(path, parseCard(card));
  return path;
}

export function writeSuite(ws: Workspace, suite: EvalSuite): string {
  ensureWorkspace(ws);
  const path = suitePath(ws, suite.id);
  writeJson(path, suite);
  return path;
}

export function writeJsonl(path: string, rows: unknown[]): void {
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(path, body.length > 0 ? `${body}\n` : "", "utf8");
}

export function writeRun(
  ws: Workspace,
  run: Run,
  candidates: Candidate[],
  extra?: {
    diff?: string;
    diffName?: string;
    scores?: Score[];
    candidatesJsonl?: unknown[];
    summary?: string;
    sections?: unknown;
    patch?: unknown;
  },
): {
  dir: string;
  runPath: string;
  candidatesPath: string;
  diffPath?: string;
  scoresPath?: string;
  candidatesJsonlPath?: string;
  summaryPath?: string;
  sectionsPath?: string;
  patchPath?: string;
} {
  ensureWorkspace(ws);
  const dir = runDir(ws, run.id);
  mkdirSync(dir, { recursive: true });
  const runPath = join(dir, "run.json");
  const candidatesPath = join(dir, "candidates.json");
  writeJson(runPath, parseRun(run));
  writeJson(
    candidatesPath,
    candidates.map((c) => parseCandidate(c)),
  );
  let diffPath: string | undefined;
  if (extra?.diff !== undefined) {
    diffPath = join(dir, extra.diffName ?? "r0.diff");
    writeFileSync(diffPath, extra.diff.endsWith("\n") ? extra.diff : `${extra.diff}\n`, "utf8");
  }
  let scoresPath: string | undefined;
  if (extra?.scores) {
    scoresPath = join(dir, "scores.json");
    writeJson(
      scoresPath,
      extra.scores.map((s) => parseScore(s)),
    );
  }
  let candidatesJsonlPath: string | undefined;
  if (extra?.candidatesJsonl) {
    candidatesJsonlPath = join(dir, "candidates.jsonl");
    writeJsonl(candidatesJsonlPath, extra.candidatesJsonl);
  }
  let summaryPath: string | undefined;
  if (extra?.summary !== undefined) {
    summaryPath = join(dir, "summary.md");
    writeFileSync(
      summaryPath,
      extra.summary.endsWith("\n") ? extra.summary : `${extra.summary}\n`,
      "utf8",
    );
  }
  let sectionsPath: string | undefined;
  if (extra?.sections !== undefined) {
    sectionsPath = join(dir, "sections.json");
    writeJson(sectionsPath, extra.sections);
  }
  let patchPath: string | undefined;
  if (extra?.patch !== undefined) {
    patchPath = join(dir, "patch.json");
    writeJson(patchPath, extra.patch);
  }
  return {
    dir,
    runPath,
    candidatesPath,
    diffPath,
    scoresPath,
    candidatesJsonlPath,
    summaryPath,
    sectionsPath,
    patchPath,
  };
}

export function loadCardFromFile(path: string): PromptCard {
  return parseCard(readJson(path));
}

export function loadSuiteFromFile(path: string): EvalSuite {
  const raw = readFileSync(path, "utf8");
  const data = path.endsWith(".yaml") || path.endsWith(".yml") ? parseYaml(raw) : JSON.parse(raw);
  return normalizeSuite(data);
}

export function resolveCardRef(ws: Workspace, ref: string): string {
  if (ref.endsWith(".json")) {
    return isAbsolute(ref) ? ref : resolve(ws.root, ref);
  }
  return cardPath(ws, ref);
}

export function loadCard(ws: Workspace, ref: string): PromptCard {
  return loadCardFromFile(resolveCardRef(ws, ref));
}

export function loadSuite(ws: Workspace, ref: string): EvalSuite {
  if (ref.endsWith(".json") || ref.endsWith(".yaml") || ref.endsWith(".yml")) {
    const path = isAbsolute(ref) ? ref : resolve(ws.root, ref);
    return loadSuiteFromFile(path);
  }
  return loadSuiteFromFile(suitePath(ws, ref));
}

export function listCardIds(ws: Workspace): string[] {
  try {
    return readdirSync(ws.cardsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
}
