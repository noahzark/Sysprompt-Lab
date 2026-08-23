import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exportVersion, findRepoRoot, parseCard, parseRun } from "@sysprompt-lab/core";
import { ingest, bind, exportCard, runR0 } from "@sysprompt-lab/cli";

const repo = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const cli = join(repo, "packages", "cli", "src", "cli.ts");
const example = join(repo, "examples", "support-bot");

/** Full OpenAI-style keys. A masked `***…xx` form is allowed. */
const FULL_API_KEY = /sk-[a-zA-Z0-9_-]{8,}/;

const CLEAR_LLM_ENV = {
  LLM_API_BASE: "",
  LLM_API_MODEL: "",
  LLM_API_TOKEN: "",
} as const;

const SAMPLE_LLM_ENV = {
  LLM_API_BASE: "https://api.openai.com/v1",
  LLM_API_MODEL: "gpt-4o-mini",
  LLM_API_TOKEN: "sk-super-secret-token",
} as const;

function runCli(root: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, ["--import", "tsx", cli, "--root", root, ...args], {
    encoding: "utf8",
    cwd: repo,
    env: { ...process.env, ...extraEnv },
  });
}

function assertNoFullApiKey(text: string): void {
  expect(text).not.toMatch(FULL_API_KEY);
}

describe("CLI suite-viewer help", () => {
  it("documents localhost bind, --port, and a private suite path", () => {
    const out = execFileSync(process.execPath, ["--import", "tsx", cli, "suite-viewer", "--help"], {
      encoding: "utf8",
      cwd: repo,
    });
    expect(out).toMatch(/127\.0\.0\.1|localhost/);
    expect(out).toMatch(/--port/);
    expect(out).toMatch(/--image-dir/);
    expect(out).toMatch(/private/);
    expect(out).toMatch(/8787/);
  });
});

describe("library ingest → bind → export", () => {
  it("round-trips the example in a temp workspace without API keys", () => {
    const root = mkdtempSync(join(tmpdir(), "spl-lib-"));
    const ingested = ingest(example, { root });
    expect(ingested.card.status).toBe("draft");
    expect(ingested.card.versions[0]?.is_baseline).toBe(true);
    expect(ingested.card.tools).toHaveLength(1);

    const bound = bind(ingested.card.id, join(example, "suite.yaml"), { root });
    expect(bound.card.status).toBe("bound");
    expect(bound.card.suite_id).toBe("support-bot");

    const exported = exportCard(bound.card.id, { root });
    expect(exported.card.status).toBe("exported");
    expect(existsSync(exported.cardPath)).toBe(true);
    expect(existsSync(exported.promptPath)).toBe(true);

    const prompt = readFileSync(exported.promptPath, "utf8");
    expect(prompt).toBe(exportVersion(ingested.card).system_prompt);

    const onDisk = parseCard(JSON.parse(readFileSync(exported.cardPath, "utf8")));
    expect(onDisk.id).toBe("support-bot");
    expect(onDisk.suite_id).toBe("support-bot");
  });
});

describe("CLI ingest → bind → export", () => {
  it("writes .spl artifacts via the sysprompt CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "spl-cli-"));
    const ingestOut = runCli(root, ["ingest", example]);
    expect(ingestOut).toMatch(/ingested support-bot \(draft\)/);

    const bindOut = runCli(root, ["bind", "support-bot", join(example, "suite.yaml")]);
    expect(bindOut).toMatch(/bound support-bot to suite support-bot/);

    const exportOut = runCli(root, ["export", "support-bot"]);
    expect(exportOut).toMatch(/exported support-bot/);

    const relativeRoot = mkdtempSync(join(tmpdir(), "spl-cli-rel-"));
    const relativeIngest = runCli(relativeRoot, ["ingest", "examples/support-bot"]);
    expect(relativeIngest).toMatch(/ingested support-bot \(draft\)/);

    const card = parseCard(
      JSON.parse(readFileSync(join(root, ".spl", "cards", "support-bot.json"), "utf8")),
    );
    expect(card.status).toBe("exported");
    expect(card.versions[0]?.is_baseline).toBe(true);

    const suite = JSON.parse(readFileSync(join(root, ".spl", "suites", "support-bot.json"), "utf8"));
    expect(suite.cases.length).toBeGreaterThanOrEqual(6);

    const exportedPrompt = readFileSync(
      join(root, ".spl", "export", "support-bot", "system.promoted.md"),
      "utf8",
    );
    expect(exportedPrompt).toContain("Northwind");
  });
});

describe("Phase 1 R0 stub", () => {
  it("copies baseline to a stub candidate and writes a unified diff", async () => {
    const root = mkdtempSync(join(tmpdir(), "spl-r0-"));
    ingest(example, { root });
    const result = await runR0("support-bot", { root, dryRun: true });
    expect(result.version.hypothesis).toBe("stub");
    expect(result.version.is_baseline).toBe(false);
    expect(result.version.parent).toBe(result.card.versions[0]?.id);
    expect(result.candidate.status).toBe("stub");
    expect(result.run.rung).toBe("R0");
    expect(existsSync(result.diffPath)).toBe(true);
    const diff = readFileSync(result.diffPath, "utf8");
    expect(diff).toMatch(/^(Index: |--- )/);
    const run = parseRun(
      JSON.parse(readFileSync(join(root, ".spl", "runs", result.run.id, "run.json"), "utf8")),
    );
    expect(run.card_id).toBe("support-bot");
  });

  it("CLI accepts R0 --dry-run, requires bind before R1/R2, and R2 --dry-run skips Python", () => {
    const root = mkdtempSync(join(tmpdir(), "spl-r0-cli-"));
    runCli(root, ["ingest", example]);
    expect(() => runCli(root, ["run", "support-bot", "--rung", "R2", "--dry-run"])).toThrow(
      /must be bound/,
    );
    expect(() => runCli(root, ["run", "support-bot", "--rung", "R1", "--dry-run"])).toThrow(
      /must be bound/,
    );
    const out = runCli(root, ["run", "support-bot", "--rung", "R0", "--dry-run"], CLEAR_LLM_ENV);
    expect(out).toMatch(/R0 stub/);
    expect(out).toMatch(/hypothesis=stub/);
    expect(out).toMatch(/LLM config not set/);
    assertNoFullApiKey(out);
  });

  it("CLI R2 --dry-run writes r2.diff without network or Python", () => {
    const root = mkdtempSync(join(tmpdir(), "spl-r2-cli-"));
    runCli(root, ["ingest", example]);
    runCli(root, ["bind", "support-bot", join(example, "suite.yaml")]);
    const withoutEnv = runCli(
      root,
      ["run", "support-bot", "--rung", "R2", "--dry-run", "--budget", "light"],
      CLEAR_LLM_ENV,
    );
    expect(withoutEnv).toMatch(/R2 dry-run/);
    expect(withoutEnv).toMatch(/r2\.diff/);
    expect(withoutEnv).toMatch(/LLM config not set/);
    assertNoFullApiKey(withoutEnv);
    expect(withoutEnv).not.toMatch(/\bGEPA\b.*R0|\bR0\b.*GEPA/);

    const withEnv = runCli(
      root,
      ["run", "support-bot", "--rung", "R2", "--dry-run", "--budget", "light"],
      SAMPLE_LLM_ENV,
    );
    expect(withEnv).toMatch(/R2 dry-run/);
    expect(withEnv).toMatch(/LLM \(unused in stub\)/);
    expect(withEnv).toMatch(/gpt-4o-mini @ https:\/\/api\.openai\.com\/v1/);
    expect(withEnv).toMatch(/token \*\*\*…en/);
    assertNoFullApiKey(withEnv);
    expect(withEnv).not.toContain(SAMPLE_LLM_ENV.LLM_API_TOKEN);
  });

  it("CLI R2 live path rejects a missing Python with an install hint", () => {
    const root = mkdtempSync(join(tmpdir(), "spl-r2-nopy-"));
    runCli(root, ["ingest", example]);
    runCli(root, ["bind", "support-bot", join(example, "suite.yaml")]);
    expect(() =>
      runCli(root, ["run", "support-bot", "--rung", "R2"], {
        ...SAMPLE_LLM_ENV,
        SYSPROMPT_PYTHON: "/no/such/sysprompt-python-r2",
      }),
    ).toThrow(/Python 3\.10\+|pip install -r python\/requirements\.txt/);
  });

  it("CLI R1 --dry-run writes r1.diff and candidates.jsonl without network", () => {
    const root = mkdtempSync(join(tmpdir(), "spl-r1-cli-"));
    runCli(root, ["ingest", example]);
    runCli(root, ["bind", "support-bot", join(example, "suite.yaml")]);
    const r1Args = ["run", "support-bot", "--rung", "R1", "--dry-run", "--rounds", "1", "--candidates", "2"];
    const withoutEnv = runCli(root, r1Args, CLEAR_LLM_ENV);
    expect(withoutEnv).toMatch(/R1 dry-run/);
    expect(withoutEnv).toMatch(/r1\.diff/);
    expect(withoutEnv).toMatch(/candidates\.jsonl/);
    expect(withoutEnv).toMatch(/LLM config not set/);
    assertNoFullApiKey(withoutEnv);

    const withEnv = runCli(root, r1Args, SAMPLE_LLM_ENV);
    expect(withEnv).toMatch(/R1 dry-run/);
    expect(withEnv).toMatch(/LLM \(unused in stub\)/);
    expect(withEnv).toMatch(/token \*\*\*…en/);
    assertNoFullApiKey(withEnv);
    expect(withEnv).not.toContain(SAMPLE_LLM_ENV.LLM_API_TOKEN);
  });

  it("prints masked LLM base/model on --dry-run when env is set, without a network call", () => {
    const root = mkdtempSync(join(tmpdir(), "spl-r0-llm-"));
    runCli(root, ["ingest", example]);
    const out = runCli(root, ["run", "support-bot", "--rung", "R0", "--dry-run"], SAMPLE_LLM_ENV);
    expect(out).toMatch(/gpt-4o-mini @ https:\/\/api\.openai\.com\/v1/);
    expect(out).toContain("token ***…en");
    expect(out).not.toContain("sk-");
    assertNoFullApiKey(out);
    expect(out).not.toContain(SAMPLE_LLM_ENV.LLM_API_TOKEN);
  });

  it("CLI errors clearly when R0 needs the network but env is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "spl-r0-missing-"));
    runCli(root, ["ingest", example]);
    expect(() =>
      runCli(root, ["run", "support-bot", "--rung", "R0"], CLEAR_LLM_ENV),
    ).toThrow(/LLM_API_/);
  });
});
