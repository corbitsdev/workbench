// The settings surface's shell: renders the active section's panel only.
// Section nav is a master-detail list — it lives in the host's own col2
// (see `resolveSettingsSectionGroups`), never repeated in the stage.
// Everything about what a section shows and how it saves lives in the
// section's own `render`, never here.

import { EmptyState } from "@corbits/react-ui";
import type { LucideIcon } from "lucide-react";
import type { ReactElement } from "react";

import { SETTINGS_STRINGS } from "./strings";

/** Whatever shared context a section needs to do its own fetching: the
 * bench currently selected in the app's chrome, and the signed-in account's
 * principal on that bench (for permission probes). A section with no use
 * for either (Account, today) simply ignores the field. */
export type SettingsContext = {
  readonly tenantId: string | null;
  readonly principalId: string | null;
  /** Client-side navigation, for a section whose own content routes
   * elsewhere (e.g. Agents' "Start chat" opening a channel). Sections with
   * no use for it simply ignore the field. */
  readonly navigate?: (to: string) => void;
  /** A sub-selection carried in the host's URL below the section id (e.g.
   * `/settings/agents/:definitionId`), so a section with its own
   * master-detail can restore the right selection on a deep link. */
  readonly entityId?: string | null;
};

export type SettingsSection = {
  readonly id: string;
  readonly title: string;
  /** Leading icon for a host's own section nav (col2). */
  readonly icon: LucideIcon;
  readonly render: (ctx: SettingsContext) => ReactElement;
};

/** A labeled group of sections (Personal · only you / Workspace · shared). */
export type SettingsSectionGroup = {
  readonly id: string;
  readonly label: string;
  readonly sections: readonly SettingsSection[];
};

export function flattenSettingsSections(
  groups: readonly SettingsSectionGroup[],
): readonly SettingsSection[] {
  return groups.flatMap((group) => group.sections);
}

/**
 * The section a shell should treat as active: the requested id if it names
 * a real section, otherwise the first section — never a crash, and never a
 * blank nav. `sections` is validated non-empty by the caller; an empty
 * registry is a distinct, deliberate empty state.
 */
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

  const activeSection =
    resolveActiveSection(sections, activeId) ?? firstSection;

  return (
    <div className="settings-shell">
      <div className="settings-stage" key={activeSection.id}>
        <header className="settings-stage-header">
          <h1 className="settings-stage-title">
            {SETTINGS_STRINGS.pageTitle}
            <span className="settings-stage-title-sep" aria-hidden="true">
              ·
            </span>
            <span className="settings-stage-section">
              {activeSection.title}
            </span>
          </h1>
        </header>
        <div className="settings-stage-body">
          {activeSection.render(context)}
        </div>
      </div>
    </div>
  );
}
