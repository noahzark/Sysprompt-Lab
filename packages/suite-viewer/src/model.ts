import { dirname } from "node:path";
import type { EvalCase, EvalSuite, SplitName } from "@sysprompt-lab/core";
import {
  caseHasImage,
  caseUserText,
  goldAcceptSet,
  goldSeverity,
  goldText,
  type ImageResolveOptions,
} from "@sysprompt-lab/eval";
import { isNsfwMetric, isUnlabeledGold } from "./gold.js";
import { caseImageResolve } from "./paths.js";

export const UNLABELED_BUCKET = "(unlabeled)";

export interface SuiteOverview {
  id: string;
  name: string;
  metricId: string;
  metricKind: string;
  nsfw: boolean;
  trainSize: number;
  valSize: number;
  unlabeledCount: number;
  missingImageCount: number;
  goldHistogram: Record<string, number>;
}

export interface CaseSummary {
  id: string;
  split: SplitName | "unassigned";
  gold: unknown;
  goldLabel: string;
  severity?: string;
  accept: string[];
  hasImage: boolean;
  imageResolved: boolean;
  unlabeled: boolean;
  preview: string;
  notes?: string;
}

export interface CaseDetail extends CaseSummary {
  input: Record<string, unknown>;
  userText: string;
  imageRef?: string;
  imageRemote?: boolean;
}

function splitByCaseId(suite: EvalSuite): Map<string, SplitName> {
  const map = new Map<string, SplitName>();
  for (const name of ["train", "val"] as const) {
    for (const caseId of suite.splits[name].case_ids) {
      map.set(caseId, name);
    }
  }
  return map;
}

function goldLabel(gold: unknown, nsfw: boolean, unlabeled: boolean): string {
  if (unlabeled) {
    return UNLABELED_BUCKET;
  }
  if (nsfw) {
    const accept = goldAcceptSet(gold);
    const primary = goldSeverity(gold) ?? accept[0];
    if (accept.length > 1) {
      return `${primary} · accept ${accept.join("|")}`;
    }
    return primary ?? goldText(gold);
  }
  return goldText(gold);
}

function histogramKey(gold: unknown, nsfw: boolean, unlabeled: boolean): string {
  if (unlabeled) {
    return UNLABELED_BUCKET;
  }
  if (nsfw) {
    return goldSeverity(gold) ?? goldAcceptSet(gold)[0] ?? goldText(gold);
  }
  return goldText(gold);
}

function shortPreview(text: string, max = 80): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) {
    return collapsed;
  }
  return `${collapsed.slice(0, max - 1)}…`;
}

export function summarizeCase(
  suite: EvalSuite,
  evalCase: EvalCase,
  split: SplitName | "unassigned",
  imageOptions: ImageResolveOptions,
): CaseSummary {
  const nsfw = isNsfwMetric(suite.metric);
  const unlabeled = isUnlabeledGold(evalCase.gold, nsfw);
  const hasImage = caseHasImage(evalCase.input);
  const image = caseImageResolve(evalCase.input, imageOptions);
  return {
    id: evalCase.id,
    split,
    gold: evalCase.gold,
    goldLabel: goldLabel(evalCase.gold, nsfw, unlabeled),
    severity: goldSeverity(evalCase.gold),
    accept: goldAcceptSet(evalCase.gold),
    hasImage,
    imageResolved: image.resolved.ok,
    unlabeled,
    preview: shortPreview(caseUserText(evalCase.input)),
    notes: evalCase.feedback,
  };
}

export function buildCaseSummaries(suite: EvalSuite, imageOptions: ImageResolveOptions): CaseSummary[] {
  const splits = splitByCaseId(suite);
  return suite.cases.map((evalCase) =>
    summarizeCase(suite, evalCase, splits.get(evalCase.id) ?? "unassigned", imageOptions),
  );
}

export function buildOverview(suite: EvalSuite, cases: CaseSummary[]): SuiteOverview {
  const goldHistogram: Record<string, number> = {};
  for (const item of cases) {
    const key = histogramKey(item.gold, isNsfwMetric(suite.metric), item.unlabeled);
    goldHistogram[key] = (goldHistogram[key] ?? 0) + 1;
  }
  return {
    id: suite.id,
    name: suite.name,
    metricId: suite.metric.id,
    metricKind: suite.metric.kind,
    nsfw: isNsfwMetric(suite.metric),
    trainSize: suite.splits.train.case_ids.length,
    valSize: suite.splits.val.case_ids.length,
    unlabeledCount: cases.filter((item) => item.unlabeled).length,
    missingImageCount: cases.filter((item) => item.hasImage && !item.imageResolved).length,
    goldHistogram,
  };
}

export function buildCaseDetail(
  suite: EvalSuite,
  evalCase: EvalCase,
  split: SplitName | "unassigned",
  imageOptions: ImageResolveOptions,
): CaseDetail {
  const summary = summarizeCase(suite, evalCase, split, imageOptions);
  const image = caseImageResolve(evalCase.input, imageOptions);
  return {
    ...summary,
    input: evalCase.input,
    userText: caseUserText(evalCase.input),
    imageRef: image.ref,
    imageRemote: image.resolved.ok ? image.resolved.remote : undefined,
  };
}

export function imageOptionsForSuite(
  suitePath: string,
  imageDir?: string,
): ImageResolveOptions {
  return {
    imageDir,
    suiteDir: dirname(suitePath),
  };
}
