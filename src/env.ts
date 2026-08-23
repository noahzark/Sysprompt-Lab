import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

export const LLM_ENV_KEYS = ["LLM_API_BASE", "LLM_API_MODEL", "LLM_API_TOKEN"] as const;

export interface LlmConfig {
  apiBase: string;
  model: string;
  token: string;
}

export interface LoadEnvOptions {
  cwd?: string;
  root?: string;
}

/** Load `.env` from cwd, then from `--root` if it is a different directory. Existing process.env wins. */
export function loadEnvFiles(options: LoadEnvOptions = {}): string[] {
  const cwd = resolve(options.cwd ?? process.cwd());
  const paths = [resolve(cwd, ".env")];
  if (options.root) {
    const rootEnv = resolve(options.root, ".env");
    if (!paths.includes(rootEnv)) {
      paths.push(rootEnv);
    }
  }
  const loaded: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }
    loadDotenv({ path, override: false, quiet: true });
    loaded.push(path);
  }
  return loaded;
}

function readVar(name: (typeof LLM_ENV_KEYS)[number]): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function readLlmConfig(): LlmConfig | null {
  const apiBase = readVar("LLM_API_BASE");
  const model = readVar("LLM_API_MODEL");
  const token = readVar("LLM_API_TOKEN");
  if (!apiBase && !model && !token) {
    return null;
  }
  if (!apiBase || !model || !token) {
    return null;
  }
  return { apiBase: stripTrailingSlash(apiBase), model, token };
}

/** Required LLM settings. Throws if any of the three vars are missing. */
export function getLlmConfig(): LlmConfig {
  const apiBase = readVar("LLM_API_BASE");
  const model = readVar("LLM_API_MODEL");
  const token = readVar("LLM_API_TOKEN");
  const missing = LLM_ENV_KEYS.filter((key, i) => ![apiBase, model, token][i]);
  if (missing.length > 0) {
    throw new Error(
      `缺少 LLM 配置：${missing.join(", ")}。请复制 .env.example 为 .env 并填写。\n` +
        `Missing LLM config: ${missing.join(", ")}. Copy .env.example to .env and fill in the values.`,
    );
  }
  return { apiBase: stripTrailingSlash(apiBase!), model: model!, token: token! };
}

export function maskToken(token: string): string {
  if (token.length <= 4) {
    return "****";
  }
  return `${token.slice(0, 3)}…${token.slice(-2)}`;
}

export function formatLlmTarget(config: LlmConfig): string {
  return `${config.model} @ ${config.apiBase} (token ${maskToken(config.token)})`;
}

/** Peek `--root` from argv so `.env` can load before Commander parses. */
export function peekRootFlag(argv: string[] = process.argv): string | undefined {
  const index = argv.indexOf("--root");
  if (index >= 0) {
    const value = argv[index + 1];
    if (value && !value.startsWith("-")) {
      return value;
    }
  }
  const eq = argv.find((arg) => arg.startsWith("--root="));
  return eq ? eq.slice("--root=".length) || undefined : undefined;
}
