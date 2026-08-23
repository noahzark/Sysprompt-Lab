import { mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findRepoRoot, loadSuiteFromFile } from "@sysprompt-lab/core";
import { listenSuiteViewer, type SuiteViewerHandle } from "./server.js";

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

async function start(suitePath: string, imageDir?: string): Promise<SuiteViewerHandle> {
  const handle = await listenSuiteViewer({
    suitePath,
    host: "127.0.0.1",
    port: 0,
    imageDir,
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

    const handle = await start(suitePath, dir);
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
