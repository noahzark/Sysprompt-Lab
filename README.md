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

## Quickstart (offline, no API keys)

```bash
npm run sysprompt -- ingest examples/support-bot
npm run sysprompt -- bind support-bot examples/support-bot/suite.yaml
npm run sysprompt -- export support-bot
```

This reads `examples/support-bot/system.md` (+ `tools.json`), writes a card under `.spl/cards/`, attaches `suite.yaml`, then exports:

- `.spl/export/support-bot/card.json`
- `.spl/export/support-bot/system.promoted.md` (baseline until something is promoted)

Phase 1 stub only — copies the baseline, writes a unified diff, does **not** call a model:

```bash
npm run sysprompt -- run support-bot --rung R0
```

More detail: [examples/support-bot/README.md](examples/support-bot/README.md).

## 在哪里配置 / Where to configure

把仓库根目录（或运行 CLI 时的当前工作目录）里的 `.env.example` 复制为 `.env`，填写这三个变量：

| 变量 | 含义 |
|---|---|
| `LLM_API_BASE` | OpenAI 兼容 API 根地址 |
| `LLM_API_MODEL` | 模型 / API id（如 `gpt-4o-mini`、`deepseek-chat`） |
| `LLM_API_TOKEN` | 密钥；只写在 `.env`，不要提交 |

```bash
cp .env.example .env
```

`ingest` / `bind` / `export` 不需要这些变量。真正调模型的档位才会调用 `getLlmConfig()`。当前的 `run --rung R0` 仍是 stub：若 `.env` 已填写，只打印将使用的 base / model（token 打码），不会发请求。

## Library

```ts
import { ingest, bind, exportCard, loadCard, loadSuite } from "sysprompt-lab";
```

JSON Schema (draft-07) for every entity lives in [`schemas/`](schemas/). Zod sources in `src/schemas.ts` are the runtime validators and can re-emit those files (`npm run emit-schemas`).

## Status

Phase 0: schemas + offline ingest / bind / export. R0 is a stub. R1 / R2 / GEPA are not implemented.

## License

MIT
