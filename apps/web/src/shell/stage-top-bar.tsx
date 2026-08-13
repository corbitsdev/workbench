// Every stage surface renders the same top bar: title · dot · subtitle,
// then right-aligned per-page actions. Breadcrumb trails (channel / thread /
// run) render in the title slot via StageCrumbs so back affordances stay
// top-left. Col2's collapse control lives on col2 itself (see
// contextual-panel.tsx) — this bar carries no toggle of its own.

import { Fragment, type ReactNode } from "react";

export function StageTopBar({
  title,
  subtitle,
  actions,
}: {
  /** Plain text or a StageCrumbs trail. */
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
}) {
  const hasSubtitle = subtitle !== undefined && subtitle !== null;
  return (
    <header className="stage-top-bar" data-testid="stage-top-bar">
      <div className="stage-top-bar-title">{title}</div>
      {hasSubtitle ? (
        <>
          <span className="stage-top-bar-dot" aria-hidden="true" />
          <div className="stage-top-bar-sub">{subtitle}</div>
        </>
      ) : null}
      <div className="stage-top-bar-actions">{actions}</div>
    </header>
  );
}

export type StageCrumb = {
  readonly label: string;
  /** Present on every crumb except the current (last) one. */
  readonly onSelect?: () => void;
};

export function StageCrumbs({
  crumbs,
}: {
  readonly crumbs: readonly StageCrumb[];
}) {
  return (
    <nav className="stage-crumbs" aria-label="Breadcrumb">
      {crumbs.map((crumb, index) => (
        <Fragment key={`${String(index)}-${crumb.label}`}>
          {index > 0 ? (
            <span className="stage-crumbs-sep" aria-hidden="true">
              /
            </span>
          ) : null}
          {crumb.onSelect !== undefined ? (
            <button type="button" onClick={crumb.onSelect}>
              {crumb.label}
            </button>
          ) : (
            <span aria-current="page">{crumb.label}</span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
