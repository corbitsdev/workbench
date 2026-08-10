// The settings surface's shell: a package-contributed registry of sections
// rendered behind a grouped Personal / Workspace nav. `apps/web` supplies the
// literal groups and mounts this component — everything about what a section
// shows and how it saves lives in the section's own `render`, never here.

import { EmptyState } from "@corbits/react-ui";
import { useState } from "react";
import type { ReactElement } from "react";

import { SETTINGS_STRINGS } from "./strings";

/** Whatever shared context a section needs to do its own fetching: the
 * bench currently selected in the app's chrome, and the signed-in account's
 * principal on that bench (for permission probes). A section with no use
 * for either (Account, today) simply ignores the field. */
export type SettingsContext = {
  readonly tenantId: string | null;
  readonly principalId: string | null;
};

export type SettingsSection = {
  readonly id: string;
  readonly title: string;
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
  groups,
  sections: flatSections,
  context,
  activeId,
  onSelect,
}: {
  /**
   * Preferred: Personal / Workspace groups for the mock-aligned nav.
   * When provided, `sections` is ignored.
   */
  readonly groups?: readonly SettingsSectionGroup[];
  /**
   * Legacy flat registry. Prefer `groups`. Kept so existing hosts that only
   * pass sections still render without regrouping.
   */
  readonly sections?: readonly SettingsSection[];
  readonly context: SettingsContext;
  /** The externally-requested active section id, e.g. from the URL. `null`
   * defers entirely to the shell's own fallback (the first section). */
  readonly activeId?: string | null;
  /** Notified whenever the active section changes, so a host that tracks the
   * active section in the URL can stay in sync. Omit for a shell that owns
   * its own selection. */
  readonly onSelect?: (id: string) => void;
}) {
  const [internalActiveId, setInternalActiveId] = useState<string | null>(null);

  const resolvedGroups: readonly SettingsSectionGroup[] =
    groups !== undefined && groups.length > 0
      ? groups
      : flatSections !== undefined && flatSections.length > 0
        ? [
            {
              id: "all",
              label: SETTINGS_STRINGS.pageTitle,
              sections: flatSections,
            },
          ]
        : [];

  const sections = flattenSettingsSections(resolvedGroups);

  if (sections.length === 0) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.emptySectionsTitle}
        description={SETTINGS_STRINGS.emptySectionsDescription}
      />
    );
  }

  const requested = activeId ?? internalActiveId;
  const active = resolveActiveSection(sections, requested);
  const activeSection = active ?? sections[0];
  if (activeSection === undefined) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.emptySectionsTitle}
        description={SETTINGS_STRINGS.emptySectionsDescription}
      />
    );
  }

  function select(id: string) {
    setInternalActiveId(id);
    onSelect?.(id);
  }

  return (
    <div className="settings-shell">
      <nav
        className="settings-nav"
        aria-label={SETTINGS_STRINGS.sectionsNavLabel}
      >
        {resolvedGroups.map((group) => (
          <div key={group.id} className="settings-nav-group">
            <div className="settings-nav-group-label">{group.label}</div>
            <ul className="settings-nav-list">
              {group.sections.map((section) => {
                const isActive = section.id === activeSection.id;
                return (
                  <li key={section.id}>
                    <button
                      type="button"
                      className="settings-nav-item"
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => select(section.id)}
                    >
                      {section.title}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
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
