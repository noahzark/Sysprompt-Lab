/** Ordered NSFW severity labels. A prediction may include at most one. */
export const NSFW_SEVERITY_TAGS = ["性感", "擦边", "软色情", "露骨", "硬色情"] as const;

export type NsfwSeverityTag = (typeof NSFW_SEVERITY_TAGS)[number];

const SEVERITY_SET = new Set<string>(NSFW_SEVERITY_TAGS);

export function isNsfwSeverityTag(value: string): value is NsfwSeverityTag {
  return SEVERITY_SET.has(value);
}

/** Gold may be `"软色情"` or `{ severity: "软色情" }`. */
export function goldSeverity(gold: unknown): string | undefined {
  if (typeof gold === "string") {
    const trimmed = gold.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (gold && typeof gold === "object" && "severity" in gold) {
    const value = (gold as { severity?: unknown }).severity;
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  }
  return undefined;
}

/**
 * Parse a JSON object from model output. Tolerates markdown fences and
 * leading/trailing prose around a single `{ ... }` object.
 */
export function parseJsonObjectFromModelOutput(output: string): Record<string, unknown> | undefined {
  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const parsed = tryParseObject(candidate);
  if (parsed) {
    return parsed;
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParseObject(candidate.slice(start, end + 1));
  }
  return undefined;
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function severityTagsIn(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags.filter((item): item is string => typeof item === "string" && isNsfwSeverityTag(item));
}

/**
 * Primary image-tagger metric: exact match of the single NSFW severity tag.
 * Feedback on miss is `got X want Y` for the R1 rewriter (text only).
 */
export function scoreNsfwSeverityTag(
  output: string,
  gold: unknown,
): { quality: number; note?: string } {
  const want = goldSeverity(gold);
  if (!want) {
    return { quality: 0, note: "no gold severity" };
  }
  const obj = parseJsonObjectFromModelOutput(output);
  if (!obj) {
    return { quality: 0, note: `got (unparseable) want ${want}` };
  }
  const found = severityTagsIn(obj.tags);
  if (found.length === 0) {
    return { quality: 0, note: `got (none) want ${want}` };
  }
  if (found.length > 1) {
    return { quality: 0, note: `got ${found.join("+")} want ${want}` };
  }
  const got = found[0]!;
  if (got === want) {
    return { quality: 1 };
  }
  return { quality: 0, note: `got ${got} want ${want}` };
}
