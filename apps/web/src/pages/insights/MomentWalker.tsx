import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AlertCircle, ArrowRight, ChevronRight } from "lucide-react";
import {
  Badge,
  formatDuration,
  formatFullTimestamp,
  Skeleton,
} from "@workbench/ui";
import type { MomentDetail, TimelineEntry } from "@workbench/client";
import { KIND_META, relativeTime, timelineEntryTone } from "./timeline-kinds";
import { describeActivityEntry } from "./activity-naming";
import {
  GRANT_EFFECT_LABEL,
  entityLinkForEntry,
  formatElapsedBetween,
  grantEffect,
} from "./trace-links";
import { usePrincipalActivity, useMomentDetail } from "./ActorTimeline";
import { isPermissionDeniedError } from "./activity-error";
import { PermissionCaveatBanner } from "./PermissionCaveatBanner";
import { TraceOutputView } from "./trace-output-view";
import {
  clampListIndex,
  listboxShouldHandleKeyDown,
  stepListIndexOnKeyDown,
  useScrollListboxOption,
} from "./moment-listbox";

// Kinds the hub detail route enriches (mirrors @workbench/timeline's
// detailEnrichedKinds). Kept local so the list mock in tests need not stub it,
// and so apps/web does not take a direct @workbench/timeline dependency.
const DETAIL_ENRICHED_KINDS = new Set([
  "tool_call",
  "inference_turn",
  "workflow_run",
  "compaction",
]);

/** A quiet, single-line honest absence — no loud gold chip. */
function Absent({
  children,
  "data-testid": testid,
}: {
  children: React.ReactNode;
  "data-testid"?: string;
}) {
  return (
    <span data-testid={testid} className="text-[11.5px] italic text-text-3">
      {children}
    </span>
  );
}

/** The colored moment dot, by entry kind — mirrors the legend hues. */
function dotClass(entry: TimelineEntry): string {
  if (entry.kind === "tool_call") return "bg-green";
  if (entry.kind === "workflow_run") return "bg-blue-deep";
  if (entry.kind === "compaction") return "bg-text-3";
  if (entry.kind === "artifact" || entry.kind === "artifact_version") {
    return "bg-accent";
  }
  return "bg-blue";
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
  tenantId,
  principalId,
}: {
  entry: TimelineEntry;
  /** The chronologically-previous (older) moment, for the elapsed gap. */
  previous: TimelineEntry | undefined;
  tenantId: string;
  principalId: string;
}) {
  const { headline, detail } = describeActivityEntry(entry);
  const meta = KIND_META[entry.kind];
  const link = entityLinkForEntry(entry);
  const elapsed = formatElapsedBetween(previous?.timestamp, entry.timestamp);
  const effect = grantEffect(entry);

  const detailQuery = useMomentDetail(
    tenantId,
    principalId,
    { kind: entry.kind, id: entry.id },
    { enabled: DETAIL_ENRICHED_KINDS.has(entry.kind) },
  );
  const moment: MomentDetail | undefined = detailQuery.data;
  const detailLoading =
    detailQuery.isLoading && detailQuery.fetchStatus !== "idle";

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
        {entry.kind === "tool_call" && moment?.toolCall?.isError === true && (
          <Badge tone="danger" data-testid="moment-tool-errored">
            Errored
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
            {detailLoading && moment === undefined ? (
              <Absent>Loading…</Absent>
            ) : moment?.toolCall?.input !== undefined &&
              moment.toolCall.input !== null ? (
              <TraceOutputView
                value={moment.toolCall.input}
                testId="moment-tool-input"
              />
            ) : (
              <Absent data-testid="moment-input-empty">
                No input recorded for this call
              </Absent>
            )}
          </DecompRow>
          <DecompRow label="Output">
            {detailLoading && moment === undefined ? (
              <Absent>Loading…</Absent>
            ) : moment?.toolCall?.output !== undefined &&
              moment.toolCall.output !== null ? (
              <TraceOutputView
                value={moment.toolCall.output}
                testId="moment-tool-output"
              />
            ) : (
              <Absent data-testid="moment-output-empty">
                No output recorded for this call
              </Absent>
            )}
          </DecompRow>
          <DecompRow label="Records touched">
            <Absent data-testid="moment-records-gap">—</Absent>
          </DecompRow>
        </>
      )}

      {entry.kind === "inference_turn" && (
        <>
          {detailLoading && moment?.turn === undefined && (
            <DecompRow label="Turn">
              <Absent>Loading…</Absent>
            </DecompRow>
          )}
          {moment?.turn !== undefined && moment.turn.model !== null && (
            <DecompRow label="Model">
              <span
                data-testid="moment-turn-model"
                className="font-mono text-[11.5px] text-text-2"
              >
                {moment.turn.model}
              </span>
            </DecompRow>
          )}
          {moment?.turn !== undefined && moment.turn.durationMs !== null && (
            <DecompRow label="Duration">
              <span
                data-testid="moment-duration"
                className="font-mono text-[11.5px] text-text-2"
              >
                {formatDuration(moment.turn.durationMs)}
              </span>
            </DecompRow>
          )}
          {moment?.turn !== undefined && moment.turn.parts.length > 0 && (
            <DecompRow label="Parts">
              <span
                data-testid="moment-turn-parts"
                className="text-[11.5px] text-text-2"
              >
                {moment.turn.parts.map((p) => p.type).join(", ")}
              </span>
            </DecompRow>
          )}
          {moment?.turn !== undefined &&
            moment.turn.parts.some(
              (p) =>
                p.type === "tool" && p.toolName !== null && p.toolName !== "",
            ) && (
              <DecompRow label="Tool calls">
                <span
                  data-testid="moment-turn-tool-calls"
                  className="text-[11.5px] text-text-2"
                >
                  {moment.turn.parts
                    .filter(
                      (p) =>
                        p.type === "tool" &&
                        p.toolName !== null &&
                        p.toolName !== "",
                    )
                    .map((p) => p.toolName)
                    .join(", ")}
                </span>
              </DecompRow>
            )}
          {moment?.turn !== undefined && (
            <DecompRow label="Input">
              {moment.turn.input !== undefined ? (
                <div
                  className="flex flex-col gap-2"
                  data-testid="moment-turn-input"
                >
                  {moment.turn.input.map((message, i) => (
                    <div key={i} className="flex flex-col gap-0.5">
                      <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-text-3">
                        {message.kind === "tool_result"
                          ? "tool result"
                          : message.role}
                      </span>
                      <TraceOutputView
                        value={message.text}
                        testId={`moment-turn-input-${i}`}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <Absent data-testid="moment-turn-input-gap">
                  {moment.turn.inputGap ?? "Input is not available."}
                </Absent>
              )}
            </DecompRow>
          )}
          {moment?.turn !== undefined &&
            moment.turn.parts.some(
              (p) => p.content !== null && p.content !== "",
            ) && (
              <DecompRow label="Output">
                <div
                  className="flex flex-col gap-2"
                  data-testid="moment-turn-output"
                >
                  {moment.turn.parts
                    .map((p, i) => ({ part: p, i }))
                    .filter(
                      ({ part }) =>
                        part.content !== null && part.content !== "",
                    )
                    .map(({ part, i }) => (
                      <div key={i} className="flex flex-col gap-0.5">
                        <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-text-3">
                          {part.type}
                        </span>
                        <TraceOutputView
                          value={part.content}
                          testId={`moment-turn-output-${i}`}
                        />
                      </div>
                    ))}
                </div>
              </DecompRow>
            )}
        </>
      )}

      {entry.kind === "workflow_run" && moment?.run !== undefined && (
        <>
          {moment.run.durationMs !== null && (
            <DecompRow label="Duration">
              <span
                data-testid="moment-duration"
                className="font-mono text-[11.5px] text-text-2"
              >
                {formatDuration(moment.run.durationMs)}
              </span>
            </DecompRow>
          )}
          {moment.run.outcome !== null && (
            <DecompRow label="Outcome">
              <span className="font-mono text-[11.5px] text-text-2">
                {moment.run.outcome}
              </span>
            </DecompRow>
          )}
        </>
      )}

      {entry.kind === "compaction" && (
        <>
          {detailLoading && moment?.compaction === undefined && (
            <DecompRow label="Compaction">
              <Absent>Loading…</Absent>
            </DecompRow>
          )}
          {moment?.compaction !== undefined && (
            <>
              <DecompRow label="Turns">
                <span
                  data-testid="moment-compaction-turns"
                  className="font-mono text-[11.5px] text-text-2"
                >
                  {moment.compaction.turnsIn ?? "?"} →{" "}
                  {moment.compaction.turnsOut ?? "?"}
                </span>
              </DecompRow>
              {(moment.compaction.kept !== null ||
                moment.compaction.dropped !== null ||
                moment.compaction.summarized !== null) && (
                <DecompRow label="Decisions">
                  <span
                    data-testid="moment-compaction-decisions"
                    className="font-mono text-[11.5px] text-text-2"
                  >
                    {[
                      moment.compaction.kept !== null
                        ? `${moment.compaction.kept} kept`
                        : null,
                      moment.compaction.dropped !== null
                        ? `${moment.compaction.dropped} dropped`
                        : null,
                      moment.compaction.summarized !== null
                        ? `${moment.compaction.summarized} summarized`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </DecompRow>
              )}
              {moment.compaction.reason !== null && (
                <DecompRow label="Reason">
                  <span
                    data-testid="moment-compaction-reason"
                    className="font-mono text-[11.5px] text-text-2"
                  >
                    {moment.compaction.reason}
                  </span>
                </DecompRow>
              )}
              {moment.compaction.summaryChars !== null && (
                <DecompRow label="Summary size">
                  <span
                    data-testid="moment-compaction-summary-chars"
                    className="font-mono text-[11.5px] text-text-2"
                  >
                    {moment.compaction.summaryChars.toLocaleString()} chars
                  </span>
                </DecompRow>
              )}
              {moment.compaction.tokens !== null && (
                <DecompRow label="Tokens">
                  <span
                    data-testid="moment-compaction-tokens"
                    className="font-mono text-[11.5px] text-text-2"
                  >
                    {moment.compaction.tokens.toLocaleString()}
                  </span>
                </DecompRow>
              )}
            </>
          )}
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
          {formatFullTimestamp(entry.timestamp)}
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

      {link !== null && (
        <div className="col-span-2">
          <Link
            to={link.to}
            className="inline-flex w-fit items-center gap-1 rounded-[8px] border border-border px-2.5 py-1.5 text-[12px] font-medium text-accent outline-none transition-colors hover:bg-row-hover focus-visible:ring-1 focus-visible:ring-accent"
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

  const clampedSelected = clampListIndex(selected, entries.length);

  useScrollListboxOption(listRef, "moment-", clampedSelected);

  function onKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    if (!listboxShouldHandleKeyDown(event)) return;
    const next = stepListIndexOnKeyDown(event, clampedSelected, entries.length);
    if (next !== null) setSelected(next);
  }

  if (activityQuery.isLoading) return <WalkerSkeleton />;

  if (activityQuery.isError) {
    if (isPermissionDeniedError(activityQuery.error)) {
      return (
        <div
          data-testid="moment-walker-forbidden"
          className="flex flex-col items-start gap-2 rounded-[12px] border border-border bg-surface p-4"
        >
          <span className="flex items-start gap-1.5 text-[13px] text-text-2">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0 text-text-3" />
            <span>
              You don&rsquo;t have permission to view this person&rsquo;s
              activity.
            </span>
          </span>
        </div>
      );
    }
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

      <PermissionCaveatBanner entries={entries} />

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
              className={`rounded border bg-surface shadow-[var(--shadow-card)] transition-colors ${
                isSelected ? "border-accent" : "border-border"
              }`}
            >
              <div
                id={`moment-${index}`}
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  setSelected(index);
                  listRef.current?.focus();
                }}
                className={`flex cursor-pointer items-center gap-3 px-3.5 py-3 outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                  !isSelected ? "hover:bg-row-hover" : ""
                }`}
              >
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
                  title={formatFullTimestamp(entry.timestamp)}
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
                    tenantId={tenantId}
                    principalId={principalId}
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
