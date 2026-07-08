import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router";
import { PagePanel, Skeleton } from "@workbench/ui";
import { getMe } from "../../lib/hub-api";
import { tabButtonClass } from "./admin-ui";

// Owner-area tabs. Feature tabs (Workflows, Models, Credentials, Setup,
// Templates) append their entry here as they land; Overview is the landing.
const SUB_NAV = [
  { to: "/owner", label: "Overview", end: true },
  { to: "/owner/setup", label: "Setup", end: false },
  { to: "/owner/templates", label: "Templates", end: false },
  { to: "/owner/workflows", label: "Workflows", end: false },
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
      <div
        className={`flex flex-col border-b border-border px-6 pt-5${
          SUB_NAV.length > 1 ? "" : " pb-4"
        }`}
      >
        <h1 className="text-lg font-semibold text-text">Owner</h1>
        <p className="mt-0.5 text-sm text-text-2">
          Underlying setup, features, models, and credentials for this
          workbench.
        </p>
        {SUB_NAV.length > 1 && (
          <nav className="mt-4 flex gap-1" aria-label="Owner sections">
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
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <Outlet />
      </div>
    </PagePanel>
  );
}
