import type { EvalCase, EvalSuite, Metric } from "@sysprompt-lab/core";
import { goldAcceptSet, isNsfwSeverityTag, NSFW_SEVERITY_TAGS } from "@sysprompt-lab/eval";

export const NSFW_METRIC_ID = "nsfw_severity_tag";

export { NSFW_SEVERITY_TAGS };

export class GoldUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldUpdateError";
  }
}

export interface CaseGoldUpdate {
  gold?: unknown;
  /** Persisted as `feedback` on the eval case. */
  notes?: string | null;
}

export function isNsfwMetric(metric: Metric): boolean {
  return metric.kind === "custom" && metric.id === NSFW_METRIC_ID;
}

export function isUnlabeledGold(gold: unknown, nsfw: boolean): boolean {
  if (gold === undefined || gold === null) {
    return true;
  }
  if (typeof gold === "string" && gold.trim() === "") {
    return true;
  }
  if (nsfw) {
    return goldAcceptSet(gold).length === 0;
  }
  return false;
}

function collectNsfwGoldValues(gold: unknown): string[] {
  if (typeof gold === "string") {
    const trimmed = gold.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!gold || typeof gold !== "object" || Array.isArray(gold)) {
    throw new GoldUpdateError("NSFW gold must be a string or a { severity, accept } object");
  }
  const obj = gold as { severity?: unknown; accept?: unknown };
  const values: string[] = [];
  if (obj.severity === undefined) {
    // ok — accept-only gold is allowed
  } else if (typeof obj.severity === "string") {
    const trimmed = obj.severity.trim();
    if (trimmed) {
      values.push(trimmed);
    }
  } else if (Array.isArray(obj.severity)) {
    for (const item of obj.severity) {
      if (typeof item !== "string") {
        throw new GoldUpdateError("NSFW gold severity[] items must be strings");
      }
      const trimmed = item.trim();
      if (trimmed) {
        values.push(trimmed);
      }
    }
  } else {
    throw new GoldUpdateError("NSFW gold severity must be a string or string array");
  }
  if (obj.accept !== undefined) {
    if (!Array.isArray(obj.accept)) {
      throw new GoldUpdateError("NSFW gold accept must be an array of strings");
    }
    for (const item of obj.accept) {
      if (typeof item !== "string") {
        throw new GoldUpdateError("NSFW gold accept[] items must be strings");
      }
      const trimmed = item.trim();
      if (trimmed) {
        values.push(trimmed);
      }
    }
  }
  return values;
}

/** Reject unknown NSFW severity labels. Generic metrics accept any gold. */
export function validateGoldForMetric(metric: Metric, gold: unknown): void {
  if (gold === undefined || gold === null) {
    return;
  }
  if (!isNsfwMetric(metric)) {
    return;
  }
  if (typeof gold === "string" && gold.trim() === "") {
    return;
  }
  const values = collectNsfwGoldValues(gold);
  for (const value of values) {
    if (!isNsfwSeverityTag(value)) {
      throw new GoldUpdateError(
        `Invalid NSFW severity "${value}". Allowed: ${NSFW_SEVERITY_TAGS.join(" / ")}`,
      );
    }
  }
}

/**
 * Return a new suite with one case's gold and/or notes updated.
 * Notes map to the schema field `feedback`.
 */
export function mergeCaseGold(suite: EvalSuite, caseId: string, update: CaseGoldUpdate): EvalSuite {
  const idx = suite.cases.findIndex((item) => item.id === caseId);
  if (idx < 0) {
    throw new GoldUpdateError(`Unknown case "${caseId}"`);
  }
  if ("gold" in update) {
    validateGoldForMetric(suite.metric, update.gold);
  }
  const current = suite.cases[idx]!;
  const nextCase: EvalCase = { ...current };
  if ("gold" in update) {
    if (update.gold === undefined || update.gold === null) {
      delete nextCase.gold;
    } else {
      nextCase.gold = update.gold;
    }
  }
  if ("notes" in update) {
    if (update.notes === undefined || update.notes === null || update.notes === "") {
      delete nextCase.feedback;
    } else {
      nextCase.feedback = update.notes;
    }
  }
  const cases = suite.cases.slice();
  cases[idx] = nextCase;
  return { ...suite, cases };
}
