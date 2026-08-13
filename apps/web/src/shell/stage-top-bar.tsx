// Every stage surface renders the same top bar: the single col2 collapse
// control on the left, then title · dot · subtitle, then right-aligned
// per-page actions. Breadcrumb trails (channel / thread / run) render in
// the title slot via StageCrumbs so back affordances stay top-left. The
// shell owns the collapsed state (see stage-chrome.tsx); pages only mount
// the bar.

import { Button } from "@corbits/react-ui";
import { PanelLeft } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { COL2_ID, useRegisteredToggle } from "./stage-chrome";

/** The one collapse control for col2 — no per-column chevrons anywhere.
 * Registers itself with the shell so the fallback control stays hidden
 * while any top bar (or the chat header) carries it. */
export function StageTopBarToggle() {
  const { col2Collapsed, toggleCol2 } = useRegisteredToggle();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="stage-top-bar-toggle"
      aria-label="Toggle sidebar"
      title="Toggle sidebar"
      aria-expanded={!col2Collapsed}
      aria-controls={COL2_ID}
      onClick={toggleCol2}
    >
      <PanelLeft />
    </Button>
  );
}

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
      <StageTopBarToggle />
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
