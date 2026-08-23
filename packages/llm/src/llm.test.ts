import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  chatCompletion,
  chatCompletionsUrl,
  imageFileToDataUrl,
  imageMimeFromBytes,
  imageMimeFromPath,
  normalizeLlmApiBase,
} from "@sysprompt-lab/llm";
import type { LlmConfig } from "@sysprompt-lab/llm";
import { findRepoRoot } from "@sysprompt-lab/core";

const config: LlmConfig = {
  apiBase: "https://one.us1.imvery.moe/",
  model: "demo-model",
  token: "sk-super-secret-token",
};

const repo = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const tinyPng = join(repo, "test", "fixtures", "tiny.png");

describe("normalizeLlmApiBase", () => {
  it("appends /v1 when the base has no /v1 suffix", () => {
    expect(normalizeLlmApiBase("https://one.us1.imvery.moe/")).toBe("https://one.us1.imvery.moe/v1");
    expect(normalizeLlmApiBase("https://one.us1.imvery.moe")).toBe("https://one.us1.imvery.moe/v1");
    expect(chatCompletionsUrl("https://one.us1.imvery.moe/")).toBe(
      "https://one.us1.imvery.moe/v1/chat/completions",
    );
  });

  it("does not double /v1", () => {
    expect(normalizeLlmApiBase("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    expect(normalizeLlmApiBase("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(chatCompletionsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });
});

describe("imageFileToDataUrl", () => {
  it("maps jpeg/png/webp extensions and magic bytes", () => {
    expect(imageMimeFromPath("frame.mp4.jpg")).toBe("image/jpeg");
    expect(imageMimeFromPath("shot.PNG")).toBe("image/png");
    expect(imageMimeFromPath("a.webp")).toBe("image/webp");
    expect(imageMimeFromPath("notes.txt")).toBeUndefined();
    expect(imageMimeFromBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
    expect(imageMimeFromBytes(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    );
    expect(
      imageMimeFromBytes(
        Uint8Array.from([
          0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        ]),
      ),
    ).toBe("image/webp");
  });

  it("reads the tiny fixture png as a data URL", () => {
    const url = imageFileToDataUrl(tinyPng);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(url.length).toBeGreaterThan("data:image/png;base64,".length);
  });
});

describe("chatCompletion", () => {
  it("POSTs to the normalized URL and returns message content", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ choices: [{ message: { content: "rewritten" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await chatCompletion(
      config,
      [{ role: "user", content: "hi" }],
      { fetch: fetchMock },
    );
    expect(result.content).toBe("rewritten");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://one.us1.imvery.moe/v1/chat/completions");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer sk-super-secret-token");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.model).toBe("demo-model");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBeUndefined();
  });

  it("passes multimodal user content plus temperature and max_tokens", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const content = [
      { type: "text" as const, text: "请分析这张照片，并按系统要求仅返回 JSON。" },
      { type: "image_url" as const, image_url: { url: imageFileToDataUrl(tinyPng) } },
    ];
    await chatCompletion(config, [{ role: "user", content }], {
      fetch: fetchMock,
      temperature: 1,
      max_tokens: 4096,
    });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.temperature).toBe(1);
    expect(body.max_tokens).toBe(4096);
    expect(body.messages[0].content).toEqual(content);
    expect(body.messages[0].content[1].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("never includes the raw token in HTTP error messages", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(`unauthorized token=sk-super-secret-token`, { status: 401 });

    await expect(
      chatCompletion(config, [{ role: "user", content: "hi" }], { fetch: fetchMock }),
    ).rejects.toThrow(/HTTP 401/);

    try {
      await chatCompletion(config, [{ role: "user", content: "hi" }], { fetch: fetchMock });
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("sk-super-secret-token");
      expect(message).toContain("[redacted]");
    }
  });
});
