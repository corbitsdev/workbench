import type { ActivityOverview } from "../../lib/hub-api";
import { formatNumber, Stat } from "./stats";
import { SectionLabel } from "./section-label";

export function EngagementSection({ data }: { data: ActivityOverview }) {
  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Engagement</SectionLabel>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Conversations"
          value={formatNumber(data.conversations.total)}
          sub={`${formatNumber(data.conversations.createdInRange)} in range`}
        />
        <Stat
          label="Messages"
          value={formatNumber(data.messages.total)}
          sub={`${formatNumber(data.messages.createdInRange)} in range`}
        />
        <Stat
          label="Active agents"
          value={formatNumber(data.agentActivity.active)}
          sub="with activity"
        />
        <Stat
          label="Idle agents"
          value={formatNumber(data.agentActivity.idle)}
          sub="of total instances"
        />
      </div>
    </div>
  );
}
