// Both the stage and the nav call this, not the package's bare resolver
// directly, so the two can never drift.

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
