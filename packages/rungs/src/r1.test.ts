import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bind, ingest, runR1 } from "@sysprompt-lab/cli";
import { formatEvidence, sanitizeValue, selectEvidenceCases } from "@sysprompt-lab/rungs";
import { dedupeProposals, parseR1Candidates } from "@sysprompt-lab/rewrite";
import { resolveR1Config } from "@sysprompt-lab/rungs";
import { parseCard, parseScore } from "@sysprompt-lab/core";
import type { CaseEvalResult } from "@sysprompt-lab/eval";
import type { EvalCase } from "@sysprompt-lab/core";

const LLM_KEYS = ["LLM_API_BASE", "LLM_API_MODEL", "LLM_API_TOKEN"] as const;
const R1_KEYS = [
  "SYSPROMPT_R1_ROUNDS",
  "SYSPROMPT_R1_CANDIDATES",
  "SYSPROMPT_R1_PASS_STREAK",
  "SYSPROMPT_R1_BUDGET",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of [...LLM_KEYS, ...R1_KEYS]) {
    out[key] = process.env[key];
  }
  return out;
}

function restoreEnv(prev: Record<string, string | undefined>): void {
  for (const key of [...LLM_KEYS, ...R1_KEYS]) {
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

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

describe("parseR1Candidates / dedupe / config", () => {
  it("parses fenced JSON candidates and accepts system_prompt alias", () => {
    const parsed = parseR1Candidates(
      '```json\n{"candidates":[{"hypothesis":"Clarify refunds","system_prompt":"You are careful."}]}\n```',
    );
    expect(parsed).toEqual([{ hypothesis: "Clarify refunds", prompt: "You are careful." }]);
  });

  it("drops unchanged and duplicate prompts", () => {
    const out = dedupeProposals(
      [
        { hypothesis: "same", prompt: "Current prompt" },
        { hypothesis: "dup", prompt: "Better prompt" },
        { hypothesis: "dup2", prompt: "Better prompt" },
        { hypothesis: "new", prompt: "Another prompt" },
      ],
      "Current prompt",
      [],
      2,
    );
    expect(out.map((p) => p.prompt)).toEqual(["Better prompt", "Another prompt"]);
  });

  it("resolves flag over env over defaults", () => {
    process.env.SYSPROMPT_R1_ROUNDS = "9";
    process.env.SYSPROMPT_R1_CANDIDATES = "8";
    expect(resolveR1Config({ rounds: 2, candidates: 4 })).toEqual({
      rounds: 2,
      candidates: 4,
      passStreak: 1,
      budget: 8,
    });
    expect(resolveR1Config()).toMatchObject({ rounds: 9, candidates: 8, passStreak: 1 });
  });
});

describe("evidence sanitization", () => {
  it("redacts secret keys, tokens, and truncates long vars", () => {
    process.env.LLM_API_TOKEN = "sk-super-secret-token";
    const sanitized = sanitizeValue({
      user: "hello",
      api_key: "should-not-leak",
      note: `Bearer sk-super-secret-token ${"x".repeat(400)}`,
    }) as Record<string, string>;
    expect(sanitized.api_key).toBe("[redacted]");
    expect(JSON.stringify(sanitized)).not.toContain("sk-super-secret-token");
    expect(JSON.stringify(sanitized)).not.toContain("should-not-leak");
    expect(sanitized.note.endsWith("…")).toBe(true);

    const evalCase: EvalCase = {
      id: "t1",
      input: { user: "hi", token: "abc" },
      gold: "good",
    };
    const cases: CaseEvalResult[] = [
      { evalCase, output: "nope", quality: 0, note: "got 性感 want 软色情", latency_ms: 1 },
      { evalCase: { ...evalCase, id: "t2" }, output: "good", quality: 1, latency_ms: 1 },
    ];
    const selected = selectEvidenceCases(cases);
    expect(selected.failures).toHaveLength(1);
    expect(selected.successes).toHaveLength(1);
    const text = formatEvidence(
      {
        currentPrompt: "Be helpful.",
        trainMean: 0.5,
        valMean: 0.25,
        failures: selected.failures,
        successes: selected.successes,
        history: [{ round: 1, hypothesis: "Try X", train: 0.5, val: 0.25, adopted: false }],
        hypotheses: ["Try X"],
      },
      3,
    );
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("abc");
    expect(text).toContain("got 性感 want 软色情");
  });
});

describe("runR1 with mocked fetch", () => {
  it("adopts a higher-scoring candidate and promotes when val rises", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r1-adopt-"));
    writeMiniCard(root, "Be vague.", valSuite);

    const fetchMock: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0]?.content ?? "");
      if (system.includes("R1 eval-loop")) {
        return completion(
          JSON.stringify({
            candidates: [
              { hypothesis: "Ask the model to say good", prompt: "IMPROVED: always reply with good." },
            ],
          }),
        );
      }
      if (system.includes("IMPROVED")) {
        return completion("this is good");
      }
      return completion("nope");
    };

    const result = await runR1("mini", {
      root,
      fetch: fetchMock,
      rounds: 2,
      candidates: 2,
      passStreak: 1,
    });
    expect(result.dryRun).toBe(false);
    expect(result.adoptedCount).toBe(1);
    expect(result.promoted).toBe(true);
    expect(result.message).toMatch(/rose/);
    expect(result.llmTarget).toMatch(/demo-model @ https:\/\/one\.us1\.imvery\.moe\/v1/);
    expect(result.llmTarget).not.toContain("sk-super-secret-token");
    expect(result.table).toMatch(/val/);
    expect(existsSync(result.diffPath)).toBe(true);
    expect(result.diffPath).toMatch(/r1\.diff$/);
    expect(result.candidatesJsonlPath).toBeDefined();
    const jsonl = readFileSync(result.candidatesJsonlPath!, "utf8").trim().split("\n");
    expect(jsonl.length).toBeGreaterThanOrEqual(1);
    const rawScores = JSON.parse(readFileSync(result.scoresPath!, "utf8")) as unknown[];
    for (const row of rawScores) {
      parseScore(row);
    }
    const card = parseCard(JSON.parse(readFileSync(join(root, ".spl", "cards", "mini.json"), "utf8")));
    expect(card.status).toBe("promoted");
    expect(card.rung).toBe("R1");
    expect(card.versions.some((v) => !v.is_baseline && v.promoted)).toBe(true);
  });

  it("rejects a worse candidate and does not promote", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r1-reject-"));
    writeMiniCard(root, "IMPROVED: always reply with good.", valSuite);

    const fetchMock: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0]?.content ?? "");
      if (system.includes("R1 eval-loop")) {
        return completion(
          JSON.stringify({
            candidates: [{ hypothesis: "Make it vague", prompt: "Be vague and unhelpful." }],
          }),
        );
      }
      if (system.includes("IMPROVED")) {
        return completion("this is good");
      }
      return completion("nope");
    };

    const result = await runR1("mini", { root, fetch: fetchMock, rounds: 1, candidates: 1 });
    expect(result.adoptedCount).toBe(0);
    expect(result.promoted).toBe(false);
    expect(result.message).toMatch(/did not strictly rise/);
    const card = parseCard(JSON.parse(readFileSync(join(root, ".spl", "cards", "mini.json"), "utf8")));
    expect(card.status).toBe("verifying");
    expect(card.versions.some((v) => v.promoted)).toBe(false);
  });

  it("adopts a val-tie when train rises but does not promote", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r1-tie-"));
    writeMiniCard(
      root,
      "Say hello only.",
      `
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
    gold: hello
`,
    );

    const fetchMock: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0]?.content ?? "");
      if (system.includes("R1 eval-loop")) {
        return completion(
          JSON.stringify({
            candidates: [{ hypothesis: "Also say good", prompt: "IMPROVED: say hello good." }],
          }),
        );
      }
      if (system.includes("IMPROVED")) {
        return completion("hello good");
      }
      return completion("hello");
    };

    const result = await runR1("mini", { root, fetch: fetchMock, rounds: 1, candidates: 1 });
    expect(result.adoptedCount).toBe(1);
    expect(result.promoted).toBe(false);
    expect(result.message).toMatch(/did not strictly rise vs original baseline/);
  });

  it("promotes on a train-only suite when train strictly rises", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r1-train-"));
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

    const fetchMock: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0]?.content ?? "");
      if (system.includes("R1 eval-loop")) {
        return completion(
          JSON.stringify({
            candidates: [{ hypothesis: "Say good", prompt: "IMPROVED: always reply with good." }],
          }),
        );
      }
      if (system.includes("IMPROVED")) {
        return completion("this is good");
      }
      return completion("nope");
    };

    const result = await runR1("mini", { root, fetch: fetchMock, rounds: 1, candidates: 1 });
    expect(result.adoptedCount).toBe(1);
    expect(result.promoted).toBe(true);
    expect(result.message).toMatch(/train mean quality rose/);
    expect(result.table).toMatch(/train/);
    expect(result.table).not.toMatch(/^val\s/m);
  });

  it("stops after the first adopt when pass-streak is 1", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r1-streak-"));
    writeMiniCard(root, "Be vague.", valSuite);
    let rewriteCalls = 0;
    const fetchMock: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0]?.content ?? "");
      if (system.includes("R1 eval-loop")) {
        rewriteCalls += 1;
        return completion(
          JSON.stringify({
            candidates: [
              { hypothesis: `Improve ${rewriteCalls}`, prompt: `IMPROVED ${rewriteCalls}: always reply with good.` },
            ],
          }),
        );
      }
      if (system.includes("IMPROVED")) {
        return completion("this is good");
      }
      return completion("nope");
    };

    const result = await runR1("mini", {
      root,
      fetch: fetchMock,
      rounds: 3,
      candidates: 1,
      passStreak: 1,
    });
    expect(rewriteCalls).toBe(1);
    expect(result.roundsRan).toBe(1);
    expect(result.adoptedCount).toBe(1);
    expect(result.promoted).toBe(true);
  });

  it("stops when the rewriter returns only unchanged prompts", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r1-none-"));
    writeMiniCard(root, "Stay the same.", valSuite);
    const fetchMock: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0]?.content ?? "");
      if (system.includes("R1 eval-loop")) {
        return completion(
          JSON.stringify({
            candidates: [{ hypothesis: "noop", prompt: "Stay the same." }],
          }),
        );
      }
      return completion("nope");
    };

    const result = await runR1("mini", { root, fetch: fetchMock, rounds: 3, candidates: 2 });
    expect(result.adoptedCount).toBe(0);
    expect(result.candidates).toHaveLength(0);
    expect(result.promoted).toBe(false);
  });

  it("writes dry-run artifacts without calling fetch or requiring LLM env", async () => {
    for (const key of LLM_KEYS) {
      delete process.env[key];
    }
    const root = mkdtempSync(join(tmpdir(), "spl-r1-dry-"));
    writeMiniCard(root, "Baseline prompt.", valSuite);
    let calls = 0;
    const fetchMock: typeof fetch = async () => {
      calls += 1;
      return completion("should not be called");
    };

    const result = await runR1("mini", {
      root,
      dryRun: true,
      fetch: fetchMock,
      rounds: 1,
      candidates: 2,
    });
    expect(calls).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.promoted).toBe(false);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((c) => c.status === "stub")).toBe(true);
    expect(existsSync(result.diffPath)).toBe(true);
    expect(result.diffPath).toMatch(/r1\.diff$/);
    expect(result.candidatesJsonlPath).toBeDefined();
    expect(existsSync(result.candidatesJsonlPath!)).toBe(true);
    expect(result.summaryPath).toBeDefined();
    expect(readFileSync(result.summaryPath!, "utf8")).toMatch(/dry-run/);
    const diff = readFileSync(result.diffPath, "utf8");
    expect(diff).toMatch(/R1 dry-run candidate/);
  });

  it("applies edits JSON so the candidate is not a full unrelated rewrite", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r1-patch-"));
    const system = `# Role
You are a support agent.

# Rules
Never invent order details.

# Style
Be brief.
`;
    writeMiniCard(root, system, valSuite);

    const fetchMock: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const systemMsg = String(body.messages[0]?.content ?? "");
      if (systemMsg.includes("R1 eval-loop")) {
        expect(systemMsg).toMatch(/patch only what the failures implicate|Do not rewrite the entire prompt/i);
        return completion(
          JSON.stringify({
            candidates: [
              {
                hypothesis: "Ask the model to say good",
                edits: [
                  {
                    op: "replace_section",
                    section_id: "s3",
                    content: "# Style\nIMPROVED: always reply with good.\n",
                  },
                ],
              },
            ],
          }),
        );
      }
      if (systemMsg.includes("IMPROVED")) {
        return completion("this is good");
      }
      return completion("nope");
    };

    const result = await runR1("mini", {
      root,
      fetch: fetchMock,
      rounds: 1,
      candidates: 1,
      rewriteMode: "patch",
    });
    expect(result.rewriteMode).toBe("patch");
    expect(result.adoptedCount).toBe(1);
    expect(result.promoted).toBe(true);
    expect(result.version.system_prompt).toContain("You are a support agent");
    expect(result.version.system_prompt).toContain("Never invent order details");
    expect(result.version.system_prompt).toContain("IMPROVED");
    expect(result.version.system_prompt).not.toBe("Be vague and unhelpful.");
    expect(result.sectionsPath).toBeDefined();
  });

  it("rewrites only when --no-eval is set", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r1-noeval-"));
    writeMiniCard(root, "Old prompt.", valSuite);
    let calls = 0;
    const fetchMock: typeof fetch = async () => {
      calls += 1;
      return completion(
        JSON.stringify({
          candidates: [{ hypothesis: "Tighten wording", prompt: "New prompt." }],
        }),
      );
    };

    const result = await runR1("mini", { root, noEval: true, fetch: fetchMock, candidates: 1 });
    expect(calls).toBe(1);
    expect(result.scores).toEqual([]);
    expect(result.promoted).toBe(false);
    expect(result.version.system_prompt).toBe("New prompt.");
    expect(result.message).toMatch(/--no-eval/);
  });

  it("requires a bound suite and throws when env is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "spl-r1-bound-"));
    const dir = join(root, "prompt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "system.md"), "Old prompt.", "utf8");
    ingest(dir, { root, id: "mini" });
    await expect(runR1("mini", { root, dryRun: true })).rejects.toThrow(/must be bound/);

    setLlmEnv();
    writeMiniCard(root, "Old prompt.", valSuite, "bound");
    for (const key of LLM_KEYS) {
      delete process.env[key];
    }
    await expect(runR1("bound", { root, noEval: true })).rejects.toThrow(/LLM_API_/);
  });
});
