import { describe, expect, it } from "vitest";
import { chatCompletion, chatCompletionsUrl, normalizeLlmApiBase } from "../src/llm.js";
import type { LlmConfig } from "../src/env.js";

const config: LlmConfig = {
  apiBase: "https://one.us1.imvery.moe/",
  model: "demo-model",
  token: "sk-super-secret-token",
};

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
