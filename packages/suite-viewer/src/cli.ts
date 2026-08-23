#!/usr/bin/env node
import { runSuiteViewerCli } from "./command.js";

export {
  SUITE_VIEWER_HELP,
  configureSuiteViewerCommand,
  registerSuiteViewerCommand,
  runSuiteViewerCli,
} from "./command.js";

runSuiteViewerCli().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
