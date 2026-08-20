// One resolver for the settings section groups this app actually shows —
// the package's own Account/Everyone registry plus this app's Agents and
// Skills sections spliced into Everyone. Both `settings-page.tsx` (stage)
// and `pages/settings-nav.tsx` call this, never the package's bare
// `resolveSettingsSectionGroups`, so the two can never disagree about what
// Everyone contains.

import {
  insertEveryoneSections,
  resolveSettingsSectionGroups,
} from "@corbits/settings-ui";
import type { SettingsSectionGroup, TenancyAccess } from "@corbits/settings-ui";

import { everyoneExtraSections } from "./settings-everyone-sections";

export function resolveAppSettingsSectionGroups(
  access: TenancyAccess,
): readonly SettingsSectionGroup[] {
  return insertEveryoneSections(
    resolveSettingsSectionGroups(access),
    everyoneExtraSections(),
  );
}
