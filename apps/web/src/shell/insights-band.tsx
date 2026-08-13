// Insights col2 nav: Overview | Runs, mirroring the shell mock's
// `data-insights-view` list. A run detail path (`/insights/runs/:id`) keeps
// the Runs row active since it's a drill-in of the runs list.

import { SidebarItemRow } from "@corbits/react-ui";

const INSIGHTS_VIEWS: readonly { id: "overview" | "runs"; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "runs", label: "Runs" },
];

export function insightsViewFromPath(path: string): "overview" | "runs" {
  return path === "/insights" || path === "/insights/" ? "overview" : "runs";
}

export function insightsPathForView(view: "overview" | "runs"): string {
  return view === "overview" ? "/insights" : "/insights/runs";
}

export function InsightsViewsBand({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const active = insightsViewFromPath(path);

  return (
    <div className="panel-stack" aria-label="Insights views">
      {INSIGHTS_VIEWS.map((view) => (
        <SidebarItemRow
          key={view.id}
          name={view.label}
          selected={active === view.id}
          onSelect={() => onNavigate(insightsPathForView(view.id))}
        />
      ))}
    </div>
  );
}
