export { SettingsShell, resolveActiveSection, flattenSettingsSections } from "./shell";
export type { SettingsSectionGroup } from "./shell";

export { resolveSettingsSectionGroups, insertEveryoneSections } from "./section-registry";

export { probeSectionAccess, coalesceSectionAccess } from "./access";
export type { TenancyAccess } from "./access";

export { SETTINGS_STRINGS } from "./strings";
