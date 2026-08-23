#!/usr/bin/env node
import { Command } from "commander";
import { bind, exportCard, ingest, promoteVersion, runR0, runR1, runR2 } from "./commands.js";
import { formatLlmTarget, loadEnvFiles, peekRootFlag, readLlmConfig } from "./env.js";
import { loadCardFromFile, loadSuiteFromFile } from "./workspace.js";

loadEnvFiles({ cwd: process.cwd(), root: peekRootFlag() });

const program = new Command();

program
  .name("sysprompt")
  .description("Sysprompt Lab — ingest, bind, R0 rewrite / R1 eval-loop / R2 GEPA wrap, export system-prompt cards")
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
  .description("Optimization run. --rung R0 rewrites once; --rung R1 eval-loop; --rung R2 wraps GEPA")
  .argument("<card>", "card id or path to card JSON")
  .requiredOption("--rung <rung>", "R0 | R1 | R2")
  .option("--dry-run", "No LLM / Python GEPA calls; stub/fake candidates (for tests)")
  .option("--no-eval", "R0/R1: rewrite only. R2: skip auto-promote after the wrap")
  .option("--rounds <n>", "R1 max search rounds (default 3, or SYSPROMPT_R1_ROUNDS)")
  .option("--candidates <n>", "R1 candidates per round (default 3, or SYSPROMPT_R1_CANDIDATES)")
  .option("--pass-streak <n>", "R1 stop after N consecutive adopts (default 1, or SYSPROMPT_R1_PASS_STREAK)")
  .option(
    "--budget <value>",
    "R1: max candidate evals (int, default rounds×candidates, or SYSPROMPT_R1_BUDGET). R2: light|medium|heavy or max metric calls (default light, or SYSPROMPT_R2_BUDGET)",
  )
  .action(
    async (
      card: string,
      opts: {
        rung: string;
        dryRun?: boolean;
        eval?: boolean;
        rounds?: string;
        candidates?: string;
        passStreak?: string;
        budget?: string;
      },
    ) => {
      const rung = opts.rung.toUpperCase();
      if (rung !== "R0" && rung !== "R1" && rung !== "R2") {
        throw new Error(`Unknown rung "${opts.rung}". Use R0, R1, or R2.`);
      }
      const dryRun = Boolean(opts.dryRun);
      const noEval = opts.eval === false;
      if (rung === "R0") {
        const result = await runR0(card, { root: rootOpt(), dryRun, noEval });
        if (result.dryRun) {
          console.log(`R0 stub ${result.run.id}: candidate ${result.candidate.id} (hypothesis=stub)`);
          console.log(`diff → ${result.diffPath}`);
          const llm = readLlmConfig();
          if (llm) {
            console.log(`LLM (unused in stub) ${formatLlmTarget(llm)}`);
          } else {
            console.log("LLM config not set — stub does not call a model");
          }
          return;
        }
        console.log(`R0 ${result.run.id}: candidate ${result.candidate.id} (hypothesis=${result.version.hypothesis})`);
        console.log(`diff → ${result.diffPath}`);
        if (result.llmTarget) {
          console.log(`LLM ${result.llmTarget}`);
        }
        if (result.table) {
          console.log(result.table);
        }
        if (result.scoresPath) {
          console.log(`scores → ${result.scoresPath}`);
        }
        console.log(result.message);
        return;
      }

      if (rung === "R2") {
        const result = await runR2(card, {
          root: rootOpt(),
          dryRun,
          noEval,
          budget: opts.budget,
        });
        if (result.dryRun) {
          console.log(`R2 dry-run ${result.run.id}: candidate ${result.version.id} (sidecar skipped)`);
          console.log(`diff → ${result.diffPath}`);
          const llm = readLlmConfig();
          if (llm) {
            console.log(`LLM (unused in stub) ${formatLlmTarget(llm)}`);
          } else {
            console.log("LLM config not set — stub does not call a model");
          }
          console.log(result.message);
          return;
        }
        console.log(`R2 ${result.run.id}: candidate ${result.version.id} (budget=${result.budget.name})`);
        console.log(`diff → ${result.diffPath}`);
        if (result.llmTarget) {
          console.log(`LLM ${result.llmTarget}`);
        }
        if (result.table) {
          console.log(result.table);
        }
        if (result.scoresPath) {
          console.log(`scores → ${result.scoresPath}`);
        }
        if (result.candidatesJsonlPath) {
          console.log(`candidates → ${result.candidatesJsonlPath}`);
        }
        console.log(result.message);
        return;
      }

      const result = await runR1(card, {
        root: rootOpt(),
        dryRun,
        noEval,
        rounds: parseOptionalInt(opts.rounds, "--rounds"),
        candidates: parseOptionalInt(opts.candidates, "--candidates"),
        passStreak: parseOptionalInt(opts.passStreak, "--pass-streak"),
        budget: parseOptionalInt(opts.budget, "--budget"),
      });
      if (result.dryRun) {
        console.log(
          `R1 dry-run ${result.run.id}: ${result.candidates.length} fake candidate(s), ${result.roundsRan} round(s)`,
        );
        console.log(`diff → ${result.diffPath}`);
        if (result.candidatesJsonlPath) {
          console.log(`candidates → ${result.candidatesJsonlPath}`);
        }
        const llm = readLlmConfig();
        if (llm) {
          console.log(`LLM (unused in stub) ${formatLlmTarget(llm)}`);
        } else {
          console.log("LLM config not set — stub does not call a model");
        }
        console.log(result.message);
        return;
      }
      console.log(
        `R1 ${result.run.id}: ${result.roundsRan} round(s), ${result.candidates.length} candidate(s), adopted ${result.adoptedCount}`,
      );
      console.log(`diff → ${result.diffPath}`);
      if (result.llmTarget) {
        console.log(`LLM ${result.llmTarget}`);
      }
      if (result.table) {
        console.log(result.table);
      }
      if (result.scoresPath) {
        console.log(`scores → ${result.scoresPath}`);
      }
      if (result.candidatesJsonlPath) {
        console.log(`candidates → ${result.candidatesJsonlPath}`);
      }
      console.log(result.message);
    },
  );

program
  .command("promote")
  .description("Manually mark a version as promoted (human accept)")
  .argument("<card>", "card id or path to card JSON")
  .argument("[version]", "version id (default: latest non-baseline candidate)")
  .action((card: string, version?: string) => {
    const result = promoteVersion(card, version, { root: rootOpt() });
    console.log(`promoted ${result.card.id} version ${result.version.id} → ${result.cardPath}`);
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

function parseOptionalInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be a positive integer, got "${value}"`);
  }
  return n;
}

program.parseAsync().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
