# Sysprompt Lab

[English](README.md) | 简体中文

跨模型的系统提示工作台：读入已有系统提示 → 分档优化（R0 改写 / R1 评测环 / R2 包 GEPA）→ 在指定模型上执行 → 用同一套评测验收，更好才晋升。

## 定位

不是再做一个「粘贴 → 更漂亮的提示」工具，也不是让你先改写成 DSPy 模块。占的是大厂控制台锁模型和编译器框架逼你换对象模型之间的空位。

核心单元是 **Prompt Card**，不是聊天。

## 三档一览

| 档 | 何时 | 做什么 |
|---|---|---|
| **R0** | 没有数据集 / 一次性 | 元提示改写或结构化补丁，出 unified diff，人接受 |
| **R1** | 有字面系统提示 + 评测集 | 基线 → 失败证据 → 少量候选 → 涨分才换 |
| **R2** | 同一张 Card + 评测集，需要 Python | 包官方 `gepa.optimize`（sidecar）：train 变异，val 选择 |

三档共用同一验收门：执行 → 同指标验证（含 val hold-out）→ val 均分严格上升才自动晋升。

分阶段说明见 [docs/plan.md](docs/plan.md)。给编码代理的稳定约定见 [AGENTS.md](AGENTS.md)。

## 目录结构

npm workspaces。公共导入使用 `@sysprompt-lab/<name>`（根包 `sysprompt-lab` 重新导出同一组接口）。

```
packages/core      Card / suite schema，.spl 读写
packages/llm       OpenAI 兼容客户端 + LLM_API_* 环境变量
packages/eval      打分、数据划分、晋升 / 采纳判定
packages/rewrite   整段改写 + 补丁应用 + R0/R1 元提示
packages/rungs     R0 / R1 / R2 编排（R2 调用 python/）
packages/cli       sysprompt / spl 命令行与各命令
packages/suite-viewer  本地 Suite Viewer（查看 / 标注评测集）
python/            GEPA sidecar（不放进 TS 包里）
schemas/           JSON Schema draft-07，唯一事实来源
examples/          可 ingest 的示例卡片（support-bot）
docs/              产品规划
```

## 安装

Node 20+。在仓库根目录：

```bash
npm install
npm run build    # 可选；编译 dist/ 并刷新 schemas/
npm test
```

开发用 CLI（无需全局安装）：

```bash
npm run sysprompt -- --help
# 别名：npm run spl -- …    或    npx tsx packages/cli/src/cli.ts …
```

`npm run build` 之后，可执行文件为 `sysprompt` 和 `spl`（在本包内用 `npx sysprompt` / `npx spl`）。

## 快速上手

用自带示例走完整流程：读入提示 → 绑定评测集 → 在某一档上优化 → 同指标评测 → 晋升 → 导出。除第 4 步外都可离线运行，不需要 API 密钥。

```bash
# 1. 读入：examples/support-bot/system.md（+ tools.json）→ 草稿 Prompt Card
npm run sysprompt -- ingest examples/support-bot

# 2. 校验评测集，再绑定到卡片（状态变为 bound）
npm run sysprompt -- validate examples/support-bot/suite.yaml
npm run sysprompt -- bind support-bot examples/support-bot/suite.yaml

# 3. 在某一档上优化 + 评测（离线桩；不需要 API 密钥和 Python）
npm run sysprompt -- run support-bot --rung R1 --dry-run

# 4. 真实调用：复制 .env.example → .env，填写 LLM_API_BASE / LLM_API_MODEL / LLM_API_TOKEN
cp .env.example .env
npm run sysprompt -- run support-bot --rung R1     # 或 R0，或 R2（需要 Python sidecar）

# 5. 晋升：只有 val 严格提升才自动晋升；否则手动接受
npm run sysprompt -- promote support-bot           # 最新的非基线版本
npm run sysprompt -- promote support-bot ver_…     # 或指定版本 id

# 6. 导出已晋升的提示（没有晋升版本时导出基线）
npm run sysprompt -- export support-bot            # → .spl/export/support-bot/system.promoted.md
```

每次真实 `run` 都会在**同一套**评测集和指标上给基线和候选打分，并打印 train / val 表格。工作区状态存放在当前目录（或 `--root <dir>`）下的 `.spl/`，不要提交：

| 路径 | 内容 |
|---|---|
| `.spl/cards/<card>.json` | Prompt Card（含全部版本） |
| `.spl/suites/<suite>.json` | 规范化后的评测集（由 `bind` 写入） |
| `.spl/runs/<run>/` | 每次运行的产物：`run.json`、`candidates.json`、`r0.diff` / `r1.diff` / `r2.diff`、`scores.json`（真实评测），以及下文各档特有的文件 |
| `.spl/export/<card>/` | `card.json` + `system.promoted.md` |

## Prompt Card 格式

`ingest <path>` 读取一个目录（或目录中的 `system.md` 路径）：

| 文件 | 必需 | 内容 |
|---|---|---|
| `system.md` | 是 | 字面系统提示，原样作为基线版本 |
| `tools.json` | 否 | `[{ "id", "name", "description" }]` 或 `{ "tools": [...] }` |

卡片 id 默认取目录名（slug 化），可用 `--id` 覆盖。存储的卡片（`schemas/prompt-card.json`）形如：

```jsonc
{
  "id": "support-bot",
  "source": "/abs/path/examples/support-bot",
  "rung": "R0",                       // 最近一次运行的档：R0 | R1 | R2
  "status": "draft",                  // draft → bound → optimizing → verifying → promoted → exported（或 rejected）
  "suite_id": "support-bot",          // 由 `bind` 设置
  "versions": [
    { "id": "ver_…", "system_prompt": "…", "is_baseline": true, "promoted": false },
    { "id": "ver_…", "system_prompt": "…", "hypothesis": "…", "is_baseline": false, "promoted": true, "parent": "ver_…" }
  ],
  "tools": [{ "id": "lookup_order", "name": "lookup_order", "description": "…" }],
  "models": []
}
```

每一档都只追加版本，不会覆盖基线。`promote` 把某个版本标记为 `promoted`，`export` 导出该版本（或基线）。

## 评测集格式

YAML 或 JSON（`schemas/eval-suite.json`）。参见 [`examples/support-bot/suite.yaml`](examples/support-bot/suite.yaml)：

```yaml
id: support-bot
name: Support bot offline suite
metric:
  id: string_contains
  kind: custom            # exact | custom（llm_judge 尚未实现）
  returns_feedback: false
splits:                   # 用例 id；一个用例只能属于一个划分
  train: [greet-hello, refund-ask, hours-ask, unknown-order]
  val: [greet-hi, escalate-angry]   # 可为空；只有 train 的评测集在 R0 上永不自动晋升
cases:
  - id: refund-ask
    input:
      user: I want a refund for my last purchase.
      # image: / image_path: 视觉用例的本地 jpeg/png/webp
    gold: 30-day
    feedback: 可选，给改写器看的备注
temperature: 0            # 可选，仅用于学生模型评测
max_tokens: 512           # 可选，仅用于学生模型评测
```

各 `metric` 的打分规则：

| `kind` / `id` | 通过条件 |
|---|---|
| `exact` | 去除首尾空白后输出等于 `gold` |
| `custom`（任意 id） | 输出包含 `gold`（不区分大小写） |
| `custom` + `id: nsfw_severity_tag` | JSON `tags[]` 中有一个严重度标签与 gold 匹配（见[视觉用例](#视觉用例)） |

划分也可以写成 `{ name: train, case_ids: [...] }`。

## 命令

所有命令都接受全局参数 `--root <dir>`（存放 `.spl/` 的工作区，默认为当前目录）。`<card>` 可以是卡片 id，也可以是卡片 JSON 的路径。

| 命令 | 作用 |
|---|---|
| `ingest <path> [--id <id>]` | `system.md`（+ `tools.json`）→ 草稿卡片 |
| `validate <path>` | 按 schema 校验卡片 JSON 或评测集 YAML/JSON |
| `bind <card> <suite.yaml>` | 绑定评测集；状态变为 `bound` |
| `run <card> --rung R0\|R1\|R2 [flags]` | 优化 + 评测；各档与参数见下文 |
| `promote <card> [version]` | 人工接受；不会重跑验收门 |
| `export <card> [-o <dir>]` | `card.json` + `system.promoted.md`（默认 `.spl/export/<card>`） |
| `suite-viewer <suite.yaml> [flags]` | 本地 WebUI；见 [Suite Viewer](#suite-viewer-本地-webui) |

`ingest` / `bind` / `export` / `validate` / `promote` / `run --dry-run` / `suite-viewer` 不需要 LLM 环境变量。

## 三档详解

**R0**（`run --rung R0`）调用配置好的 OpenAI 兼容 API，在 `.spl/runs/<id>/r0.diff` 写出候选和 unified diff，用同一指标给 **train** 和 **val**（若评测集有 val 用例）打分，**只有** val 均分严格上升时才自动晋升。否则新版本保持 `promoted=false`。只有 train 的评测集永不自动晋升。

对大系统提示（`auto` 模式下长度 ≥ 1500 字符，或 `--rewrite-mode patch`），R0 会要求**结构化补丁**（JSON edits 或 unified diff）并应用到当前提示上。小提示仍然整段改写。产物包括 `sections.json`（分段映射）和 `patch.json`。

**R1**（`run --rung R1`，同一份 `.env`；卡片必须已绑定）先给基线打分，把 train 失败用例、分数和历史交给改写器，让它提出少量候选。对大提示（`auto` ≥ 1500 字符，或 `--rewrite-mode patch`），候选是**补丁**（JSON `edits` 或 unified diff），而不是整段改写；改写器只修补失败用例牵涉到的部分。小提示仍然整段改写。每个候选都在同一套评测集上评测，只有分数上升才采纳（先看 val，val 打平时用 train 决胜；评测集没有 val 时只看 train）。循环结束后写出 `.spl/runs/<id>/candidates.jsonl`、`scores.json`、`sections.json` 和 `r1.diff`（基线 → 最优）。只有**最终** val（无 val 时为 train）严格超过最初基线才自动晋升；否则本次运行不晋升，CLI 会说明。

**R2** 包装官方 GEPA（同一份 `.env`，另可选 `LLM_REFLECTION_MODEL`）。先安装 Python sidecar（Python 3.10+；会下载 `gepa`）：

```bash
pip install -r python/requirements.txt   # 或：pip install -e python/
npm run sysprompt -- run support-bot --rung R2 --budget light
```

`--rung R2` 写出一个任务（种子提示 + 评测用例 + 指标 + API 环境），运行调用 `gepa.optimize` 的 `python -m sysprompt_gepa`，再把最优指令写回 Card。产物：`.spl/runs/<id>/r2.diff`、`sidecar.json`、`scores.json`、`candidates.jsonl`、`summary.md`。train 变异，val 选择。进入验收门之前，基线和 GEPA 的最优提示会在 TypeScript 中用评测集指标重新打分（与 R0/R1 同一个评分器），只有这些分数决定是否晋升；sidecar 自己的分数作为诊断信息保留在 `sidecar.json` 和 `summary.md` 中。自动晋升与 R1 用同一验收门（val 必须严格超过最初基线；只有 train 的评测集在 train 上升时可晋升）。`--dry-run` 跳过 Python，写出桩候选（CI 使用）。`--budget light|medium|heavy`（默认 `light` = 24 次指标调用；`medium` 60；`heavy` 150）或正整数。不要把 R0/R1 称为「GEPA」。R2 通过 GEPA sidecar 优化整段指令；大提示补丁模式只用于 R0/R1。

### `run` 参数

| 参数 | 作用 |
|---|---|
| `--dry-run` | 不调用 LLM / Python GEPA。R0/R1 应用一个很小的假补丁；R2 写出桩候选（测试使用） |
| `--no-eval` | R0/R1：只改写。R2：包装后跳过复核和自动晋升 |
| `--rounds <n>` | R1 最大搜索轮数（默认 `3`，或 `SYSPROMPT_R1_ROUNDS`） |
| `--candidates <n>` | R1 每轮候选数（默认 `3`，或 `SYSPROMPT_R1_CANDIDATES`） |
| `--pass-streak <n>` | R1 连续采纳 N 次后停止（默认 `1`，或 `SYSPROMPT_R1_PASS_STREAK`） |
| `--budget <value>` | R1：最大候选评测次数（整数，默认 `rounds × candidates`）。R2：`light` / `medium` / `heavy` 或最大指标调用次数（默认 `light`，或 `SYSPROMPT_R2_BUDGET`） |
| `--rewrite-mode <mode>` | R0/R1：`patch` \| `full` \| `auto`（默认 `auto`）。`auto` 在提示 ≥ 1500 字符（`SYSPROMPT_PATCH_THRESHOLD`）时用 `patch`，否则用 `full` |
| `--max-patch-ratio <n>` | R0/R1：拒绝改动字符比例超过该值的补丁（R0 默认 `0.8`，R1 默认 `0.5`） |
| `--allow-full-rewrite` / `--no-allow-full-rewrite` | 补丁无法应用时重试一次，之后可选择回退到整段改写。默认：R0 开启；R1 在大提示 / `patch` 模式下关闭 |
| `--temperature <n>` | R0/R1 及 R2 复核的**学生模型**评测温度（默认 `0`，或 `suite.temperature`）。改写器温度更低 |
| `--max-tokens <n>` | R0/R1 及 R2 复核的**学生模型**评测 `max_tokens`（默认不传，或 `suite.max_tokens`） |

更多细节：[examples/support-bot/README.md](examples/support-bot/README.md)。

### 视觉用例

框架支持视觉用例（`input.image` / `input.image_path`、学生模型 `--temperature` / `--max-tokens`、自定义指标 `nsfw_severity_tag`），但**不要提交**图片文件或真实的打标评测集。评测集和文件留在本机；图片指向本地目录或 `SYSPROMPT_IMAGE_DIR`。`nsfw_severity_tag` 的 gold 可以为边界图片列出多个可接受的严重度（`accept` 或 `severity` 数组）。gold 没有等级时，模型也不输出严重度标签即算通过。

### Suite Viewer 本地 WebUI

查看评测集、预览本地图片，并把 gold / 备注写回磁盘上的 YAML。可选叠加一次已保存的评测运行（`--run report.json|scores.json`）来查看未命中的用例：gold 与模型输出对比，文件中有推理过程时一并显示。**只绑定本机**（默认 `127.0.0.1:8787`）。不做云端部署、不做鉴权、不在 UI 中调用模型评测。

```bash
npm run suite-viewer -- examples/support-bot/suite.yaml
npm run suite-viewer -- /path/to/private/suite.yaml --port 8787 --image-dir /path/to/images
npm run suite-viewer -- examples/support-bot/suite.yaml --run /path/to/report.json
# 也可以通过 CLI：
npm run sysprompt -- suite-viewer /path/to/private/suite.yaml --run scores.json --runs-dir .spl/runs
```

参数：`--port <n>`（默认 `8787`）、`--host <host>`（默认 `127.0.0.1`）、`--image-dir <dir>`（或 `SYSPROMPT_IMAGE_DIR`）、`--run <file>`（只读叠加）、`--runs-dir <dir>`（UI 可切换的运行文件目录）。

请指向**私有**评测集路径。保存是原子操作（临时文件 + 重命名），会拒绝写入无效的 NSFW 严重度。如果文件在磁盘上已被修改，UI 会在覆盖前询问。保存 gold 不会修改运行文件。参见 [`packages/suite-viewer/README.md`](packages/suite-viewer/README.md)。

## 在哪里配置

把仓库根目录（或运行 CLI 时的当前工作目录）里的 `.env.example` 复制为 `.env`，填写这三个变量：

| 变量 | 含义 |
|---|---|
| `LLM_API_BASE` | OpenAI 兼容 API 根地址。若没有 `/v1` 后缀会自动补上，再 POST `{base}/chat/completions` |
| `LLM_API_MODEL` | 模型 / API id（如 `gpt-4o-mini`、`deepseek-chat`） |
| `LLM_API_TOKEN` | 密钥；只写在 `.env`，不要提交。日志里只打码，不会打印原文 |

```bash
cp .env.example .env
```

`ingest` / `bind` / `export` / `validate` / `promote` / `run --dry-run` / `suite-viewer` 不需要这些变量。真正调模型的 `run --rung R0` / `R1` / `R2` 会调用 `getLlmConfig()`；缺任一变量会报错并提示复制 `.env.example`。

可选覆盖项（命令行参数优先）：

| 变量 | 含义 |
|---|---|
| `SYSPROMPT_R1_ROUNDS` / `SYSPROMPT_R1_CANDIDATES` / `SYSPROMPT_R1_PASS_STREAK` / `SYSPROMPT_R1_BUDGET` | R1 循环参数 |
| `SYSPROMPT_REWRITE_MODE` | R0/R1 改写模式：`patch` / `full` / `auto`。大提示默认打补丁，避免整段重写被截断 |
| `SYSPROMPT_PATCH_THRESHOLD` | `auto` 模式切换到补丁的字符数（默认 `1500`） |
| `LLM_REFLECTION_MODEL` | R2 反思模型；缺省与 `LLM_API_MODEL` 相同 |
| `SYSPROMPT_R2_BUDGET` | R2 预算：`light` / `medium` / `heavy` 或最大指标调用次数 |
| `SYSPROMPT_PYTHON` | R2 sidecar 使用的 Python 3.10+ 可执行文件 |
| `SYSPROMPT_IMAGE_DIR` | 视觉用例的本地图片目录 |

## 作为库使用

```ts
import { ingest, bind, exportCard, runR0, runR1, runR2, promoteVersion, loadCard, loadSuite } from "sysprompt-lab";
```

每个实体的 JSON Schema（draft-07）都在 [`schemas/`](schemas/)。[`packages/core`](packages/core) 中的 Zod 定义是运行时校验器，也可重新生成这些文件（`npm run emit-schemas`）。各包的 README 说明其公共接口和不做的事。

## 状态

Phase 3：schema + 离线 ingest / bind / validate / export + R0 改写、R1 评测环（均支持大提示补丁模式）、R2 GEPA 包装（`python -m sysprompt_gepa`）、多模态评测用例，以及本地 Suite Viewer。真实运行 R2 需要 `pip install -r python/requirements.txt`。

## 许可证

MIT
