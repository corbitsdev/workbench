import { Button } from "@corbits/react-ui";

import { QueryView } from "@/lib/api-query";
import { Link } from "../navigation";
import { toolCountLabel } from "../tools/tool-count";
import { useMcpServers } from "../tools/mcp-servers-query";
import "../tools/tools-page.css";
import "./drawer.css";

/** One section per connected MCP server, listing the tools it offers. */
export function ToolsTab({ workbenchTenantId }: { readonly workbenchTenantId: string }) {
  const query = useMcpServers(workbenchTenantId);
  const manage = `/tools?from=${encodeURIComponent(workbenchTenantId)}`;

  return (
    <QueryView query={query} label="this workbench's tools" skeleton="rows">
      {(servers) =>
        servers.length === 0 ? (
          <section className="workbench-info-panel">
            <div className="workbench-info-panel-header">
              <h2>Tools</h2>
            </div>
            <p className="drawer-about">
              Nothing connected yet — connect a server from the Tools page and every tool it offers
              shows up here.
            </p>
            <Button asChild size="lg">
              <Link to={manage}>Connect a tool</Link>
            </Button>
          </section>
        ) : (
          <>
            {servers.map((server) => (
              <section key={server.credentialId} className="drawer-sec">
                <div className="drawer-sec-head">
                  <h3>
                    {server.name}{" "}
                    <span className="tools-tab-count">{toolCountLabel(server.tools.length)}</span>
                  </h3>
                  <Link to={manage} className="tools-tab-add">
                    Add tools
                  </Link>
                </div>
                <ul className="drawer-list">
                  {server.tools.map((tool) => (
                    <li key={tool.name} className="drawer-tool">
                      <b className="drawer-perm-name">{tool.name}</b>
                      <span className="tool-live">Live</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )
      }
    </QueryView>
  );
}
