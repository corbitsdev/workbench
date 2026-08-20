// Path-id helpers for settings and top-level roster deep links. Shared by
// the shell (col2 section nav) and the settings sections (stage detail) so
// neither layer owns the other. Same pattern as workbench-path.ts. Agents
// and Skills were Settings sections for a stretch (CL-5990) at
// `/settings/agents/:id` and `/settings/skills/:id`; CL-6353/CL-6354/
// CL-6355 moved both back out to their own top-level rail destinations —
// `/agents/:id` and `/skills/:id`, via `agentIdFromPath`/`skillIdFromPath`
// below.

import { isValidSlug, type Slug } from "@corbits/slug";

export const SETTINGS_PATH_PREFIX = "/settings";
export const AGENTS_PATH_PREFIX = "/agents";
export const SKILLS_PATH_PREFIX = "/skills";
export const FILES_PATH_PREFIX = "/files";
export const PLUGINS_PATH_PREFIX = "/plugins";
export const ROUTINES_PATH_PREFIX = "/routines";
export const INSIGHTS_PATH_PREFIX = "/insights";
export const INSIGHTS_RUNS_PATH = `${INSIGHTS_PATH_PREFIX}/runs`;

/** The slug a detail path carries — `null` unless the path is exactly
 * `<prefix>/<slug>`. Validation reads the raw segment: a slug carries no
 * percent-escape and no character that needs one, so decoding could only
 * turn a malformed URL into a `URIError` mid-render. An id-shaped segment
 * (`wfd_1`, `skill_1`) is not a slug either, so id deep links keep
 * resolving to their roster rather than to a slug-addressed detail
 * screen. */
export function detailSlugFromPath(path: string, prefix: string): Slug | null {
  const segment = rawSegmentFromTopLevelPath(path, prefix);
  if (segment === null) return null;
  return isValidSlug(segment) ? segment : null;
}

/** The undecoded remainder of a flat top-level route (`/agents/:id`) —
 * `null` for the bare prefix or a path outside it. */
function rawSegmentFromTopLevelPath(
  path: string,
  prefix: string,
): string | null {
  if (path === prefix) return null;
  if (!path.startsWith(`${prefix}/`)) return null;
  const rest = path.slice(prefix.length + 1);
  return rest === "" ? null : rest;
}

/** A URL segment carries percent-escapes an id needs decoded, and a
 * hand-typed or truncated URL can carry a malformed one — which
 * `decodeURIComponent` answers with a throw. A path that cannot be decoded
 * names no entity, so it reads as no selection at all rather than taking
 * the render down with it. */
function decodedOrNull(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Extract a sub-selection from a flat top-level route (`/agents/:id`,
 * `/skills/:id`) — `null` for the bare prefix or a path outside it. */
function entityIdFromTopLevelPath(path: string, prefix: string): string | null {
  const segment = rawSegmentFromTopLevelPath(path, prefix);
  return segment === null ? null : decodedOrNull(segment);
}

export function agentIdFromPath(path: string): string | null {
  return entityIdFromTopLevelPath(path, AGENTS_PATH_PREFIX);
}

export function skillIdFromPath(path: string): string | null {
  return entityIdFromTopLevelPath(path, SKILLS_PATH_PREFIX);
}

/** A deep link into one routine (the context menu's "Open routine",
 * `/routines/:id` bookmarks) expands that row on the Routines page — the
 * page itself is one flat list, never a route per routine. */
export function routineIdFromPath(path: string): string | null {
  return entityIdFromTopLevelPath(path, ROUTINES_PATH_PREFIX);
}

/** Extract a settings section id from `/settings/:id` or `/settings/:id/…`
 * — only the first path segment, so a section with its own sub-selection
 * (e.g. `/settings/agents/:definitionId`) still resolves to its section id. */
export function settingsSectionIdFromPath(path: string): string | null {
  if (!path.startsWith(`${SETTINGS_PATH_PREFIX}/`)) return null;
  const rest = path.slice(SETTINGS_PATH_PREFIX.length + 1);
  if (rest === "") return null;
  const id = rest.split("/")[0];
  return id === undefined || id === "" ? null : decodedOrNull(id);
}

/** Extract a section's own sub-selection from `/settings/:sectionId/:entityId`
 * — `null` when the path isn't under that section, or carries no sub-id. */
export function settingsEntityIdFromPath(
  path: string,
  sectionId: string,
): string | null {
  const prefix = `${SETTINGS_PATH_PREFIX}/${sectionId}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  return rest === "" ? null : decodedOrNull(rest);
}
