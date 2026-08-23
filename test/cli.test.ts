import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exportVersion, parseCard, parseRun } from "../src/schemas.js";
import { ingest, bind, exportCard, runR0 } from "../src/commands.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "src", "cli.ts");
const example = join(repo, "examples", "support-bot");

function runCli(root: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, ["--import", "tsx", cli, "--root", root, ...args], {
    encoding: "utf8",
    cwd: repo,
    env: { ...process.env, ...extraEnv },
  });
}

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
  it("copies baseline to a stub candidate and writes a unified diff", () => {
    const root = mkdtempSync(join(tmpdir(), "spl-r0-"));
    ingest(example, { root });
    const result = runR0("support-bot", { root });
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

  it("CLI rejects R1/R2 and accepts R0 without network", () => {
    const root = mkdtempSync(join(tmpdir(), "spl-r0-cli-"));
    runCli(root, ["ingest", example]);
    expect(() => runCli(root, ["run", "support-bot", "--rung", "R1"])).toThrow(/not implemented/);
    const out = runCli(root, ["run", "support-bot", "--rung", "R0"]);
    expect(out).toMatch(/R0 stub/);
    expect(out).toMatch(/hypothesis=stub/);
    expect(out).toMatch(/LLM config not set|LLM \(unused in stub\)/);
  });

  it("prints masked LLM base/model when env is set, without requiring a network call", () => {
    const root = mkdtempSync(join(tmpdir(), "spl-r0-llm-"));
    runCli(root, ["ingest", example]);
    const token = "sk-super-secret-token";
    const out = runCli(root, ["run", "support-bot", "--rung", "R0"], {
      LLM_API_BASE: "https://api.openai.com/v1",
      LLM_API: "gpt-4o-mini",
      LLM_API_TOKEN: token,
    });
    expect(out).toMatch(/gpt-4o-mini @ https:\/\/api\.openai\.com\/v1/);
    expect(out).toContain("token sk-…en");
    expect(out).not.toContain(token);
  });
});
