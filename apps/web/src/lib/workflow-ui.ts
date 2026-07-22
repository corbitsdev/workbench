import type { ComponentType } from "react";
import type { WorkflowPanelProps } from "@workbench/ui";

export type WorkflowUIModule = {
  label?: string;
  description?: string;
  Panel?: ComponentType<WorkflowPanelProps>;
};

// Maps kind → lazy importer for the workflow's CLIENT entry (`/ui`), which
// exports the custom `Panel`. The `/ui` subpath is browser-safe — it never
// imports the package's server-only workflow definition (which pulls in
// `@intx/agent`). Vite code-splits each entry into its own chunk; only the
// opened workflow loads. Add one entry per workflow package.
const importers: Record<string, () => Promise<WorkflowUIModule>> = {
  "attio-task-agent": () => import("@workbench/workflow-attio-task-agent/ui"),
  "gamma-presentation-creator": () =>
    import("@workbench/workflow-gamma-presentation-creator/ui"),
  heartbeat: () => import("@workbench/workflow-heartbeat/ui"),
  "pain-point-collateral": () =>
    import("@workbench/workflow-pain-point-collateral/ui"),
  "multi-source-collateral": () =>
    import("@workbench/workflow-multi-source-collateral/ui"),
  "reddit-opportunity-scanner": () =>
    import("@workbench/workflow-reddit-opportunity-scanner/ui"),
  "last30days-research": () =>
    import("@workbench/workflow-last30days-research/ui"),
  "sumble-account-intel": () =>
    import("@workbench/workflow-sumble-account-intel/ui"),
  "competitor-analysis": () =>
    import("@workbench/workflow-competitor-analysis/ui"),
};

export async function loadWorkflowUI(
  kind: string,
): Promise<WorkflowUIModule | null> {
  const load = importers[kind];
  if (!load) return null;
  return load();
}
