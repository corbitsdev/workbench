// Agents and Skills were Settings sections for a stretch; both moved back
// out to their own top-level rail destinations (`/agents/:id`, `/skills/:id`).

import { isValidSlug, type Slug } from "@/lib/slug";
import { decodedOrNull } from "@corbits/url-path";

export const SETTINGS_PATH_PREFIX = "/settings";
export const AGENTS_PATH_PREFIX = "/agents";
export const SKILLS_PATH_PREFIX = "/skills";
export const ARTIFACTS_PATH_PREFIX = "/artifacts";
export const TOOLS_PATH_PREFIX = "/tools";
export const WORKFLOWS_PATH_PREFIX = "/workflows";
export const INSIGHTS_PATH_PREFIX = "/insights";
export const INSIGHTS_RUNS_PATH = `${INSIGHTS_PATH_PREFIX}/runs`;

/** `null` unless the path is exactly `<prefix>/<slug>`. Reads the raw
 * segment — decoding a slug could only turn a malformed URL into a
 * `URIError` mid-render, and an id-shaped segment isn't a slug either. */
export function detailSlugFromPath(path: string, prefix: string): Slug | null {
  const segment = rawSegmentFromTopLevelPath(path, prefix);
  if (segment === null) return null;
  return isValidSlug(segment) ? segment : null;
}

/** The undecoded remainder of a flat top-level route (`/agents/:id`) —
 * `null` for the bare prefix or a path outside it. */
function rawSegmentFromTopLevelPath(path: string, prefix: string): string | null {
  if (path === prefix) return null;
  if (!path.startsWith(`${prefix}/`)) return null;
  const rest = path.slice(prefix.length + 1);
  return rest === "" ? null : rest;
}

/** Extract a sub-selection from a flat top-level route (`/agents/:id`,
 * `/skills/:id`) — `null` for the bare prefix or a path outside it. */
function entityIdFromTopLevelPath(path: string, prefix: string): string | null {
  const segment = rawSegmentFromTopLevelPath(path, prefix);
  return segment === null ? null : decodedOrNull(segment);
}

export function skillIdFromPath(path: string): string | null {
  return entityIdFromTopLevelPath(path, SKILLS_PATH_PREFIX);
}

/** A routine id (canonical) or a name-derived slug the detail route
 * resolves and redirects to the id. */
export function routineSegmentFromPath(path: string): string | null {
  return entityIdFromTopLevelPath(path, WORKFLOWS_PATH_PREFIX);
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
export function settingsEntityIdFromPath(path: string, sectionId: string): string | null {
  const prefix = `${SETTINGS_PATH_PREFIX}/${sectionId}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  return rest === "" ? null : decodedOrNull(rest);
}
