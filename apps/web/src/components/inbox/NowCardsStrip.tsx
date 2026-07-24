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
 * Selection is shared with the queue / detail drawer for mail ids.
 */
export function NowCardsStrip({
  cards,
  ready,
  selectedMailId,
  selectedTaskId,
}: NowCardsStripProps) {
  const features = useMeFeatures();
  const schedulerEnabled = isFeatureEnabled(features.data, "scheduler");

  if (!ready) {
    return (
      <div className="shrink-0 border-b border-border bg-surface/80 px-4 py-3">
        <p className="text-xs text-text-3" role="status">
          Loading what needs you…
        </p>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="shrink-0 border-b border-border bg-surface/80 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange">
          Now
        </p>
        <p className="mt-1 text-sm font-medium text-text">
          You&apos;re all caught up
        </p>
        <p className="mt-0.5 max-w-xl text-xs text-text-3">
          {schedulerEnabled
            ? "Your morning brief, workflow approvals, task updates, and mail from your agents will land here as they arrive."
            : "Workflow approvals, task updates, and mail from your agents will land here as they arrive."}
        </p>
        {schedulerEnabled ? (
          <Link
            to="/settings#morning-brief"
            className="mt-2 inline-flex text-xs font-medium text-orange hover:underline"
          >
            Set up your morning brief
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <section className="shrink-0 border-b border-border bg-surface px-4 py-3 md:px-5">
      <div className="mb-2.5 flex items-end justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange">
            Now
          </p>
          <p className="text-sm font-semibold tracking-tight text-text">
            {cards.length === 1
              ? "1 thing needs you"
              : `${cards.length} things need you`}
          </p>
        </div>
        <p className="hidden text-xs text-text-3 sm:block">
          Biggest decisions · queue below has the rest
        </p>
      </div>

      <ul
        aria-label="Now"
        className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3"
      >
        {cards.map((card, index) => {
          const href = cardHref(card);
          const selected = isSelected(card, selectedMailId, selectedTaskId);
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
    </section>
  );
}
