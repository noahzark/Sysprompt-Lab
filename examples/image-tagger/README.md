# Image tagger (vision) example

Optimize a Chinese image-classifier system prompt. The student model sees **system prompt + user text + image** and must return:

```json
{"tags":["..."],"description":"...","score":0}
```

Primary metric (`nsfw_severity_tag`): parse JSON (markdown fences ok), take the single NSFW severity tag among `{性感, 擦边, 软色情, 露骨, 硬色情}`, score **1** iff it equals `gold.severity`. Misses produce `got X want Y` feedback for the R1 rewriter (text only — the rewriter does not see images).

## Images are not in git

Do **not** commit the 8 NSFW frames. Copy them locally:

```bash
mkdir -p examples/image-tagger/images
# copy <hash>.mp4.jpg into that directory, names matching suite.yaml
```

Expected filenames (same hashes as the case ids):

| File | Gold severity |
|---|---|
| `1617a8ff965998f96b1b38e19aee54af.mp4.jpg` | 软色情 |
| `18b441ee4f2d65dc21a75ebc9c7753ac.mp4.jpg` | 软色情 |
| `1b4ef13d7a1d71c78636ccdbbb6da925.mp4.jpg` | 硬色情 |
| `20ccf9c90777b0749e7cb38a29f0d71d.mp4.jpg` | 软色情 |
| `57daa318c1d36340351547bbf580712b.mp4.jpg` | 露骨 |
| `7d04f38fad7bc9271cc89215615b6411.mp4.jpg` | 硬色情 |
| `c890adfb60d7e91efff8444d34a78e90.mp4.jpg` | 露骨 |
| `f487a4e0fb37896b9ba12dfde4a89f08.mp4.jpg` | 性感 |

`examples/image-tagger/images/` is gitignored. Alternatively point at another folder:

```bash
export SYSPROMPT_IMAGE_DIR=/path/to/your/frames
```

Paths in the suite (`images/<file>.mp4.jpg`) resolve against, in order: `SYSPROMPT_IMAGE_DIR`, the card ingest directory (`card.source`), the suite file directory, then cwd. The resolver also accepts the bare filename inside `SYSPROMPT_IMAGE_DIR`.

## Labeling notes

- 故意突显胸 / 臀 / 阴部 → **软色情**（即使未露点）。
- 未露点不要标 **露骨**。
- 五档严重程度只能标一个：性感 < 擦边 < 软色情 < 露骨 < 硬色情。

## Offline (no images, no API)

Ingest / bind / validate do not read the jpgs:

```bash
npm run sysprompt -- ingest examples/image-tagger
npm run sysprompt -- bind image-tagger examples/image-tagger/suite.yaml
npm run sysprompt -- validate examples/image-tagger/suite.yaml
```

## Live baseline (needs images + vision model)

Copy `.env.example` → `.env`. Use a **vision** student model (`LLM_API_MODEL`). Suite defaults: student `temperature: 1`, `max_tokens: 4096`. The rewriter stays colder.

```bash
cp .env.example .env
# fill LLM_API_BASE, LLM_API_MODEL (vision), LLM_API_TOKEN
# copy the 8 jpgs into examples/image-tagger/images/

npm run sysprompt -- ingest examples/image-tagger
npm run sysprompt -- bind image-tagger examples/image-tagger/suite.yaml
npm run sysprompt -- run image-tagger --rung R0
# or the eval loop:
npm run sysprompt -- run image-tagger --rung R1
```

CLI flags override the suite (`--temperature 1 --max-tokens 4096`). R2 / GEPA is out of scope for vision.

Train is 5 cases, val is 3; both splits mix severities. Auto-promote still requires a **strict val rise**.
