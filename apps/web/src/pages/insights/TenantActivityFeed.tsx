import { Link } from "react-router";
import { AlertTriangle, ChevronRight } from "lucide-react";
import type { TimelineEntry } from "@workbench/client";
import { useTenantActivity } from "../../hooks/use-tenant-activity";
import { KIND_META, relativeTime } from "./timeline-kinds";
import {
  describeActivityEntry,
  groupActivityIntoTurns,
  type ActivityTurn,
} from "./activity-naming";
import { entityLinkForEntry } from "./trace-links";

// The tenant-wide activity feed (CL-2743): the MIDDLE band of Insights, below
// the charts. Every principal's activity in the tenant, grouped into
// time-adjacent turns. Each entity-shaped row deep-links into that entity's own
// trace ("click anything → trace it"); rows with no dedicated destination yet
// render as plain, honest references rather than dead links.

function hasPermissionEntry(entries: TimelineEntry[]): boolean {
  return entries.some((e) => e.kind === "grant" || e.kind === "credential");
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
  const link = entityLinkForEntry(entry);
  const shared = "flex items-start gap-3 rounded-[8px] px-3 py-2";
  if (link !== null) {
    return (
      <li>
        <Link
          to={link.to}
          aria-label={link.label}
          data-testid="tenant-activity-entry"
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
      data-testid="tenant-activity-entry"
      data-kind={entry.kind}
      className={shared}
    >
      <EntryBody entry={entry} now={now} />
    </li>
  );
}

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
  if (turn.entries.length === 1) {
    return (
      <ul
        className="rounded-[12px] border border-border bg-surface p-1"
        data-testid="tenant-activity-turn"
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
      data-testid="tenant-activity-turn"
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

export function TenantActivityFeed({ tenantId }: { tenantId: string }) {
  const query = useTenantActivity(tenantId);
  const entries = (query.data?.pages ?? []).flatMap((p) => p.entries);
  const turns = groupActivityIntoTurns(entries);
  const showCaveat = hasPermissionEntry(entries);
  const now = new Date();

  return (
    <div className="flex flex-col gap-3" data-testid="tenant-activity-feed">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">
          Activity across your workbench
        </h2>
        <p className="text-[12px] text-text-3">
          Everyone&rsquo;s agents, workflows, and runs — newest first. Grant and
          credential rows are current-state activity, not an audit log. Click any
          row to trace it.
        </p>
      </div>

      {showCaveat && (
        <p
          className="flex items-start gap-1.5 rounded-[10px] border border-border bg-surface px-3 py-2 text-[11px] leading-snug text-text-3"
          data-testid="permission-caveat"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>
            Grant and credential entries reflect their current state only — past
            changes, revocations, and who made them are not recorded, so this
            activity feed is not an audit history for permissions or credentials.
          </span>
        </p>
      )}

      {query.isLoading && (
        <div
          className="flex flex-col gap-2"
          data-testid="tenant-activity-loading"
        >
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[44px] animate-pulse rounded-[8px] bg-surface-2"
            />
          ))}
        </div>
      )}

      {query.isError && (
        <div
          className="flex flex-col items-start gap-2 rounded-[12px] border border-border bg-surface p-4"
          data-testid="tenant-activity-error"
        >
          <span className="text-[13px] text-text-2">
            Couldn&rsquo;t load activity. Please try again.
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
        <div
          className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2"
          data-testid="tenant-activity-empty"
        >
          No activity recorded in this workbench yet.
        </div>
      )}

      {turns.length > 0 && (
        <div className="flex flex-col gap-2">
          {turns.map((turn) => (
            <TurnCard key={turn.id} turn={turn} now={now} />
          ))}
          {query.hasNextPage && (
            <button
              type="button"
              data-testid="tenant-activity-load-more"
              disabled={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
              className="mt-1 flex min-h-[36px] items-center justify-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60"
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
