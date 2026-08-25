import { mkdtempSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findRepoRoot, loadSuiteFromFile } from "@sysprompt-lab/core";
import { listenSuiteViewer, type SuiteViewerHandle, type SuiteViewerOptions } from "./server.js";

const repo = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const supportSuite = join(repo, "examples", "support-bot", "suite.yaml");
const tinyPng = join(repo, "test", "fixtures", "tiny.png");

const handles: SuiteViewerHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    await handle?.close();
  }
});

async function start(
  suitePath: string,
  extras: Partial<SuiteViewerOptions> = {},
): Promise<SuiteViewerHandle> {
  const handle = await listenSuiteViewer({
    suitePath,
    host: "127.0.0.1",
    port: 0,
    ...extras,
  });
  handles.push(handle);
  return handle;
}

describe("suite viewer HTTP smoke", () => {
  it("serves /api/suite JSON for the text-only support-bot example", async () => {
    const handle = await start(supportSuite);
    const res = await fetch(`${handle.url}/api/suite`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      overview: { id: string; name: string; trainSize: number; valSize: number; missingImageCount: number };
      cases: Array<{ id: string; hasImage: boolean }>;
    };
    expect(body.overview.id).toBe("support-bot");
    expect(body.overview.name).toMatch(/support/i);
    expect(body.overview.trainSize).toBeGreaterThanOrEqual(4);
    expect(body.overview.valSize).toBeGreaterThanOrEqual(2);
    expect(body.overview.missingImageCount).toBe(0);
    expect(body.cases.some((item) => item.id === "greet-hello")).toBe(true);
    expect(body.cases.every((item) => item.hasImage === false)).toBe(true);

    const home = await fetch(handle.url);
    expect(home.ok).toBe(true);
    expect(await home.text()).toMatch(/Suite Viewer/);
  });

  it("saves gold on a temp copy and serves a resolved local image", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spl-viewer-http-"));
    const suitePath = join(dir, "suite.yaml");
    writeFileSync(
      suitePath,
      [
        "id: tmp-view",
        "name: tmp-view",
        "metric:",
        "  id: nsfw_severity_tag",
        "  kind: custom",
        "  returns_feedback: true",
        "splits:",
        "  train:",
        "    - pic",
        "  val: []",
        "cases:",
        "  - id: pic",
        "    input:",
        "      user: look",
        "      image: tiny.png",
        "    gold:",
        "      severity: 性感",
        "",
      ].join("\n"),
      "utf8",
    );
    copyFileSync(tinyPng, join(dir, "tiny.png"));

    const handle = await start(suitePath, { imageDir: dir });
    const suite = await (await fetch(`${handle.url}/api/suite`)).json();
    expect(suite.overview.missingImageCount).toBe(0);
    expect(suite.cases[0]?.imageResolved).toBe(true);

    const img = await fetch(`${handle.url}/api/cases/pic/image`);
    expect(img.ok).toBe(true);
    expect(img.headers.get("content-type")).toMatch(/image\/png/);

    const save = await fetch(`${handle.url}/api/cases/pic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gold: { severity: "软色情", accept: ["擦边", "软色情"] },
        notes: "borderline",
        expectedMtimeMs: suite.mtimeMs,
      }),
    });
    expect(save.ok).toBe(true);
    const loaded = loadSuiteFromFile(suitePath);
    expect(loaded.cases[0]?.gold).toEqual({ severity: "软色情", accept: ["擦边", "软色情"] });
    expect(loaded.cases[0]?.feedback).toBe("borderline");

    const bad = await fetch(`${handle.url}/api/cases/pic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gold: { severity: "nope" } }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/Invalid NSFW severity/);
  });
});

describe("suite viewer run overlay", () => {
  const scores = [
    {
      quality: 1,
      split: "train",
      model_id: "gpt-x",
      metric_id: "string_contains",
      version_id: "ver_1",
      case_id: "greet-hello",
      output: "happy to help you",
      reasoning: "greet the shopper",
      finish_reason: "stop",
      reasoning_tokens: 5,
    },
    {
      quality: 0,
      split: "train",
      model_id: "gpt-x",
      metric_id: "string_contains",
      version_id: "ver_1",
      case_id: "refund-ask",
      output: "I cannot help with that",
      note: "missed 30-day",
    },
    {
      quality: 0.5,
      split: "train",
      model_id: "gpt-x",
      metric_id: "string_contains",
    },
  ];

  const report = {
    model: "local-qwen",
    temperature: 0,
    splits: {
      train: {
        meanQuality: 1,
        cases: [{ id: "greet-hello", gold: "happy to help", quality: 1, output: "happy to help" }],
      },
      val: {
        meanQuality: 0,
        cases: [{ id: "greet-hi", gold: "help", quality: 0, output: "hello", note: "too short" }],
      },
    },
  };

  it("includes traj fields on /api/suite and /api/cases when --run is a scores.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spl-viewer-run-"));
    const runPath = join(dir, "scores.json");
    writeFileSync(runPath, JSON.stringify(scores), "utf8");

    const handle = await start(supportSuite, { runPath });
    const suiteRes = await fetch(`${handle.url}/api/suite`);
    expect(suiteRes.ok).toBe(true);
    const body = (await suiteRes.json()) as {
      run: { model?: string; missCount: number; hitCount: number; kind: string };
      cases: Array<{
        id: string;
        prediction?: {
          status: string;
          output?: string;
          reasoning?: string;
          finish_reason?: string;
          reasoning_tokens?: number;
          note?: string;
        };
      }>;
    };
    expect(body.run.kind).toBe("scores");
    expect(body.run.model).toBe("gpt-x");
    expect(body.run.hitCount).toBe(1);
    expect(body.run.missCount).toBe(1);
    const greet = body.cases.find((item) => item.id === "greet-hello");
    expect(greet?.prediction).toMatchObject({
      status: "ok",
      output: "happy to help you",
      reasoning: "greet the shopper",
      finish_reason: "stop",
      reasoning_tokens: 5,
    });
    const refund = body.cases.find((item) => item.id === "refund-ask");
    expect(refund?.prediction).toMatchObject({
      status: "miss",
      output: "I cannot help with that",
      note: "missed 30-day",
    });
    const missing = body.cases.find((item) => item.id === "hours-ask");
    expect(missing?.prediction).toEqual({ status: "none" });

    const detail = await (await fetch(`${handle.url}/api/cases/greet-hello`)).json();
    expect(detail.case.prediction.reasoning).toBe("greet the shopper");
    expect(detail.case.prediction.finish_reason).toBe("stop");
    expect(detail.run.model).toBe("gpt-x");
  });

  it("lists report.json under --runs-dir and does not mutate the report on save", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spl-viewer-runs-"));
    const suitePath = join(dir, "suite.yaml");
    writeFileSync(
      suitePath,
      [
        "id: tmp-run",
        "name: tmp-run",
        "metric:",
        "  id: string_contains",
        "  kind: custom",
        "  returns_feedback: false",
        "splits:",
        "  train:",
        "    - greet-hello",
        "  val: []",
        "cases:",
        "  - id: greet-hello",
        "    input:",
        "      user: Hello",
        "    gold: happy to help",
        "",
      ].join("\n"),
      "utf8",
    );
    const runPath = join(dir, "report.json");
    const original = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(runPath, original, "utf8");

    const handle = await start(suitePath, { runPath, runsDir: dir });
    const listed = await (await fetch(`${handle.url}/api/runs`)).json();
    expect(listed.runs.some((item: { name: string }) => item.name === "report.json")).toBe(true);

    const suite = await (await fetch(`${handle.url}/api/suite`)).json();
    expect(suite.run.kind).toBe("report");
    expect(suite.cases[0]?.prediction?.status).toBe("ok");

    const save = await fetch(`${handle.url}/api/cases/greet-hello`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gold: "happy to help always",
        notes: "tweaked gold",
        expectedMtimeMs: suite.mtimeMs,
      }),
    });
    expect(save.ok).toBe(true);
    const savedBody = await save.json();
    expect(savedBody.suite.cases[0]?.prediction?.output).toBe("happy to help");
    expect(readFileSync(runPath, "utf8")).toBe(original);
    expect(loadSuiteFromFile(suitePath).cases[0]?.gold).toBe("happy to help always");
  });
});
