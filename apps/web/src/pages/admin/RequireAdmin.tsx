import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { PagePanel, Skeleton } from "@workbench/ui";
import { getMe } from "../../lib/hub-api";

/**
 * Gates a full-page admin surface (e.g. the relocated Tools page) on the
 * caller's `isAdmin` flag. Cosmetic — the hub routes the page calls each
 * re-check the admin grant server-side.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
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
  if (meQuery.isError || !meQuery.data?.isAdmin) {
    return (
      <PagePanel>
        <div className="mx-auto max-w-md p-10 text-center">
          <h1 className="text-lg font-semibold text-text">Admin only</h1>
          <p className="mt-2 text-sm text-text-2">
            You do not have permission to view this page.
          </p>
        </div>
      </PagePanel>
    );
  }
  return <>{children}</>;
}
