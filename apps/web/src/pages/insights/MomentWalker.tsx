import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AlertCircle, ArrowRight, ChevronRight, Info } from "lucide-react";
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

/** The colored moment dot, by entry kind — mirrors the legend hues. */
function dotClass(entry: TimelineEntry): string {
  if (entry.kind === "tool_call") return "bg-green";
  if (entry.kind === "workflow_run") return "bg-blue-deep";
  if (entry.kind === "artifact" || entry.kind === "artifact_version") {
    return "bg-accent";
  }
  return "bg-blue";
}

/**
 * An honest "not recorded yet" chip in the gold gap hue. The tracking ticket
 * stays in the title attribute (code, not user-facing prose). Carries the
 * caller's testid so each specific gap (tokens / tool I/O / grant usage) is
 * assertable.
 */
function GapChip({
  testid,
  title,
  children,
}: {
  testid: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <span
      data-testid={testid}
      title={title}
      className="inline-flex items-center gap-1 rounded-[5px] border border-dashed border-cream-deep bg-cream/40 px-1.5 py-0.5 font-mono text-[10px] text-gold"
    >
      <Info className="h-2.5 w-2.5" />
      {children}
    </span>
  );
}

function DecompRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="pt-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-text-3">
        {label}
      </div>
      <div className="min-w-0 text-[12.5px] text-text-2">{children}</div>
    </>
  );
}

/**
 * The expanded decomposition of one moment, in the artifact's Input / Output /
 * When / Reference / Grant layout. Everything the record model actually carries
 * renders as a real value; everything it does NOT yet carry (per-moment tokens,
 * a tool call's inputs/output and which records it touched, whether a grant was
 * exercised) renders as an explicit honest gap chip — never a fabricated value.
 */
export function MomentDecomposition({
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
      className="mt-3 grid gap-y-2.5 rounded-[10px] border border-border bg-surface p-3.5 [grid-template-columns:96px_1fr] gap-x-3.5"
    >
      <div className="col-span-2 flex flex-wrap items-center gap-2">
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

      <div className="col-span-2">
        <p className="text-[14px] font-semibold text-text">{headline}</p>
        {detail !== null && detail !== "" && (
          <p className="text-[12px] text-text-3">{detail}</p>
        )}
      </div>

      {entry.kind === "tool_call" && (
        <>
          <DecompRow label="Input">
            <GapChip
              testid="gap-tool-io"
              title="Tool inputs and which records a call touched are not stored yet (CL-2724)."
            >
              inputs not recorded
            </GapChip>
          </DecompRow>
          <DecompRow label="Output">
            <GapChip
              testid="gap-tool-io-output"
              title="Which records this call returned is not stored yet (CL-2724)."
            >
              which records? not recorded
            </GapChip>
          </DecompRow>
        </>
      )}

      {entry.summary !== null && entry.summary !== "" && (
        <DecompRow label="Raw record">
          <pre className="overflow-x-auto rounded-[7px] border border-border bg-surface-2 px-2.5 py-2 font-mono text-[11.5px] text-text-2">
            {entry.summary}
          </pre>
        </DecompRow>
      )}

      <DecompRow label="When">
        <span className="font-mono text-[11.5px] text-text-2">
          {fullTimestamp(entry.timestamp)}
        </span>
        <span className="ml-2 text-[11px] text-text-3">
          {elapsed !== null ? `· ${elapsed} after previous` : "· first loaded"}
        </span>
      </DecompRow>

      <DecompRow label="Reference">
        <span className="block break-all font-mono text-[11px] text-text-3">
          {entry.id}
        </span>
        <span className="block break-all font-mono text-[10.5px] text-text-3">
          {entry.sourceTable}
        </span>
      </DecompRow>

      {tokenBearing && (
        <DecompRow label="Tokens">
          <GapChip
            testid="gap-tokens"
            title="Token usage is recorded per model and per day, not per moment yet (CL-2723)."
          >
            not attributed per moment
          </GapChip>
        </DecompRow>
      )}

      {entry.kind === "grant" && (
        <DecompRow label="Used">
          <GapChip
            testid="gap-grant-usage"
            title="Whether and when this grant was exercised is not persisted yet (CL-2722)."
          >
            not recorded yet
          </GapChip>
        </DecompRow>
      )}

      {link !== null && (
        <div className="col-span-2">
          <Link
            to={link.to}
            className="inline-flex w-fit items-center gap-1 rounded-[8px] border border-border px-2.5 py-1.5 text-[12px] font-medium text-blue-deep outline-none transition-colors hover:bg-row-hover focus-visible:ring-1 focus-visible:ring-accent"
          >
            {link.label}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
    </div>
  );
}

function WalkerSkeleton() {
  return (
    <div className="flex flex-col gap-2" data-testid="moment-walker-loading">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-[58px] rounded-[12px]" />
      ))}
    </div>
  );
}

/**
 * Moment-walker: a time-ordered walk through recorded moments (the
 * {@link usePrincipalActivity} timeline union). Each moment is a card; the
 * selected one expands inline to its decomposition. Arrow/j/k/Home/End step
 * through it from the keyboard, so stepping IS the decomposition walk.
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
      <p className="flex items-center gap-2 text-[11.5px] text-text-3">
        Step through moments with
        <span className="rounded-[4px] border border-border-strong px-1 py-px font-mono text-[9.5px]">
          ↑
        </span>
        <span className="rounded-[4px] border border-border-strong px-1 py-px font-mono text-[9.5px]">
          ↓
        </span>
        · each opens to what we recorded — and flags what isn&rsquo;t.
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
        className="flex flex-col gap-2 outline-none"
      >
        {entries.map((entry, index) => {
          const isSelected = index === clampedSelected;
          const { headline, detail } = describeActivityEntry(entry);
          return (
            <li
              key={`${entry.sourceTable}:${entry.id}`}
              id={`moment-${index}`}
              role="option"
              aria-selected={isSelected}
              onClick={() => setSelected(index)}
              className={`cursor-pointer rounded-[12px] border bg-surface shadow-[var(--shadow)] transition-colors ${
                isSelected
                  ? "border-accent"
                  : "border-border hover:bg-row-hover"
              }`}
            >
              <div className="flex items-center gap-3 px-3.5 py-3">
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass(entry)}`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-[13px] font-semibold text-text">
                      {headline}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-text-3">
                      {KIND_META[entry.kind].label}
                    </span>
                  </span>
                  {detail !== null && detail !== "" && (
                    <span className="mt-0.5 block truncate text-[11.5px] text-text-2">
                      {detail}
                    </span>
                  )}
                </span>
                <time
                  dateTime={entry.timestamp}
                  title={new Date(entry.timestamp).toLocaleString()}
                  className="shrink-0 font-mono text-[10px] tabular-nums text-text-3"
                >
                  {relativeTime(entry.timestamp, now)}
                </time>
                <ChevronRight
                  className={`h-3.5 w-3.5 shrink-0 text-text-3 transition-transform ${
                    isSelected ? "rotate-90" : ""
                  }`}
                  aria-hidden
                />
              </div>
              {isSelected && (
                <div className="border-t border-border bg-surface-2 px-3.5 pb-3.5 pt-3">
                  <MomentDecomposition
                    entry={entry}
                    previous={entries[index + 1]}
                  />
                </div>
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
