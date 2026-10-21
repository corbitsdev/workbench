// Both the stage and the nav call this, not the package's bare resolver
// directly, so the two can never drift.

import { ChartBar } from "@/lib/icons";
import { insertEveryoneSections, resolveSettingsSectionGroups } from "@/settings";
import type { SettingsSectionGroup, TenancyAccess } from "@/settings";

import { InsightsRoute } from "./pages/insights-page";
import { INSIGHTS_RUNS_PATH } from "./path-ids";

export function resolveAppSettingsSectionGroups(
  access: TenancyAccess,
): readonly SettingsSectionGroup[] {
  const groups = resolveSettingsSectionGroups(access);
  return insertEveryoneSections(groups, [
    {
      id: "insights",
      title: "Insights",
      icon: ChartBar,
      // InsightsRoute falls back to the browser URL when given no path, and
      // the dialog's own `/settings/insights` parses as an Insights landing
      // page — landing renders a redirect to a top-level route, which unmounts
      // the dialog. Hand it the runs history instead: that mode renders inline.
      render: () => <InsightsRoute path={INSIGHTS_RUNS_PATH} embedded />,
    },
  ]);
}
