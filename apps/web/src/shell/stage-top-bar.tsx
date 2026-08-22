// Every stage surface renders the same top bar, and every one of them
// titles itself with a breadcrumb trail: `crumbs` is the single way a page
// declares where it sits, and `actions` is the single home for its primary
// controls (a page never keeps a "New …" button in its body). A one-level
// page passes one crumb; a detail view passes its parent plus itself.
//
// Crumbs are routes, not callbacks: every level above the current page
// carries an `href`, so the trail is deep-linkable and a plain click
// navigates through the app's own `Link` instead of reloading the shell.
//
// `filter` is a page's own per-page filter (DECISIONS.md → Search), rendered
// through `StageSearch` ahead of `actions` when a page passes one. It is not
// shell chrome the way it used to be: a page with nothing to filter passes
// none and gets no magnifier at all. The global command palette (`Cmd+K`)
// is a separate surface entirely — see `command-palette-provider.tsx` —
// mounted on its own rather than out of this bar.
//
// `@corbits/react-ui`'s `TopBarBreadcrumbs` renders bare `<a href>`, which
// would drop the SPA out from under the click, so the trail lives here
// until react-ui takes a link-render slot.

import { Fragment, type ReactNode } from "react";

import { Link } from "../navigation";
import { Chip, type ChipTone } from "./chip";
import { StageSearch, type StageSearchProps } from "./stage-search";

export type StageCrumb = {
  readonly label: string;
  /** The route this crumb links to. Omitted on the last crumb — the
   * current page is the title, never a link. */
  readonly href?: string;
};

export function StageTopBar({
  crumbs,
  subtitle,
  chip,
  filter,
  actions,
}: {
  /** The page's title trail: parents first, the page itself last. */
  readonly crumbs: readonly StageCrumb[];
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
      <div className="stage-top-bar-title">
        <StageCrumbTrail crumbs={crumbs} />
      </div>
      {hasSubtitle ? (
        <>
          <span className="stage-top-bar-dot" aria-hidden="true" />
          <div className="stage-top-bar-sub">{subtitle}</div>
        </>
      ) : null}
      <div
        className="stage-top-bar-actions"
        data-testid="stage-top-bar-actions"
      >
        {filter !== undefined ? <StageSearch {...filter} /> : null}
        {chip !== undefined ? <Chip tone={chip.tone}>{chip.label}</Chip> : null}
        {actions}
      </div>
    </header>
  );
}

function StageCrumbTrail({
  crumbs,
}: {
  readonly crumbs: readonly StageCrumb[];
}) {
  const lastIndex = crumbs.length - 1;
  const trail = crumbs.map((crumb, index) => (
    <Fragment key={`${String(index)}-${crumb.label}`}>
      {index > 0 ? (
        <span className="stage-crumbs-sep" aria-hidden="true">
          /
        </span>
      ) : null}
      {index === lastIndex ? (
        <span className="stage-crumb-current" aria-current="page">
          {crumb.label}
        </span>
      ) : crumb.href === undefined ? (
        <span className="stage-crumb-label">{crumb.label}</span>
      ) : (
        <Link to={crumb.href} className="stage-crumb-link">
          {crumb.label}
        </Link>
      )}
    </Fragment>
  ));

  // A one-level page has nowhere to go up to — a Breadcrumb landmark around
  // a bare page title is noise, so the landmark appears only for a real
  // trail.
  if (lastIndex === 0) {
    return <div className="stage-crumbs">{trail}</div>;
  }
  return (
    <nav className="stage-crumbs" aria-label="Breadcrumb">
      {trail}
    </nav>
  );
}
