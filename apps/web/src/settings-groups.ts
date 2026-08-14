// One resolver for the settings section groups this app actually shows —
// the package's own Personal/Workspace registry plus this app's Agents and
// Skills sections spliced into Workspace. Both `settings-page.tsx` (stage)
// and `settings-nav-band.tsx` (col2) call this, never the package's bare
// `resolveSettingsSectionGroups`, so the two can never disagree about what
// Workspace contains.

import {
  insertWorkspaceSections,
  resolveSettingsSectionGroups,
} from "@corbits/settings-ui";
import type { SettingsSectionGroup, TenancyAccess } from "@corbits/settings-ui";

import { workspaceExtraSections } from "./settings-workspace-sections";

export function resolveAppSettingsSectionGroups(
  access: TenancyAccess,
): readonly SettingsSectionGroup[] {
  return insertWorkspaceSections(
    resolveSettingsSectionGroups(access),
    workspaceExtraSections(),
  );
}
