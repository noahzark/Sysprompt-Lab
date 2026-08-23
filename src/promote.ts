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
