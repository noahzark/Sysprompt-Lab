import { describe, expect, it } from "vitest";
import {
  adoptDecision,
  caseUserText,
  formatScoreTable,
  promotionDecision,
  r1PromotionDecision,
  scoreCase,
} from "@sysprompt-lab/eval";
import type { Metric } from "@sysprompt-lab/core";

const exact: Metric = { id: "exact", kind: "exact", returns_feedback: false };
const custom: Metric = { id: "string_contains", kind: "custom", returns_feedback: false };
const judge: Metric = { id: "judge", kind: "llm_judge", returns_feedback: true };

describe("scoreCase", () => {
  it("scores exact after trim", () => {
    expect(scoreCase(exact, "hello\n", "hello").quality).toBe(1);
    expect(scoreCase(exact, "hello", "Hello").quality).toBe(0);
  });

  it("scores custom as case-insensitive string-contains (support-bot style)", () => {
    expect(scoreCase(custom, "Happy to help with that.", "happy to help").quality).toBe(1);
    expect(scoreCase(custom, "We have a 30-day return window.", "30-day").quality).toBe(1);
    expect(scoreCase(custom, "store opens at noon", "09:00").quality).toBe(0);
  });

  it("stubs llm_judge with a clear error", () => {
    expect(() => scoreCase(judge, "ok", "ok")).toThrow(/llm_judge is not implemented/);
  });
});

describe("caseUserText", () => {
  it("prefers user / message fields and falls back to JSON", () => {
    expect(caseUserText({ user: "Hello" })).toBe("Hello");
    expect(caseUserText({ message: "Hi" })).toBe("Hi");
    expect(caseUserText({ order: 1 })).toBe('{"order":1}');
  });
});

describe("promotionDecision", () => {
  it("promotes only when val mean quality strictly rises", () => {
    expect(promotionDecision({ hasVal: true, valBaseline: 0.5, valCandidate: 0.75 }).promote).toBe(true);
    expect(promotionDecision({ hasVal: true, valBaseline: 0.5, valCandidate: 0.5 }).promote).toBe(false);
    expect(promotionDecision({ hasVal: true, valBaseline: 0.8, valCandidate: 0.2 }).promote).toBe(false);
  });

  it("refuses auto-promote when there is no val split", () => {
    const decision = promotionDecision({ hasVal: false, valBaseline: 1, valCandidate: 1 });
    expect(decision.promote).toBe(false);
    expect(decision.reason).toBe("train_only");
    expect(decision.message).toMatch(/train-only/);
  });
});

describe("adoptDecision", () => {
  it("requires a strict val rise and uses train as a val-tie break", () => {
    expect(
      adoptDecision({
        hasVal: true,
        currentVal: 0.5,
        candidateVal: 0.75,
        currentTrain: 0.2,
        candidateTrain: 0.1,
      }).adopt,
    ).toBe(true);
    expect(
      adoptDecision({
        hasVal: true,
        currentVal: 0.5,
        candidateVal: 0.5,
        currentTrain: 0.2,
        candidateTrain: 0.4,
      }).reason,
    ).toBe("val_tie_train_improved");
    expect(
      adoptDecision({
        hasVal: true,
        currentVal: 0.5,
        candidateVal: 0.4,
        currentTrain: 0.2,
        candidateTrain: 1,
      }).adopt,
    ).toBe(false);
  });

  it("requires a strict train rise when there is no val split", () => {
    expect(
      adoptDecision({ hasVal: false, currentTrain: 0.2, candidateTrain: 0.3 }).adopt,
    ).toBe(true);
    expect(
      adoptDecision({ hasVal: false, currentTrain: 0.3, candidateTrain: 0.3 }).adopt,
    ).toBe(false);
  });
});

describe("r1PromotionDecision", () => {
  it("promotes when final val (or train if no val) beats the original baseline", () => {
    expect(
      r1PromotionDecision({
        hasVal: true,
        originalVal: 0.4,
        finalVal: 0.6,
        originalTrain: 0.1,
        finalTrain: 0.2,
      }).promote,
    ).toBe(true);
    expect(
      r1PromotionDecision({
        hasVal: true,
        originalVal: 0.5,
        finalVal: 0.5,
        originalTrain: 0.1,
        finalTrain: 0.9,
      }).promote,
    ).toBe(false);
    expect(
      r1PromotionDecision({
        hasVal: false,
        originalTrain: 0.2,
        finalTrain: 0.8,
      }).promote,
    ).toBe(true);
  });
});

describe("formatScoreTable", () => {
  it("prints quality and latency columns", () => {
    const table = formatScoreTable([
      {
        split: "train",
        baselineQuality: 0.5,
        candidateQuality: 0.75,
        baselineLatency: 100,
        candidateLatency: 120,
      },
    ]);
    expect(table).toMatch(/train\s+0\.500\s+0\.750\s+\+0\.250/);
    expect(table).toMatch(/100/);
    expect(table).toMatch(/120/);
  });
});
