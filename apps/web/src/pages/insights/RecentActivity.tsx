import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import { getPrincipalActivity, type TimelineEntry } from "@workbench/client";
import { KIND_META, relativeTime } from "./timeline-kinds";
import {
  describeActivityEntry,
  groupActivityIntoTurns,
  type ActivityTurn,
} from "./activity-naming";

// A short reverse-chronological slice; the deep per-actor timeline (with
// pagination) lives in the Activity search section. This is the entry point.
export const RECENT_ACTIVITY_LIMIT = 15;

// A workflow_run timeline entry's `id` IS the run id (the workflow_run_record
// primary key), so it deep-links straight to that run's trace page.
export function traceHrefForEntry(entry: TimelineEntry): string | null {
  if (entry.kind !== "workflow_run") return null;
  return `/insights/trace/${encodeURIComponent(entry.id)}`;
}

function EntryBody({ entry, now }: { entry: TimelineEntry; now: Date }) {
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  const { headline, detail } = describeActivityEntry(entry);
  return (
    <>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-3" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-text">
          {headline}
        </span>
        {detail !== null && detail !== "" && (
          <span className="block truncate text-[12px] text-text-3">
            {detail}
          </span>
        )}
      </span>
      <time
        dateTime={entry.timestamp}
        title={new Date(entry.timestamp).toLocaleString()}
        className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-text-3"
      >
        {relativeTime(entry.timestamp, now)}
      </time>
    </>
  );
}

function EntryRow({ entry, now }: { entry: TimelineEntry; now: Date }) {
  const href = traceHrefForEntry(entry);
  const shared = "flex items-start gap-3 rounded-[8px] px-3 py-2";
  if (href !== null) {
    return (
      <li>
        <Link
          to={href}
          data-testid="recent-activity-entry"
          data-kind={entry.kind}
          className={`${shared} transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
        >
          <EntryBody entry={entry} now={now} />
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-3" />
        </Link>
      </li>
    );
  }
  return (
    <li
      data-testid="recent-activity-entry"
      data-kind={entry.kind}
      className={shared}
    >
      <EntryBody entry={entry} now={now} />
    </li>
  );
}

/** "2 grants · 1 tool call" from a turn's per-kind counts. */
function flowSummary(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([kind, n]) => {
      const label =
        KIND_META[kind as TimelineEntry["kind"]].label.toLowerCase();
      return n === 1 ? `1 ${label}` : `${n} ${label}s`;
    })
    .join(" · ");
}

function TurnCard({ turn, now }: { turn: ActivityTurn; now: Date }) {
  // A single-entry turn needs no grouping header — it reads as one row.
  if (turn.entries.length === 1) {
    return (
      <ul
        className="rounded-[12px] border border-border bg-surface p-1"
        data-testid="activity-turn"
      >
        <EntryRow entry={turn.entries[0]!} now={now} />
      </ul>
    );
  }
  const anchor = turn.entries[0]!;
  const AnchorIcon = KIND_META[anchor.kind].icon;
  return (
    <div
      className="rounded-[12px] border border-border bg-surface"
      data-testid="activity-turn"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <AnchorIcon className="h-3.5 w-3.5 shrink-0 text-text-3" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">
          {turn.headline}
        </span>
        <span className="shrink-0 text-[11px] text-text-3">
          {flowSummary(turn.counts)}
        </span>
        <time
          dateTime={turn.endedAt}
          title={new Date(turn.endedAt).toLocaleString()}
          className="shrink-0 font-mono text-[11px] tabular-nums text-text-3"
        >
          {relativeTime(turn.endedAt, now)}
        </time>
      </div>
      <ul className="flex flex-col gap-px p-1">
        {turn.entries.map((entry) => (
          <EntryRow
            key={`${entry.sourceTable}:${entry.id}`}
            entry={entry}
            now={now}
          />
        ))}
      </ul>
    </div>
  );
}

export function RecentActivity({
  tenantId,
  principalId,
}: {
  tenantId: string;
  principalId: string;
}) {
  const query = useQuery({
    queryKey: ["recent-activity", tenantId, principalId],
    queryFn: ({ signal }) =>
      getPrincipalActivity(
        { init: { signal } },
        { tenantId, principalId, limit: RECENT_ACTIVITY_LIMIT },
      ),
    enabled: tenantId !== "" && principalId !== "",
  });

  const entries = query.data?.entries ?? [];
  const turns = groupActivityIntoTurns(entries);
  const now = new Date();

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">
        Recent activity
      </h2>

      {query.isLoading && (
        <div
          className="flex flex-col gap-2"
          data-testid="recent-activity-loading"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[44px] animate-pulse rounded-[8px] bg-surface-2"
            />
          ))}
        </div>
      )}

      {query.isError && (
        <div className="flex flex-col items-start gap-2 rounded-[12px] border border-border bg-surface p-4">
          <span className="text-[13px] text-text-2">
            Couldn&rsquo;t load recent activity. Please try again.
          </span>
          <button
            type="button"
            onClick={() => {
              void query.refetch();
            }}
            className="flex min-h-[32px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Retry
          </button>
        </div>
      )}

      {query.isSuccess && entries.length === 0 && (
        <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
          No recent activity recorded yet.
        </div>
      )}

      {turns.length > 0 && (
        <div className="flex flex-col gap-2">
          <p
            className="text-[11px] leading-snug text-text-3"
            data-testid="recent-activity-grouping-note"
          >
            Grouped by time proximity — entries close together in time are shown
            as one flow, not by a recorded session.
          </p>
          {turns.map((turn) => (
            <TurnCard key={turn.id} turn={turn} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}
