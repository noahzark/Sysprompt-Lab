# Sysprompt Lab

跨模型的系统提示工作台：读入已有系统提示 → 分档优化（R0 改写 / R1 评测环 / R2 包 GEPA）→ 在指定模型上执行 → 用同一套评测验收，更好才晋升。

## 定位

不是再做一个「粘贴 → 更漂亮的提示」工具，也不是让你先改写成 DSPy 模块。占的是大厂控制台锁模型和编译器框架逼你换对象模型之间的空位。

核心单元是 **Prompt Card**，不是聊天。

## 三档

| 档 | 何时 | 做什么 |
|---|---|---|
| **R0** | 没有数据集 | 元提示改写，出 diff，人接受 |
| **R1** | 有字面系统提示 + 评测集 | 基线 → 失败证据 → 少量候选 → 涨分才换 |
| **R2** | 有任务图式 + 反馈型指标 + 例子 | 包 `gepa` / `dspy.GEPA`，训改验选 |

三档共用同一验收门：执行 → 同指标验证（含 hold-out）→ 质量 / $ / 延迟 → 更好才晋升。

分阶段说明见 [docs/plan.md](docs/plan.md)。给编码代理的稳定约定见 [AGENTS.md](AGENTS.md)。

## Layout

npm workspaces. Public imports use `@sysprompt-lab/<name>` (the root package `sysprompt-lab` re-exports the same surface).

```
packages/core      Card / suite schemas, .spl I/O
packages/llm       OpenAI-compatible client + LLM_API_* env
packages/eval      Score, splits, promote / adopt gate
packages/rewrite   Full rewrite + patch apply + R0/R1 meta-prompts
packages/rungs     R0 / R1 / R2 orchestration (R2 calls python/)
packages/cli       sysprompt / spl bins and commands
python/            GEPA sidecar (not inside a TS package)
schemas/           JSON Schema draft-07 sources of truth
examples/          Ingestable cards (support-bot)
docs/              Product plan
```

## Install

Node 20+. From the repo root:

```bash
npm install
npm run build    # optional; compiles dist/ and refreshes schemas/
npm test
```

Development CLI (no global install):

```bash
npm run sysprompt -- --help
# aliases: npm run spl -- …    or    npx tsx packages/cli/src/cli.ts …
```

After `npm run build`, the bins are `sysprompt` and `spl` (`npx sysprompt` / `npx spl` from this package).

## Quickstart

Offline ingest / bind / export (no API keys):

```bash
npm run sysprompt -- ingest examples/support-bot
npm run sysprompt -- bind support-bot examples/support-bot/suite.yaml
npm run sysprompt -- export support-bot
```

Live R0 rewrite + before/after eval on one model. Copy `.env.example` → `.env` first:

```bash
cp .env.example .env
# fill LLM_API_BASE, LLM_API_MODEL, LLM_API_TOKEN

npm run sysprompt -- ingest examples/support-bot
npm run sysprompt -- bind support-bot examples/support-bot/suite.yaml
npm run sysprompt -- run support-bot --rung R0
npm run sysprompt -- export support-bot
```

`run --rung R0` calls the configured OpenAI-compatible API, writes a candidate + unified diff under `.spl/runs/<id>/r0.diff`, scores **train** and **val** (if the suite has val cases) with the same metric, and auto-promotes **only** when val mean quality strictly rises. Otherwise the new version stays `promoted=false`. Train-only suites never auto-promote.

On large system prompts (`auto` when length ≥ 1500 characters, or `--rewrite-mode patch`) R0 asks for a **structured patch** (JSON edits or a unified diff) and applies it to the current prompt. Tiny prompts still get a full rewrite. Artifacts include `sections.json` (section map) and `patch.json`.

Live R1 eval-loop (same `.env`). The card must already be bound to a suite:

```bash
npm run sysprompt -- ingest examples/support-bot
npm run sysprompt -- bind support-bot examples/support-bot/suite.yaml
npm run sysprompt -- run support-bot --rung R1
```

R1 scores the baseline, shows the rewriter train failures + scores + history, and proposes a few candidates. On large prompts (`auto` ≥ 1500 chars, or `--rewrite-mode patch`) those candidates are **patches** — JSON `edits` or a unified diff — not a full rewrite; the rewriter is told to patch only what the failures implicate. Tiny prompts still use a full rewrite. Each candidate is eval'd on the same suite and adopted only if the score rises (val first, train as a val-tie break; train-only if the suite has no val cases). After the loop it writes `.spl/runs/<id>/candidates.jsonl`, `scores.json`, `sections.json`, and `r1.diff` (baseline → best). Auto-promote happens only if the **final** val (or train if there is no val) strictly beats the original baseline; otherwise the run stays unpromoted and the CLI says so.

Live R2 wraps official GEPA (same `.env`, plus optional `LLM_REFLECTION_MODEL`). Install the Python sidecar first (Python 3.10+; this downloads `gepa`):

```bash
pip install -r python/requirements.txt   # or: pip install -e python/
npm run sysprompt -- ingest examples/support-bot
npm run sysprompt -- bind support-bot examples/support-bot/suite.yaml
npm run sysprompt -- run support-bot --rung R2
```

`--rung R2` writes a job (seed prompt + suite cases + metric + API env), runs `python -m sysprompt_gepa` which calls `gepa.optimize`, then writes the best instruction back onto the Card. Artifacts: `.spl/runs/<id>/r2.diff`, `sidecar.json`, `scores.json`, `candidates.jsonl`, `summary.md`. Train mutates, val selects. Auto-promote uses the same gate as R1 (val must strictly beat the original baseline; train-only suites may promote if train rises). `--dry-run` skips Python and writes a stub candidate (what CI uses). `--budget light|medium|heavy` (default `light` = 24 metric calls; `medium` 60; `heavy` 150) or a positive integer. Do not call R0/R1 “GEPA”. R2 still optimizes the whole instruction via the GEPA sidecar; large-prompt patch mode is R0/R1 only.

Human accept without auto-promote:

```bash
npm run sysprompt -- promote support-bot            # latest non-baseline version
npm run sysprompt -- promote support-bot ver_…      # a specific version
npm run sysprompt -- export support-bot
```

Flags:

| Flag | Effect |
|---|---|
| `--dry-run` | No LLM / Python GEPA calls. R0/R1 apply a tiny fake patch; R2 writes a stub candidate (used by tests) |
| `--no-eval` | R0/R1: rewrite only. R2: skip auto-promote after the wrap |
| `--rounds <n>` | R1 max search rounds (default `3`, or `SYSPROMPT_R1_ROUNDS`) |
| `--candidates <n>` | R1 candidates per round (default `3`, or `SYSPROMPT_R1_CANDIDATES`) |
| `--pass-streak <n>` | R1 stop after N consecutive adopts (default `1`, or `SYSPROMPT_R1_PASS_STREAK`) |
| `--budget <value>` | R1: max candidate evals (int, default `rounds × candidates`). R2: `light` / `medium` / `heavy` or max metric calls (default `light`, or `SYSPROMPT_R2_BUDGET`) |
| `--rewrite-mode <mode>` | R0/R1: `patch` \| `full` \| `auto` (default `auto`). `auto` uses `patch` when the prompt is ≥ 1500 chars (`SYSPROMPT_PATCH_THRESHOLD`), else `full` |
| `--max-patch-ratio <n>` | R0/R1: reject a patch that changes more than this fraction of characters (default `0.8` on R0, `0.5` on R1) |
| `--allow-full-rewrite` / `--no-allow-full-rewrite` | If a patch cannot be applied, retry once, then optionally fall back to a full rewrite. Default: on for R0; off for R1 on large/`patch` prompts |
| `--temperature <n>` | R0/R1 **student** eval temperature (default `0`, or `suite.temperature`). Rewriter stays colder |
| `--max-tokens <n>` | R0/R1 **student** eval `max_tokens` (omit by default, or `suite.max_tokens`) |

More detail: [examples/support-bot/README.md](examples/support-bot/README.md).

Vision cases are supported in the framework (`input.image` / `input.image_path`, student `--temperature` / `--max-tokens`, custom metric `nsfw_severity_tag`) but **do not commit** image binaries or a real tagging bench. Keep the suite and files on your machine; point images at a local directory or `SYSPROMPT_IMAGE_DIR`. Gold for `nsfw_severity_tag` may list multiple acceptable severities (`accept` or a `severity` array) for borderline images.

## 在哪里配置 / Where to configure

把仓库根目录（或运行 CLI 时的当前工作目录）里的 `.env.example` 复制为 `.env`，填写这三个变量：

| 变量 | 含义 |
|---|---|
| `LLM_API_BASE` | OpenAI 兼容 API 根地址。若没有 `/v1` 后缀会自动补上，再 POST `{base}/chat/completions` |
| `LLM_API_MODEL` | 模型 / API id（如 `gpt-4o-mini`、`deepseek-chat`） |
| `LLM_API_TOKEN` | 密钥；只写在 `.env`，不要提交。日志里只打码，不会打印原文 |

```bash
cp .env.example .env
```

`ingest` / `bind` / `export` / `run --dry-run` 不需要这些变量。真正调模型的 `run --rung R0` / `R1` / `R2` 会调用 `getLlmConfig()`；缺任一变量会报错并提示复制 `.env.example`。

R1 循环次数也可用环境变量覆盖（命令行 flag 优先）：`SYSPROMPT_R1_ROUNDS`、`SYSPROMPT_R1_CANDIDATES`、`SYSPROMPT_R1_PASS_STREAK`、`SYSPROMPT_R1_BUDGET`。

R0/R1 改写模式：`SYSPROMPT_REWRITE_MODE`（`patch` / `full` / `auto`）、`SYSPROMPT_PATCH_THRESHOLD`（默认 1500 字符）。大提示默认打补丁，避免整段重写被截断。

R2 还可用 `LLM_REFLECTION_MODEL`（缺省与 `LLM_API_MODEL` 相同）、`SYSPROMPT_R2_BUDGET`、`SYSPROMPT_PYTHON`。日志只打码 token，不会打印原文。

## Library

```ts
import { ingest, bind, exportCard, runR0, runR1, runR2, promoteVersion, loadCard, loadSuite } from "sysprompt-lab";
```

JSON Schema (draft-07) for every entity lives in [`schemas/`](schemas/). Zod sources in [`packages/core`](packages/core) are the runtime validators and can re-emit those files (`npm run emit-schemas`). Package READMEs document each workspace’s public surface and non-goals.

## Status

Phase 3: schemas + offline ingest / bind / export + R0 rewrite, R1 eval-loop, and R2 GEPA wrap (`python -m sysprompt_gepa`). Live R2 needs `pip install -r python/requirements.txt`.

## License

MIT
