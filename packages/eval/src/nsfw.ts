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
 *
 * Returns `[]` when gold names no severity tier. That includes
 * `{ allow_missing: true }` with no `severity` / `accept`, and empty gold
 * (`{}`). `allow_missing` is not an accept label and is not required for the
 * empty set. `scoreNsfwSeverityTag` treats `[]` as want `(none)`.
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
 * Custom metric `nsfw_severity_tag`.
 *
 * When gold has a severity or accept set, the single predicted NSFW severity
 * tag must be in that set. Feedback on miss is `got X want A|B`. A missing
 * prediction fails (`got (none) want …`). `allow_missing` is not read on this
 * path, so a severity plus `allow_missing: true` still requires the tag.
 *
 * When `goldAcceptSet(gold)` is empty, the case wants no severity tag. Empty
 * gold (`{}`) and `{ allow_missing: true }` with no tier are the same case:
 * both pass when the model emits zero severity tags. `allow_missing` is not
 * required for that pass.
 * - unparseable output → quality 0, `got (unparseable) want (none)`
 * - one or more severity tags → quality 0, `got 擦边 want (none)` or
 *   `got 擦边+性感 want (none)`
 * - zero severity tags (other content tags are fine) → quality 1
 */
export function scoreNsfwSeverityTag(
  output: string,
  gold: unknown,
): { quality: number; note?: string } {
  const accept = goldAcceptSet(gold);
  if (accept.length === 0) {
    return scoreNoSeverityTier(output);
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

/** No gold tier: pass only when the model also emits no severity tag. */
function scoreNoSeverityTier(output: string): { quality: number; note?: string } {
  const obj = parseJsonObjectFromModelOutput(output);
  if (!obj) {
    return { quality: 0, note: "got (unparseable) want (none)" };
  }
  const found = severityTagsIn(obj.tags);
  if (found.length === 0) {
    return { quality: 1 };
  }
  return { quality: 0, note: `got ${found.join("+")} want (none)` };
}
