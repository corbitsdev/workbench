import { useState } from "react";
import { Activity, ChevronDown } from "lucide-react";
import { TenantActivityFeed } from "./TenantActivityFeed";

// Progressive loading (CL-2753). The tenant-wide activity feed is the heaviest
// Insights query — a per-row UNION across interchange-owned tables we cannot
// index — and greybeard flagged it running on EVERY Insights open. The landing
// page loads only the cheap aggregate analytics (charts/KPIs/cost from
// workbench-owned rollup + fact tables); this section defers the union feed
// behind an explicit disclosure so it fetches only when a member opens it, not
// on every mount. Mounting `TenantActivityFeed` is what fires the query, so we
// gate the mount rather than the `enabled` flag alone — before reveal there is
// no hook, no request, no work.
export function DeferredActivitySection({ tenantId }: { tenantId: string }) {
  const [revealed, setRevealed] = useState(false);

  if (revealed) {
    return <TenantActivityFeed tenantId={tenantId} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">
          Activity across your workbench
        </h2>
        <p className="text-[12px] text-text-3">
          Everyone&rsquo;s agents, workflows, and runs — newest first. Loaded on
          demand.
        </p>
      </div>
      <button
        type="button"
        data-testid="reveal-tenant-activity"
        onClick={() => setRevealed(true)}
        className="flex items-center justify-center gap-2 rounded-[12px] border border-dashed border-border bg-surface px-4 py-5 text-[13px] font-medium text-text-2 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.99]"
      >
        <Activity className="h-4 w-4 shrink-0 text-text-3" />
        Show activity feed
        <ChevronDown className="h-4 w-4 shrink-0 text-text-3" />
      </button>
    </div>
  );
}
