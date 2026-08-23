import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSuiteFromFile } from "@sysprompt-lab/core";
import { applyCaseUpdateToSuiteText, saveSuiteCase, SuiteConflictError } from "./save.js";

const nsfwYaml = `# keep this header
id: label-me
name: Label me
metric:
  id: nsfw_severity_tag
  kind: custom
  returns_feedback: true
splits:
  train:
    - c1
  val: []
cases:
  - id: c1
    input:
      user: look
    # case comment
    gold:
      severity: 性感
`;

describe("applyCaseUpdateToSuiteText", () => {
  it("patches gold on a YAML case and keeps the header comment", () => {
    const next = applyCaseUpdateToSuiteText(
      nsfwYaml,
      "suite.yaml",
      "c1",
      { gold: { severity: "软色情", accept: ["擦边", "软色情"] }, notes: "borderline" },
    );
    expect(next).toMatch(/# keep this header/);
    expect(next).toMatch(/severity: 软色情/);
    expect(next).toMatch(/feedback: borderline/);
    expect(next).toContain("c1");
  });
});

describe("saveSuiteCase", () => {
  it("atomically writes gold, re-parses, and rejects invalid severity without changing the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "spl-viewer-"));
    const path = join(dir, "suite.yaml");
    writeFileSync(path, nsfwYaml, "utf8");

    saveSuiteCase(path, "c1", { gold: { severity: "露骨" }, notes: "ok" });
    const loaded = loadSuiteFromFile(path);
    expect(loaded.cases[0]?.gold).toEqual({ severity: "露骨" });
    expect(loaded.cases[0]?.feedback).toBe("ok");
    expect(readFileSync(path, "utf8")).toMatch(/# keep this header/);

    const before = readFileSync(path, "utf8");
    expect(() => saveSuiteCase(path, "c1", { gold: { severity: "nope" } })).toThrow(/Invalid NSFW severity/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("conflicts when the on-disk mtime does not match, unless force is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "spl-viewer-mtime-"));
    const path = join(dir, "suite.yaml");
    writeFileSync(path, nsfwYaml, "utf8");
    const first = saveSuiteCase(path, "c1", { gold: { severity: "擦边" } });
    utimesSync(path, new Date(), new Date(Date.now() + 2000));
    expect(() =>
      saveSuiteCase(path, "c1", { gold: { severity: "软色情" } }, { expectedMtimeMs: first.mtimeMs }),
    ).toThrow(SuiteConflictError);
    saveSuiteCase(path, "c1", { gold: { severity: "软色情" } }, { expectedMtimeMs: first.mtimeMs, force: true });
    expect(loadSuiteFromFile(path).cases[0]?.gold).toEqual({ severity: "软色情" });
  });

  it("updates a JSON suite without rewriting unrelated keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "spl-viewer-json-"));
    const path = join(dir, "suite.json");
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          id: "tiny",
          name: "tiny",
          extra: "keep-me",
          metric: { id: "string_contains", kind: "custom", returns_feedback: false },
          splits: { train: ["a"], val: [] },
          cases: [{ id: "a", input: { user: "hi" }, gold: "old" }],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    saveSuiteCase(path, "a", { gold: "new gold" });
    const raw = JSON.parse(readFileSync(path, "utf8")) as { extra: string; cases: Array<{ gold: string }> };
    expect(raw.extra).toBe("keep-me");
    expect(raw.cases[0]?.gold).toBe("new gold");
    expect(loadSuiteFromFile(path).cases[0]?.gold).toBe("new gold");
  });
});
