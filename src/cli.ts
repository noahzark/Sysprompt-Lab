#!/usr/bin/env node
import { Command } from "commander";
import { bind, exportCard, ingest, runR0 } from "./commands.js";
import { formatLlmTarget, loadEnvFiles, peekRootFlag, readLlmConfig } from "./env.js";
import { loadCardFromFile, loadSuiteFromFile } from "./workspace.js";

loadEnvFiles({ cwd: process.cwd(), root: peekRootFlag() });

const program = new Command();

program
  .name("sysprompt")
  .description("Sysprompt Lab — ingest, bind, export system-prompt cards (no API keys for Phase 0)")
  .version("0.1.0")
  .option("--root <dir>", "workspace root that holds .spl/ (default: cwd)");

program
  .command("ingest")
  .description("Read system.md (+ optional tools.json) into a draft Prompt Card")
  .argument("<path>", "directory containing system.md, or the system.md file itself")
  .option("--id <id>", "card id (default: directory name)")
  .action((path: string, opts: { id?: string }) => {
    const { card, path: written } = ingest(path, { root: rootOpt(), id: opts.id });
    console.log(`ingested ${card.id} (${card.status}) → ${written}`);
  });

program
  .command("bind")
  .description("Attach an eval suite and set card status to bound")
  .argument("<card>", "card id or path to card JSON")
  .argument("<suite.yaml>", "eval suite YAML or JSON")
  .action((card: string, suite: string) => {
    const result = bind(card, suite, { root: rootOpt() });
    console.log(`bound ${result.card.id} to suite ${result.card.suite_id} → ${result.cardPath}`);
  });

program
  .command("export")
  .description("Write card.json + system.promoted.md (promoted version, or baseline)")
  .argument("<card>", "card id or path to card JSON")
  .option("-o, --out <dir>", "output directory (default: .spl/export/<card>)")
  .action((card: string, opts: { out?: string }) => {
    const result = exportCard(card, { root: rootOpt(), out: opts.out });
    console.log(`exported ${result.card.id} → ${result.cardPath}`);
    console.log(`prompt → ${result.promptPath}`);
  });

program
  .command("run")
  .description("Optimization run. Phase 1 stub: only --rung R0 (copy baseline, write diff, no LLMs)")
  .argument("<card>", "card id or path to card JSON")
  .requiredOption("--rung <rung>", "R0 | R1 | R2")
  .action((card: string, opts: { rung: string }) => {
    const rung = opts.rung.toUpperCase();
    if (rung !== "R0") {
      throw new Error(`${rung} is not implemented yet. Only --rung R0 is a Phase 1 stub (no LLM calls).`);
    }
    const result = runR0(card, { root: rootOpt() });
    console.log(`R0 stub ${result.run.id}: candidate ${result.candidate.id} (hypothesis=stub)`);
    console.log(`diff → ${result.diffPath}`);
    const llm = readLlmConfig();
    if (llm) {
      console.log(`LLM (unused in stub) ${formatLlmTarget(llm)}`);
    } else {
      console.log("LLM config not set — stub does not call a model");
    }
  });

program
  .command("validate")
  .description("Validate a card JSON or suite YAML/JSON against the schemas")
  .argument("<path>", "card.json or suite.yaml")
  .action((path: string) => {
    if (path.endsWith(".yaml") || path.endsWith(".yml") || path.includes("suite")) {
      const suite = loadSuiteFromFile(path);
      console.log(`ok suite ${suite.id} (${suite.cases.length} cases)`);
      return;
    }
    const card = loadCardFromFile(path);
    console.log(`ok card ${card.id} (${card.status})`);
  });

function rootOpt(): string | undefined {
  return program.opts<{ root?: string }>().root;
}

try {
  program.parse();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
