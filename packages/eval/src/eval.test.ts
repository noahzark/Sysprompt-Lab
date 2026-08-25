import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adoptDecision,
  caseUserContent,
  caseUserText,
  DEFAULT_IMAGE_USER_TEXT,
  evaluatePrompt,
  formatScoreTable,
  promotionDecision,
  r1PromotionDecision,
  resolveEvalSampling,
  resolveImagePath,
  goldAcceptSet,
  scoreCase,
  scoreNsfwSeverityTag,
} from "@sysprompt-lab/eval";
import type { EvalSuite, Metric } from "@sysprompt-lab/core";
import { findRepoRoot, parseScore } from "@sysprompt-lab/core";
import type { LlmConfig } from "@sysprompt-lab/llm";

const exact: Metric = { id: "exact", kind: "exact", returns_feedback: false };
const custom: Metric = { id: "string_contains", kind: "custom", returns_feedback: false };
const judge: Metric = { id: "judge", kind: "llm_judge", returns_feedback: true };
const nsfw: Metric = { id: "nsfw_severity_tag", kind: "custom", returns_feedback: true };

const repo = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const tinyPng = join(repo, "test", "fixtures", "tiny.png");
const llm: LlmConfig = {
  apiBase: "https://one.us1.imvery.moe/",
  model: "demo-model",
  token: "sk-test",
};

describe("scoreCase", () => {
  it("scores exact after trim", () => {
    expect(scoreCase(exact, "hello\n", "hello").quality).toBe(1);
    expect(scoreCase(exact, "hello", "Hello").quality).toBe(0);
  });

  it("scores custom as case-insensitive string-contains (support-bot style)", () => {
    expect(scoreCase(custom, "Happy to help with that.", "happy to help").quality).toBe(1);
    expect(scoreCase(custom, "We have a 30-day return window.", "30-day").quality).toBe(1);
    expect(scoreCase(custom, "store opens at noon", "09:00").quality).toBe(0);
  });

  it("stubs llm_judge with a clear error", () => {
    expect(() => scoreCase(judge, "ok", "ok")).toThrow(/llm_judge is not implemented/);
  });

  it("routes nsfw_severity_tag instead of string-contains", () => {
    const output = '{"tags":["软色情"],"description":"x","score":80}';
    expect(scoreCase(nsfw, output, { severity: "软色情" }).quality).toBe(1);
    expect(scoreCase(nsfw, output, { severity: "露骨" }).quality).toBe(0);
    expect(scoreCase(nsfw, output, { severity: "露骨" }).note).toBe("got 软色情 want 露骨");
    expect(
      scoreCase(nsfw, '{"tags":["擦边"]}', { severity: "软色情", accept: ["擦边", "软色情"] })
        .quality,
    ).toBe(1);
  });
});

describe("goldAcceptSet", () => {
  it("reads string, primary severity, accept, and severity-array gold", () => {
    expect(goldAcceptSet("软色情")).toEqual(["软色情"]);
    expect(goldAcceptSet({ severity: "软色情" })).toEqual(["软色情"]);
    expect(goldAcceptSet({ severity: "软色情", accept: ["擦边", "软色情"] })).toEqual([
      "擦边",
      "软色情",
    ]);
    expect(goldAcceptSet({ accept: ["擦边", "软色情"] })).toEqual(["擦边", "软色情"]);
    expect(goldAcceptSet({ severity: ["擦边", "软色情"] })).toEqual(["擦边", "软色情"]);
    expect(goldAcceptSet({ severity: "软色情", accept: [] })).toEqual(["软色情"]);
    expect(goldAcceptSet({})).toEqual([]);
  });
});

describe("scoreNsfwSeverityTag", () => {
  const gold = { severity: "软色情" };
  const tagged = (tags: string[]) => JSON.stringify({ tags, description: "", score: 1 });

  it("scores an exact single severity tag", () => {
    expect(
      scoreNsfwSeverityTag('{"tags":["泳装","软色情"],"description":"","score":70}', gold).quality,
    ).toBe(1);
    expect(scoreNsfwSeverityTag('{"tags":["软色情"],"description":"","score":1}', "软色情").quality).toBe(
      1,
    );
  });

  it("accepts JSON wrapped in markdown fences", () => {
    const fenced = "```json\n{\"tags\":[\"软色情\"],\"description\":\"ok\",\"score\":50}\n```";
    expect(scoreNsfwSeverityTag(fenced, gold).quality).toBe(1);
  });

  it("misses when the tag is wrong, missing, or duplicated", () => {
    expect(scoreNsfwSeverityTag('{"tags":["性感"],"description":"","score":1}', gold)).toEqual({
      quality: 0,
      note: "got 性感 want 软色情",
    });
    expect(scoreNsfwSeverityTag('{"tags":["泳装"],"description":"","score":1}', gold)).toEqual({
      quality: 0,
      note: "got (none) want 软色情",
    });
    expect(
      scoreNsfwSeverityTag('{"tags":["软色情","露骨"],"description":"","score":1}', gold).note,
    ).toBe("got 软色情+露骨 want 软色情");
    expect(scoreNsfwSeverityTag("not json", gold).note).toBe("got (unparseable) want 软色情");
  });

  it("passes when the predicted tag is in gold.accept", () => {
    const withAccept = { severity: "软色情", accept: ["擦边", "软色情"] };
    expect(scoreNsfwSeverityTag(tagged(["擦边"]), withAccept).quality).toBe(1);
    expect(scoreNsfwSeverityTag(tagged(["软色情"]), withAccept).quality).toBe(1);
    expect(scoreNsfwSeverityTag(tagged(["性感"]), withAccept)).toEqual({
      quality: 0,
      note: "got 性感 want 擦边|软色情",
    });
  });

  it("treats omitted accept as [severity] and accept-only gold as the set", () => {
    expect(scoreNsfwSeverityTag(tagged(["软色情"]), { severity: "软色情" }).quality).toBe(1);
    expect(scoreNsfwSeverityTag(tagged(["擦边"]), { accept: ["擦边", "软色情"] }).quality).toBe(1);
    expect(scoreNsfwSeverityTag(tagged(["露骨"]), { accept: ["擦边", "软色情"] }).note).toBe(
      "got 露骨 want 擦边|软色情",
    );
  });

  it("treats a severity string array as the accept set", () => {
    const arrayGold = { severity: ["擦边", "软色情"] };
    expect(scoreNsfwSeverityTag(tagged(["擦边"]), arrayGold).quality).toBe(1);
    expect(scoreNsfwSeverityTag(tagged(["软色情"]), arrayGold).quality).toBe(1);
    expect(scoreNsfwSeverityTag(tagged(["硬色情"]), arrayGold).note).toBe(
      "got 硬色情 want 擦边|软色情",
    );
    expect(scoreNsfwSeverityTag("not json", arrayGold).note).toBe(
      "got (unparseable) want 擦边|软色情",
    );
  });
});

describe("caseUserText", () => {
  it("prefers user / message fields and falls back to JSON", () => {
    expect(caseUserText({ user: "Hello" })).toBe("Hello");
    expect(caseUserText({ message: "Hi" })).toBe("Hi");
    expect(caseUserText({ order: 1 })).toBe('{"order":1}');
  });

  it("uses the default Chinese line when only an image is set", () => {
    expect(caseUserText({ image: "images/a.mp4.jpg" })).toBe(DEFAULT_IMAGE_USER_TEXT);
  });
});

describe("caseUserContent", () => {
  it("returns a string for text-only input", () => {
    expect(caseUserContent({ user: "Hello" })).toBe("Hello");
  });

  it("builds multimodal parts from a local image path", () => {
    const content = caseUserContent({ image: tinyPng });
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("expected multimodal parts");
    }
    expect(content[0]).toEqual({ type: "text", text: DEFAULT_IMAGE_USER_TEXT });
    expect(content[1]?.type).toBe("image_url");
    if (content[1]?.type !== "image_url") {
      throw new Error("expected image_url part");
    }
    expect(content[1].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("resolves a basename via imageDir", () => {
    expect(resolveImagePath("tiny.png", { imageDir: join(repo, "test", "fixtures") })).toBe(tinyPng);
    expect(resolveImagePath("images/tiny.png", { imageDir: join(repo, "test", "fixtures") })).toBe(
      tinyPng,
    );
  });
});

describe("evaluatePrompt sampling", () => {
  const suite: EvalSuite = {
    id: "vision",
    name: "vision",
    metric: nsfw,
    splits: {
      train: { name: "train", case_ids: ["c1"] },
      val: { name: "val", case_ids: [] },
    },
    cases: [
      {
        id: "c1",
        input: { image: tinyPng },
        gold: { severity: "软色情" },
      },
    ],
    temperature: 1,
    max_tokens: 4096,
  };

  it("keeps text-suite defaults at temperature 0 and no max_tokens", () => {
    expect(resolveEvalSampling({ ...suite, temperature: undefined, max_tokens: undefined })).toEqual({
      temperature: 0,
      max_tokens: undefined,
    });
  });

  it("sends suite temperature/max_tokens and multimodal user content", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '```json\n{"tags":["软色情"],"description":"","score":9}\n```' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const result = await evaluatePrompt({
      config: llm,
      systemPrompt: "tag",
      versionId: "ver_1",
      suite,
      split: "train",
      fetch: fetchMock,
    });
    expect(result.meanQuality).toBe(1);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.temperature).toBe(1);
    expect(body.max_tokens).toBe(4096);
    expect(body.messages[0].content).toBe("tag");
    expect(body.messages[1].content[0]).toEqual({ type: "text", text: DEFAULT_IMAGE_USER_TEXT });
    expect(body.messages[1].content[1].type).toBe("image_url");
  });
});

describe("evaluatePrompt reasoning traces", () => {
  const suite: EvalSuite = {
    id: "trace",
    name: "trace",
    metric: exact,
    splits: {
      train: { name: "train", case_ids: ["c1"] },
      val: { name: "val", case_ids: [] },
    },
    cases: [{ id: "c1", input: { user: "hi" }, gold: "hello" }],
  };

  it("persists reasoning next to scored output and does not score it", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "hello", reasoning_content: "I should greet" },
            },
          ],
          usage: { completion_tokens_details: { reasoning_tokens: 12 } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const result = await evaluatePrompt({
      config: llm,
      systemPrompt: "greet",
      versionId: "ver_1",
      suite,
      split: "train",
      fetch: fetchMock,
    });
    expect(result.meanQuality).toBe(1);
    expect(result.cases[0]?.output).toBe("hello");
    expect(result.cases[0]?.reasoning).toBe("I should greet");
    expect(result.cases[0]?.finish_reason).toBe("stop");
    expect(result.cases[0]?.reasoning_tokens).toBe(12);
    expect(result.cases[0]?.quality).toBe(1);
    const row = result.scores[0];
    expect(row?.output).toBe("hello");
    expect(row?.reasoning).toBe("I should greet");
    expect(row?.finish_reason).toBe("stop");
    expect(row?.reasoning_tokens).toBe(12);
    expect(parseScore(row)).toMatchObject({
      case_id: "c1",
      output: "hello",
      reasoning: "I should greet",
      finish_reason: "stop",
      reasoning_tokens: 12,
    });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.messages).toEqual([
      { role: "system", content: "greet" },
      { role: "user", content: "hi" },
    ]);
    expect(JSON.stringify(body)).not.toContain("I should greet");
  });

  it("scores empty visible output as a miss while keeping reasoning on the case", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: null, reasoning: "planned hello but emitted nothing" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const result = await evaluatePrompt({
      config: llm,
      systemPrompt: "greet",
      versionId: "ver_1",
      suite,
      split: "train",
      fetch: fetchMock,
    });
    expect(result.cases[0]?.output).toBe("");
    expect(result.cases[0]?.reasoning).toBe("planned hello but emitted nothing");
    expect(result.cases[0]?.quality).toBe(0);
    expect(result.scores[0]?.output).toBe("");
    expect(result.scores[0]?.reasoning).toBe("planned hello but emitted nothing");
    expect(result.scores[0]).not.toHaveProperty("finish_reason");
    expect(result.scores[0]).not.toHaveProperty("reasoning_tokens");
  });

  it("omits reasoning when the API does not send it", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const result = await evaluatePrompt({
      config: llm,
      systemPrompt: "greet",
      versionId: "ver_1",
      suite,
      split: "train",
      fetch: fetchMock,
    });
    expect(result.cases[0]?.output).toBe("hello");
    expect(result.cases[0]).not.toHaveProperty("reasoning");
    expect(result.scores[0]?.output).toBe("hello");
    expect(result.scores[0]).not.toHaveProperty("reasoning");
    expect(parseScore(result.scores[0])).not.toHaveProperty("reasoning");
  });
});

describe("promotionDecision", () => {
  it("promotes only when val mean quality strictly rises", () => {
    expect(promotionDecision({ hasVal: true, valBaseline: 0.5, valCandidate: 0.75 }).promote).toBe(true);
    expect(promotionDecision({ hasVal: true, valBaseline: 0.5, valCandidate: 0.5 }).promote).toBe(false);
    expect(promotionDecision({ hasVal: true, valBaseline: 0.8, valCandidate: 0.2 }).promote).toBe(false);
  });

  it("refuses auto-promote when there is no val split", () => {
    const decision = promotionDecision({ hasVal: false, valBaseline: 1, valCandidate: 1 });
    expect(decision.promote).toBe(false);
    expect(decision.reason).toBe("train_only");
    expect(decision.message).toMatch(/train-only/);
  });
});

describe("adoptDecision", () => {
  it("requires a strict val rise and uses train as a val-tie break", () => {
    expect(
      adoptDecision({
        hasVal: true,
        currentVal: 0.5,
        candidateVal: 0.75,
        currentTrain: 0.2,
        candidateTrain: 0.1,
      }).adopt,
    ).toBe(true);
    expect(
      adoptDecision({
        hasVal: true,
        currentVal: 0.5,
        candidateVal: 0.5,
        currentTrain: 0.2,
        candidateTrain: 0.4,
      }).reason,
    ).toBe("val_tie_train_improved");
    expect(
      adoptDecision({
        hasVal: true,
        currentVal: 0.5,
        candidateVal: 0.4,
        currentTrain: 0.2,
        candidateTrain: 1,
      }).adopt,
    ).toBe(false);
  });

  it("requires a strict train rise when there is no val split", () => {
    expect(
      adoptDecision({ hasVal: false, currentTrain: 0.2, candidateTrain: 0.3 }).adopt,
    ).toBe(true);
    expect(
      adoptDecision({ hasVal: false, currentTrain: 0.3, candidateTrain: 0.3 }).adopt,
    ).toBe(false);
  });
});

describe("r1PromotionDecision", () => {
  it("promotes when final val (or train if no val) beats the original baseline", () => {
    expect(
      r1PromotionDecision({
        hasVal: true,
        originalVal: 0.4,
        finalVal: 0.6,
        originalTrain: 0.1,
        finalTrain: 0.2,
      }).promote,
    ).toBe(true);
    expect(
      r1PromotionDecision({
        hasVal: true,
        originalVal: 0.5,
        finalVal: 0.5,
        originalTrain: 0.1,
        finalTrain: 0.9,
      }).promote,
    ).toBe(false);
    expect(
      r1PromotionDecision({
        hasVal: false,
        originalTrain: 0.2,
        finalTrain: 0.8,
      }).promote,
    ).toBe(true);
  });
});

describe("formatScoreTable", () => {
  it("prints quality and latency columns", () => {
    const table = formatScoreTable([
      {
        split: "train",
        baselineQuality: 0.5,
        candidateQuality: 0.75,
        baselineLatency: 100,
        candidateLatency: 120,
      },
    ]);
    expect(table).toMatch(/train\s+0\.500\s+0\.750\s+\+0\.250/);
    expect(table).toMatch(/100/);
    expect(table).toMatch(/120/);
  });
});
