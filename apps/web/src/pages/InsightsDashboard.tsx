import { PagePanel } from "@workbench/ui";
import { motion, useReducedMotion } from "framer-motion";

import { useInsightsOverview } from "../hooks/use-insights-overview";
import { describeHubApiFailure } from "../lib/hub-api";
import { ActorActivitySection } from "./insights/ActorActivity";
import { ChartsSection } from "./insights/ChartsSection";
import { CostInsights } from "./insights/CostInsights";
import { DeferredActivitySection } from "./insights/DeferredActivitySection";
import { EngagementSection } from "./insights/EngagementSection";
import { FiltersBar } from "./insights/FiltersBar";
import { InferenceSection } from "./insights/InferenceSection";
import { InstanceBreakdown } from "./insights/InstanceBreakdown";
import { InsightsPageHeader } from "./insights/InsightsPageHeader";
import { InsightsSkeleton } from "./insights/InsightsSkeleton";
import { KpiRow } from "./insights/KpiRow";
import { OperationalLedger } from "./insights/OperationalLedger";
import { SectionLabel } from "./insights/section-label";
import { SECTION_ITEM, SECTIONS_CONTAINER } from "./insights/section-motion";
import { TenantRoster } from "./insights/TenantRoster";
import { TrendsSection } from "./insights/TrendsSection";
import { UsageByPersonSection } from "./insights/UsageByPersonSection";
import { WorkflowRunsByKindSection } from "./insights/WorkflowRunsByKindSection";

export { resolveRange } from "./insights/time-range";
export {
  filterPeople,
  mergeWorkflowKindRows,
  type WorkflowKindRow,
} from "./insights/overview-derivations";

export function InsightsDashboard() {
  const reduceMotion = useReducedMotion();
  const insights = useInsightsOverview();

  return (
    <PagePanel scroll={false} flat fitContent>
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

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 max-md:px-3">
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

        {insights.overview && (
          <motion.div
            className="flex flex-col gap-10"
            variants={SECTIONS_CONTAINER}
            initial={reduceMotion ? false : "hidden"}
            animate="show"
          >
            <motion.div variants={SECTION_ITEM}>
              <ChartsSection
                data={insights.overview}
                range={insights.dates}
                kindRows={insights.filteredKindRows}
                people={insights.filteredPeople}
                tokenCaveat={insights.tokenCaveat}
              />
            </motion.div>
            {insights.overview.dailySeries.length > 0 && (
              <motion.div variants={SECTION_ITEM}>
                <TrendsSection
                  data={insights.overview}
                  range={insights.dates}
                  tokenCaveat={insights.tokenCaveat}
                />
              </motion.div>
            )}
            {insights.activeTenantId && (
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
            )}
            <motion.div variants={SECTION_ITEM}>
              <FiltersBar
                kinds={insights.workflowKinds}
                kindFilter={insights.kindFilter}
                onKindFilter={insights.setKindFilter}
                actorFilter={insights.actorFilter}
                onActorFilter={insights.setActorFilter}
              />
            </motion.div>
            {insights.activeTenantId && (
              <motion.div variants={SECTION_ITEM}>
                <TenantRoster tenantId={insights.activeTenantId} />
              </motion.div>
            )}
            {insights.activeTenantId && (
              <motion.div variants={SECTION_ITEM}>
                <SectionLabel>Activity</SectionLabel>
                <div className="mt-4 flex flex-col gap-10">
                  <DeferredActivitySection tenantId={insights.activeTenantId} />
                  <ActorActivitySection tenantId={insights.activeTenantId} />
                </div>
              </motion.div>
            )}
            <motion.div variants={SECTION_ITEM}>
              <KpiRow
                data={insights.overview}
                activePeople={insights.overview.byPerson.length}
                costTotal={insights.priced?.cost.total ?? null}
                costTokens={insights.costTokens}
                costUnavailable={insights.costUnavailable}
              />
            </motion.div>
            <motion.div variants={SECTION_ITEM}>
              <UsageByPersonSection
                people={insights.filteredPeople}
                tokenCaveat={insights.tokenCaveat}
              />
            </motion.div>
            <motion.div variants={SECTION_ITEM}>
              <WorkflowRunsByKindSection rows={insights.filteredKindRows} />
            </motion.div>
            <motion.div variants={SECTION_ITEM}>
              <EngagementSection data={insights.overview} />
            </motion.div>
            <motion.div variants={SECTION_ITEM}>
              <InferenceSection
                data={insights.overview}
                tokenCaveat={insights.tokenCaveat}
              />
            </motion.div>
            <motion.div variants={SECTION_ITEM}>
              <OperationalLedger data={insights.overview} />
            </motion.div>
            {insights.overview.inference.byInstance.length > 0 && (
              <motion.div variants={SECTION_ITEM}>
                <InstanceBreakdown
                  instances={insights.overview.inference.byInstance}
                />
              </motion.div>
            )}
          </motion.div>
        )}
      </div>
    </PagePanel>
  );
}
