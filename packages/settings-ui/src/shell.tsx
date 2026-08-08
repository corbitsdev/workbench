// The settings surface's shell: a package-contributed registry of sections
// rendered behind a section nav. `apps/web` supplies the literal list of
// sections and mounts this component — everything about what a section
// shows and how it saves lives in the section's own `render`, never here.

import { EmptyState, Tabs } from "@corbits/react-ui";
import { useState } from "react";
import type { ReactElement } from "react";

import { SETTINGS_STRINGS } from "./strings";

/** Whatever shared context a section needs to do its own fetching: the
 * bench currently selected in the app's chrome. A section with no use for
 * it (Account, today) simply ignores the field. */
export type SettingsContext = {
  readonly tenantId: string | null;
};

export type SettingsSection = {
  readonly id: string;
  readonly title: string;
  readonly render: (ctx: SettingsContext) => ReactElement;
};

/**
 * The section a shell should treat as active: the requested id if it names
 * a real section, otherwise the first section — never a crash, and never a
 * blank tab strip. `sections` is validated non-empty by the caller; an
 * empty registry is a distinct, deliberate empty state.
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
  onSelect,
}: {
  readonly sections: readonly SettingsSection[];
  readonly context: SettingsContext;
  /** The externally-requested active section id, e.g. from the URL. `null`
   * defers entirely to the shell's own fallback (the first section). */
  readonly activeId?: string | null;
  /** Notified whenever the active tab changes, so a host that tracks the
   * active section in the URL can stay in sync. Omit for a shell that owns
   * its own selection. */
  readonly onSelect?: (id: string) => void;
}) {
  const [internalActiveId, setInternalActiveId] = useState<string | null>(null);
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
    <Tabs
      label={SETTINGS_STRINGS.sectionsNavLabel}
      tabs={sections.map((section) => ({
        id: section.id,
        label: section.title,
      }))}
      active={activeSection.id}
      onChange={select}
    >
      {(id) => {
        const section = resolveActiveSection(sections, id) ?? sections[0];
        return section === undefined ? null : section.render(context);
      }}
    </Tabs>
  );
}
