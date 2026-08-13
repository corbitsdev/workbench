// Path-id helpers for agents and skills deep links. Shared by the shell
// (col2 selection) and the pages (stage detail) so neither layer owns the
// other. Same pattern as channel-path.ts.

export const AGENTS_PATH_PREFIX = "/agents";
export const SKILLS_PATH_PREFIX = "/skills";
export const SETTINGS_PATH_PREFIX = "/settings";

/** Extract an agent definition id from `/agents/:id`. */
export function agentIdFromPath(path: string): string | null {
  if (!path.startsWith(`${AGENTS_PATH_PREFIX}/`)) return null;
  const rest = path.slice(AGENTS_PATH_PREFIX.length + 1);
  return rest === "" ? null : decodeURIComponent(rest);
}

/** Extract a skill id from `/skills/:id`. */
export function skillIdFromPath(path: string): string | null {
  if (!path.startsWith(`${SKILLS_PATH_PREFIX}/`)) return null;
  const rest = path.slice(SKILLS_PATH_PREFIX.length + 1);
  return rest === "" ? null : decodeURIComponent(rest);
}

/** Extract a settings section id from `/settings/:id`. */
export function settingsSectionIdFromPath(path: string): string | null {
  if (!path.startsWith(`${SETTINGS_PATH_PREFIX}/`)) return null;
  const rest = path.slice(SETTINGS_PATH_PREFIX.length + 1);
  return rest === "" ? null : decodeURIComponent(rest);
}
