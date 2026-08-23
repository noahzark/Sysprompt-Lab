import { createTwoFilesPatch } from "diff";

/** Unified diff of two system prompts (Phase 1 R0 stub writes this file). */
export function unifiedPromptDiff(before: string, after: string): string {
  return createTwoFilesPatch(
    "system.md",
    "system.md",
    ensureTrailingNewline(before),
    ensureTrailingNewline(after),
    "baseline",
    "candidate",
  );
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
