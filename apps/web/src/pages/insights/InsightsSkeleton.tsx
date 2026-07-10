function SkeletonCard() {
  return (
    <div className="h-[96px] animate-pulse rounded-[12px] border border-border bg-surface-2" />
  );
}

export function InsightsSkeleton() {
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-4"
      data-testid="insights-skeleton"
    >
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}
