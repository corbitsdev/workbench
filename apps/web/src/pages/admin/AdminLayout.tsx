import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router";
import { AppPageChromeRow, PagePanel, Skeleton } from "@workbench/ui";
import { useSetPageChrome } from "../../lib/page-chrome";
import { getMe } from "../../lib/hub-api";
import { tabButtonClass } from "./admin-ui";

const SUB_NAV = [
  { to: "/settings/admin/principals", label: "Principals & Grants" },
  { to: "/settings/admin/definitions", label: "Definitions" },
  { to: "/settings/admin/audit", label: "Audit" },
  { to: "/settings/admin/tools", label: "Tools" },
] as const;

/**
 * The Admin area shell. Gates on the caller's `isAdmin` flag from `/me` (itself
 * resolved server-side via Interchange's native grant model). This is cosmetic
 * defense-in-depth: every hub admin route independently re-checks the admin
 * grant, so a non-admin who forces the route still gets a 403 payload — but we
 * render a clear no-access state rather than a wall of failed requests.
 */
export function AdminLayout() {
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });

  const isAdmin = meQuery.data?.isAdmin === true;
  const pageChrome = useMemo(
    () =>
      isAdmin ? (
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <AppPageChromeRow
            title="Users & agents"
            titleSize="sm"
            className="[&_h1]:text-lg"
          />
          <nav className="flex flex-wrap gap-1" aria-label="Admin sections">
            {SUB_NAV.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => tabButtonClass(isActive)}
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      ) : null,
    [isAdmin],
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

  if (!meQuery.data?.isAdmin) {
    return (
      <PagePanel>
        <div className="mx-auto max-w-md p-10 text-center">
          <h1 className="text-lg font-semibold text-text">Admin only</h1>
          <p className="mt-2 text-sm text-text-2">
            You do not have permission to view the Admin area. Ask an admin to
            grant you access.
          </p>
        </div>
      </PagePanel>
    );
  }

  return (
    <PagePanel scroll={false}>
      <p className="border-b border-border px-6 py-3 text-sm text-text-2">
        Manage users, agents, and their access.
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <Outlet />
      </div>
    </PagePanel>
  );
}
