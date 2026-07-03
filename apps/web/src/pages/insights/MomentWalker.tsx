import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AlertCircle, ArrowRight, Info } from "lucide-react";
import { Badge, Skeleton } from "@workbench/ui";
import type { TimelineEntry } from "@workbench/client";
import { KIND_META, relativeTime, timelineEntryTone } from "./timeline-kinds";
import { describeActivityEntry } from "./activity-naming";
import {
  GRANT_EFFECT_LABEL,
  entityLinkForEntry,
  formatElapsedBetween,
  grantEffect,
} from "./trace-links";
import { usePrincipalActivity } from "./ActorTimeline";

function fullTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Honest gaps: the timeline row is a single raw projection (id/kind/timestamp/
// summary), so per-moment token attribution, tool inputs/outputs and which
// records a call touched, and whether a grant was ever exercised are simply not
// recorded yet. We name each absence rather than fabricate a value. These are
// benign "not recorded yet" notices, not warnings — the tracking tickets
// (CL-2722/2723/2724) stay in code, never in user copy.
function GapNote({
  testid,
  children,
}: {
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <p
      data-testid={testid}
      className="flex items-start gap-1.5 rounded-[8px] border border-dashed border-border bg-surface-2 px-2.5 py-2 text-[11px] leading-snug text-text-3"
    >
      <Info className="mt-px h-3 w-3 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function RefRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">
        {label}
      </span>
      <span className="min-w-0 truncate font-mono text-[11px] tabular-nums text-text-2">
        {value}
      </span>
    </div>
  );
}

/**
 * The expanded decomposition of one moment: everything the record model
 * actually carries (plain headline, when, elapsed since the previous moment,
 * grant effect, a cross-link to the entity's own trace) plus the raw id /
 * source table as a secondary compliance reference — and an explicit "not
 * recorded yet" note for each thing the data does not have.
 */
function MomentDecomposition({
  entry,
  previous,
}: {
  entry: TimelineEntry;
  /** The chronologically-previous (older) moment, for the elapsed gap. */
  previous: TimelineEntry | undefined;
}) {
  const { headline, detail } = describeActivityEntry(entry);
  const meta = KIND_META[entry.kind];
  const link = entityLinkForEntry(entry);
  const elapsed = formatElapsedBetween(previous?.timestamp, entry.timestamp);
  const effect = grantEffect(entry);
  const tokenBearing =
    entry.kind === "inference_turn" ||
    entry.kind === "tool_call" ||
    entry.kind === "message";

  return (
    <div
      data-testid="moment-decomposition"
      className="mt-3 flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={timelineEntryTone(entry)}>{meta.label}</Badge>
        {entry.kind === "grant" && (
          <Badge
            tone={
              effect === "blocked"
                ? "danger"
                : effect === "allowed"
                  ? "positive"
                  : "neutral"
            }
          >
            {GRANT_EFFECT_LABEL[effect]}
          </Badge>
        )}
      </div>

      <div>
        <p className="text-[14px] font-semibold text-text">{headline}</p>
        {detail !== null && detail !== "" && (
          <p className="text-[12px] text-text-3">{detail}</p>
        )}
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2">
        <RefRow label="Recorded" value={fullTimestamp(entry.timestamp)} />
        <RefRow
          label="Since previous"
          value={elapsed ?? "First moment loaded"}
        />
        <RefRow label="Record id" value={entry.id} />
        <RefRow label="Source" value={entry.sourceTable} />
      </div>

      {entry.summary !== null && entry.summary !== "" && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">
            Raw record
          </span>
          <pre className="overflow-x-auto rounded-[6px] border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[11px] text-text-2">
            {entry.summary}
          </pre>
        </div>
      )}

      {link !== null && (
        <Link
          to={link.to}
          className="inline-flex w-fit items-center gap-1 rounded-[8px] border border-border px-2.5 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-colors hover:bg-row-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent"
        >
          {link.label}
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      )}

      {tokenBearing && (
        <GapNote testid="gap-tokens">
          Token usage isn&rsquo;t attributed to a single moment yet — tokens are
          recorded per model and per day, not per turn or tool call.
        </GapNote>
      )}
      {entry.kind === "tool_call" && (
        <GapNote testid="gap-tool-io">
          This tool call&rsquo;s inputs, output, and which records it touched
          aren&rsquo;t recorded — only the tool name and whether it errored are
          captured today.
        </GapNote>
      )}
      {entry.kind === "grant" && (
        <GapNote testid="gap-grant-usage">
          This is the permission&rsquo;s current state. Whether it was actually
          exercised, when, or by which action isn&rsquo;t recorded yet.
        </GapNote>
      )}
    </div>
  );
}

function WalkerSkeleton() {
  return (
    <div className="flex flex-col gap-1.5" data-testid="moment-walker-loading">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-[52px] rounded-[10px]" />
      ))}
    </div>
  );
}

/**
 * Moment-walker: a time-ordered walk through a principal's recorded moments
 * (the {@link usePrincipalActivity} timeline union). The selected moment
 * expands inline to its decomposition; Arrow/j/k/Home/End step through it from
 * the keyboard. Selection auto-expands, so stepping IS the decomposition walk.
 */
export function MomentWalker({
  tenantId,
  principalId,
}: {
  tenantId: string;
  principalId: string;
}) {
  const activityQuery = usePrincipalActivity(tenantId, principalId, {
    enabled: tenantId !== "" && principalId !== "",
  });
  const listRef = useRef<HTMLUListElement>(null);
  const [selected, setSelected] = useState(0);

  const entries = useMemo(
    () => activityQuery.data?.pages.flatMap((p) => p.entries) ?? [],
    [activityQuery.data],
  );

  const now = new Date();
  const hasPermissionEntry = entries.some(
    (e) => e.kind === "grant" || e.kind === "credential",
  );

  const clampedSelected = Math.min(selected, Math.max(entries.length - 1, 0));

  // Keep the selected moment visible as keyboard step-through moves it. Without
  // this the selection can walk off-screen with no scroll. Respect the user's
  // reduced-motion preference (jump instead of smooth-scroll).
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const el = list.querySelector<HTMLElement>(`#moment-${clampedSelected}`);
    if (el === null || typeof el.scrollIntoView !== "function") return;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({
      block: "nearest",
      behavior: reduced ? "auto" : "smooth",
    });
  }, [clampedSelected]);

  function move(next: number) {
    const clamped = Math.max(0, Math.min(next, entries.length - 1));
    setSelected(clamped);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      move(clampedSelected + 1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      move(clampedSelected - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(0);
    } else if (event.key === "End") {
      event.preventDefault();
      move(entries.length - 1);
    }
  }

  if (activityQuery.isLoading) return <WalkerSkeleton />;

  if (activityQuery.isError) {
    return (
      <div
        data-testid="moment-walker-error"
        className="flex flex-col items-start gap-2 rounded-[12px] border border-red/40 bg-surface p-4"
      >
        <span className="flex items-start gap-1.5 text-[13px] text-text-2">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0 text-red" />
          <span>
            Couldn&rsquo;t load this trace&rsquo;s moments. Please try again.
          </span>
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
    );
  }

  if (entries.length === 0) {
    return (
      <div
        data-testid="moment-walker-empty"
        className="rounded-[12px] border border-border bg-surface p-8 text-center text-[13px] text-text-2"
      >
        No moments recorded for this trace yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] leading-snug text-text-3">
        Step through with the arrow keys (or j / k). Each moment opens to the
        detail we have recorded — and flags what isn&rsquo;t.
      </p>

      {hasPermissionEntry && (
        <p
          data-testid="permission-caveat"
          className="flex items-start gap-1.5 rounded-[10px] border border-border bg-surface px-3 py-2 text-[11px] leading-snug text-text-3"
        >
          <Info className="mt-px h-3 w-3 shrink-0" />
          <span>
            Grant and credential moments reflect current state only — past
            changes, revocations, and whether a permission was exercised are not
            recorded, so this is not a permission audit history.
          </span>
        </p>
      )}

      <ul
        ref={listRef}
        role="listbox"
        aria-label="Recorded moments"
        aria-activedescendant={`moment-${clampedSelected}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="flex flex-col gap-1 rounded-[12px] border border-border bg-bg p-1 outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {entries.map((entry, index) => {
          const isSelected = index === clampedSelected;
          const { headline } = describeActivityEntry(entry);
          const Icon = KIND_META[entry.kind].icon;
          return (
            <li
              key={`${entry.sourceTable}:${entry.id}`}
              id={`moment-${index}`}
              role="option"
              aria-selected={isSelected}
              onClick={() => setSelected(index)}
              className={`cursor-pointer rounded-[10px] px-3 py-2.5 transition-colors ${
                isSelected ? "bg-surface-2" : "hover:bg-row-hover"
              }`}
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-[8px] border border-border bg-surface text-text-3">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-text">
                    {headline}
                  </span>
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">
                    {KIND_META[entry.kind].label}
                  </span>
                </span>
                <time
                  dateTime={entry.timestamp}
                  title={new Date(entry.timestamp).toLocaleString()}
                  className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-text-3"
                >
                  {relativeTime(entry.timestamp, now)}
                </time>
              </div>
              {isSelected && (
                <MomentDecomposition
                  entry={entry}
                  previous={entries[index + 1]}
                />
              )}
            </li>
          );
        })}
      </ul>

      {activityQuery.hasNextPage && (
        <button
          type="button"
          disabled={activityQuery.isFetchingNextPage}
          onClick={() => {
            void activityQuery.fetchNextPage();
          }}
          className="flex min-h-[40px] w-fit items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-[colors,transform] hover:bg-row-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97] disabled:opacity-50"
        >
          {activityQuery.isFetchingNextPage ? "Loading…" : "Load more moments"}
        </button>
      )}
    </div>
  );
}
