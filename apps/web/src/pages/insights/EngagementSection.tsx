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
          value={formatNumber(data.conversations.createdInRange)}
          sub={`${formatNumber(data.conversations.total)} all-time`}
        />
        <Stat
          label="Messages"
          value={formatNumber(data.messages.createdInRange)}
          sub={`${formatNumber(data.messages.total)} all-time`}
        />
        <Stat
          label="Active agents"
          value={formatNumber(data.agentActivity.active)}
          sub="with turns in range"
        />
        <Stat
          label="Idle agents"
          value={formatNumber(data.agentActivity.idle)}
          sub="in range, no turns"
        />
      </div>
    </div>
  );
}
