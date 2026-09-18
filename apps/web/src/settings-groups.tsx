// One resolver for the settings section groups this app actually shows —
// the package's own Account/Everyone registry, plus this app's one splice:
// Insights, pulled off the primary nav rail and reachable here instead.
// Both `settings-page.tsx` (stage) and `pages/settings-nav.tsx` call this
// rather than the package's bare `resolveSettingsSectionGroups` directly,
// so the two can never drift.

import { ChartBar } from "@/lib/icons";
import { insertEveryoneSections, resolveSettingsSectionGroups } from "@/settings";
import type { SettingsSectionGroup, TenancyAccess } from "@/settings";

import { InsightsRoute } from "./pages/insights-page";

export function resolveAppSettingsSectionGroups(
  access: TenancyAccess,
): readonly SettingsSectionGroup[] {
  const groups = resolveSettingsSectionGroups(access);
  return insertEveryoneSections(groups, [
    {
      id: "insights",
      title: "Insights",
      icon: ChartBar,
      render: () => <InsightsRoute />,
    },
  ]);
}
