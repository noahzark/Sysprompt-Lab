import { createTwoFilesPatch } from "diff";
import { describe, expect, it } from "vitest";
import {
  applyEdits,
  applyUnifiedDiff,
  assertSafePatch,
  changedCharRatio,
  dryRunPatch,
  formatSectionMap,
  parseEdits,
  parseRewriteMode,
  PatchError,
  resolveEffectiveRewriteMode,
  splitSections,
} from "../src/patch.js";
import { parsePatchResponse } from "../src/rewrite.js";
import { materializeR1Proposals, parseR1RawCandidates } from "../src/r1-rewrite.js";

const headed = `# Role
You are a support agent.

# Rules
Never invent order details.

# Style
Be brief.
`;

describe("splitSections", () => {
  it("splits markdown headings and assigns s1, s2 ids", () => {
    const sections = splitSections(headed);
    expect(sections.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(sections.map((s) => s.title)).toEqual(["Role", "Rules", "Style"]);
    expect(sections[0]?.content).toContain("You are a support agent");
    expect(formatSectionMap(sections)).toMatch(/s2 \(lines \d+–\d+\) Rules/);
  });

  it("splits numbered Rules: style headers", () => {
    const prompt = `You are a concise customer-support agent for Northwind.

Rules:
- Greet the user briefly.
- Never invent order details.
`;
    const sections = splitSections(prompt);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections.some((s) => s.title === "Rules")).toBe(true);
  });

  it("falls back to blank-line blocks", () => {
    const prompt = `First paragraph stays here.

Second paragraph is separate.
`;
    const sections = splitSections(prompt);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.content).toContain("First paragraph");
    expect(sections[1]?.content).toContain("Second paragraph");
  });
});

describe("applyEdits", () => {
  it("replaces, inserts, and deletes by section id", () => {
    const sections = splitSections(headed);
    const replaced = applyEdits(
      headed,
      [{ op: "replace_section", section_id: "s2", content: "# Rules\nAlways ask for the order id.\n" }],
      sections,
    );
    expect(replaced.prompt).toContain("You are a support agent");
    expect(replaced.prompt).toContain("Always ask for the order id");
    expect(replaced.prompt).not.toContain("Never invent order details");
    expect(replaced.hunks).toBe(1);

    const inserted = applyEdits(
      headed,
      [{ op: "insert_after_section", section_id: "s1", content: "\n# Tone\nBe polite.\n" }],
      sections,
    );
    expect(inserted.prompt).toContain("# Tone");
    expect(inserted.prompt).toContain("# Rules");

    const deleted = applyEdits(headed, [{ op: "delete_section", section_id: "s3" }], sections);
    expect(deleted.prompt).not.toContain("# Style");
    expect(deleted.prompt).toContain("# Role");
  });

  it("replaces a line range", () => {
    const applied = applyEdits(headed, [
      { op: "replace_range", start_line: 2, end_line: 2, content: "You are a careful support agent." },
    ]);
    expect(applied.prompt).toContain("You are a careful support agent.");
    expect(applied.prompt).toContain("# Role");
  });

  it("rejects unknown sections and overlapping edits", () => {
    expect(() => applyEdits(headed, [{ op: "delete_section", section_id: "s99" }])).toThrow(PatchError);
    expect(() =>
      applyEdits(headed, [
        { op: "replace_range", start_line: 1, end_line: 4, content: "x" },
        { op: "replace_range", start_line: 3, end_line: 5, content: "y" },
      ]),
    ).toThrow(/overlapping/);
  });
});

describe("applyUnifiedDiff / safety", () => {
  it("applies a unified diff generated against the full prompt", () => {
    const after = headed.replace("Be brief.", "Be brief and say good.");
    const diff = createTwoFilesPatch("system.md", "system.md", headed, after);
    const applied = applyUnifiedDiff(headed, diff);
    expect(applied.prompt).toContain("Be brief and say good.");
    expect(applied.kind).toBe("diff");
    expect(applied.hunks).toBeGreaterThan(0);
  });

  it("rejects an empty hunk list and a failed apply", () => {
    expect(() => applyUnifiedDiff(headed, "not a diff")).toThrow(/0 hunks|did not apply/);
    const other = createTwoFilesPatch("system.md", "system.md", "unrelated\n", "changed\n");
    expect(() => applyUnifiedDiff(headed, other)).toThrow(/did not apply/);
  });

  it("rejects empty and oversized patches", () => {
    expect(() => assertSafePatch("keep me", "   ", { maxPatchRatio: 1, hunks: 1 })).toThrow(/emptied/);
    expect(() => assertSafePatch("keep me", "keep me", { maxPatchRatio: 1, hunks: 1 })).toThrow(/changed nothing/);
    expect(() => assertSafePatch("aaaa", "bbbb", { maxPatchRatio: 0.2, hunks: 1 })).toThrow(/max-patch-ratio/);
    expect(changedCharRatio("same\nline", "same\nline")).toBe(0);
    assertSafePatch(headed, headed.replace("Be brief.", "Be brief and clear."), {
      maxPatchRatio: 0.5,
      hunks: 1,
    });
  });

  it("parseEdits validates the structured JSON shape", () => {
    const edits = parseEdits([
      { op: "replace_section", section_id: "s1", content: "hello" },
      { op: "delete_section", section_id: "s2" },
    ]);
    expect(edits).toHaveLength(2);
    expect(() => parseEdits([{ op: "explode" }])).toThrow(/unknown op/);
    expect(() => parseEdits([])).toThrow(/non-empty/);
  });
});

describe("rewrite-mode helpers and parsers", () => {
  it("auto uses full for tiny prompts and patch at the threshold", () => {
    expect(resolveEffectiveRewriteMode("auto", "x".repeat(1499))).toBe("full");
    expect(resolveEffectiveRewriteMode("auto", "x".repeat(1500))).toBe("patch");
    expect(resolveEffectiveRewriteMode("full", "x".repeat(5000))).toBe("full");
    expect(parseRewriteMode(undefined)).toBe("auto");
    expect(() => parseRewriteMode("magic")).toThrow(/patch, full, or auto/);
  });

  it("parses edits JSON and a raw unified diff", () => {
    const parsed = parsePatchResponse(
      JSON.stringify({
        hypothesis: "Clarify refunds",
        edits: [{ op: "replace_section", section_id: "s2", content: "# Rules\nAsk for the order id.\n" }],
      }),
    );
    expect(parsed.hypothesis).toBe("Clarify refunds");
    expect(parsed.edits?.[0]?.op).toBe("replace_section");

    const after = headed.replace("Be brief.", "Be brief and say good.");
    const diff = parsePatchResponse(createTwoFilesPatch("system.md", "system.md", headed, after));
    expect(diff.diff).toMatch(/Be brief and say good/);
  });

  it("materializes R1 candidates from edits without a full rewrite", () => {
    const raw = parseR1RawCandidates(
      JSON.stringify({
        candidates: [
          {
            hypothesis: "Ask to say good",
            edits: [{ op: "replace_section", section_id: "s3", content: "# Style\nIMPROVED: always reply with good.\n" }],
          },
        ],
      }),
    );
    const proposals = materializeR1Proposals(raw, headed, { maxPatchRatio: 0.8, allowFullRewrite: false });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.prompt).toContain("You are a support agent");
    expect(proposals[0]?.prompt).toContain("Never invent order details");
    expect(proposals[0]?.prompt).toContain("IMPROVED");
    expect(proposals[0]?.prompt).not.toBe("totally unrelated rewrite");
  });

  it("dry-run inserts a small note instead of replacing the prompt", () => {
    const patched = dryRunPatch(headed, "[R0 dry-run stub]");
    expect(patched.prompt).toContain("You are a support agent");
    expect(patched.prompt).toContain("[R0 dry-run stub]");
    expect(patched.edits[0]?.op).toBe("insert_after_section");
  });
});
