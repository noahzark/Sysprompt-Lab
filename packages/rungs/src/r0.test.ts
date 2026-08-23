import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bind, ingest, promoteVersion, runR0 } from "@sysprompt-lab/cli";
import { parseCard, parseScore } from "@sysprompt-lab/core";

const KEYS = ["LLM_API_BASE", "LLM_API_MODEL", "LLM_API_TOKEN"] as const;

function snapshotEnv(): Record<(typeof KEYS)[number], string | undefined> {
  return {
    LLM_API_BASE: process.env.LLM_API_BASE,
    LLM_API_MODEL: process.env.LLM_API_MODEL,
    LLM_API_TOKEN: process.env.LLM_API_TOKEN,
  };
}

function restoreEnv(prev: ReturnType<typeof snapshotEnv>): void {
  for (const key of KEYS) {
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

function writeMiniCard(root: string, system: string, suiteYaml: string): string {
  const dir = join(root, "prompt");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "system.md"), system, "utf8");
  writeFileSync(join(root, "suite.yaml"), suiteYaml, "utf8");
  ingest(dir, { root, id: "mini" });
  bind("mini", join(root, "suite.yaml"), { root });
  return "mini";
}

describe("runR0 with mocked fetch", () => {
  it("rewrites, writes a real diff, scores train+val, and does not promote when val is unchanged", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r0-eval-"));
    writeMiniCard(
      root,
      "Say the word hello.",
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
    input: { user: "hi" }
    gold: hello
  - id: v1
    input: { user: "yo" }
    gold: hello
`,
    );

    const fetchMock: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const system = body.messages[0]?.content ?? "";
      if (system.includes("Sysprompt Lab")) {
        return completion(
          JSON.stringify({
            hypothesis: "Keep the greeting explicit",
            system_prompt: "Always say hello to the user.",
          }),
        );
      }
      return completion("hello there");
    };

    const result = await runR0("mini", { root, fetch: fetchMock });
    expect(result.dryRun).toBe(false);
    expect(result.version.hypothesis).toBe("Keep the greeting explicit");
    expect(result.version.system_prompt).toContain("Always say hello");
    expect(result.version.promoted).toBe(false);
    expect(result.promoted).toBe(false);
    expect(result.message).toMatch(/did not strictly rise/);
    expect(result.table).toMatch(/train/);
    expect(result.table).toMatch(/val/);
    expect(result.llmTarget).toMatch(/demo-model @ https:\/\/one\.us1\.imvery\.moe\/v1/);
    expect(result.llmTarget).not.toContain("sk-super-secret-token");

    const diff = readFileSync(result.diffPath, "utf8");
    expect(diff).toMatch(/Always say hello/);
    expect(result.scoresPath).toBeDefined();
    const rawScores = JSON.parse(readFileSync(result.scoresPath!, "utf8")) as unknown[];
    expect(rawScores.length).toBeGreaterThan(0);
    for (const row of rawScores) {
      parseScore(row);
    }

    const card = parseCard(JSON.parse(readFileSync(join(root, ".spl", "cards", "mini.json"), "utf8")));
    expect(card.status).toBe("verifying");
    expect(card.versions.some((v) => v.promoted)).toBe(false);
  });

  it("promotes only when val mean quality strictly rises", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r0-promote-"));
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
  val: [v1]
cases:
  - id: t1
    input: { user: "train" }
    gold: good
  - id: v1
    input: { user: "val" }
    gold: good
`,
    );

    const fetchMock: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0]?.content ?? "");
      if (system.includes("Sysprompt Lab")) {
        return completion(
          JSON.stringify({
            hypothesis: "Ask the model to say good",
            system_prompt: "IMPROVED: always reply with good.",
          }),
        );
      }
      if (system.includes("IMPROVED")) {
        return completion("this is good");
      }
      return completion("nope");
    };

    const result = await runR0("mini", { root, fetch: fetchMock });
    expect(result.promoted).toBe(true);
    expect(result.message).toMatch(/rose/);
    const card = parseCard(JSON.parse(readFileSync(join(root, ".spl", "cards", "mini.json"), "utf8")));
    const candidate = card.versions.find((v) => !v.is_baseline);
    expect(candidate?.promoted).toBe(true);
    expect(card.status).toBe("promoted");
  });

  it("refuses auto-promote on a train-only suite", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r0-train-"));
    writeMiniCard(
      root,
      "Say hello.",
      `
id: mini
name: mini
metric:
  id: exact
  kind: exact
  returns_feedback: false
splits:
  train: [t1]
  val: []
cases:
  - id: t1
    input: { user: "hi" }
    gold: hello
`,
    );

    const fetchMock: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0]?.content ?? "");
      if (system.includes("Sysprompt Lab")) {
        return completion(
          JSON.stringify({ hypothesis: "Keep hello", system_prompt: "Reply with hello." }),
        );
      }
      return completion("hello");
    };

    const result = await runR0("mini", { root, fetch: fetchMock });
    expect(result.promoted).toBe(false);
    expect(result.message).toMatch(/train-only/);
    expect(result.table).toMatch(/train/);
    expect(result.table).not.toMatch(/^val\s/m);
  });

  it("rewrites only when --no-eval is set", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r0-noeval-"));
    const dir = join(root, "prompt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "system.md"), "Old prompt.", "utf8");
    ingest(dir, { root, id: "mini" });

    let calls = 0;
    const fetchMock: typeof fetch = async () => {
      calls += 1;
      return completion(
        JSON.stringify({ hypothesis: "Tighten wording", system_prompt: "New prompt." }),
      );
    };

    const result = await runR0("mini", { root, noEval: true, fetch: fetchMock });
    expect(calls).toBe(1);
    expect(result.scores).toEqual([]);
    expect(result.promoted).toBe(false);
    expect(result.version.system_prompt).toBe("New prompt.");
    expect(result.message).toMatch(/--no-eval/);
  });

  it("applies structured edits on a multi-section prompt instead of a full rewrite", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r0-patch-"));
    const system = `# Role
You are a support agent.

# Rules
Never invent order details.

# Style
Be brief.
`;
    writeMiniCard(
      root,
      system,
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
    gold: good
`,
    );

    const fetchMock: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const systemMsg = String(body.messages[0]?.content ?? "");
      if (systemMsg.includes("Sysprompt Lab")) {
        return completion(
          JSON.stringify({
            hypothesis: "Ask the model to say good",
            edits: [
              {
                op: "replace_section",
                section_id: "s3",
                content: "# Style\nIMPROVED: always reply with good.\n",
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

    const result = await runR0("mini", { root, fetch: fetchMock, rewriteMode: "patch" });
    expect(result.rewriteMode).toBe("patch");
    expect(result.version.system_prompt).toContain("You are a support agent");
    expect(result.version.system_prompt).toContain("Never invent order details");
    expect(result.version.system_prompt).toContain("IMPROVED");
    expect(result.version.system_prompt).not.toBe("Always say hello to the user.");
    expect(result.promoted).toBe(true);
    expect(result.sectionsPath).toBeDefined();
    const sections = JSON.parse(readFileSync(result.sectionsPath!, "utf8")) as {
      sections: Array<{ id: string }>;
      effective_mode: string;
    };
    expect(sections.effective_mode).toBe("patch");
    expect(sections.sections.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("rejects an oversized patch and falls back to a full rewrite when allowed", async () => {
    setLlmEnv();
    const root = mkdtempSync(join(tmpdir(), "spl-r0-oversize-"));
    const dir = join(root, "prompt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "system.md"), "# Role\nKeep the original handbook.\n", "utf8");
    ingest(dir, { root, id: "mini" });

    let rewriteCalls = 0;
    const fetchMock: typeof fetch = async () => {
      rewriteCalls += 1;
      if (rewriteCalls <= 2) {
        return completion(
          JSON.stringify({
            hypothesis: "Replace everything",
            edits: [{ op: "replace_section", section_id: "s1", content: "UNRELATED full rewrite of the handbook." }],
          }),
        );
      }
      return completion(
        JSON.stringify({ hypothesis: "Legacy full rewrite", system_prompt: "New prompt after fallback." }),
      );
    };

    const result = await runR0("mini", {
      root,
      noEval: true,
      fetch: fetchMock,
      rewriteMode: "patch",
      maxPatchRatio: 0.2,
      allowFullRewrite: true,
    });
    expect(rewriteCalls).toBe(3);
    expect(result.version.system_prompt).toBe("New prompt after fallback.");
  });

  it("throws when env is missing and this is not a dry-run", async () => {
    for (const key of KEYS) {
      delete process.env[key];
    }
    const root = mkdtempSync(join(tmpdir(), "spl-r0-env-"));
    const dir = join(root, "prompt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "system.md"), "Old prompt.", "utf8");
    ingest(dir, { root, id: "mini" });
    await expect(runR0("mini", { root, noEval: true })).rejects.toThrow(/LLM_API_/);
  });
});

describe("promoteVersion", () => {
  it("lets a human accept a candidate without auto-promote", async () => {
    const root = mkdtempSync(join(tmpdir(), "spl-promote-"));
    const dir = join(root, "prompt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "system.md"), "Baseline.", "utf8");
    ingest(dir, { root, id: "mini" });
    const stub = await runR0("mini", { root, dryRun: true });
    const promoted = promoteVersion("mini", stub.version.id, { root });
    expect(promoted.version.id).toBe(stub.version.id);
    expect(promoted.card.status).toBe("promoted");
    expect(promoted.card.versions.find((v) => v.id === stub.version.id)?.promoted).toBe(true);
    expect(promoted.card.versions.find((v) => v.is_baseline)?.promoted).toBe(false);
  });
});

