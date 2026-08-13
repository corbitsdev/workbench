// Settings section nav: col2's list surface for the settings page —
// master-detail, so the list lives only here, never repeated in the stage.
// Grouping, gating, and icons come from `@corbits/settings-ui`'s section
// registry (`resolveSettingsSectionGroups`); this component only adapts
// bench context and the app router around it.

import { SidebarItemRow } from "@corbits/react-ui";
import {
  resolveSettingsSectionGroups,
  SETTINGS_STRINGS,
} from "@corbits/settings-ui";

import { useBench } from "../bench-context";
import { SETTINGS_PATH_PREFIX, settingsSectionIdFromPath } from "../path-ids";
import { useSettingsAccess } from "../settings-access";

export function SettingsNavBand({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId, selectedPrincipalId } = useBench();
  const access = useSettingsAccess(selectedTenantId, selectedPrincipalId);
  const groups = resolveSettingsSectionGroups(access);
  const activeId = settingsSectionIdFromPath(path);

  return (
    <div className="panel-stack" aria-label={SETTINGS_STRINGS.sectionsNavLabel}>
      {groups.map((group) => (
        <div key={group.id} className="panel-stack-group">
          <p className="panel-band-subheading">{group.label}</p>
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
    </div>
  );
}
