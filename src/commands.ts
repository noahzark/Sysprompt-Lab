import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { unifiedPromptDiff } from "./diff.js";
import {
  type Candidate,
  type PromptCard,
  type PromptVersion,
  type Run,
  type ToolSpec,
  baselineVersion,
  exportVersion,
  parseToolSpec,
} from "./schemas.js";
import {
  type Workspace,
  loadCard,
  loadSuiteFromFile,
  newId,
  openWorkspace,
  slugify,
  writeCard,
  writeRun,
  writeSuite,
} from "./workspace.js";

export interface IngestResult {
  card: PromptCard;
  path: string;
}

export interface BindResult {
  card: PromptCard;
  cardPath: string;
  suitePath: string;
}

export interface ExportResult {
  card: PromptCard;
  cardPath: string;
  promptPath: string;
}

export interface RunR0Result {
  card: PromptCard;
  run: Run;
  candidate: Candidate;
  version: PromptVersion;
  diffPath: string;
}

function resolveUserPath(inputPath: string): string {
  return isAbsolute(inputPath) ? inputPath : resolve(process.cwd(), inputPath);
}

function resolveIngestDir(inputPath: string): string {
  const resolved = resolveUserPath(inputPath);
  if (!existsSync(resolved)) {
    throw new Error(`Path not found: ${resolved}`);
  }
  return resolved.endsWith(".md") ? dirname(resolved) : resolved;
}

function readTools(dir: string): ToolSpec[] {
  const path = join(dir, "tools.json");
  if (!existsSync(path)) {
    return [];
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const list = Array.isArray(raw) ? raw : (raw as { tools?: unknown }).tools;
  if (!Array.isArray(list)) {
    throw new Error(`tools.json must be an array or { "tools": [...] }`);
  }
  return list.map((item) => parseToolSpec(item));
}

export function ingest(inputPath: string, options: { root?: string; id?: string } = {}): IngestResult {
  const ws = openWorkspace(options.root);
  const dir = resolveIngestDir(inputPath);
  const systemPath = join(dir, "system.md");
  if (!existsSync(systemPath)) {
    throw new Error(`Expected system.md at ${systemPath}`);
  }
  const systemPrompt = readFileSync(systemPath, "utf8");
  const id = options.id ?? slugify(basename(dir));
  const version: PromptVersion = {
    id: newId("ver"),
    system_prompt: systemPrompt,
    is_baseline: true,
    promoted: false,
  };
  const card: PromptCard = {
    id,
    source: dir,
    rung: "R0",
    status: "draft",
    versions: [version],
    tools: readTools(dir),
    models: [],
  };
  const path = writeCard(ws, card);
  return { card, path };
}

export function bind(cardRef: string, suiteFile: string, options: { root?: string } = {}): BindResult {
  const ws = openWorkspace(options.root);
  const card = loadCard(ws, cardRef);
  const suitePathResolved = resolveUserPath(suiteFile);
  const suite = loadSuiteFromFile(suitePathResolved);
  const storedSuitePath = writeSuite(ws, suite);
  card.suite_id = suite.id;
  card.status = "bound";
  const cardPath = writeCard(ws, card);
  return { card, cardPath, suitePath: storedSuitePath };
}

export function exportCard(
  cardRef: string,
  options: { root?: string; out?: string } = {},
): ExportResult {
  const ws = openWorkspace(options.root);
  const card = loadCard(ws, cardRef);
  const version = exportVersion(card);
  const outDir = options.out ? resolveUserPath(options.out) : join(ws.exportDir, card.id);
  mkdirSync(outDir, { recursive: true });
  const exported: PromptCard = { ...card, status: "exported" };
  const cardPath = join(outDir, "card.json");
  const promptPath = join(outDir, "system.promoted.md");
  writeFileSync(cardPath, `${JSON.stringify(exported, null, 2)}\n`, "utf8");
  writeFileSync(promptPath, version.system_prompt, "utf8");
  writeCard(ws, exported);
  return { card: exported, cardPath, promptPath };
}

export function runR0(cardRef: string, options: { root?: string } = {}): RunR0Result {
  const ws = openWorkspace(options.root);
  const card = loadCard(ws, cardRef);
  const baseline = baselineVersion(card);
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
  return { card, run, candidate, version, diffPath: written.diffPath };
}

export function workspaceAt(root?: string): Workspace {
  return openWorkspace(root);
}
