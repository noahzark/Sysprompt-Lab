import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RunArtifactError,
  joinRunToSuite,
  listRunArtifacts,
  loadRunArtifactFromFile,
  parseRunArtifact,
  predictedDisplayLabel,
  summarizeJoinedRun,
} from "./run.js";

const SUITE_IDS = ["greet-hello", "refund-ask", "hours-ask", "ghost"];

const officialScores = [
  {
    quality: 0.75,
    split: "train",
    model_id: "gpt-x",
    metric_id: "string_contains",
    version_id: "ver_candidate",
  },
  {
    quality: 1,
    latency_ms: 12,
    split: "train",
    model_id: "gpt-x",
    metric_id: "string_contains",
    version_id: "ver_candidate",
    case_id: "greet-hello",
    output: "happy to help you today",
    reasoning: "greet politely",
    finish_reason: "stop",
    reasoning_tokens: 4,
  },
  {
    quality: 0,
    split: "train",
    model_id: "gpt-x",
    metric_id: "string_contains",
    version_id: "ver_baseline",
    case_id: "refund-ask",
    output: "nope",
  },
  {
    quality: 0,
    split: "train",
    model_id: "gpt-x",
    metric_id: "string_contains",
    version_id: "ver_candidate",
    case_id: "refund-ask",
    output: "I can process that",
    reasoning: "missed the window",
    finish_reason: "stop",
    reasoning_tokens: 2,
  },
  {
    quality: 0,
    split: "val",
    model_id: "gpt-x",
    metric_id: "string_contains",
    version_id: "ver_candidate",
    case_id: "hours-ask",
    output: "",
  },
  {
    quality: 1,
    split: "train",
    model_id: "other-model",
    metric_id: "string_contains",
    version_id: "ver_candidate",
    case_id: "extra-only",
    output: "not in the suite",
  },
];

const baselineReport = {
  model: "local-qwen",
  temperature: 0,
  splits: {
    train: {
      meanQuality: 0.5,
      cases: [
        {
          id: "greet-hello",
          gold: "happy to help",
          quality: 1,
          note: "contains gold",
          output: "happy to help",
        },
        {
          id: "refund-ask",
          gold: "30-day",
          quality: 0,
          note: "missed policy",
          output: "sorry",
          error: undefined,
        },
      ],
    },
    val: {
      meanQuality: 0,
      cases: [
        {
          id: "hours-ask",
          gold: "09:00",
          quality: 0,
          note: "empty",
          output: "",
        },
        {
          id: "extra-val",
          gold: "x",
          quality: 1,
          output: "x",
        },
      ],
    },
  },
};

describe("parseRunArtifact", () => {
  it("parses official scores.json rows and ignores extra / aggregate ids", () => {
    const parsed = parseRunArtifact(officialScores);
    expect(parsed.kind).toBe("scores");
    expect(parsed.model).toBe("other-model");
    expect(parsed.metricId).toBe("string_contains");
    expect(parsed.splitMeans?.train).toBe(0.75);
    expect(parsed.cases.map((row) => row.id).sort()).toEqual(
      ["extra-only", "greet-hello", "hours-ask", "refund-ask"].sort(),
    );
    const refund = parsed.cases.find((row) => row.id === "refund-ask");
    expect(refund?.output).toBe("I can process that");
    expect(refund?.reasoning).toBe("missed the window");
    expect(refund?.finish_reason).toBe("stop");
    expect(refund?.reasoning_tokens).toBe(2);
    const greet = parsed.cases.find((row) => row.id === "greet-hello");
    expect(greet?.output).toBe("happy to help you today");
    expect(greet?.reasoning).toBe("greet politely");
  });

  it("parses { scores: [...] } the same as a bare array", () => {
    const parsed = parseRunArtifact({
      model: "wrap",
      scores: officialScores,
    });
    expect(parsed.kind).toBe("scores");
    expect(parsed.cases.some((row) => row.id === "greet-hello")).toBe(true);
  });

  it("parses an older baseline report.json with train/val cases", () => {
    const parsed = parseRunArtifact(baselineReport);
    expect(parsed.kind).toBe("report");
    expect(parsed.model).toBe("local-qwen");
    expect(parsed.temperature).toBe(0);
    expect(parsed.splitMeans).toEqual({ train: 0.5, val: 0 });
    expect(parsed.cases).toHaveLength(4);
    expect(parsed.cases.find((row) => row.id === "refund-ask")?.note).toBe("missed policy");
    expect(parsed.cases.find((row) => row.id === "hours-ask")?.output).toBe("");
  });

  it("rejects unrecognized JSON", () => {
    expect(() => parseRunArtifact({ hello: true })).toThrow(RunArtifactError);
    expect(() => parseRunArtifact(null)).toThrow(/JSON object or a scores array/);
  });
});

describe("joinRunToSuite", () => {
  it("joins scores by id; missing suite cases have no prediction; extras are dropped", () => {
    const artifact = parseRunArtifact(officialScores);
    const joined = joinRunToSuite(SUITE_IDS, artifact, false);
    expect([...joined.keys()]).toEqual(SUITE_IDS);
    expect(joined.get("greet-hello")).toMatchObject({
      status: "ok",
      output: "happy to help you today",
      predictedLabel: "happy to help you today",
      quality: 1,
      reasoning: "greet politely",
      finish_reason: "stop",
      reasoning_tokens: 4,
    });
    expect(joined.get("refund-ask")?.status).toBe("miss");
    expect(joined.get("hours-ask")).toMatchObject({ status: "miss", output: "" });
    expect(joined.get("ghost")).toEqual({ status: "none" });
    expect(joined.has("extra-only")).toBe(false);

    const summary = summarizeJoinedRun(artifact, joined);
    expect(summary.hitCount).toBe(1);
    expect(summary.missCount).toBe(2);
    expect(summary.noneCount).toBe(1);
  });

  it("joins a baseline report and keeps scorer notes / errors", () => {
    const artifact = parseRunArtifact({
      ...baselineReport,
      splits: {
        ...baselineReport.splits,
        train: {
          meanQuality: 0.5,
          cases: [
            ...baselineReport.splits.train.cases,
            { id: "ghost", quality: 0, output: "", error: "timeout" },
          ],
        },
      },
    });
    const joined = joinRunToSuite(SUITE_IDS, artifact, false);
    expect(joined.get("greet-hello")?.status).toBe("ok");
    expect(joined.get("refund-ask")).toMatchObject({
      status: "miss",
      note: "missed policy",
      output: "sorry",
    });
    expect(joined.get("ghost")).toMatchObject({ status: "error", error: "timeout" });
  });

  it("parses an NSFW severity tag from model JSON output", () => {
    expect(predictedDisplayLabel('{"tags":["软色情"],"description":"x"}', true)).toBe("软色情");
    expect(predictedDisplayLabel("not json", true)).toBeUndefined();
    expect(predictedDisplayLabel("raw text", false)).toBe("raw text");
  });
});

describe("loadRunArtifactFromFile / listRunArtifacts", () => {
  it("loads JSON from disk and lists report.json / scores.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "spl-run-art-"));
    writeFileSync(join(dir, "scores.json"), JSON.stringify(officialScores), "utf8");
    mkdirSync(join(dir, "run-a"));
    writeFileSync(join(dir, "run-a", "report.json"), JSON.stringify(baselineReport), "utf8");
    writeFileSync(join(dir, "notes.txt"), "ignore", "utf8");

    const loaded = loadRunArtifactFromFile(join(dir, "scores.json"));
    expect(loaded.path).toBe(join(dir, "scores.json"));
    expect(loaded.cases.length).toBeGreaterThan(0);

    const listed = listRunArtifacts(dir);
    expect(listed.map((item) => item.label).sort()).toEqual(["run-a/report.json", "scores.json"]);
  });
});
