// Tools: a standalone rail destination listing what this tenant can call —
// Interchange tool packages, read from the same capability inventory the
// Agents detail view's "Add a capability" picker already uses
// (`listCapabilityInventory`, `packages/agent-directory`'s package-registry
// read). There is no connect flow here: pinning a tool package to an agent
// happens on that agent's own detail page. No stock route lists a tenant's
// MCP servers yet, so this page has nothing to show for those until one
// exists.

import {
  PageShell,
  RichEmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { Plugs } from "@/lib/icons";
import { WorkbenchLoadingState } from "@/chat";
import { useCallback, useEffect, useState } from "react";

import { listCapabilityInventory, type CapabilityInventory } from "../chat/api";
import { useBench } from "../bench-context";
import { StageTopBar } from "../shell/stage-top-bar";

type ToolsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly inventory: CapabilityInventory }
  | { readonly status: "error"; readonly message: string };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The tenant's installed tool packages, over the same capability inventory
 * the Agents detail view reads. `tenantId` is the tenant every read is
 * scoped to.
 */
export function ToolsPage({ tenantId }: { readonly tenantId: string | null }) {
  const [state, setState] = useState<ToolsState>({ status: "loading" });

  const reload = useCallback(async () => {
    if (tenantId === null) return;
    setState({ status: "loading" });
    try {
      const inventory = await listCapabilityInventory(tenantId);
      setState({ status: "ready", inventory });
    } catch (cause) {
      setState({ status: "error", message: messageOf(cause) });
    }
  }, [tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const crumbs = [{ label: "Tools" }];

  function stage(body: React.ReactNode) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={crumbs} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PageShell width="full" className="page-fill">
            {body}
          </PageShell>
        </div>
      </div>
    );
  }

  if (tenantId === null) {
    return stage(
      <p className="text-sm text-muted-foreground">Pick a workbench to see its tools.</p>,
    );
  }

  if (state.status === "loading") {
    return stage(<WorkbenchLoadingState title="Loading tools…" />);
  }

  if (state.status === "error") {
    return stage(
      <RichEmptyState
        icon={<Plugs />}
        title="Couldn't load your tools"
        description="Something went wrong on our side. Try again in a moment."
        actions={[{ label: "Retry", onClick: () => void reload() }]}
      />,
    );
  }

  const { toolPackages } = state.inventory;

  if (toolPackages.length === 0) {
    return stage(
      <RichEmptyState
        icon={<Plugs />}
        title="No tools yet"
        description="A tool package gives every agent in this workbench a new capability. Install one to see it here."
      />,
    );
  }

  return stage(
    <div className="px-4 pb-5 sm:px-7">
      <Table aria-label="Tools">
        <TableHeader>
          <TableRow>
            <TableHead>Tool package</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {toolPackages.map((tool) => (
            <TableRow key={tool.name}>
              <TableCell className="font-medium">{tool.name}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>,
  );
}

/**
 * Tools roster mount at `/tools`: a thin adapter that resolves which
 * workbench's inventory is listed. The stage chrome lives on `ToolsPage`.
 */
export function ToolsRoute() {
  const { selectedTenantId } = useBench();

  return <ToolsPage tenantId={selectedTenantId} />;
}
