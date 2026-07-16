import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router";
import { AppPageChromeRow, PagePanel, Skeleton } from "@workbench/ui";
import { useSetPageChrome } from "../../lib/page-chrome";
import { getMe } from "../../lib/hub-api";
import { tabButtonClass } from "./admin-ui";

// Owner-area tabs. Catalog is the landing (/owner redirects to it): inference
// providers, their models, and credentials. Capabilities holds tool/integration
// providers. Workflows enables/disables per workbench.
const SUB_NAV = [
  { to: "/settings/owner/catalog", label: "Catalog", end: false },
  { to: "/settings/owner/capabilities", label: "Capabilities", end: false },
  { to: "/settings/owner/workflows", label: "Workflows", end: false },
  { to: "/settings/owner/demos", label: "Demos", end: false },
  { to: "/settings/owner/members", label: "Members", end: false },
] as const;

/**
 * The Owner area shell — ABK Labs staff only. Gates on the caller's `isOwner`
 * flag from `/me` (resolved server-side via Interchange's native grant model:
 * the `owner` role's `*`/`*`). Cosmetic defense-in-depth: every hub `/owner`
 * route independently re-checks the owner grant (403), so a non-owner who forces
 * the route still fails — this renders a clear no-access state instead.
 */
export function OwnerLayout() {
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });

  const isOwner = meQuery.data?.isOwner === true;
  const pageChrome = useMemo(
    () =>
      isOwner ? (
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <AppPageChromeRow
            title="Workbench management"
            titleSize="sm"
            className="[&_h1]:text-lg"
          />
          {SUB_NAV.length > 1 && (
            <nav className="flex flex-wrap gap-1" aria-label="Owner sections">
              {SUB_NAV.map(({ to, label, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) => tabButtonClass(isActive)}
                >
                  {label}
                </NavLink>
              ))}
            </nav>
          )}
        </div>
      ) : null,
    [isOwner],
  );
  useSetPageChrome(pageChrome);

  if (meQuery.isLoading) {
    return (
      <PagePanel>
        <div className="space-y-3 p-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </PagePanel>
    );
  }

  if (meQuery.isError) {
    return (
      <PagePanel>
        <div className="p-6 text-sm text-text-2">
          Could not load your account. Check your connection and try again.
        </div>
      </PagePanel>
    );
  }

  if (!meQuery.data?.isOwner) {
    return (
      <PagePanel>
        <div className="mx-auto max-w-md p-10 text-center">
          <h1 className="text-lg font-semibold text-text">Owner only</h1>
          <p className="mt-2 text-sm text-text-2">
            You do not have permission to view the Owner area — it is reserved
            for workbench owners. Contact ABK Labs if you need owner access.
          </p>
        </div>
      </PagePanel>
    );
  }

  return (
    <PagePanel scroll={false}>
      <p className="border-b border-border px-6 py-3 text-sm text-text-2">
        Underlying setup, features, models, and credentials for this workbench.
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <Outlet />
      </div>
    </PagePanel>
  );
}
