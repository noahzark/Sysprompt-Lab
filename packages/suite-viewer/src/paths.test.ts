import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "@sysprompt-lab/core";
import { caseImageResolve, tryResolveViewerImage } from "./paths.js";

const repo = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(repo, "test", "fixtures");
const tinyPng = join(fixtures, "tiny.png");

describe("tryResolveViewerImage", () => {
  it("resolves a basename via imageDir (eval-compatible roots)", () => {
    expect(tryResolveViewerImage("tiny.png", { imageDir: fixtures })).toEqual({
      ok: true,
      path: tinyPng,
      remote: false,
    });
    expect(tryResolveViewerImage("images/tiny.png", { imageDir: fixtures })).toEqual({
      ok: true,
      path: tinyPng,
      remote: false,
    });
  });

  it("resolves a path relative to the suite directory", () => {
    expect(tryResolveViewerImage("tiny.png", { suiteDir: fixtures })).toEqual({
      ok: true,
      path: tinyPng,
      remote: false,
    });
  });

  it("returns ok:false when the file is missing", () => {
    expect(tryResolveViewerImage("missing-no-such.png", { suiteDir: fixtures, imageDir: fixtures })).toEqual({
      ok: false,
    });
    expect(tryResolveViewerImage(undefined)).toEqual({ ok: false });
  });

  it("passes through data and http refs without looking on disk", () => {
    expect(tryResolveViewerImage("https://example.test/a.png")).toEqual({
      ok: true,
      path: "https://example.test/a.png",
      remote: true,
    });
    expect(tryResolveViewerImage("data:image/png;base64,aa")).toMatchObject({ ok: true, remote: true });
  });

  it("reads image / image_path from a case input", () => {
    expect(caseImageResolve({ user: "x" }).ref).toBeUndefined();
    expect(caseImageResolve({ image_path: "tiny.png" }, { imageDir: fixtures }).resolved).toEqual({
      ok: true,
      path: tinyPng,
      remote: false,
    });
  });
});
