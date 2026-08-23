import { describe, expect, it } from "vitest";
import { caseUserText, formatScoreTable, scoreCase } from "../src/eval.js";
import { parseRewriteResponse, shortHypothesis } from "../src/rewrite.js";
import { promotionDecision } from "../src/promote.js";
import type { Metric } from "../src/schemas.js";

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

describe("parseRewriteResponse", () => {
  it("reads JSON hypothesis + system_prompt", () => {
    const parsed = parseRewriteResponse(
      JSON.stringify({ hypothesis: "Clarify the refund window", system_prompt: "You are helpful." }),
    );
    expect(parsed.hypothesis).toBe("Clarify the refund window");
    expect(parsed.system_prompt).toBe("You are helpful.");
  });

  it("falls back to the raw text and a truncated hypothesis", () => {
    const parsed = parseRewriteResponse("Be a careful support agent who never invents orders.");
    expect(parsed.system_prompt).toContain("never invents");
    expect(parsed.hypothesis).toBe(shortHypothesis(parsed.system_prompt));
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
