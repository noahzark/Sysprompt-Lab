import { describe, expect, it } from "vitest";
import type { EvalSuite } from "@sysprompt-lab/core";
import { GoldUpdateError, mergeCaseGold, validateGoldForMetric } from "./gold.js";

const nsfwSuite = (): EvalSuite => ({
  id: "vision",
  name: "vision",
  metric: { id: "nsfw_severity_tag", kind: "custom", returns_feedback: true },
  splits: {
    train: { name: "train", case_ids: ["c1"] },
    val: { name: "val", case_ids: [] },
  },
  cases: [{ id: "c1", input: { user: "look" } }],
});

const textSuite = (): EvalSuite => ({
  id: "support",
  name: "support",
  metric: { id: "string_contains", kind: "custom", returns_feedback: false },
  splits: {
    train: { name: "train", case_ids: ["greet"] },
    val: { name: "val", case_ids: [] },
  },
  cases: [{ id: "greet", input: { user: "Hello" }, gold: "happy to help" }],
});

describe("mergeCaseGold", () => {
  it("merges NSFW gold and notes into the suite object", () => {
    const next = mergeCaseGold(nsfwSuite(), "c1", {
      gold: { severity: "软色情", accept: ["擦边", "软色情"] },
      notes: "borderline",
    });
    expect(next.cases[0]?.gold).toEqual({ severity: "软色情", accept: ["擦边", "软色情"] });
    expect(next.cases[0]?.feedback).toBe("borderline");
    expect(nsfwSuite().cases[0]?.gold).toBeUndefined();
  });

  it("clears gold and notes when they are null/empty", () => {
    const labeled = mergeCaseGold(nsfwSuite(), "c1", {
      gold: { severity: "性感" },
      notes: "keep",
    });
    const cleared = mergeCaseGold(labeled, "c1", { gold: null, notes: "" });
    expect(cleared.cases[0]?.gold).toBeUndefined();
    expect(cleared.cases[0]?.feedback).toBeUndefined();
  });

  it("updates generic string gold without touching other cases", () => {
    const suite = textSuite();
    suite.cases.push({ id: "other", input: { user: "x" }, gold: "stay" });
    suite.splits.train.case_ids.push("other");
    const next = mergeCaseGold(suite, "greet", { gold: "happy to help you" });
    expect(next.cases[0]?.gold).toBe("happy to help you");
    expect(next.cases[1]?.gold).toBe("stay");
  });

  it("rejects an unknown case id", () => {
    expect(() => mergeCaseGold(textSuite(), "missing", { gold: "x" })).toThrow(GoldUpdateError);
  });
});

describe("validateGoldForMetric", () => {
  const nsfw = nsfwSuite().metric;
  const custom = textSuite().metric;

  it("rejects an invalid NSFW severity", () => {
    expect(() => validateGoldForMetric(nsfw, { severity: "nope" })).toThrow(/Invalid NSFW severity/);
    expect(() => validateGoldForMetric(nsfw, "explicit")).toThrow(/Invalid NSFW severity/);
    expect(() => validateGoldForMetric(nsfw, { accept: ["软色情", "bad"] })).toThrow(/Invalid NSFW severity/);
    expect(() => mergeCaseGold(nsfwSuite(), "c1", { gold: { severity: "nope" } })).toThrow(
      /Invalid NSFW severity/,
    );
  });

  it("accepts the five NSFW labels and generic gold", () => {
    expect(() => validateGoldForMetric(nsfw, "性感")).not.toThrow();
    expect(() => validateGoldForMetric(nsfw, { severity: "擦边", accept: ["软色情"] })).not.toThrow();
    expect(() => validateGoldForMetric(nsfw, { severity: ["露骨", "硬色情"] })).not.toThrow();
    expect(() => validateGoldForMetric(custom, "any string gold")).not.toThrow();
    expect(() => validateGoldForMetric(custom, { foo: 1 })).not.toThrow();
  });
});
