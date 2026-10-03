// The stage's own title row: `StageSidebarToggle`, the page's title, an
// optional subtitle, then the page's own actions. The title is plain text —
// no breadcrumb trail renders app-wide (CL-9787). `PageLayout` below owns
// the page's h1, so this slot stays a `div` and the page keeps exactly one
// top-level heading.

// `filter` is per-page (DECISIONS.md -> Search), not shell chrome — a page
// with nothing to filter gets no magnifier at all.

import type { ReactNode } from "react";

import { Chip, type ChipTone } from "./chip";
import { StageSidebarToggle } from "./sidebar-toggle";
import { StageSearch, type StageSearchProps } from "./stage-search";

export function StageTopBar({
  title,
  subtitle,
  chip,
  filter,
  actions,
}: {
  /** The page's title, rendered as plain text. */
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  /** A quiet status pill (mock's `.chip[data-tone]`), rendered first among
   * the right-aligned actions — ambient state, not a button. */
  readonly chip?: { readonly tone: ChipTone; readonly label: ReactNode };
  /** This page's own filter, if it has one — rendered as the magnifier that
   * morphs into an input (`StageSearch`), driving the page's own filter
   * state directly. Omitted entirely on a page with nothing to filter. */
  readonly filter?: StageSearchProps;
  /** The primary-action slot: the buttons and inputs this page owns. */
  readonly actions?: ReactNode;
}) {
  const hasSubtitle = subtitle !== undefined && subtitle !== null;
  return (
    <header className="stage-top-bar" data-testid="stage-top-bar">
      <StageSidebarToggle />
      <div className="stage-top-bar-title">{title}</div>
      {hasSubtitle ? (
        <>
          <span className="stage-top-bar-dot" aria-hidden="true" />
          <div className="stage-top-bar-sub">{subtitle}</div>
        </>
      ) : null}
      <div className="stage-top-bar-actions" data-testid="stage-top-bar-actions">
        {filter !== undefined ? <StageSearch {...filter} /> : null}
        {chip !== undefined ? <Chip tone={chip.tone}>{chip.label}</Chip> : null}
        {actions}
      </div>
    </header>
  );
}
