import { applyPatch, parsePatch } from "diff";
import { createHash } from "node:crypto";

export type RewriteMode = "patch" | "full" | "auto";
export type EffectiveRewriteMode = "patch" | "full";

export const DEFAULT_PATCH_CHAR_THRESHOLD = 1500;
export const DEFAULT_R0_MAX_PATCH_RATIO = 0.8;
export const DEFAULT_R1_MAX_PATCH_RATIO = 0.5;

const EDIT_OPS = ["replace_section", "replace_range", "insert_after_section", "delete_section"] as const;
export type PatchOp = (typeof EDIT_OPS)[number];

export interface PromptSection {
  id: string;
  title?: string;
  start_line: number;
  end_line: number;
  content: string;
  hash: string;
}

export interface PatchEdit {
  op: PatchOp;
  section_id?: string;
  start_line?: number;
  end_line?: number;
  content?: string;
}

export interface ApplyResult {
  prompt: string;
  hunks: number;
  kind: "edits" | "diff";
}

export interface SectionMapArtifact {
  rewrite_mode: RewriteMode;
  effective_mode: EffectiveRewriteMode;
  max_patch_ratio: number;
  allow_full_rewrite: boolean;
  used_fallback: boolean;
  source_chars: number;
  sections: PromptSection[];
}

export class PatchError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PatchError";
    this.code = code;
  }
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

export function parseRewriteMode(value: string | undefined): RewriteMode {
  if (value === undefined || value.trim() === "") {
    return "auto";
  }
  const mode = value.trim().toLowerCase();
  if (mode === "patch" || mode === "full" || mode === "auto") {
    return mode;
  }
  throw new Error(`--rewrite-mode must be patch, full, or auto, got "${value}"`);
}

export function parseMaxPatchRatio(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(`--max-patch-ratio must be in (0, 1], got "${value}"`);
  }
  return n;
}

export function resolveEffectiveRewriteMode(
  mode: RewriteMode,
  prompt: string,
  threshold = DEFAULT_PATCH_CHAR_THRESHOLD,
): EffectiveRewriteMode {
  if (mode !== "auto") {
    return mode;
  }
  return prompt.length >= threshold ? "patch" : "full";
}

export function resolveMaxPatchRatio(explicit: number | undefined, rung: "R0" | "R1"): number {
  return explicit ?? (rung === "R0" ? DEFAULT_R0_MAX_PATCH_RATIO : DEFAULT_R1_MAX_PATCH_RATIO);
}

/** R0 defaults to fallback. R1 only falls back on tiny/full prompts unless the flag is set. */
export function resolveAllowFullRewrite(
  explicit: boolean | undefined,
  rung: "R0" | "R1",
  effectiveMode: EffectiveRewriteMode,
): boolean {
  if (explicit !== undefined) {
    return explicit;
  }
  return rung === "R0" ? true : effectiveMode === "full";
}

export function resolvePatchThreshold(explicit?: number): number {
  if (explicit !== undefined) {
    return explicit;
  }
  const raw = process.env.SYSPROMPT_PATCH_THRESHOLD?.trim();
  if (!raw) {
    return DEFAULT_PATCH_CHAR_THRESHOLD;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`SYSPROMPT_PATCH_THRESHOLD must be a positive integer, got "${raw}"`);
  }
  return n;
}

export function splitLines(text: string): string[] {
  return text.split("\n");
}

function isMarkdownHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line);
}

function isLabeledHeader(line: string): boolean {
  const trimmed = line.trim();
  if (/^(?:rules|role|constraints|policy|tools|style|tone|safety|instructions)\s*:\s*$/i.test(trimmed)) {
    return true;
  }
  if (/^[A-Za-z][\w /.&-]{0,48}:\s*$/.test(trimmed)) {
    return true;
  }
  return /^\d+[\.)]\s+[A-Za-z][\w /.&-]{0,48}:?\s*$/.test(trimmed);
}

function headingTitle(line: string): string {
  const md = line.match(/^#{1,6}\s+(\S.*)$/);
  if (md) {
    return md[1].trim();
  }
  const numbered = line.match(/^\d+[\.)]\s+(.+?)\s*:?\s*$/);
  if (numbered) {
    return numbered[1].replace(/:$/, "").trim();
  }
  return line.trim().replace(/:$/, "");
}

function blockTitle(content: string): string | undefined {
  const first = content.split("\n").find((line) => line.trim());
  if (!first) {
    return undefined;
  }
  if (isMarkdownHeading(first) || isLabeledHeader(first)) {
    return headingTitle(first);
  }
  const oneLine = first.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
}

function toSections(prompt: string, ranges: Array<{ start: number; end: number }>): PromptSection[] {
  const lines = splitLines(prompt);
  return ranges.map((range, index) => {
    const content = lines.slice(range.start, range.end + 1).join("\n");
    return {
      id: `s${index + 1}`,
      title: blockTitle(content),
      start_line: range.start + 1,
      end_line: range.end + 1,
      content,
      hash: contentHash(content),
    };
  });
}

function rangesFromMarkers(lineCount: number, markers: number[]): Array<{ start: number; end: number }> {
  if (markers.length === 0) {
    return lineCount === 0 ? [] : [{ start: 0, end: lineCount - 1 }];
  }
  const starts = markers[0] === 0 ? markers : [0, ...markers];
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]!;
    const end = (starts[i + 1] ?? lineCount) - 1;
    if (end >= start) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

function blankBlockRanges(lines: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < lines.length) {
    const start = i;
    while (i < lines.length && lines[i]!.trim() !== "") {
      i += 1;
    }
    while (i < lines.length && lines[i]!.trim() === "") {
      i += 1;
    }
    ranges.push({ start, end: i - 1 });
  }
  return ranges;
}

/** Split a system prompt into sections by markdown headings, labeled headers, or blank-line blocks. */
export function splitSections(prompt: string): PromptSection[] {
  const lines = splitLines(prompt);
  if (lines.length === 1 && lines[0] === "") {
    return [
      {
        id: "s1",
        start_line: 1,
        end_line: 1,
        content: "",
        hash: contentHash(""),
      },
    ];
  }

  const mdMarkers = lines.flatMap((line, index) => (isMarkdownHeading(line) ? [index] : []));
  if (mdMarkers.length >= 1) {
    return toSections(prompt, rangesFromMarkers(lines.length, mdMarkers));
  }

  const labelMarkers = lines.flatMap((line, index) => (isLabeledHeader(line) ? [index] : []));
  if (labelMarkers.length >= 1) {
    const ranges = rangesFromMarkers(lines.length, labelMarkers);
    if (ranges.length >= 2 || labelMarkers[0] !== 0) {
      return toSections(prompt, ranges);
    }
  }

  return toSections(prompt, blankBlockRanges(lines));
}

export function formatSectionMap(sections: PromptSection[]): string {
  if (sections.length === 0) {
    return "(no sections)";
  }
  return sections
    .map((section) => {
      const title = section.title ? ` ${section.title}` : "";
      return `${section.id} (lines ${section.start_line}–${section.end_line})${title}`;
    })
    .join("\n");
}

export function parseEdits(value: unknown): PatchEdit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PatchError("edits must be a non-empty array", "empty_edits");
  }
  return value.map((item, index) => parseEdit(item, index));
}

function parseEdit(value: unknown, index: number): PatchEdit {
  if (!value || typeof value !== "object") {
    throw new PatchError(`edits[${index}] must be an object`, "bad_edit");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.op !== "string" || !EDIT_OPS.includes(raw.op as PatchOp)) {
    throw new PatchError(`edits[${index}] has unknown op "${String(raw.op)}"`, "unknown_op");
  }
  const op = raw.op as PatchOp;
  const edit: PatchEdit = { op };

  if (op === "replace_section" || op === "insert_after_section" || op === "delete_section") {
    if (typeof raw.section_id !== "string" || !raw.section_id.trim()) {
      throw new PatchError(`edits[${index}] (${op}) requires section_id`, "bad_edit");
    }
    edit.section_id = raw.section_id;
  }
  if (op === "replace_range") {
    if (!Number.isInteger(raw.start_line) || !Number.isInteger(raw.end_line)) {
      throw new PatchError(`edits[${index}] (replace_range) requires integer start_line and end_line`, "bad_edit");
    }
    edit.start_line = raw.start_line as number;
    edit.end_line = raw.end_line as number;
  }
  if (op === "replace_section" || op === "replace_range" || op === "insert_after_section") {
    if (typeof raw.content !== "string") {
      throw new PatchError(`edits[${index}] (${op}) requires string content`, "bad_edit");
    }
    edit.content = raw.content;
  }
  return edit;
}

interface LineOp {
  start: number;
  end: number;
  insert: string[];
  kind: "replace" | "insert";
  order: number;
}

function sectionById(sections: PromptSection[], id: string): PromptSection {
  const found = sections.find((section) => section.id === id);
  if (!found) {
    throw new PatchError(`unknown section_id "${id}"`, "unknown_section");
  }
  return found;
}

function editToLineOp(edit: PatchEdit, sections: PromptSection[], order: number): LineOp {
  switch (edit.op) {
    case "replace_section": {
      const section = sectionById(sections, edit.section_id!);
      return {
        start: section.start_line,
        end: section.end_line,
        insert: splitLines(edit.content ?? ""),
        kind: "replace",
        order,
      };
    }
    case "delete_section": {
      const section = sectionById(sections, edit.section_id!);
      return { start: section.start_line, end: section.end_line, insert: [], kind: "replace", order };
    }
    case "insert_after_section": {
      const section = sectionById(sections, edit.section_id!);
      return {
        start: section.end_line + 1,
        end: section.end_line,
        insert: splitLines(edit.content ?? ""),
        kind: "insert",
        order,
      };
    }
    case "replace_range": {
      const start = edit.start_line!;
      const end = edit.end_line!;
      if (start < 1 || end < start) {
        throw new PatchError(`replace_range ${start}-${end} is invalid`, "range");
      }
      return { start, end, insert: splitLines(edit.content ?? ""), kind: "replace", order };
    }
  }
}

function assertNoOverlap(ops: LineOp[]): void {
  const sorted = [...ops].sort((a, b) => a.start - b.start || a.order - b.order);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const current = sorted[i]!;
    const prevLast = prev.kind === "insert" ? prev.start - 1 : prev.end;
    if (current.start <= prevLast) {
      throw new PatchError("overlapping edits", "overlap");
    }
  }
}

/** Apply structured section/range edits to the current prompt. */
export function applyEdits(prompt: string, edits: PatchEdit[], sections?: PromptSection[]): ApplyResult {
  const parsed = edits.length > 0 && edits.every((edit) => edit.op) ? edits : parseEdits(edits);
  if (parsed.length === 0) {
    throw new PatchError("patch contains no edits", "empty_edits");
  }
  const map = sections ?? splitSections(prompt);
  const ops = parsed.map((edit, index) => editToLineOp(edit, map, index));
  assertNoOverlap(ops);

  const lines = splitLines(prompt);
  const ordered = [...ops].sort((a, b) => b.start - a.start || b.order - a.order);
  for (const op of ordered) {
    if (op.kind === "insert") {
      const idx = op.start - 1;
      if (idx < 0 || idx > lines.length) {
        throw new PatchError(`insert after line ${op.end} is out of bounds (${lines.length} lines)`, "range");
      }
      lines.splice(idx, 0, ...op.insert);
    } else {
      const startIdx = op.start - 1;
      const count = op.end - op.start + 1;
      if (startIdx < 0 || startIdx + count > lines.length) {
        throw new PatchError(`replace_range ${op.start}-${op.end} is out of bounds (${lines.length} lines)`, "range");
      }
      lines.splice(startIdx, count, ...op.insert);
    }
  }
  return { prompt: lines.join("\n"), hunks: ops.length, kind: "edits" };
}

export function looksLikeUnifiedDiff(text: string): boolean {
  return /^(?:diff --git |--- |\+\+\+ |@@ )/m.test(text);
}

/** Apply a unified diff against the full current prompt. */
export function applyUnifiedDiff(prompt: string, diffText: string): ApplyResult {
  const parsed = parsePatch(diffText);
  const hunks = parsed.flatMap((file) => file.hunks ?? []);
  if (hunks.length === 0) {
    throw new PatchError("unified diff applied 0 hunks", "zero_hunks");
  }

  const applied = applyPatch(prompt, diffText);
  if (applied !== false) {
    return { prompt: applied, hunks: hunks.length, kind: "diff" };
  }

  const padded = prompt.endsWith("\n") ? prompt : `${prompt}\n`;
  const retry = applyPatch(padded, diffText);
  if (retry === false) {
    throw new PatchError("unified diff did not apply cleanly", "diff_apply");
  }
  return {
    prompt: prompt.endsWith("\n") ? retry : retry.replace(/\n$/, ""),
    hunks: hunks.length,
    kind: "diff",
  };
}

/**
 * Fraction of characters that changed (multiset-of-lines approximation).
 * 0 = identical, 1 = no shared lines.
 */
export function changedCharRatio(before: string, after: string): number {
  if (before === after) {
    return 0;
  }
  const denom = Math.max(before.length, after.length, 1);
  const beforeCounts = new Map<string, number>();
  for (const line of splitLines(before)) {
    beforeCounts.set(line, (beforeCounts.get(line) ?? 0) + 1);
  }
  let matched = 0;
  for (const line of splitLines(after)) {
    const count = beforeCounts.get(line) ?? 0;
    if (count > 0) {
      matched += line.length;
      beforeCounts.set(line, count - 1);
    }
  }
  const changed = Math.max(0, denom - matched);
  return Math.min(1, changed / denom);
}

export function assertSafePatch(
  before: string,
  after: string,
  options: { maxPatchRatio: number; hunks?: number },
): void {
  if (options.hunks === 0) {
    throw new PatchError("patch applied 0 hunks", "zero_hunks");
  }
  if (after === before) {
    throw new PatchError("patch applied cleanly but changed nothing", "zero_hunks");
  }
  if (!after.trim()) {
    throw new PatchError("patch emptied the system prompt", "empty_prompt");
  }
  const ratio = changedCharRatio(before, after);
  if (ratio - options.maxPatchRatio > 1e-9) {
    throw new PatchError(
      `patch changes ${(ratio * 100).toFixed(1)}% of characters, exceeds --max-patch-ratio ${options.maxPatchRatio}`,
      "oversized",
    );
  }
}

export function applyPromptPatch(
  prompt: string,
  input: { edits?: PatchEdit[]; diff?: string },
  options: { maxPatchRatio: number; sections?: PromptSection[] },
): ApplyResult {
  if (input.edits && input.edits.length > 0) {
    const applied = applyEdits(prompt, input.edits, options.sections);
    assertSafePatch(prompt, applied.prompt, { maxPatchRatio: options.maxPatchRatio, hunks: applied.hunks });
    return applied;
  }
  if (input.diff?.trim()) {
    const applied = applyUnifiedDiff(prompt, input.diff);
    assertSafePatch(prompt, applied.prompt, { maxPatchRatio: options.maxPatchRatio, hunks: applied.hunks });
    return applied;
  }
  throw new PatchError("response has neither edits nor a unified diff", "no_patch");
}

export function dryRunPatch(
  prompt: string,
  note: string,
): { prompt: string; edits: PatchEdit[]; sections: PromptSection[] } {
  const sections = splitSections(prompt);
  const last = sections.at(-1);
  const content = note.startsWith("\n") ? note : `\n${note}`;
  const edits: PatchEdit[] =
    last !== undefined
      ? [{ op: "insert_after_section", section_id: last.id, content }]
      : [
          {
            op: "replace_range",
            start_line: 1,
            end_line: Math.max(1, splitLines(prompt).length),
            content: `${prompt}${content}`,
          },
        ];
  const applied = applyEdits(prompt, edits, sections);
  return { prompt: applied.prompt, edits, sections };
}

export function sectionMapArtifact(input: {
  sections: PromptSection[];
  rewriteMode: RewriteMode;
  effectiveMode: EffectiveRewriteMode;
  maxPatchRatio: number;
  allowFullRewrite: boolean;
  usedFallback: boolean;
  sourceChars: number;
}): SectionMapArtifact {
  return {
    rewrite_mode: input.rewriteMode,
    effective_mode: input.effectiveMode,
    max_patch_ratio: input.maxPatchRatio,
    allow_full_rewrite: input.allowFullRewrite,
    used_fallback: input.usedFallback,
    source_chars: input.sourceChars,
    sections: input.sections,
  };
}
