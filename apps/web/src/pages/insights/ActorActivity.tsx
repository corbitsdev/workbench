import { useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronLeft,
  CheckCircle2,
  CircleDot,
  Database,
  FileText,
  KeyRound,
  Layers,
  MessageCircle,
  MessageSquare,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  getPrincipalActivity,
  searchActors,
  type Actor,
  type TimelineEntry,
  type TimelineEntryKind,
} from "@workbench/client";
import { useDebouncedValue } from "../../hooks/use-debounced-value";

export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_MIN_QUERY_LENGTH = 2;
// Search results go stale fast (people/agents join and change status), so
// this is deliberately much shorter than the dashboard's 5-minute policy.
const SEARCH_STALE_MS = 30_000;
const TIMELINE_PAGE_SIZE = 50;

// Neutral, non-anthropomorphizing labels: each row states what was recorded,
// not what anyone "decided" or "wanted".
const KIND_META: Record<
  TimelineEntryKind,
  { label: string; icon: LucideIcon }
> = {
  session: { label: "Session", icon: CircleDot },
  message: { label: "Message", icon: MessageSquare },
  inference_turn: { label: "Inference turn", icon: Sparkles },
  tool_call: { label: "Tool call", icon: Wrench },
  workflow_run: { label: "Workflow run", icon: Workflow },
  artifact: { label: "Artifact", icon: FileText },
  artifact_version: { label: "Artifact version", icon: Layers },
  upload: { label: "Upload", icon: Upload },
  memory: { label: "Memory", icon: Database },
  approval: { label: "Approval", icon: CheckCircle2 },
  output_feedback: { label: "Feedback", icon: MessageCircle },
  grant: { label: "Grant", icon: ShieldCheck },
  credential: { label: "Credential", icon: KeyRound },
};

function relativeTime(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

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

function KindTag({ kind }: { kind: Actor["kind"] }) {
  return (
    <span className="rounded-[4px] border border-blue/40 bg-blue/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-blue">
      {kind === "user" ? "User" : "Agent"}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  if (status === "active") return null;
  return (
    <span
      data-testid="actor-status"
      className="rounded-[4px] border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-3"
    >
      {status}
    </span>
  );
}

function ActorRow({ actor, onSelect }: { actor: Actor; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-[8px] px-3 py-2 text-left transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-text">
          {actor.displayName}
        </span>
        {actor.email && (
          <span className="block truncate text-[11px] text-text-3">
            {actor.email}
          </span>
        )}
      </span>
      <StatusChip status={actor.status} />
      <KindTag kind={actor.kind} />
    </button>
  );
}

function TimelineRow({ entry, now }: { entry: TimelineEntry; now: Date }) {
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  const timestamp = new Date(entry.timestamp);
  return (
    <li
      data-testid="timeline-entry"
      data-kind={entry.kind}
      className="flex items-start gap-3 rounded-[8px] px-3 py-2 transition-colors hover:bg-row-hover"
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-3" />
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">
          {meta.label}
        </span>
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
    <div className="flex flex-col gap-2" data-testid="timeline-loading">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-[44px] animate-pulse rounded-[8px] bg-surface-2"
        />
      ))}
    </div>
  );
}

function ActorTimeline({
  tenantId,
  actor,
  onBack,
}: {
  tenantId: string;
  actor: Actor;
  onBack: () => void;
}) {
  const activityQuery = useInfiniteQuery({
    // Keying on the actor id resets the cursor chain whenever the selected
    // actor changes; timeline pages use the default staleTime (dynamic data).
    queryKey: ["principal-activity", tenantId, actor.id],
    queryFn: ({ pageParam, signal }) =>
      getPrincipalActivity(
        { init: { signal } },
        {
          tenantId,
          principalId: actor.id,
          limit: TIMELINE_PAGE_SIZE,
          ...(pageParam !== null ? { cursor: pageParam } : {}),
        },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const entries = activityQuery.data?.pages.flatMap((p) => p.entries) ?? [];
  const groups = groupEntriesByDay(entries);
  const now = new Date();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex min-h-[32px] items-center gap-1 rounded-[8px] px-2 py-1.5 text-[12px] font-medium text-text-3 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Search
        </button>
        <span className="text-[14px] font-semibold text-text">
          {actor.displayName}
        </span>
        <KindTag kind={actor.kind} />
        <StatusChip status={actor.status} />
      </div>

      <p className="flex items-start gap-1.5 text-[11px] leading-snug text-text-3">
        <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
        <span>
          Grant and credential entries reflect their current state only — past
          changes, revocations, and who made them are not recorded, so this
          timeline is not an audit history for permissions or credentials.
        </span>
      </p>

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
            className="flex min-h-[32px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Retry
          </button>
        </div>
      )}

      {activityQuery.isSuccess && entries.length === 0 && (
        <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
          No activity recorded for this actor yet.
        </div>
      )}

      {groups.length > 0 && (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              <span className="font-mono text-[11px] tabular-nums text-text-3">
                {group.label}
              </span>
              <ul className="flex flex-col border-l border-border pl-2">
                {group.entries.map((entry) => (
                  <TimelineRow
                    key={`${entry.sourceTable}:${entry.id}`}
                    entry={entry}
                    now={now}
                  />
                ))}
              </ul>
            </div>
          ))}
          {activityQuery.hasNextPage && (
            <div>
              <button
                type="button"
                disabled={activityQuery.isFetchingNextPage}
                onClick={() => {
                  void activityQuery.fetchNextPage();
                }}
                className="flex min-h-[32px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
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

/**
 * Actor search + per-principal activity timeline for the Insights page.
 * Self-contained: owns its own query lifecycle, independent of the
 * dashboard's 5-minute-stale overview query.
 */
export function ActorActivitySection({ tenantId }: { tenantId: string }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Actor | null>(null);

  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const searchEnabled =
    selected === null && debouncedQuery.length >= SEARCH_MIN_QUERY_LENGTH;

  const searchQuery = useQuery({
    queryKey: ["actor-search", tenantId, debouncedQuery],
    queryFn: ({ signal }) =>
      searchActors({ init: { signal } }, { tenantId, query: debouncedQuery }),
    enabled: searchEnabled,
    staleTime: SEARCH_STALE_MS,
    placeholderData: keepPreviousData,
  });

  const actors = searchQuery.data ?? [];
  const trimmed = query.trim();

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">
        Activity
      </h2>

      {selected ? (
        <ActorTimeline
          tenantId={tenantId}
          actor={selected}
          onBack={() => setSelected(null)}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5 rounded-[10px] border border-border bg-surface px-3 py-2 focus-within:ring-1 focus-within:ring-accent">
            <Search size={16} className="flex-none text-text-3" />
            <input
              type="text"
              role="searchbox"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search people and agents…"
              aria-label="Search people and agents"
              className="w-full bg-transparent text-sm text-text outline-none placeholder:text-text-3"
            />
          </div>

          {trimmed.length > 0 && trimmed.length < SEARCH_MIN_QUERY_LENGTH && (
            <p className="px-1 text-[12px] text-text-3">
              Type at least {SEARCH_MIN_QUERY_LENGTH} characters to search.
            </p>
          )}

          {searchEnabled && searchQuery.isPending && (
            <p className="px-1 text-[12px] text-text-3">Searching…</p>
          )}

          {searchQuery.isError && (
            <p className="px-1 text-[12px] text-text-3">
              Search failed. Please try again.
            </p>
          )}

          {searchEnabled && searchQuery.isSuccess && actors.length === 0 && (
            <p className="px-1 text-[12px] text-text-3">
              No people or agents match “{debouncedQuery}”.
            </p>
          )}

          {searchEnabled && actors.length > 0 && (
            <ul className="flex flex-col rounded-[12px] border border-border bg-surface p-1">
              {actors.map((actor) => (
                <li key={actor.id}>
                  <ActorRow actor={actor} onSelect={() => setSelected(actor)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
