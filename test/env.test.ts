import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatLlmTarget,
  getLlmConfig,
  loadEnvFiles,
  maskToken,
  peekRootFlag,
  readLlmConfig,
} from "../src/env.js";

const KEYS = ["LLM_API_BASE", "LLM_API_MODEL", "LLM_API_TOKEN"] as const;
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function snapshotEnv(): Record<(typeof KEYS)[number], string | undefined> {
  return {
    LLM_API_BASE: process.env.LLM_API_BASE,
    LLM_API_MODEL: process.env.LLM_API_MODEL,
    LLM_API_TOKEN: process.env.LLM_API_TOKEN,
  };
}

function restoreEnv(prev: ReturnType<typeof snapshotEnv>): void {
  for (const key of KEYS) {
    if (prev[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev[key];
    }
  }
}

function clearLlmEnv(): void {
  for (const key of KEYS) {
    delete process.env[key];
  }
}

const saved = snapshotEnv();
afterEach(() => {
  restoreEnv(saved);
});

describe(".env.example", () => {
  it("documents the three uppercase LLM variables", () => {
    const text = readFileSync(join(repo, ".env.example"), "utf8");
    for (const key of KEYS) {
      expect(text).toMatch(new RegExp(`^${key}=`, "m"));
    }
    expect(text).toMatch(/LLM_API_TOKEN=\s*$/m);
  });
});

describe("getLlmConfig", () => {
  it("reads LLM_API_BASE / LLM_API_MODEL / LLM_API_TOKEN from env", () => {
    process.env.LLM_API_BASE = "https://api.example.com/v1/";
    process.env.LLM_API_MODEL = "gpt-4o-mini";
    process.env.LLM_API_TOKEN = "sk-test-token";
    expect(getLlmConfig()).toEqual({
      apiBase: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      token: "sk-test-token",
    });
  });

  it("throws a clear error when any required var is missing", () => {
    clearLlmEnv();
    process.env.LLM_API_BASE = "https://api.openai.com/v1";
    process.env.LLM_API_MODEL = "gpt-4o-mini";
    expect(() => getLlmConfig()).toThrow(/LLM_API_TOKEN/);
    expect(() => getLlmConfig()).toThrow(/\.env\.example/);
  });
});

describe("readLlmConfig", () => {
  it("returns null when config is absent (ingest/bind/export stay offline)", () => {
    clearLlmEnv();
    expect(readLlmConfig()).toBeNull();
  });

  it("returns null when only some vars are set", () => {
    clearLlmEnv();
    process.env.LLM_API_MODEL = "gpt-4o-mini";
    expect(readLlmConfig()).toBeNull();
  });
});

describe("loadEnvFiles", () => {
  it("loads .env from cwd and falls back to --root without overriding cwd", () => {
    clearLlmEnv();
    const cwd = mkdtempSync(join(tmpdir(), "spl-env-cwd-"));
    const root = mkdtempSync(join(tmpdir(), "spl-env-root-"));
    writeFileSync(
      join(cwd, ".env"),
      "LLM_API_BASE=https://from-cwd.example/v1\nLLM_API_MODEL=cwd-model\nLLM_API_TOKEN=cwd-token\n",
    );
    writeFileSync(
      join(root, ".env"),
      "LLM_API_BASE=https://from-root.example/v1\nLLM_API_MODEL=root-model\nLLM_API_TOKEN=root-token\n",
    );

    const loaded = loadEnvFiles({ cwd, root });
    expect(loaded).toHaveLength(2);
    expect(getLlmConfig()).toEqual({
      apiBase: "https://from-cwd.example/v1",
      model: "cwd-model",
      token: "cwd-token",
    });
  });

  it("loads --root .env when cwd has none", () => {
    clearLlmEnv();
    const cwd = mkdtempSync(join(tmpdir(), "spl-env-empty-"));
    const root = mkdtempSync(join(tmpdir(), "spl-env-only-root-"));
    writeFileSync(
      join(root, ".env"),
      "LLM_API_BASE=https://root-only.example/v1\nLLM_API_MODEL=root-only\nLLM_API_TOKEN=root-secret\n",
    );
    loadEnvFiles({ cwd, root });
    expect(getLlmConfig().model).toBe("root-only");
  });
});

describe("maskToken / peekRootFlag", () => {
  it("masks the token and formats the target line", () => {
    expect(maskToken("sk-secret-value")).toBe("sk-…ue");
    expect(
      formatLlmTarget({
        apiBase: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        token: "sk-secret-value",
      }),
    ).toContain("gpt-4o-mini @ https://api.openai.com/v1");
    expect(
      formatLlmTarget({
        apiBase: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        token: "sk-secret-value",
      }),
    ).not.toContain("sk-secret-value");
  });

  it("peeks --root from argv", () => {
    expect(peekRootFlag(["node", "cli", "--root", "/tmp/ws", "run"])).toBe("/tmp/ws");
    expect(peekRootFlag(["node", "cli", "--root=/tmp/ws"])).toBe("/tmp/ws");
    expect(peekRootFlag(["node", "cli", "ingest", "x"])).toBeUndefined();
  });
});
