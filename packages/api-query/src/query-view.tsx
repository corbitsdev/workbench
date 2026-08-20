// Shared rendering for the three non-data outcomes of a hub query, so every
// page says "loading", "no session" and "failed" the same way and none of
// them invents placeholder content.

import { Button, EmptyState, Skeleton } from "@corbits/react-ui";
import { Lock, WarningCircle } from "@corbits/icons";
import type { ReactNode } from "react";

import type { APIQuery } from "./envelope";
import { describeApiError } from "./envelope";

/** Which shape a loading `QueryView` should hint at, close enough to the
 * real content's footprint to keep layout shift small — not a skeleton
 * framework, just the handful of shapes host pages actually need. `"block"`
 * (the default) is a fixed placeholder for surfaces that are neither a list
 * nor a single record. */
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
  loadingContent,
  children,
}: {
  readonly query: APIQuery<T>;
  /** What is being loaded, named in the failure message: "your benches". */
  readonly label: string;
  /** The loading placeholder's shape — pick the one nearest this surface's
   * real content so it doesn't jump when data lands. Ignored when
   * `loadingContent` is set. */
  readonly skeleton?: QuerySkeletonVariant;
  /** Overrides the loading render entirely — a page-level wait (a whole
   * stage or panel's primary content, not a row hint) should pass its own
   * warm loader here rather than take the `"block"` skeleton slab, which
   * this package can't render itself: `@corbits/chat-ui`'s
   * `WorkbenchLoadingState` depends on this package, so `QueryView` can
   * never import it back without a cycle. */
  readonly loadingContent?: ReactNode;
  readonly children: (data: T) => ReactNode;
}) {
  switch (query.kind) {
    case "loading":
      return loadingContent ?? <QuerySkeleton variant={skeleton} />;
    case "unauthenticated":
      return <SignedOutNotice />;
    case "error":
      return (
        <EmptyState
          icon={<WarningCircle />}
          title={`Couldn't load ${label}`}
          description={describeApiError(
            { status: query.status },
            `loading ${label}`,
          )}
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
