// Tools: a standalone rail destination listing the tool packages this
// tenant has published into its own registry — the same
// `corbits-tools` package-registry asset `registry-publish.ts` writes to.
// No stock route lists a tenant's MCP servers yet, so this page has
// nothing to show for those until one exists.

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
import { QueryView } from "@/lib/api-query";
import { Plugs } from "@/lib/icons";

import { useToolPackages } from "../tools/registry-read";
import { useBench } from "../bench-context";
import { StageTopBar } from "../shell/stage-top-bar";

/**
 * The tenant's published tool packages, read off the stock registry asset.
 * `tenantId` is the tenant every read is scoped to.
 */
export function ToolsPage({ tenantId }: { readonly tenantId: string | null }) {
  const query = useToolPackages(tenantId);
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

  return stage(
    <QueryView query={query} label="your tools" skeleton="rows">
      {(toolPackages) =>
        toolPackages.length === 0 ? (
          <RichEmptyState
            icon={<Plugs />}
            title="No tools yet"
            description="A tool package gives every agent in this workbench a new capability. Publish one to see it here."
          />
        ) : (
          <div className="px-4 pb-5 sm:px-7">
            <Table aria-label="Tools">
              <TableHeader>
                <TableRow>
                  <TableHead>Tool package</TableHead>
                  <TableHead>Version</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {toolPackages.map((tool) => (
                  <TableRow key={tool.filename}>
                    <TableCell className="font-medium">{tool.name}</TableCell>
                    <TableCell className="text-muted-foreground">{tool.version}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      }
    </QueryView>,
  );
}

/**
 * Tools roster mount at `/tools`: a thin adapter that resolves which
 * workbench's registry is listed. The stage chrome lives on `ToolsPage`.
 */
export function ToolsRoute() {
  const { selectedTenantId } = useBench();

  return <ToolsPage tenantId={selectedTenantId} />;
}
