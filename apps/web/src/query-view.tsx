// Shared rendering for the three non-data outcomes of a hub query, so every
// page says "loading", "no session" and "failed" the same way and none of
// them invents placeholder content.

import { EmptyState, Skeleton } from "@corbits/react-ui";
import { CircleAlert, Lock } from "lucide-react";
import type { ReactNode } from "react";

import type { APIQuery } from "./api";

export function SignedOutNotice() {
  return (
    <EmptyState
      icon={<Lock />}
      title="Sign in required"
      description="Your session has ended. Reload the page to sign in again."
    />
  );
}

export function QueryView<T>({
  query,
  label,
  children,
}: {
  readonly query: APIQuery<T>;
  /** What is being loaded, named in the failure message: "your workspaces". */
  readonly label: string;
  readonly children: (data: T) => ReactNode;
}) {
  switch (query.kind) {
    case "loading":
      return <Skeleton className="query-skeleton" />;
    case "unauthenticated":
      return <SignedOutNotice />;
    case "error":
      return (
        <EmptyState
          icon={<CircleAlert />}
          title={`Couldn't load ${label}`}
          description={query.message}
        />
      );
    case "ready":
      return <>{children(query.data)}</>;
  }
}
