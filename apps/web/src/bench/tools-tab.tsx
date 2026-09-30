import { Badge, Button } from "@corbits/react-ui";

import { QueryView } from "@/lib/api-query";
import { Plugs } from "@/lib/icons";
import { Link } from "../navigation";
import { useMcpServers } from "../tools/mcp-servers-query";

/** Tools the workspace catalog makes available here; "Connected" once an
 * agent in this workbench binds the server. */
export function ToolsTab({ workbenchTenantId }: { readonly workbenchTenantId: string }) {
  const query = useMcpServers(workbenchTenantId);
  const manage = `/tools?from=${encodeURIComponent(workbenchTenantId)}`;

  return (
    <section className="workbench-info-panel">
      <div className="workbench-info-panel-header">
        <h2>Tools</h2>
      </div>
      <QueryView query={query} label="this workbench's tools" skeleton="rows">
        {(servers) =>
          servers.length === 0 ? (
            <>
              <p className="workbench-info-empty-note">No tools are connected yet.</p>
              <Button asChild size="sm">
                <Link to={manage}>Connect a tool</Link>
              </Button>
            </>
          ) : (
            <ul className="bench-tab-list">
              {servers.map((server) => (
                <li key={server.credentialId} className="bench-tab-row">
                  <span className="bench-tab-tile" aria-hidden="true">
                    <Plugs size={16} />
                  </span>
                  <span className="bench-tab-text">
                    <span className="workbench-info-cell-primary">{server.name}</span>
                    <span className="workbench-info-cell-context">{server.url}</span>
                  </span>
                  <Badge tone={server.agentNames.length > 0 ? "success" : "neutral"}>
                    {server.agentNames.length > 0 ? "Connected" : "Available"}
                  </Badge>
                  <Link to={manage} className="bench-tab-link">
                    Manage
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
    </section>
  );
}
