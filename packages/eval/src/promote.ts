export interface PromotionDecision {
  promote: boolean;
  reason: "val_improved" | "val_not_improved" | "train_only";
  message: string;
}

function fmt(n: number): string {
  return n.toFixed(3);
}

/**
 * Auto-promote only when a val split exists and candidate mean quality strictly rises.
 * Train-only suites never auto-promote.
 */
export function promotionDecision(input: {
  hasVal: boolean;
  valBaseline?: number;
  valCandidate?: number;
}): PromotionDecision {
  if (!input.hasVal) {
    return {
      promote: false,
      reason: "train_only",
      message:
        "No val split — refusing auto-promote (train-only). Export a chosen version, or run: sysprompt promote <card> [version]",
    };
  }
  const baseline = input.valBaseline ?? 0;
  const candidate = input.valCandidate ?? 0;
  if (candidate > baseline) {
    return {
      promote: true,
      reason: "val_improved",
      message: `val mean quality rose (${fmt(baseline)} → ${fmt(candidate)}); promoted candidate.`,
    };
  }
  return {
    promote: false,
    reason: "val_not_improved",
    message: `val mean quality did not strictly rise (${fmt(baseline)} → ${fmt(candidate)}); candidate left unpromoted (promoted=false).`,
  };
}

export interface AdoptDecision {
  adopt: boolean;
  reason: "val_improved" | "val_tie_train_improved" | "train_improved" | "no_improvement";
}

/**
 * R1 mid-loop adopt. If val exists, val must strictly rise; a val tie uses train
 * as the tie-break. Without val, train must strictly rise.
 */
export function adoptDecision(input: {
  hasVal: boolean;
  currentVal?: number;
  candidateVal?: number;
  currentTrain: number;
  candidateTrain: number;
}): AdoptDecision {
  if (input.hasVal) {
    const currentVal = input.currentVal ?? 0;
    const candidateVal = input.candidateVal ?? 0;
    if (candidateVal > currentVal) {
      return { adopt: true, reason: "val_improved" };
    }
    if (candidateVal === currentVal && input.candidateTrain > input.currentTrain) {
      return { adopt: true, reason: "val_tie_train_improved" };
    }
    return { adopt: false, reason: "no_improvement" };
  }
  if (input.candidateTrain > input.currentTrain) {
    return { adopt: true, reason: "train_improved" };
  }
  return { adopt: false, reason: "no_improvement" };
}

/**
 * R1 end-of-loop promote: final val (or train if the suite has no val cases)
 * must strictly beat the original baseline. Unlike R0, train-only suites may
 * auto-promote when train rises.
 */
export function r1PromotionDecision(input: {
  hasVal: boolean;
  originalVal?: number;
  finalVal?: number;
  originalTrain: number;
  finalTrain: number;
}): PromotionDecision {
  if (input.hasVal) {
    const baseline = input.originalVal ?? 0;
    const candidate = input.finalVal ?? 0;
    if (candidate > baseline) {
      return {
        promote: true,
        reason: "val_improved",
        message: `val mean quality rose (${fmt(baseline)} → ${fmt(candidate)}); promoted best candidate.`,
      };
    }
    return {
      promote: false,
      reason: "val_not_improved",
      message: `val mean quality did not strictly rise vs original baseline (${fmt(baseline)} → ${fmt(candidate)}); left unpromoted (promoted=false).`,
    };
  }
  if (input.finalTrain > input.originalTrain) {
    return {
      promote: true,
      reason: "val_improved",
      message: `No val split — train mean quality rose (${fmt(input.originalTrain)} → ${fmt(input.finalTrain)}); promoted best candidate.`,
    };
  }
  return {
    promote: false,
    reason: "train_only",
    message: `No val split — train mean quality did not strictly rise vs original baseline (${fmt(input.originalTrain)} → ${fmt(input.finalTrain)}); left unpromoted (promoted=false).`,
  };
}
