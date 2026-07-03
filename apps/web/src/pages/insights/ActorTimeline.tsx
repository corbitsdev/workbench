import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Badge, Skeleton } from "@workbench/ui";
import { getPrincipalActivity, type TimelineEntry } from "@workbench/client";
import { KIND_META, relativeTime } from "./timeline-kinds";

const TIMELINE_PAGE_SIZE = 50;

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function groupEntriesByDay(
  entries: TimelineEntry[],
): { key: string; label: string; entries: TimelineEntry[] }[] {
  const groups: { key: string; label: string; entries: TimelineEntry[] }[] = [];
  for (const entry of entries) {
    const key = dayKey(entry.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.entries.push(entry);
    } else {
      groups.push({ key, label: dayLabel(entry.timestamp), entries: [entry] });
    }
  }
  return groups;
}

function hasPermissionEntry(entries: TimelineEntry[]): boolean {
  return entries.some((e) => e.kind === "grant" || e.kind === "credential");
}

function TimelineRow({ entry, now }: { entry: TimelineEntry; now: Date }) {
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  const timestamp = new Date(entry.timestamp);
  return (
    <li
      data-testid="timeline-entry"
      data-kind={entry.kind}
      className="flex items-start gap-3 rounded-[10px] px-3 py-2.5"
    >
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-[8px] border border-border bg-surface-2 text-text-3">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <Badge tone={meta.tone} className="mb-1">
          {meta.label}
        </Badge>
        <span className="block truncate text-[13px] text-text-2">
          {entry.summary ?? "No details recorded"}
        </span>
      </span>
      <time
        dateTime={entry.timestamp}
        title={timestamp.toLocaleString()}
        className="shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-text-3"
      >
        {relativeTime(entry.timestamp, now)}
        <span className="block">
          {timestamp.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </time>
    </li>
  );
}

function TimelineSkeleton() {
  return (
    <div className="flex flex-col gap-0.5" data-testid="timeline-loading">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-start gap-3 px-3 py-2.5">
          <Skeleton className="mt-0.5 h-6 w-6 rounded-[8px]" />
          <div className="min-w-0 flex-1">
            <Skeleton className="mb-1 h-4 w-16 rounded-[4px]" />
            <Skeleton className="h-3.5 w-3/4" />
          </div>
          <div className="flex flex-col items-end gap-1 pt-0.5">
            <Skeleton className="h-2.5 w-12" />
            <Skeleton className="h-2.5 w-10" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Shared infinite-query for a principal's activity, keyed on the principal id.
 * The routed page and the timeline both call this with the same arguments;
 * TanStack dedupes them onto one cache entry, so the header's derived stats and
 * the timeline rows always agree and Load-more appends update both.
 */
export function usePrincipalActivity(
  tenantId: string,
  principalId: string,
  options: { enabled?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: ["principal-activity", tenantId, principalId],
    queryFn: ({ pageParam, signal }) =>
      getPrincipalActivity(
        { init: { signal } },
        {
          tenantId,
          principalId,
          limit: TIMELINE_PAGE_SIZE,
          ...(pageParam !== null ? { cursor: pageParam } : {}),
        },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: options.enabled ?? true,
  });
}

/**
 * Polished per-principal activity timeline. Renders from an id alone (no actor
 * object required) via {@link usePrincipalActivity}. Renders skeleton/empty/
 * error states, sticky day headers within the caller's scroll container,
 * per-kind badges, and an `aria-live` status that announces appended pages on
 * Load more.
 */
export function ActorTimeline({
  tenantId,
  principalId,
}: {
  tenantId: string;
  principalId: string;
}) {
  const activityQuery = usePrincipalActivity(tenantId, principalId);

  const entries = activityQuery.data?.pages.flatMap((p) => p.entries) ?? [];
  const groups = groupEntriesByDay(entries);
  const now = new Date();
  const showCaveat = hasPermissionEntry(entries);

  return (
    <div className="flex flex-col gap-3">
      <p
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="timeline-status"
      >
        {activityQuery.isSuccess
          ? `Showing ${entries.length} activity ${entries.length === 1 ? "entry" : "entries"}`
          : ""}
      </p>

      {showCaveat && (
        <p
          className="flex items-start gap-1.5 rounded-[10px] border border-border bg-surface px-3 py-2 text-[11px] leading-snug text-text-3"
          data-testid="permission-caveat"
        >
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>
            Grant and credential entries reflect their current state only — past
            changes, revocations, and who made them are not recorded, so this
            timeline is not an audit history for permissions or credentials.
          </span>
        </p>
      )}

      {activityQuery.isLoading && <TimelineSkeleton />}

      {activityQuery.isError && (
        <div className="flex flex-col items-start gap-2 rounded-[12px] border border-border bg-surface p-4">
          <span className="text-[13px] text-text-2">
            Couldn't load this actor's activity. Please try again.
          </span>
          <button
            type="button"
            onClick={() => {
              void activityQuery.refetch();
            }}
            className="flex min-h-[40px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-[colors,transform] hover:bg-row-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
          >
            Retry
          </button>
        </div>
      )}

      {activityQuery.isSuccess && entries.length === 0 && (
        <div className="rounded-[12px] border border-border bg-surface p-8 text-center text-[13px] text-text-2">
          No activity recorded for this actor yet.
        </div>
      )}

      {groups.length > 0 && (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <section key={group.key} className="flex flex-col gap-1">
              <h3 className="sticky top-0 z-10 -mx-1 bg-bg/95 px-1 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] tabular-nums text-text-3 backdrop-blur">
                {group.label}
              </h3>
              <ul className="flex flex-col gap-0.5 border-l border-border pl-2">
                {group.entries.map((entry) => (
                  <TimelineRow
                    key={`${entry.sourceTable}:${entry.id}`}
                    entry={entry}
                    now={now}
                  />
                ))}
              </ul>
            </section>
          ))}
          {activityQuery.hasNextPage && (
            <div>
              <button
                type="button"
                disabled={activityQuery.isFetchingNextPage}
                onClick={() => {
                  void activityQuery.fetchNextPage();
                }}
                className="flex min-h-[40px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-[colors,transform] hover:bg-row-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97] disabled:opacity-50"
              >
                {activityQuery.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
