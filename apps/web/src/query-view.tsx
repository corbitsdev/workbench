// Shared rendering for the three non-data outcomes of a hub query, so every
// page says "loading", "no session" and "failed" the same way and none of
// them invents placeholder content.

import { Button, EmptyState, Skeleton } from "@corbits/react-ui";
import { CircleAlert, Lock } from "lucide-react";
import type { ReactNode } from "react";

import type { APIQuery } from "./api";

/** Which shape a loading `QueryView` should hint at, close enough to the
 * real content's footprint to keep layout shift small — not a skeleton
 * framework, just the handful of shapes this app's surfaces actually need.
 * `"block"` (the default) is the old one-size fixed placeholder, kept for
 * surfaces that are neither a list nor a single record. */
export type QuerySkeletonVariant = "block" | "rows" | "detail";

/** A handful of list-row placeholders, sized near a real row. */
export function ListSkeleton() {
  return (
    <div className="query-skeleton-rows" aria-hidden>
      <Skeleton className="query-skeleton-row" />
      <Skeleton className="query-skeleton-row" />
      <Skeleton className="query-skeleton-row" />
      <Skeleton className="query-skeleton-row" />
    </div>
  );
}

/** A single record's shape: a heading-width block over a few body lines. */
export function DetailSkeleton() {
  return (
    <div className="query-skeleton-detail" aria-hidden>
      <Skeleton className="query-skeleton-detail-header" />
      <Skeleton className="query-skeleton-detail-line" />
      <Skeleton className="query-skeleton-detail-line" />
      <Skeleton className="query-skeleton-detail-line query-skeleton-detail-line--short" />
    </div>
  );
}

function QuerySkeleton({
  variant,
}: {
  readonly variant: QuerySkeletonVariant;
}) {
  switch (variant) {
    case "rows":
      return <ListSkeleton />;
    case "detail":
      return <DetailSkeleton />;
    case "block":
      return <Skeleton className="query-skeleton" />;
  }
}

export function SignedOutNotice() {
  return (
    <EmptyState
      icon={<Lock />}
      title="Sign in required"
      description="Your session has ended. Reload the page to sign in again."
      action={
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    />
  );
}

export function QueryView<T>({
  query,
  label,
  skeleton = "block",
  children,
}: {
  readonly query: APIQuery<T>;
  /** What is being loaded, named in the failure message: "your benches". */
  readonly label: string;
  /** The loading placeholder's shape — pick the one nearest this surface's
   * real content so it doesn't jump when data lands. */
  readonly skeleton?: QuerySkeletonVariant;
  readonly children: (data: T) => ReactNode;
}) {
  switch (query.kind) {
    case "loading":
      return <QuerySkeleton variant={skeleton} />;
    case "unauthenticated":
      return <SignedOutNotice />;
    case "error":
      return (
        <EmptyState
          icon={<CircleAlert />}
          title={`Couldn't load ${label}`}
          description={query.message}
          action={
            <Button variant="outline" onClick={query.retry}>
              Retry
            </Button>
          }
        />
      );
    case "ready":
      return <>{children(query.data)}</>;
  }
}
