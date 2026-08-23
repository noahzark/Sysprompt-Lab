import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type PromptCard,
  type PromptVersion,
  type ToolSpec,
  exportVersion,
  parseToolSpec,
} from "@sysprompt-lab/core";
import {
  type Workspace,
  loadCard,
  loadSuiteFromFile,
  newId,
  openWorkspace,
  slugify,
  writeCard,
  writeSuite,
} from "@sysprompt-lab/core";
import { type RunR0Options, type RunR0Result, runR0 } from "@sysprompt-lab/rungs";
import { type RunR1Options, type RunR1Result, runR1 } from "@sysprompt-lab/rungs";
import { type RunR2Options, type RunR2Result, runR2 } from "@sysprompt-lab/rungs";

export type { RunR0Options, RunR0Result, RunR1Options, RunR1Result, RunR2Options, RunR2Result };

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

export { runR0, runR1, runR2 };

export interface PromoteResult {
  card: PromptCard;
  version: PromptVersion;
  cardPath: string;
}

/** Mark one version as the only promoted version (human accept). */
export function promoteVersion(
  cardRef: string,
  versionId?: string,
  options: { root?: string } = {},
): PromoteResult {
  const ws = openWorkspace(options.root);
  const card = loadCard(ws, cardRef);
  const version = versionId
    ? card.versions.find((v) => v.id === versionId)
    : [...card.versions].reverse().find((v) => !v.is_baseline) ?? card.versions.at(-1);
  if (!version) {
    throw new Error(
      versionId
        ? `Card "${card.id}" has no version "${versionId}"`
        : `Card "${card.id}" has no versions to promote`,
    );
  }
  for (const item of card.versions) {
    item.promoted = item.id === version.id;
  }
  card.status = "promoted";
  const cardPath = writeCard(ws, card);
  return { card, version, cardPath };
}

export function workspaceAt(root?: string): Workspace {
  return openWorkspace(root);
}
