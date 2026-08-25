import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  emitSchemas,
  findRepoRoot,
  jsonSchemaFor,
  loadSuiteFromFile,
  namedSchemas,
  normalizeSuite,
  parseCard,
  parseCandidate,
  parseEvalCase,
  parseMetric,
  parseModel,
  parseRun,
  parseScore,
  parseSplit,
  parseToolSpec,
  parseVersion,
} from "@sysprompt-lab/core";

const repo = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const exampleDir = join(repo, "examples", "support-bot");

const requiredBySchema: Record<keyof typeof namedSchemas, string[]> = {
  "prompt-card": ["id", "source", "rung", "status"],
  "prompt-version": ["id", "system_prompt", "is_baseline", "promoted"],
  "tool-spec": ["id", "name", "description"],
  model: ["id", "provider", "name"],
  "eval-suite": ["id", "name", "cases", "metric", "splits"],
  "eval-case": ["id", "input"],
  metric: ["id", "kind", "returns_feedback"],
  split: ["name", "case_ids"],
  run: ["id", "card_id", "rung", "status"],
  candidate: ["id", "round", "pass_streak", "status", "version_id"],
  score: ["quality", "split", "model_id", "metric_id"],
};

describe("JSON schemas", () => {
  it("emit draft-07 files whose required fields match the design", () => {
    const outDir = join(repo, "schemas");
    emitSchemas(outDir);
    const files = readdirSync(outDir).filter((name) => name.endsWith(".json")).sort();
    expect(files).toEqual(
      [
        "candidate.json",
        "eval-case.json",
        "eval-suite.json",
        "metric.json",
        "model.json",
        "prompt-card.json",
        "prompt-version.json",
        "run.json",
        "score.json",
        "split.json",
        "tool-spec.json",
      ].sort(),
    );

    for (const name of Object.keys(namedSchemas) as (keyof typeof namedSchemas)[]) {
      const schema = jsonSchemaFor(name);
      expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(schema.$id).toBe(`https://sysprompt.lab/schemas/${name}.json`);
      expect(schema.required).toEqual(expect.arrayContaining(requiredBySchema[name]));
    }
  });
});

describe("example files", () => {
  it("validate suite.yaml against EvalSuite (Zod + Ajv)", () => {
    const suite = loadSuiteFromFile(join(exampleDir, "suite.yaml"));
    expect(suite.id).toBe("support-bot");
    expect(suite.metric.kind).toBe("custom");
    expect(suite.splits.train.case_ids.length).toBeGreaterThanOrEqual(4);
    expect(suite.splits.val.case_ids.length).toBeGreaterThanOrEqual(2);
    expect(suite.cases).toHaveLength(
      suite.splits.train.case_ids.length + suite.splits.val.case_ids.length,
    );

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(jsonSchemaFor("eval-suite"));
    expect(validate(suite), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts optional student sampling and a vision case shape", () => {
    const suite = normalizeSuite({
      id: "vision-shape",
      name: "vision-shape",
      temperature: 1,
      max_tokens: 4096,
      metric: { id: "nsfw_severity_tag", kind: "custom", returns_feedback: true },
      splits: { train: ["c1"], val: [] },
      cases: [
        {
          id: "c1",
          input: { image: "images/fixture.png", user: "look" },
          gold: { severity: "性感" },
        },
      ],
    });
    expect(suite.temperature).toBe(1);
    expect(suite.max_tokens).toBe(4096);
    expect(suite.cases[0]?.input.image).toBe("images/fixture.png");

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(jsonSchemaFor("eval-suite"));
    expect(validate(suite), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts YAML split shorthand and rejects unknown case ids", () => {
    const suite = normalizeSuite({
      id: "tiny",
      name: "tiny",
      metric: { id: "exact", kind: "exact", returns_feedback: false },
      splits: { train: ["a"], val: ["b"] },
      cases: [
        { id: "a", input: { user: "x" }, gold: "x" },
        { id: "b", input: { user: "y" }, gold: "y" },
      ],
    });
    expect(suite.splits.train).toEqual({ name: "train", case_ids: ["a"] });

    expect(() =>
      normalizeSuite({
        id: "bad",
        name: "bad",
        metric: { id: "exact", kind: "exact", returns_feedback: false },
        splits: { train: ["missing"], val: ["b"] },
        cases: [{ id: "b", input: { user: "y" } }],
      }),
    ).toThrow(/unknown case/);
  });
});

describe("entity fixtures", () => {
  const version = parseVersion({
    id: "ver_1",
    system_prompt: "Be helpful.",
    is_baseline: true,
    promoted: false,
  });
  const tool = parseToolSpec({
    id: "lookup_order",
    name: "lookup_order",
    description: "Look up an order",
  });
  const model = parseModel({ id: "gpt-x", provider: "openai", name: "gpt-x" });
  const metric = parseMetric({ id: "exact", kind: "exact", returns_feedback: false });
  const split = parseSplit({ name: "train", case_ids: ["c1"] });
  const evalCase = parseEvalCase({ id: "c1", input: { user: "hi" }, gold: "hello" });
  const card = parseCard({
    id: "demo",
    source: "/tmp/demo",
    rung: "R0",
    status: "draft",
    versions: [version],
    tools: [tool],
    models: [model],
  });
  const run = parseRun({ id: "run_1", card_id: "demo", rung: "R0", status: "completed" });
  const candidate = parseCandidate({
    id: "cand_1",
    round: 0,
    pass_streak: 0,
    status: "stub",
    version_id: "ver_1",
  });
  const score = parseScore({
    quality: 0.8,
    cost: 0.01,
    latency_ms: 120,
    split: "val",
    model_id: "gpt-x",
    metric_id: "exact",
  });
  const scoreWithTrace = parseScore({
    quality: 0,
    latency_ms: 40,
    split: "train",
    model_id: "gpt-x",
    metric_id: "exact",
    version_id: "ver_1",
    case_id: "c1",
    output: "",
    reasoning: "planned an answer",
    finish_reason: "length",
    reasoning_tokens: 8,
  });

  it("parse every named type", () => {
    expect(card.status).toBe("draft");
    expect(evalCase.input).toEqual({ user: "hi" });
    expect(metric.kind).toBe("exact");
    expect(split.name).toBe("train");
    expect(run.rung).toBe("R0");
    expect(candidate.version_id).toBe("ver_1");
    expect(score.split).toBe("val");
    expect(scoreWithTrace.reasoning).toBe("planned an answer");
    expect(scoreWithTrace.output).toBe("");
  });

  it("Ajv accepts fixtures for every emitted schema", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const samples: Record<keyof typeof namedSchemas, unknown> = {
      "prompt-card": card,
      "prompt-version": version,
      "tool-spec": tool,
      model,
      "eval-suite": normalizeSuite({
        id: "demo",
        name: "demo",
        cases: [evalCase],
        metric,
        splits: { train: ["c1"], val: [] },
      }),
      "eval-case": evalCase,
      metric,
      split,
      run,
      candidate,
      score,
    };

    let validateScore: ReturnType<Ajv["compile"]> | undefined;
    for (const name of Object.keys(samples) as (keyof typeof namedSchemas)[]) {
      const validate = ajv.compile(jsonSchemaFor(name));
      if (name === "score") {
        validateScore = validate;
      }
      expect(validate(samples[name]), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    expect(validateScore).toBeDefined();
    expect(validateScore!(scoreWithTrace), JSON.stringify(validateScore!.errors)).toBe(true);
  });

  it("example tools.json and system.md are present", () => {
    const tools = JSON.parse(readFileSync(join(exampleDir, "tools.json"), "utf8")) as unknown[];
    expect(tools.length).toBeGreaterThan(0);
    parseToolSpec(tools[0]);
    const system = readFileSync(join(exampleDir, "system.md"), "utf8");
    expect(system.length).toBeGreaterThan(20);
  });
});
