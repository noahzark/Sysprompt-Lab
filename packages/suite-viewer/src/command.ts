import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { loadEnvFiles } from "@sysprompt-lab/llm";
import {
  DEFAULT_VIEWER_HOST,
  DEFAULT_VIEWER_PORT,
  listenSuiteViewer,
} from "./server.js";

export const SUITE_VIEWER_HELP = [
  "Local Suite Viewer WebUI — inspect and manually label an eval suite.",
  "Binds 127.0.0.1 only by default (no cloud, no auth).",
  "Images stay on disk (suite-relative paths or SYSPROMPT_IMAGE_DIR / --image-dir).",
  "Save writes gold and optional notes (feedback) atomically back to the suite file.",
  "Do not commit NSFW images or real benches; point this at a private suite path.",
].join(" ");

function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`--port must be an integer 1–65535, got "${value}"`);
  }
  return n;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function runViewer(
  suite: string,
  opts: { port?: string; host?: string; imageDir?: string },
  root?: string,
): Promise<void> {
  loadEnvFiles({ cwd: process.cwd(), root });
  const suitePath = resolve(process.cwd(), suite);
  if (!existsSync(suitePath)) {
    throw new Error(`Suite file not found: ${suitePath}`);
  }
  const host = opts.host?.trim() || DEFAULT_VIEWER_HOST;
  const port = parsePort(opts.port ?? String(DEFAULT_VIEWER_PORT));
  const imageDir = opts.imageDir?.trim() || process.env.SYSPROMPT_IMAGE_DIR?.trim();
  if (!isLoopback(host)) {
    console.warn(
      `Warning: binding ${host} is not localhost-only. The viewer can read local images and write the suite file.`,
    );
  }
  const handle = await listenSuiteViewer({
    suitePath,
    host,
    port,
    imageDir: imageDir || undefined,
  });
  console.log(`Suite Viewer  ${handle.url}`);
  console.log(`Suite         ${suitePath}`);
  if (imageDir) {
    console.log(`Images        ${resolve(process.cwd(), imageDir)}`);
  }
  console.log(`Listen        ${handle.host}:${handle.port} (localhost only by default)`);
  console.log("Press Ctrl+C to stop.");
  await new Promise<void>((resolveWait) => {
    const stop = () => {
      void handle.close().finally(() => resolveWait());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export function configureSuiteViewerCommand(cmd: Command): Command {
  return cmd
    .description(SUITE_VIEWER_HELP)
    .argument("<suite.yaml>", "eval suite YAML or JSON (private path; do not commit image benches)")
    .option("--port <n>", `listen port (default ${DEFAULT_VIEWER_PORT})`, String(DEFAULT_VIEWER_PORT))
    .option("--host <host>", `bind address (default ${DEFAULT_VIEWER_HOST}, localhost only)`, DEFAULT_VIEWER_HOST)
    .option("--image-dir <dir>", "local image root (also SYSPROMPT_IMAGE_DIR)")
    .addHelpText(
      "after",
      `
Examples:
  npm run suite-viewer -- examples/support-bot/suite.yaml
  npm run sysprompt -- suite-viewer /path/to/private/suite.yaml --port 8787 --image-dir /path/to/images

Opens http://127.0.0.1:8787 by default. Reload after editing the file elsewhere.
Save confirms if the suite mtime changed on disk. Images are never uploaded.`,
    )
    .action(async (suite: string, opts: { port?: string; host?: string; imageDir?: string }, command: Command) => {
      const root =
        typeof command.parent?.opts === "function"
          ? (command.parent.opts() as { root?: string }).root
          : undefined;
      await runViewer(suite, opts, root);
    });
}

export function registerSuiteViewerCommand(program: Command): void {
  configureSuiteViewerCommand(program.command("suite-viewer"));
}

export async function runSuiteViewerCli(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program.name("suite-viewer");
  configureSuiteViewerCommand(program);
  await program.parseAsync(argv);
}
