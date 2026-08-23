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

分阶段说明见 [docs/plan.md](docs/plan.md)。

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
# aliases: npm run spl -- …    or    npx tsx src/cli.ts …
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

Live R1 eval-loop (same `.env`). The card must already be bound to a suite:

```bash
npm run sysprompt -- ingest examples/support-bot
npm run sysprompt -- bind support-bot examples/support-bot/suite.yaml
npm run sysprompt -- run support-bot --rung R1
```

R1 scores the baseline, shows the rewriter train failures + scores + history, proposes a few full-prompt candidates, evals each one on the same suite, and adopts only if the score rises (val first, train as a val-tie break; train-only if the suite has no val cases). After the loop it writes `.spl/runs/<id>/candidates.jsonl`, `scores.json`, and `r1.diff` (baseline → best). Auto-promote happens only if the **final** val (or train if there is no val) strictly beats the original baseline; otherwise the run stays unpromoted and the CLI says so.

Human accept without auto-promote:

```bash
npm run sysprompt -- promote support-bot            # latest non-baseline version
npm run sysprompt -- promote support-bot ver_…      # a specific version
npm run sysprompt -- export support-bot
```

Flags:

| Flag | Effect |
|---|---|
| `--dry-run` | No LLM calls. R0 copies the baseline; R1 writes fake candidates (used by tests) |
| `--no-eval` | Rewrite only; skip eval and auto-promote |
| `--rounds <n>` | R1 max search rounds (default `3`, or `SYSPROMPT_R1_ROUNDS`) |
| `--candidates <n>` | R1 candidates per round (default `3`, or `SYSPROMPT_R1_CANDIDATES`) |
| `--pass-streak <n>` | R1 stop after N consecutive adopts (default `1`, or `SYSPROMPT_R1_PASS_STREAK`) |
| `--budget <n>` | R1 max candidate evals (default `rounds × candidates`, or `SYSPROMPT_R1_BUDGET`) |

`run --rung R2` is rejected (GEPA wrap is a later phase).

More detail: [examples/support-bot/README.md](examples/support-bot/README.md).

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

`ingest` / `bind` / `export` / `run --dry-run` 不需要这些变量。真正调模型的 `run --rung R0` / `R1` 会调用 `getLlmConfig()`；缺任一变量会报错并提示复制 `.env.example`。

R1 循环次数也可用环境变量覆盖（命令行 flag 优先）：`SYSPROMPT_R1_ROUNDS`、`SYSPROMPT_R1_CANDIDATES`、`SYSPROMPT_R1_PASS_STREAK`、`SYSPROMPT_R1_BUDGET`。

## Library

```ts
import { ingest, bind, exportCard, runR0, runR1, promoteVersion, loadCard, loadSuite } from "sysprompt-lab";
```

JSON Schema (draft-07) for every entity lives in [`schemas/`](schemas/). Zod sources in `src/schemas.ts` are the runtime validators and can re-emit those files (`npm run emit-schemas`).

## Status

Phase 2: schemas + offline ingest / bind / export + R0 rewrite and R1 eval-loop. R2 / GEPA are not implemented.

## License

MIT
