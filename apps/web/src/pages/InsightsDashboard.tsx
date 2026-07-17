import { PagePanel } from "@workbench/ui";
import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef } from "react";
import { useSetPageChrome } from "../lib/page-chrome";

import { useInsightsOverview } from "../hooks/use-insights-overview";
import { describeHubApiFailure } from "../lib/hub-api";
import { AgentsSection } from "./insights/AgentsSection";
import { ActorActivitySection } from "./insights/ActorActivity";
import { ChartsSection } from "./insights/ChartsSection";
import { CostInsights } from "./insights/CostInsights";
import { ToolBreakdownSection } from "./insights/ToolBreakdownSection";
import { DeferredActivitySection } from "./insights/DeferredActivitySection";
import { EngagementSection } from "./insights/EngagementSection";
import { FiltersBar } from "./insights/FiltersBar";
import { InferenceSection } from "./insights/InferenceSection";
import { InsightsPageHeader } from "./insights/InsightsPageHeader";
import { InsightsSkeleton } from "./insights/InsightsSkeleton";
import { InsightsTabNav, useInsightsTab } from "./insights/InsightsTabs";
import { KpiRow } from "./insights/KpiRow";
import { OperationalLedger } from "./insights/OperationalLedger";
import { SectionLabel } from "./insights/section-label";
import { SECTION_ITEM, SECTIONS_CONTAINER } from "./insights/section-motion";
import { SortablePersonTable } from "./insights/SortablePersonTable";
import { TrendsSection } from "./insights/TrendsSection";
import { WorkflowsTab } from "./insights/WorkflowsTab";

export { resolveRange } from "./insights/time-range";
export {
  filterPeople,
  mergeWorkflowKindRows,
  type WorkflowKindRow,
} from "./insights/overview-derivations";

/**
 * /insights split into tabs (CL-3667): Overview, Usage & Cost, Workflows,
 * Agents, People — selected by the `?tab=` search param so the shared
 * range/granularity/export header (InsightsPageHeader, memoized above the
 * tab body) persists across tab switches. Each fact now appears on exactly
 * one tab; Overview carries only summary tiles that deep-link into the
 * owning tab, never the full breakdown table itself.
 */
export function InsightsDashboard() {
  const reduceMotion = useReducedMotion();
  const insights = useInsightsOverview();
  const [tab, setTab] = useInsightsTab();
  const tabBodyScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tabBodyScrollRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  const pageChrome = useMemo(
    () => (
      <InsightsPageHeader
        tenantName={insights.activeWorkbench?.tenantName}
        preset={insights.preset}
        onPresetChange={insights.setPreset}
        customRange={insights.customRange}
        onCustomRangeChange={insights.setCustomRange}
        exportBucket={insights.exportBucket}
        onExportBucketChange={insights.setExportBucket}
        canExport={insights.canExport}
        onExportCsv={insights.exportCsv}
      />
    ),
    [
      insights.activeWorkbench?.tenantName,
      insights.preset,
      insights.setPreset,
      insights.customRange,
      insights.setCustomRange,
      insights.exportBucket,
      insights.setExportBucket,
      insights.canExport,
      insights.exportCsv,
    ],
  );
  useSetPageChrome(pageChrome);

  return (
    <PagePanel scroll={false} flat fitContent>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="px-5 pt-3 max-md:px-3">
          <InsightsTabNav active={tab} onChange={setTab} />
        </div>
        <div
          ref={tabBodyScrollRef}
          role="tabpanel"
          id={`insights-panel-${tab}`}
          aria-labelledby={`insights-tab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-5 max-md:px-3"
        >
          {insights.showSummaryLoading && <InsightsSkeleton />}

          {!insights.workbenchLoading && !insights.activeTenantId && (
            <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
              Select a workbench to view analytics.
            </div>
          )}

          {insights.overviewQuery.isError && (
            <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
              {describeHubApiFailure(insights.overviewQuery.error)}
            </div>
          )}

          {insights.overview && insights.activeTenantId && (
            <motion.div
              className="flex flex-col gap-10"
              variants={SECTIONS_CONTAINER}
              initial={reduceMotion ? false : "hidden"}
              animate="show"
              key={tab}
            >
              {tab === "overview" && (
                <>
                  <motion.div variants={SECTION_ITEM}>
                    <KpiRow
                      data={insights.overview}
                      activePeople={insights.overview.byPerson.length}
                      costTotal={insights.priced?.cost.total ?? null}
                      costTokens={insights.costTokens}
                      costUnavailable={insights.costUnavailable}
                      onNavigateTab={setTab}
                    />
                  </motion.div>
                  <motion.div variants={SECTION_ITEM}>
                    <ChartsSection
                      data={insights.overview}
                      range={insights.dates}
                    />
                  </motion.div>
                  <motion.div variants={SECTION_ITEM}>
                    <SectionLabel>Activity</SectionLabel>
                    <div className="mt-4 flex flex-col gap-10">
                      <DeferredActivitySection
                        tenantId={insights.activeTenantId}
                      />
                      <ActorActivitySection
                        tenantId={insights.activeTenantId}
                      />
                    </div>
                  </motion.div>
                  <motion.div variants={SECTION_ITEM}>
                    <EngagementSection data={insights.overview} />
                  </motion.div>
                  <motion.div variants={SECTION_ITEM}>
                    <OperationalLedger data={insights.overview} />
                  </motion.div>
                </>
              )}

              {tab === "usage-cost" && (
                <>
                  {insights.overview.dailySeries.length > 0 && (
                    <motion.div variants={SECTION_ITEM}>
                      <TrendsSection
                        data={insights.overview}
                        range={insights.dates}
                        tokenCaveat={insights.tokenCaveat}
                      />
                    </motion.div>
                  )}
                  <motion.div variants={SECTION_ITEM}>
                    <InferenceSection
                      data={insights.overview}
                      tokenCaveat={insights.tokenCaveat}
                    />
                  </motion.div>
                  <motion.div variants={SECTION_ITEM}>
                    <CostInsights
                      tenantId={insights.activeTenantId}
                      overview={insights.overview}
                      range={insights.dates}
                      tokenCaveat={insights.tokenCaveat}
                      priced={insights.priced}
                      catalog={insights.catalog}
                      pricingUnavailable={insights.costUnavailable}
                      pricingLoading={insights.pricingQuery.isLoading}
                    />
                  </motion.div>
                  <motion.div variants={SECTION_ITEM}>
                    <ToolBreakdownSection tenantId={insights.activeTenantId} />
                  </motion.div>
                </>
              )}

              {tab === "workflows" && (
                <>
                  <motion.div variants={SECTION_ITEM}>
                    <FiltersBar
                      kinds={insights.workflowKinds}
                      kindFilter={insights.kindFilter}
                      onKindFilter={insights.setKindFilter}
                      actorFilter={insights.actorFilter}
                      onActorFilter={insights.setActorFilter}
                      showActorFilter={false}
                    />
                  </motion.div>
                  <motion.div variants={SECTION_ITEM}>
                    <WorkflowsTab
                      data={insights.overview}
                      kindRows={insights.filteredKindRows}
                    />
                  </motion.div>
                </>
              )}

              {tab === "agents" && (
                <motion.div variants={SECTION_ITEM}>
                  <AgentsSection
                    tenantId={insights.activeTenantId}
                    data={insights.overview}
                  />
                </motion.div>
              )}

              {tab === "people" && (
                <motion.div
                  variants={SECTION_ITEM}
                  className="flex flex-col gap-3"
                >
                  <SectionLabel>Usage by person</SectionLabel>
                  <FiltersBar
                    kinds={insights.workflowKinds}
                    kindFilter={insights.kindFilter}
                    onKindFilter={insights.setKindFilter}
                    actorFilter={insights.actorFilter}
                    onActorFilter={insights.setActorFilter}
                    showKindFilter={false}
                  />
                  {insights.tokenCaveat !== null && (
                    <p className="text-[11px] text-text-3">
                      {insights.tokenCaveat}
                    </p>
                  )}
                  <SortablePersonTable people={insights.filteredPeople} />
                  <p className="text-[11px] text-text-3">
                    Excludes shared agents. Cost is priced per model, per
                    person, then summed — never a blended cross-model rate.
                  </p>
                </motion.div>
              )}
            </motion.div>
          )}
        </div>
      </div>
    </PagePanel>
  );
}
