/** Ordered NSFW severity labels. A prediction may include at most one. */
export const NSFW_SEVERITY_TAGS = ["性感", "擦边", "软色情", "露骨", "硬色情"] as const;

export type NsfwSeverityTag = (typeof NSFW_SEVERITY_TAGS)[number];

const SEVERITY_SET = new Set<string>(NSFW_SEVERITY_TAGS);

export function isNsfwSeverityTag(value: string): value is NsfwSeverityTag {
  return SEVERITY_SET.has(value);
}

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function uniqueTrimmedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const trimmed = trimNonEmpty(item);
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Acceptable gold severities for `nsfw_severity_tag`.
 *
 * Supported forms:
 * - `"软色情"`
 * - `{ severity: "软色情" }` (primary; accept defaults to `[severity]`)
 * - `{ severity: "软色情", accept: ["擦边", "软色情"] }`
 * - `{ accept: ["擦边", "软色情"] }`
 * - `{ severity: ["擦边", "软色情"] }` (`severity` as the accept set)
 */
export function goldAcceptSet(gold: unknown): string[] {
  if (typeof gold === "string") {
    const trimmed = trimNonEmpty(gold);
    return trimmed ? [trimmed] : [];
  }
  if (!gold || typeof gold !== "object" || Array.isArray(gold)) {
    return [];
  }
  const obj = gold as { severity?: unknown; accept?: unknown };
  const accept = uniqueTrimmedStrings(obj.accept);
  if (accept.length > 0) {
    return accept;
  }
  if (Array.isArray(obj.severity)) {
    return uniqueTrimmedStrings(obj.severity);
  }
  const primary = trimNonEmpty(obj.severity);
  return primary ? [primary] : [];
}

/** Primary gold severity, or the first item of the accept set. */
export function goldSeverity(gold: unknown): string | undefined {
  return goldAcceptSet(gold)[0];
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
 * Custom metric `nsfw_severity_tag`: the single predicted NSFW severity tag
 * must be in the gold accept set. Feedback on miss is `got X want A|B`.
 */
export function scoreNsfwSeverityTag(
  output: string,
  gold: unknown,
): { quality: number; note?: string } {
  const accept = goldAcceptSet(gold);
  if (accept.length === 0) {
    return { quality: 0, note: "no gold severity" };
  }
  const want = accept.join("|");
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
  if (accept.includes(got)) {
    return { quality: 1 };
  }
  return { quality: 0, note: `got ${got} want ${want}` };
}
