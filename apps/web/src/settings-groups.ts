// One resolver for the settings section groups this app actually shows —
// the package's own Account/Everyone registry, unmodified. Skills was this
// app's one Everyone splice (CL-5990); CL-6355 moved it out to its own
// `/skills` rail destination, so there is nothing left for this app to add
// — both `settings-page.tsx` (stage) and `pages/settings-nav.tsx` still
// call this rather than the package's bare `resolveSettingsSectionGroups`
// directly, so the two can never drift if this app ever splices something
// else in again.

import { resolveSettingsSectionGroups } from "@corbits/settings-ui";
import type { SettingsSectionGroup, TenancyAccess } from "@corbits/settings-ui";

export function resolveAppSettingsSectionGroups(
  access: TenancyAccess,
): readonly SettingsSectionGroup[] {
  return resolveSettingsSectionGroups(access);
}
