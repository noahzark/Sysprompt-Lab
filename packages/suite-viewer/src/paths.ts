import { caseImageRef, resolveImagePath, type ImageResolveOptions } from "@sysprompt-lab/eval";

export type ImageResolveResult =
  | { ok: true; path: string; remote: boolean }
  | { ok: false };

export function isRemoteImageRef(ref: string): boolean {
  return ref.startsWith("data:") || /^https?:\/\//i.test(ref);
}

/**
 * Resolve `input.image` / `input.image_path` the same way eval does.
 * Missing local files return `{ ok: false }` instead of throwing.
 */
export function tryResolveViewerImage(
  ref: string | undefined,
  options: ImageResolveOptions = {},
): ImageResolveResult {
  if (!ref) {
    return { ok: false };
  }
  if (isRemoteImageRef(ref)) {
    return { ok: true, path: ref, remote: true };
  }
  try {
    return { ok: true, path: resolveImagePath(ref, options), remote: false };
  } catch {
    return { ok: false };
  }
}

export function caseImageResolve(
  input: Record<string, unknown>,
  options: ImageResolveOptions = {},
): { ref?: string; resolved: ImageResolveResult } {
  const ref = caseImageRef(input);
  return { ref, resolved: tryResolveViewerImage(ref, options) };
}
