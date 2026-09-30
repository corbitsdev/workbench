import type { ReactNode } from "react";

import "./page-layout.css";

export function PageLayout({
  title,
  subtitle,
  actions,
  leading,
  children,
}: {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  /** Sits before the title, e.g. a detail page's avatar. */
  readonly leading?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="page-layout">
      <div
        className={
          leading === undefined ? "page-layout-head" : "page-layout-head page-layout-head--hero"
        }
      >
        {leading}
        <div>
          <h1>{title}</h1>
          {subtitle !== undefined ? <p className="page-layout-lede">{subtitle}</p> : null}
        </div>
        {actions !== undefined && actions !== null ? (
          <div className="page-layout-actions">{actions}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
