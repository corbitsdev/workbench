import { deepLinkPath } from "./deep-link";
import type { TaskLink } from "./tasks";

const MAX_TASK_LINK_REF_CHARS = 2048;

/** True when `ref` is an absolute http(s) URL safe to open in a browser. */
export function isSafeHttpTaskUrl(ref: string): boolean {
  try {
    const url = new URL(ref);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate a single task link ref at a trust boundary (tool write, API create).
 * Returns a human-readable error string, or null when valid.
 */
export function validateTaskLinkRef(link: TaskLink): string | null {
  const { kind, ref } = link;
  if (typeof ref !== "string" || ref.length === 0) {
    return "ref must be a non-empty string";
  }
  if (ref.length > MAX_TASK_LINK_REF_CHARS) {
    return `ref must be at most ${MAX_TASK_LINK_REF_CHARS} characters`;
  }
  if (/[\x00-\x1f\x7f]/.test(ref)) {
    return "ref must not contain control characters";
  }

  switch (kind) {
    case "url":
      if (!isSafeHttpTaskUrl(ref)) {
        return "url links must be absolute http(s) URLs";
      }
      return null;
    case "artifact":
    case "workflow_run":
    case "mail":
    case "conversation":
      if (ref.trim() !== ref) {
        return `${kind} ref must not have leading or trailing whitespace`;
      }
      if (ref.includes("://") || /[\r\n\t\\]/.test(ref)) {
        return `${kind} ref must be an object id, not a URL or path fragment`;
      }
      return null;
    default:
      return "unknown link kind";
  }
}

/** Validate every link in a write payload. Returns the first error, or null. */
export function validateTaskLinks(links: TaskLink[]): string | null {
  for (let i = 0; i < links.length; i += 1) {
    const message = validateTaskLinkRef(links[i]!);
    if (message !== null) {
      return `links[${i}]: ${message}`;
    }
  }
  return null;
}

/**
 * Resolve a stored task link to an in-app or external href for UI surfaces.
 * Invalid refs (including legacy unsafe rows) resolve to null.
 */
export function resolveTaskLinkHref(link: TaskLink): string | null {
  if (validateTaskLinkRef(link) !== null) {
    return null;
  }
  switch (link.kind) {
    case "workflow_run":
    case "mail":
    case "artifact":
    case "conversation":
      return deepLinkPath(link.kind, link.ref);
    case "url":
      return link.ref;
  }
}