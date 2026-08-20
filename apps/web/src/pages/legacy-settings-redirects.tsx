// Old links that must still land somewhere real. Agents and Skills were
// Settings sections for a stretch (CL-5990: `/settings/agents[/:id]`,
// `/settings/skills[/:id]`); CL-6354/CL-6355 moved both back out to their
// own rail destinations, so any deep link into the old Settings home now
// bounces to the new one, preserving a deep-linked id. Library was renamed
// Files (CL-6353) at the same time it was moved off `/library` — that old
// prefix bounces to `/files` the same way.

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

export function LegacySettingsAgentsRedirect({
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
      oldPrefix="/settings/agents"
      newPrefix="/agents"
    />
  );
}

export function LegacySettingsSkillsRedirect({
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
      oldPrefix="/settings/skills"
      newPrefix="/skills"
    />
  );
}

export function LegacyLibraryRedirect({
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
      oldPrefix="/library"
      newPrefix="/files"
    />
  );
}
