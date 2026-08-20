// Every stage surface renders the same top bar: title · dot · subtitle,
// then right-aligned per-page actions. Breadcrumb trails (workbench / thread /
// run) render in the title slot via StageCrumbs so back affordances stay
// top-left. The sidebar is always present — this bar carries no sidebar
// toggle of any kind.

import { Button } from "@corbits/react-ui";
import { Fragment, type ReactNode } from "react";

import { Chip, type ChipTone } from "./chip";

export function StageTopBar({
  title,
  subtitle,
  chip,
  actions,
}: {
  /** Plain text or a StageCrumbs trail. */
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  /** A quiet status pill (mock's `.chip[data-tone]`), rendered first among
   * the right-aligned actions — ambient state, not a button. */
  readonly chip?: { readonly tone: ChipTone; readonly label: ReactNode };
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
      <div className="stage-top-bar-actions">
        {chip !== undefined ? <Chip tone={chip.tone}>{chip.label}</Chip> : null}
        {actions}
      </div>
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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto p-0"
              onClick={crumb.onSelect}
            >
              {crumb.label}
            </Button>
          ) : (
            <span aria-current="page">{crumb.label}</span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
