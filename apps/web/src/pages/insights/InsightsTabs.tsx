import { useSearchParams } from "react-router";

export const INSIGHTS_TABS = [
  { id: "overview", label: "Overview" },
  { id: "usage-cost", label: "Usage & Cost" },
  { id: "workflows", label: "Workflows" },
  { id: "agents", label: "Agents" },
  { id: "people", label: "People" },
] as const;

export type InsightsTabId = (typeof INSIGHTS_TABS)[number]["id"];

const DEFAULT_TAB: InsightsTabId = "overview";

function isInsightsTabId(value: string): value is InsightsTabId {
  return INSIGHTS_TABS.some((tab) => tab.id === value);
}

/**
 * Drives the /insights tab selection from the `?tab=` search param (CL-3667)
 * so the shared time-range/granularity/export controls in the page header
 * persist across tabs while each tab body swaps underneath. Falls back to
 * "overview" for a missing or unrecognized value rather than crashing.
 */
export function useInsightsTab(): [
  InsightsTabId,
  (tab: InsightsTabId) => void,
] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("tab");
  const active = raw !== null && isInsightsTabId(raw) ? raw : DEFAULT_TAB;

  function setTab(tab: InsightsTabId) {
    // Push (not replace) so each tab click is its own history entry — the
    // browser Back/Forward buttons must step through the tabs the member
    // actually visited. `replace: true` collapsed every switch
    // into the entry that was live when the page loaded, which is why Back
    // from the Insights page skipped over the tabs entirely.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", tab);
      return next;
    });
  }

  return [active, setTab];
}

export function InsightsTabNav({
  active,
  onChange,
}: {
  active: InsightsTabId;
  onChange: (tab: InsightsTabId) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Insights sections"
      className="flex flex-wrap gap-1 border-b border-border"
    >
      {INSIGHTS_TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            id={`insights-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`insights-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            data-testid={`insights-tab-${tab.id}`}
            onClick={() => onChange(tab.id)}
            className={`min-h-[36px] rounded-t-[8px] border-b-2 px-3 py-2 text-[12.5px] font-medium outline-none transition-[color,border-color] focus-visible:ring-1 focus-visible:ring-accent ${
              selected
                ? "border-accent text-text"
                : "border-transparent text-text-3 hover:text-text-2"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
