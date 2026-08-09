import { PageShell, RichEmptyState } from "@corbits/react-ui";
import { ChartColumn } from "lucide-react";

/**
 * Honest stub for the Insights nav target. The analytics surface is a later
 * wave ticket; the rail already needs the path so product navigation matches
 * the accepted nav set (Home, Routines, Library, Agents, Skills, Insights).
 */
export function InsightsPage() {
  return (
    <PageShell width="full" className="page-fill">
      <RichEmptyState
        icon={<ChartColumn />}
        title="Insights aren't built yet"
        description="Insights will show usage, run history, and an audit trail for this bench. There is no analytics surface wired yet, so this page has nothing real to chart."
      />
    </PageShell>
  );
}

export function InsightsRoute() {
  return <InsightsPage />;
}
