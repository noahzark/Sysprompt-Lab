import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bind, ingest, runR2 } from "../src/commands.js";
import { parseSidecarResult, resolvePython, resolveR2Budget } from "../src/r2.js";
import { parseCard, parseScore } from "../src/schemas.js";

const LLM_KEYS = ["LLM_API_BASE", "LLM_API_MODEL", "LLM_API_TOKEN", "LLM_REFLECTION_MODEL"] as const;
const R2_KEYS = ["SYSPROMPT_R2_BUDGET", "SYSPROMPT_PYTHON"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of [...LLM_KEYS, ...R2_KEYS]) {
    out[key] = process.env[key];
  }
  return out;
}

function restoreEnv(prev: Record<string, string | undefined>): void {
  for (const key of [...LLM_KEYS, ...R2_KEYS]) {
    if (prev[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev[key];
    }
  }
}

const saved = snapshotEnv();
afterEach(() => {
  restoreEnv(saved);
});

function setLlmEnv(): void {
  process.env.LLM_API_BASE = "https://one.us1.imvery.moe/";
  process.env.LLM_API_MODEL = "demo-model";
  process.env.LLM_API_TOKEN = "sk-super-secret-token";
}

function writeMiniCard(root: string, system: string, suiteYaml: string, id = "mini"): string {
  const dir = join(root, "prompt");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "system.md"), system, "utf8");
  writeFileSync(join(root, "suite.yaml"), suiteYaml, "utf8");
  ingest(dir, { root, id });
  bind(id, join(root, "suite.yaml"), { root });
  return id;
}

const valSuite = `
id: mini
name: mini
metric:
  id: string_contains
  kind: custom
  returns_feedback: false
splits:
  train: [t1]
  val: [v1]
cases:
  - id: t1
    input: { user: "train" }
    gold: good
  - id: v1
    input: { user: "val" }
    gold: good
`;

describe("resolveR2Budget / sidecar parse", () => {
  it("maps light|medium|heavy and integer calls; flag beats env", () => {
    process.env.SYSPROMPT_R2_BUDGET = "heavy";
    expect(resolveR2Budget("light")).toEqual({ name: "light", maxMetricCalls: 24 });
    expect(resolveR2Budget("medium")).toEqual({ name: "medium", maxMetricCalls: 60 });
    expect(resolveR2Budget()).toEqual({ name: "heavy", maxMetricCalls: 150 });
    expect(resolveR2Budget(40)).toEqual({ name: "calls:40", maxMetricCalls: 40 });
    expect(() => resolveR2Budget("turbo")).toThrow(/light, medium, heavy/);
  });

  it("requires best_prompt and accepts optional scores", () => {
    expect(() => parseSidecarResult({})).toThrow(/best_prompt/);
    const parsed = parseSidecarResult({
      best_prompt: "Better prompt.",
      hypothesis: "Clarify refunds",
      train_score: 1,
      val_score: 0.5,
      baseline_train: 0,
      baseline_val: 0,
      history: [{ idx: 0 }],
    });
    expect(parsed.best_prompt).toBe("Better prompt.");
    expect(parsed.val_score).toBe(0.5);
    expect(parsed.history).toHaveLength(1);
  });
});

describe("runR2 dry-run and mocked sidecar", () => {
  it("writes a stub candidate and r2.diff without Python or LLM env", async () => {
    for (const key of LLM_KEYS) {
      delete process.env[key];
    }
    const root = mkdtempSync(join(tmpdir(), "spl-r2-dry-"));
    writeMiniCard(root, "Baseline prompt.", valSuite);
    const result = await runR2("mini", { root, dryRun: true, budget: "light" });
    expect(result.dryRun).toBe(true);
    expect(result.promoted).toBe(false);
    expect(result.candidates[0]?.status).toBe("stub");
    expect(result.run.rung).toBe("R2");
    expect(result.budget).toEqual({ name: "light", maxMetricCalls: 24 });
    expect(existsSync(result.diffPath)).toBe(true);
    expect(result.diffPath).toMatch(/r2\.diff$/);
    expect(readFileSync(result.diffPath, "utf8")).toMatch(/R2 dry-run candidate/);
    expect(result.summaryPath).toBeDefined();
    expect(readFileSync(result.summaryPath!, "utf8")).toMatch(/dry-run/);
    expect(result.candidatesJsonlPath).toBeDefined();
    expect(existsSync(result.candidatesJsonlPath!)).toBe(true);
    const card = parseCard(JSON.parse(readFileSync(join(root, ".spl", "cards", "mini.json"), "utf8")));
    expect(card.rung).toBe("R2");
    expect(card.status).toBe("optimizing");
  });

  it("promotes when the mocked sidecar val strictly rises", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r2-promote-"));
    writeMiniCard(root, "Be vague.", valSuite);
    const result = await runR2("mini", {
      root,
      budget: "medium",
      sidecar: async (job) => {
        expect(job.seed_prompt).toContain("Be vague.");
        expect(job.train).toHaveLength(1);
        expect(job.val).toHaveLength(1);
        expect(job.max_metric_calls).toBe(60);
        expect(job.student?.model).toBe("demo-model");
        expect(job.student?.api_base).toMatch(/\/v1$/);
        expect(JSON.stringify(job)).toContain("sk-super-secret-token");
        return {
          best_prompt: "Always reply with good.",
          hypothesis: "Ask the model to say good",
          train_score: 1,
          val_score: 1,
          baseline_train: 0,
          baseline_val: 0,
          history: [{ idx: 0, val_score: 0 }, { idx: 1, val_score: 1 }],
        };
      },
    });
    expect(result.dryRun).toBe(false);
    expect(result.promoted).toBe(true);
    expect(result.message).toMatch(/rose/);
    expect(result.llmTarget).toMatch(/demo-model @ https:\/\/one\.us1\.imvery\.moe\/v1/);
    expect(result.llmTarget).not.toContain("sk-super-secret-token");
    expect(result.table).toMatch(/val/);
    expect(existsSync(result.diffPath)).toBe(true);
    expect(result.sidecarPath).toBeDefined();
    expect(existsSync(result.sidecarPath!)).toBe(true);
    const rawScores = JSON.parse(readFileSync(result.scoresPath!, "utf8")) as unknown[];
    for (const row of rawScores) {
      parseScore(row);
    }
    const card = parseCard(JSON.parse(readFileSync(join(root, ".spl", "cards", "mini.json"), "utf8")));
    expect(card.status).toBe("promoted");
    expect(card.rung).toBe("R2");
    expect(card.versions.some((v) => !v.is_baseline && v.promoted)).toBe(true);
    expect(card.versions.find((v) => v.promoted)?.system_prompt).toBe("Always reply with good.");
  });

  it("does not promote when mocked sidecar val does not rise", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r2-hold-"));
    writeMiniCard(root, "Already good.", valSuite);
    const result = await runR2("mini", {
      root,
      sidecar: async () => ({
        best_prompt: "Still good, slightly longer.",
        hypothesis: "No gain",
        train_score: 1,
        val_score: 0.5,
        baseline_train: 1,
        baseline_val: 0.5,
      }),
    });
    expect(result.promoted).toBe(false);
    expect(result.message).toMatch(/did not strictly rise/);
    const card = parseCard(JSON.parse(readFileSync(join(root, ".spl", "cards", "mini.json"), "utf8")));
    expect(card.status).toBe("verifying");
    expect(card.versions.some((v) => v.promoted)).toBe(false);
  });

  it("promotes on a train-only suite when train strictly rises", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r2-train-"));
    writeMiniCard(
      root,
      "Be vague.",
      `
id: mini
name: mini
metric:
  id: string_contains
  kind: custom
  returns_feedback: false
splits:
  train: [t1]
  val: []
cases:
  - id: t1
    input: { user: "train" }
    gold: good
`,
    );
    const result = await runR2("mini", {
      root,
      sidecar: async () => ({
        best_prompt: "Always reply with good.",
        train_score: 1,
        val_score: undefined,
        baseline_train: 0,
      }),
    });
    expect(result.promoted).toBe(true);
    expect(result.message).toMatch(/train mean quality rose/);
    expect(result.table).toMatch(/train/);
    expect(result.table).not.toMatch(/^val\s/m);
  });

  it("skips auto-promote when --no-eval is set", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r2-noeval-"));
    writeMiniCard(root, "Old prompt.", valSuite);
    const result = await runR2("mini", {
      root,
      noEval: true,
      sidecar: async () => ({
        best_prompt: "New prompt.",
        train_score: 1,
        val_score: 1,
        baseline_train: 0,
        baseline_val: 0,
      }),
    });
    expect(result.promoted).toBe(false);
    expect(result.version.system_prompt).toBe("New prompt.");
    expect(result.message).toMatch(/--no-eval/);
  });

  it("requires a bound suite, train cases, and LLM env for the live path", async () => {
    const root = mkdtempSync(join(tmpdir(), "spl-r2-bound-"));
    const dir = join(root, "prompt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "system.md"), "Old prompt.", "utf8");
    ingest(dir, { root, id: "mini" });
    await expect(runR2("mini", { root, dryRun: true })).rejects.toThrow(/must be bound/);

    writeMiniCard(
      root,
      "Old prompt.",
      `
id: novaltrain
name: novaltrain
metric:
  id: string_contains
  kind: custom
  returns_feedback: false
splits:
  train: []
  val: [v1]
cases:
  - id: v1
    input: { user: "val" }
    gold: good
`,
      "novaltrain",
    );
    await expect(runR2("novaltrain", { root, dryRun: true })).rejects.toThrow(/no train cases/);

    setLlmEnv();
    writeMiniCard(root, "Old prompt.", valSuite, "bound");
    for (const key of LLM_KEYS) {
      delete process.env[key];
    }
    await expect(
      runR2("bound", {
        root,
        sidecar: async () => ({ best_prompt: "x" }),
      }),
    ).rejects.toThrow(/LLM_API_/);
  });

  it("rejects a missing Python executable with an install hint", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r2-py-"));
    writeMiniCard(root, "Old prompt.", valSuite);
    await expect(runR2("mini", { root, python: "/no/such/sysprompt-python-r2" })).rejects.toThrow(
      /Python 3\.10\+|pip install -r python\/requirements\.txt/,
    );
    expect(() => resolvePython("/no/such/sysprompt-python-r2")).toThrow(/pip install -r python\/requirements\.txt/);
  });
});
