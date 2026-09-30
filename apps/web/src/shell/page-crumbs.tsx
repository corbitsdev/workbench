// A full-page view opened from a workbench carries `?from=<workbench id>`,
// so the trail back survives reload and share. Without it the page is just
// its own trail.

import { useQuery } from "@tanstack/react-query";
import { Fragment, useSyncExternalStore } from "react";

import { listWorkbenches } from "@/chat/workbench-tenants";
import { useBench } from "../bench-context";
import { ArrowLeft, Hash } from "../lib/icons";
import { Link } from "../navigation";
import { tenantKeys } from "../query-client";
import { getPath, subscribeToPath } from "../router-store";
import { workbenchPath } from "../workbench-path";

const FROM_PARAM = "from";

/** `path` with the originating workbench appended, for any link that opens a
 * full-page view from a workbench. */
export function benchLink(path: string, benchId: string | null): string {
  if (benchId === null) return path;
  const url = new URL(path, window.location.origin);
  url.searchParams.set(FROM_PARAM, benchId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export type PageCrumb = {
  readonly label: string;
  readonly href?: string;
  /** A workbench crumb carries the `#` mark. */
  readonly hash?: true;
};

const ROOT_CRUMB: PageCrumb = { label: "Workbench" };

/** The workbench tenant id named by `?from=`, or null. Full-page views scope
 * their data to it instead of the last-opened workbench. */
export function useFromBench(): string | null {
  // The path store re-renders this on navigation; it keeps the pathname
  // only, so the query string is read fresh.
  useSyncExternalStore(subscribeToPath, getPath);
  const id = new URLSearchParams(window.location.search).get(FROM_PARAM);
  return id === null || id === "" ? null : id;
}

function useFromWorkbench(): { readonly id: string; readonly name: string | null } | null {
  const id = useFromBench();
  const { selectedTenantId } = useBench();
  const tenantId = selectedTenantId ?? "";
  const workbenches = useQuery({
    queryKey: tenantKeys.workbenches(tenantId),
    enabled: id !== null && selectedTenantId !== null,
    queryFn: () => listWorkbenches(tenantId),
  });
  if (id === null) return null;
  return { id, name: workbenches.data?.find((w) => w.id === id)?.title ?? null };
}

/** The page's crumbs, prefixed with the originating workbench when the URL
 * names one; `back` is the arrow's target. Until the name resolves the page
 * shows its own trail. */
export function usePageCrumbs(crumbs: readonly PageCrumb[]): {
  readonly crumbs: readonly PageCrumb[];
  readonly back: { readonly href: string; readonly name: string } | null;
} {
  const from = useFromWorkbench();
  const fromId = useFromBench();
  // The root crumb is always "Workbench"; `?from=` adds the bench itself.
  if (fromId === null || from === null || from.name === null) {
    return { crumbs: [ROOT_CRUMB, ...crumbs], back: null };
  }
  const href = workbenchPath(from.id);
  return {
    crumbs: [
      ROOT_CRUMB,
      { label: from.name, href, hash: true },
      ...crumbs.map((crumb) =>
        crumb.href === undefined ? crumb : { ...crumb, href: benchLink(crumb.href, from.id) },
      ),
    ],
    back: { href, name: from.name },
  };
}

export function PageBack({ href, name }: { readonly href: string; readonly name: string }) {
  return (
    <Link to={href} className="stage-crumb-back" aria-label={`Back to ${name}`}>
      <ArrowLeft size={16} aria-hidden="true" />
    </Link>
  );
}

export function PageCrumbs({ crumbs: pageCrumbs }: { readonly crumbs: readonly PageCrumb[] }) {
  const { crumbs, back } = usePageCrumbs(pageCrumbs);
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
          {crumb.hash === true ? <Hash size={13} aria-hidden="true" /> : null}
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
      {back !== null ? <PageBack {...back} /> : null}
      {trail}
    </nav>
  );
}
