// Settings section nav: the master list of the settings surface, rendered
// inside the stage beside the active section (master-detail — the list is
// never repeated in the section panel). Grouping, gating, and icons come
// from `@corbits/settings-ui`'s section registry
// (`resolveSettingsSectionGroups`); this component only adapts the app's
// scope context and router around it.

import { SidebarItemRow } from "@corbits/react-ui";
import { SETTINGS_STRINGS } from "@corbits/settings-ui";

import { useBench } from "../bench-context";
import { SETTINGS_PATH_PREFIX, settingsSectionIdFromPath } from "../path-ids";
import { resolveAppSettingsSectionGroups } from "../settings-groups";
import { useSettingsAccess } from "../settings-access";

export function SettingsNav({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId, selectedPrincipalId } = useBench();
  const access = useSettingsAccess(selectedTenantId, selectedPrincipalId);
  const groups = resolveAppSettingsSectionGroups(access);
  const activeId = settingsSectionIdFromPath(path);

  return (
    <nav
      className="settings-nav"
      aria-label={SETTINGS_STRINGS.sectionsNavLabel}
    >
      {groups.map((group) => (
        <div key={group.id} className="settings-nav-group">
          <p className="settings-nav-heading">{group.label}</p>
          {group.sections.map((section) => {
            const Icon = section.icon;
            return (
              <SidebarItemRow
                key={section.id}
                name={section.title}
                leading={<Icon aria-hidden="true" />}
                selected={section.id === activeId}
                onSelect={() =>
                  onNavigate(`${SETTINGS_PATH_PREFIX}/${section.id}`)
                }
              />
            );
          })}
        </div>
      ))}
    </nav>
  );
}
