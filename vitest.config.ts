import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@sysprompt-lab/core": join(root, "packages/core/src/index.ts"),
      "@sysprompt-lab/llm": join(root, "packages/llm/src/index.ts"),
      "@sysprompt-lab/eval": join(root, "packages/eval/src/index.ts"),
      "@sysprompt-lab/rewrite": join(root, "packages/rewrite/src/index.ts"),
      "@sysprompt-lab/rungs": join(root, "packages/rungs/src/index.ts"),
      "@sysprompt-lab/cli": join(root, "packages/cli/src/index.ts"),
      "@sysprompt-lab/suite-viewer": join(root, "packages/suite-viewer/src/index.ts"),
    },
  },
});
