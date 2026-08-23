import { describe, expect, it } from "vitest";
import { parseRewriteResponse, shortHypothesis } from "@sysprompt-lab/rewrite";

describe("parseRewriteResponse", () => {
  it("reads JSON hypothesis + system_prompt", () => {
    const parsed = parseRewriteResponse(
      JSON.stringify({ hypothesis: "Clarify the refund window", system_prompt: "You are helpful." }),
    );
    expect(parsed.hypothesis).toBe("Clarify the refund window");
    expect(parsed.system_prompt).toBe("You are helpful.");
  });

  it("falls back to the raw text and a truncated hypothesis", () => {
    const parsed = parseRewriteResponse("Be a careful support agent who never invents orders.");
    expect(parsed.system_prompt).toContain("never invents");
    expect(parsed.hypothesis).toBe(shortHypothesis(parsed.system_prompt));
  });
});
