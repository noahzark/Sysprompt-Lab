import { renameSync, statSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { loadSuiteFromFile, normalizeSuite } from "@sysprompt-lab/core";
import { parse as parseYaml, parseDocument, isMap, isSeq } from "yaml";
import { mergeCaseGold, type CaseGoldUpdate } from "./gold.js";

export class SuiteConflictError extends Error {
  readonly mtimeMs: number;

  constructor(mtimeMs: number) {
    super("Suite file changed on disk. Reload or confirm overwrite.");
    this.name = "SuiteConflictError";
    this.mtimeMs = mtimeMs;
  }
}

export interface SaveSuiteCaseOptions {
  expectedMtimeMs?: number;
  force?: boolean;
}

export interface SaveSuiteCaseResult {
  mtimeMs: number;
}

export function suiteMtimeMs(path: string): number {
  return statSync(path).mtimeMs;
}

function isYamlPath(path: string): boolean {
  return path.endsWith(".yaml") || path.endsWith(".yml");
}

function applyUpdateToJsonText(raw: string, caseId: string, update: CaseGoldUpdate): string {
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Suite JSON root must be an object");
  }
  const cases = (data as { cases?: unknown }).cases;
  if (!Array.isArray(cases)) {
    throw new Error("Suite JSON is missing a cases array");
  }
  const found = cases.find(
    (item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object" && !Array.isArray(item) && item.id === caseId),
  );
  if (!found) {
    throw new Error(`Unknown case "${caseId}"`);
  }
  if ("gold" in update) {
    if (update.gold === undefined || update.gold === null) {
      delete found.gold;
    } else {
      found.gold = update.gold;
    }
  }
  if ("notes" in update) {
    if (update.notes === undefined || update.notes === null || update.notes === "") {
      delete found.feedback;
    } else {
      found.feedback = update.notes;
    }
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

function applyUpdateToYamlText(raw: string, caseId: string, update: CaseGoldUpdate): string {
  const doc = parseDocument(raw);
  const cases = doc.get("cases");
  if (!isSeq(cases)) {
    throw new Error("Suite YAML is missing a cases sequence");
  }
  let found = false;
  for (const item of cases.items) {
    if (!isMap(item)) {
      continue;
    }
    if (item.get("id") !== caseId) {
      continue;
    }
    found = true;
    if ("gold" in update) {
      if (update.gold === undefined || update.gold === null) {
        item.delete("gold");
      } else {
        item.set("gold", doc.createNode(update.gold));
      }
    }
    if ("notes" in update) {
      if (update.notes === undefined || update.notes === null || update.notes === "") {
        item.delete("feedback");
      } else {
        item.set("feedback", update.notes);
      }
    }
    break;
  }
  if (!found) {
    throw new Error(`Unknown case "${caseId}"`);
  }
  return doc.toString({ lineWidth: 0 });
}

/** Patch gold/notes on one case in the raw suite document (preserves other keys/order). */
export function applyCaseUpdateToSuiteText(
  raw: string,
  path: string,
  caseId: string,
  update: CaseGoldUpdate,
): string {
  return isYamlPath(path)
    ? applyUpdateToYamlText(raw, caseId, update)
    : applyUpdateToJsonText(raw, caseId, update);
}

function parseSuiteText(raw: string, path: string): unknown {
  return isYamlPath(path) ? parseYaml(raw) : JSON.parse(raw);
}

function atomicWrite(path: string, text: string): void {
  const ext = extname(path) || ".yaml";
  const tmp = `${path}.${process.pid}.tmp${ext}`;
  writeFileSync(tmp, text, "utf8");
  try {
    loadSuiteFromFile(tmp);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup
    }
    throw error;
  }
}

/**
 * Validate a gold/notes update, write it into the suite file (temp + rename),
 * and re-parse the result. Other fields and YAML comments stay as much as practical.
 */
export function saveSuiteCase(
  path: string,
  caseId: string,
  update: CaseGoldUpdate,
  options: SaveSuiteCaseOptions = {},
): SaveSuiteCaseResult {
  const currentMtime = suiteMtimeMs(path);
  if (
    !options.force &&
    options.expectedMtimeMs !== undefined &&
    Math.abs(currentMtime - options.expectedMtimeMs) > 1
  ) {
    throw new SuiteConflictError(currentMtime);
  }
  const current = loadSuiteFromFile(path);
  mergeCaseGold(current, caseId, update);
  const raw = readFileSync(path, "utf8");
  const nextText = applyCaseUpdateToSuiteText(raw, path, caseId, update);
  normalizeSuite(parseSuiteText(nextText, path));
  atomicWrite(path, nextText);
  loadSuiteFromFile(path);
  return { mtimeMs: suiteMtimeMs(path) };
}
