// Renders the active section's panel only — nav is master-detail, never
// repeated in the stage.

import { EmptyState } from "@corbits/react-ui";
import type { Icon } from "@/lib/icons";
import type { ReactElement } from "react";

import { SETTINGS_STRINGS } from "./strings";

// A section with no use for a field (Account, today) simply ignores it.
export type SettingsContext = {
  readonly tenantId: string | null;
  readonly principalId: string | null;
  /** Client-side navigation, for a section whose own content routes
   * elsewhere (e.g. Agents' "Start chat" opening a workbench). Sections with
   * no use for it simply ignore the field. */
  readonly navigate?: (to: string) => void;
  /** A sub-selection carried in the host's URL below the section id (e.g.
   * `/settings/agents/:definitionId`), so a section with its own
   * master-detail can restore the right selection on a deep link. */
  readonly entityId?: string | null;
  // Absent where the host has no sign-out concept; a section with a
  // Sign out action simply hides it when undefined.
  readonly onSignOut?: () => void;
};

export type SettingsSection = {
  readonly id: string;
  readonly title: string;
  /** Leading icon for a host's own section nav (col2). */
  readonly icon: Icon;
  readonly render: (ctx: SettingsContext) => ReactElement;
  // Tucked under a collapsed "Advanced" disclosure, not a peer section.
  readonly advanced?: boolean;
};

/** A labeled group of sections (Personal Settings / Shared Settings). */
export type SettingsSectionGroup = {
  readonly id: string;
  readonly label: string;
  readonly sections: readonly SettingsSection[];
  /** Set when a tenancy probe for a gated section in this group failed
   *  (network/5xx), so a host can show a couldn't-check state instead of
   *  treating the absent sections as an authenticated deny. */
  readonly accessProbeFailed?: true;
};

export function flattenSettingsSections(
  groups: readonly SettingsSectionGroup[],
): readonly SettingsSection[] {
  return groups.flatMap((group) => group.sections);
}

// Falls back to the first section rather than crashing or showing a blank
// nav; an empty registry is a distinct, deliberate empty state.
export function resolveActiveSection(
  sections: readonly SettingsSection[],
  requestedId: string | null,
): SettingsSection | undefined {
  if (requestedId !== null) {
    const match = sections.find((section) => section.id === requestedId);
    if (match !== undefined) return match;
  }
  return sections[0];
}

export function SettingsShell({
  sections,
  context,
  activeId,
}: {
  readonly sections: readonly SettingsSection[];
  readonly context: SettingsContext;
  /** The active section id, resolved by the host from the URL. `null`
   * defers to the shell's own fallback (the first section). */
  readonly activeId: string | null;
}) {
  const firstSection = sections[0];
  if (firstSection === undefined) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.emptySectionsTitle}
        description={SETTINGS_STRINGS.emptySectionsDescription}
      />
    );
  }

  const activeSection = resolveActiveSection(sections, activeId) ?? firstSection;

  return (
    <div className="settings-shell">
      {/* No repeated "Settings · Section" heading here — the host's stage
          top bar already carries it, and every section card names itself. */}
      <div className="settings-stage" key={activeSection.id}>
        <div className="settings-stage-body">{activeSection.render(context)}</div>
      </div>
    </div>
  );
}
