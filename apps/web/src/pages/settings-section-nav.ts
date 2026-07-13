export interface SettingsSectionLink {
  readonly id: string;
  readonly label: string;
}

/**
 * Top-level nav entries shown in the settings side nav. Each id is also a
 * DOM anchor id. `morning-brief` is a stable, independently deep-linkable
 * anchor nested inside "Your inbox & brief" — the inbox links straight to it
 * — so it is registered separately from its parent nav section.
 */
export const SETTINGS_SECTIONS: readonly SettingsSectionLink[] = [
  { id: "your-agent", label: "Your agent" },
  { id: "inbox-capabilities", label: "Your inbox & brief" },
  { id: "connections", label: "Connections" },
  { id: "account", label: "Account" },
  { id: "whats-new", label: "What's new" },
];

export const MORNING_BRIEF_ANCHOR_ID = "morning-brief";

/**
 * Maps every deep-linkable anchor id (including nested anchors that are not
 * themselves nav entries, like `morning-brief`) to the nav section id whose
 * side-nav entry should read as active when that anchor is targeted.
 */
const ANCHOR_TO_NAV_SECTION: Readonly<Record<string, string>> = {
  ...Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s.id, s.id])),
  [MORNING_BRIEF_ANCHOR_ID]: "inbox-capabilities",
};

/**
 * Resolves which settings nav entry a URL hash should highlight. Falls back
 * to the first known section when the hash is empty or does not match any
 * registered anchor, so the side nav always has exactly one active entry.
 */
export function resolveActiveSectionId(
  hash: string,
  sectionIds: readonly string[] = SETTINGS_SECTIONS.map((s) => s.id),
): string {
  const normalized = hash.replace(/^#/, "");
  const mapped = ANCHOR_TO_NAV_SECTION[normalized];
  if (mapped !== undefined && sectionIds.includes(mapped)) return mapped;
  const firstId = sectionIds[0];
  if (firstId === undefined) {
    throw new Error("resolveActiveSectionId requires at least one section");
  }
  return firstId;
}
