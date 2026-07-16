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
  { id: "myra-defaults", label: "Myra defaults" },
  { id: "inbox-capabilities", label: "Your inbox & brief" },
  { id: "connections", label: "Connections" },
  { id: "schedules", label: "Schedules" },
  { id: "account", label: "Account" },
  { id: "whats-new", label: "What's new" },
];

export const MORNING_BRIEF_ANCHOR_ID = "morning-brief";

/**
 * A management group in the settings side-nav: a role-gated link to a routed
 * sub-area (the former standalone /admin or /owner surfaces), not an in-page
 * anchor. `role` matches the boolean flag on `/me` (`isAdmin`/`isOwner`) that
 * gates visibility — the same flags `RequireAdmin`/`AdminLayout`/`OwnerLayout`
 * already check, so this list adds no new permission logic.
 */
export interface SettingsManagementGroup {
  readonly id: string;
  readonly label: string;
  readonly to: string;
  readonly role: "admin" | "owner";
}

export const SETTINGS_MANAGEMENT_GROUPS: readonly SettingsManagementGroup[] = [
  {
    id: "settings-admin",
    label: "Users & agents",
    to: "/settings/admin",
    role: "admin",
  },
  {
    id: "settings-owner",
    label: "Workbench management",
    to: "/settings/owner",
    role: "owner",
  },
];

/**
 * Filters the management groups down to the ones a viewer's role permits.
 * Hidden entirely for a role the viewer lacks — never rendered disabled.
 */
export function visibleManagementGroups(role: {
  isAdmin: boolean;
  isOwner: boolean;
}): readonly SettingsManagementGroup[] {
  return SETTINGS_MANAGEMENT_GROUPS.filter((group) => {
    if (group.role === "admin") return role.isAdmin;
    return role.isOwner;
  });
}

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
