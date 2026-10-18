import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bind, ingest } from "@sysprompt-lab/cli";
import { baselineVersion, loadCard, loadSuite, openWorkspace, parseCard } from "@sysprompt-lab/core";
import { RunSession, StudentEval, assertBound } from "./pipeline.js";

const suiteYaml = `
id: mini
name: mini
metric:
  id: string_contains
  kind: custom
  returns_feedback: false
splits:
  train: [t1]
  val: [v1]
cases:
  - id: t1
    input: { user: "train" }
    gold: good
  - id: v1
    input: { user: "val" }
    gold: good
`;

function setup(bound = true) {
  const root = mkdtempSync(join(tmpdir(), "spl-pipeline-"));
  const dir = join(root, "prompt");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "system.md"), "Be vague.", "utf8");
  ingest(dir, { root, id: "mini" });
  if (bound) {
    writeFileSync(join(root, "suite.yaml"), suiteYaml, "utf8");
    bind("mini", join(root, "suite.yaml"), { root });
  }
  const ws = openWorkspace(root);
  return { root, ws, card: loadCard(ws, "mini") };
}

describe("RunSession", () => {
  it("keeps versions, candidates and lineage rows in step, and settles promote", () => {
    const { root, ws, card } = setup();
    const baseline = baselineVersion(card);
    const session = new RunSession(ws, card, "R1", 4);
    expect(session.run).toMatchObject({ card_id: "mini", rung: "R1", status: "completed", budget: 4 });
    expect(card.status).toBe("optimizing");

    const first = session.addCandidate({ prompt: "A", hypothesis: "a", parent: baseline, round: 1, status: "evaluated" });
    const second = session.addCandidate({
      prompt: "B",
      hypothesis: "b",
      parent: first.version,
      round: 2,
      status: "evaluated",
      passStreak: 1,
      parentCandidateId: first.candidate.id,
    });
    expect(second.version.parent).toBe(first.version.id);
    expect(second.candidate.parent_candidate_id).toBe(first.candidate.id);
    expect(first.candidate).not.toHaveProperty("parent_candidate_id");
    expect(session.records.map((r) => r.version_id)).toEqual(session.candidates.map((c) => c.version_id));

    session.setStatus(second, "adopted", 2);
    expect(second.candidate).toMatchObject({ status: "adopted", pass_streak: 2 });
    expect(second.record).toMatchObject({ status: "adopted", pass_streak: 2 });

    session.settle(true, second.version.id);
    session.saveCard();
    const saved = parseCard(JSON.parse(readFileSync(join(root, ".spl", "cards", "mini.json"), "utf8")));
    expect(saved.status).toBe("promoted");
    expect(saved.versions.filter((v) => v.promoted).map((v) => v.system_prompt)).toEqual(["B"]);

    session.settle(false, second.version.id);
    expect(card.status).toBe("verifying");
  });

  it("asserts a bound suite with the rung in the hint", () => {
    const { card } = setup(false);
    expect(() => assertBound(card, "R2")).toThrow(/before run --rung R2/);
  });
});

describe("StudentEval", () => {
  it("scores with the suite metric and records per-case plus aggregate rows", async () => {
    const { ws, card } = setup();
    const suite = loadSuite(ws, card.suite_id!);
    const session = new RunSession(ws, card, "R0");
    const llm = { apiBase: "https://example.test", model: "demo-model", token: "sk-test" };
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "good" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const student = new StudentEval(session, llm, suite, { fetch: fetchMock });
    const result = await student.evaluate(baselineVersion(card), "train");
    expect(result.meanQuality).toBe(1);
    expect(session.scores.map((s) => s.case_id)).toEqual(["t1", undefined]);
    expect(session.scores.every((s) => s.split === "train" && s.model_id === "demo-model")).toBe(true);
  });
});
