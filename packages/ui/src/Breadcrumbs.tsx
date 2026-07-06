import { Fragment, type ReactNode } from "react";

export interface BreadcrumbItem {
  label: string;
  /** Destination for this crumb. When set (and not the last crumb) it renders
   * as a link via `renderLink`; the last crumb always renders as plain text. */
  to?: string;
}

export interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  /** Router-agnostic link renderer (e.g. react-router `Link`). `@workbench/ui`
   * carries no router dependency, so the host supplies how a crumb links. When
   * omitted, every crumb renders as plain text. */
  renderLink?: (to: string, label: string) => ReactNode;
}

/**
 * Back-navigation trail for a detail page (`Admin › Definitions › <name>`). The
 * last crumb is the current page (plain text); earlier crumbs with a `to` link
 * back via the host-supplied `renderLink`.
 */
export function Breadcrumbs({ items, renderLink }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-sm text-text-2">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          const linkable = !isLast && item.to && renderLink;
          return (
            <Fragment key={`${item.label}-${index}`}>
              <li>
                {linkable ? (
                  <span className="text-orange hover:underline">
                    {renderLink(item.to as string, item.label)}
                  </span>
                ) : (
                  <span className={isLast ? "text-text" : undefined}>
                    {item.label}
                  </span>
                )}
              </li>
              {!isLast && (
                <li aria-hidden className="text-text-3">
                  ›
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
