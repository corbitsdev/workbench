import { Link } from "react-router";
import { cn } from "@workbench/ui";
import {
  deepLinkPath,
  focusKindLabel,
  resolveTaskLinkHref,
  type FocusCard,
} from "@workbench/shared";
import { isFeatureEnabled, useMeFeatures } from "../../hooks/use-me-features";
import { formatRelativeTime } from "../../lib/relative-time";

interface NowCardsStripProps {
  cards: FocusCard[];
  ready: boolean;
  selectedMailId: string | null;
  selectedTaskId: string | null;
  /** When a message is open, tuck the card grid into a thin summary row. */
  collapsed?: boolean;
  reduceMotion?: boolean;
}

function cardHref(card: FocusCard): string | null {
  if (card.type === "gate") {
    return deepLinkPath("workflow_run", card.run.runId);
  }
  if (card.type === "mail") {
    return `/inbox/${card.message.id}`;
  }
  if (card.type === "task") {
    const primary = card.task.links
      .map((link) => resolveTaskLinkHref(link))
      .find((href): href is string => href !== null);
    // Fall back to inbox deep-link so the card always navigates and the
    // missing-task notice / scroll target can resolve honestly.
    return primary ?? `/inbox?task=${encodeURIComponent(card.task.id)}`;
  }
  return null;
}

function isSelected(
  card: FocusCard,
  selectedMailId: string | null,
  selectedTaskId: string | null,
): boolean {
  if (card.type === "mail") return card.id === selectedMailId;
  if (card.type === "task") return card.id === selectedTaskId;
  return false;
}

/**
 * Dia-style Now strip: ≤3 highest-attention cards above the command queue.
 * Empty state is a single compact row. When a message is open (`collapsed`),
 * the card grid tucks away so the detail pane can claim vertical space.
 */
export function NowCardsStrip({
  cards,
  ready,
  selectedMailId,
  selectedTaskId,
  collapsed = false,
  reduceMotion = false,
}: NowCardsStripProps) {
  const features = useMeFeatures();
  const schedulerEnabled = isFeatureEnabled(features.data, "scheduler");
  // Transition the properties that actually change (grid-template-rows via
  // grid-rows utilities, opacity, padding). Brand ease from --ease.
  const motionClass = reduceMotion
    ? "transition-none"
    : "transition-[grid-template-rows,opacity,padding] duration-300 ease-[var(--ease)]";

  if (!ready) {
    return (
      <div className="shrink-0 border-b border-border bg-surface/80 px-4 py-2">
        <p className="text-xs text-text-3" role="status">
          Loading what needs you…
        </p>
      </div>
    );
  }

  // Empty: one compact row. Short status so the queue empty state owns
  // the longer “caught up” voice without doubling it here.
  if (cards.length === 0) {
    return (
      <div className="shrink-0 border-b border-border bg-surface/80 px-4 py-2">
        <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className="font-semibold uppercase tracking-[0.14em] text-orange">
            Now
          </span>
          <span className="text-text-3" aria-hidden="true">
            ·
          </span>
          <span className="font-medium text-text">Clear</span>
          {schedulerEnabled ? (
            <Link
              to="/settings#morning-brief"
              className="ml-auto min-h-8 inline-flex items-center font-medium text-orange hover:underline"
            >
              Set up morning brief
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  const countLabel =
    cards.length === 1
      ? "1 thing needs you"
      : `${cards.length} things need you`;

  return (
    <section
      className={cn(
        "shrink-0 border-b border-border bg-surface px-4 md:px-5",
        collapsed ? "py-2" : "py-3",
        motionClass,
      )}
    >
      {collapsed ? (
        <div className="flex min-h-8 items-center gap-x-2 text-xs">
          <span className="font-semibold uppercase tracking-[0.14em] text-orange">
            Now
          </span>
          <span className="text-text-3" aria-hidden="true">
            ·
          </span>
          <span className="truncate font-medium text-text-3">{countLabel}</span>
        </div>
      ) : (
        <div className="mb-2.5 flex items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange">
              Now
            </p>
            <p className="text-sm font-semibold tracking-tight text-text">
              {countLabel}
            </p>
          </div>
          <p className="hidden shrink-0 text-xs text-text-3 sm:block">
            Biggest decisions · queue below has the rest
          </p>
        </div>
      )}

      <div
        className={cn(
          "grid",
          motionClass,
          collapsed
            ? "grid-rows-[0fr] opacity-0"
            : "grid-rows-[1fr] opacity-100",
        )}
        // Keep DOM for collapse animation + task anchors; inert removes
        // focus/hit-testing while tucked (stronger than aria-hidden alone).
        aria-hidden={collapsed}
        // React 19: boolean `inert` maps to the HTML attribute.
        {...(collapsed ? { inert: true as const } : {})}
      >
        <div className="min-h-0 overflow-hidden">
          <ul
            aria-label="Now"
            className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3"
          >
            {cards.map((card, index) => {
              const href = cardHref(card);
              const selected = isSelected(
                card,
                selectedMailId,
                selectedTaskId,
              );
              const body = (
                <>
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-orange/15 text-xs font-bold text-orange">
                      {index + 1}
                    </span>
                    <span className="text-xs font-semibold uppercase tracking-wide text-text-3">
                      {focusKindLabel(card.kind)}
                    </span>
                    <span className="ml-auto text-xs text-text-3">
                      {formatRelativeTime(card.when)}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm font-semibold leading-snug text-text">
                    {card.title}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-3">
                    {card.summary}
                  </p>
                  {href ? (
                    <p className="mt-2.5 text-xs font-medium text-orange">
                      {card.primaryAction} →
                    </p>
                  ) : null}
                </>
              );

              const shellClass = cn(
                "block h-full w-full rounded-xl border p-3.5 text-left shadow-[var(--shadow-card)] transition-[box-shadow,border-color,background-color]",
                selected
                  ? "border-orange/45 bg-sel/40"
                  : "border-border/80 bg-surface/95 hover:border-border",
              );

              return (
                <li
                  key={`${card.type}:${card.id}`}
                  id={card.type === "task" ? `task-${card.id}` : undefined}
                >
                  {href ? (
                    <Link
                      to={href}
                      aria-current={selected ? "true" : undefined}
                      className={shellClass}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div
                      aria-current={selected ? "true" : undefined}
                      className={shellClass}
                    >
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
