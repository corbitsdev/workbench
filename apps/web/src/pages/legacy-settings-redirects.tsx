// Agents and Skills used to be their own rail destinations; they are now
// Settings sections (CL-5990). These two routes keep old `/agents[/:id]`
// and `/skills[/:id]` links alive by bouncing straight to the section's new
// home — `/settings/agents[/:id]` / `/settings/skills[/:id]` — so a deep
// link's selection survives the move, not just the bare list.

import { useEffect } from "react";

function legacyRedirectTarget(
  path: string,
  oldPrefix: string,
  newPrefix: string,
): string {
  if (path === oldPrefix) return newPrefix;
  if (path.startsWith(`${oldPrefix}/`)) {
    return `${newPrefix}/${path.slice(oldPrefix.length + 1)}`;
  }
  return newPrefix;
}

export function LegacyRedirect({
  path,
  navigate,
  oldPrefix,
  newPrefix,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
  readonly oldPrefix: string;
  readonly newPrefix: string;
}) {
  useEffect(() => {
    navigate(legacyRedirectTarget(path, oldPrefix, newPrefix));
  }, [path, navigate, oldPrefix, newPrefix]);
  return null;
}

export function LegacyAgentsRedirect({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  return (
    <LegacyRedirect
      path={path}
      navigate={navigate}
      oldPrefix="/agents"
      newPrefix="/settings/agents"
    />
  );
}

export function LegacySkillsRedirect({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  return (
    <LegacyRedirect
      path={path}
      navigate={navigate}
      oldPrefix="/skills"
      newPrefix="/settings/skills"
    />
  );
}
