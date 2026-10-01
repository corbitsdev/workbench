// Two idioms, per DESIGN.md: a data table for what the workspace catalog
// already carries, and a card catalog for the servers it could add.

import { useState } from "react";

import "../tools/tools-page.css";
import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  Input,
  RichEmptyState,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { toast } from "@corbits/react-ui/ui/toast";
import { QueryView } from "@/lib/api-query";
import { Plugs } from "@/lib/icons";

import { describeApiError } from "@/lib/api-query";
import { MCP_SERVER_CATALOG, type McpCatalogEntry } from "../mcp-servers";
import {
  describeRedeployResult,
  useAddMcpServer,
  useMcpServers,
  useRemoveMcpServer,
  type McpServerRow,
} from "../tools/mcp-servers-query";
import { useDeployedToolPackages } from "../tools/deployed-tool-packages";
import { useBench } from "../bench-context";
import { useFromBench } from "../shell/page-crumbs";
import { PageLayout } from "../shell/page-layout";
import { StageTopBar } from "../shell/stage-top-bar";
import { ConfirmButton } from "../components/confirm-button";

/** The handle a pasted URL's server is stored under; the host's first label
 * reads better than a random id and is what a person would have typed. */
function handleFromUrl(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const label = host.split(".")[0] ?? host;
  return label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function toolHost(url: string): string {
  return new URL(url).hostname;
}

function ToolTile({
  mark,
  name,
  desc,
  official,
  children,
}: {
  readonly mark: string;
  readonly name: string;
  readonly desc: string;
  readonly official: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="tool-tile">
      <div className="tool-tile-mark" aria-hidden="true">
        {mark}
      </div>
      <h3 className="tool-tile-title">
        {name}
        <span className="tool-kind">{official ? "Official" : "Custom"}</span>
      </h3>
      <p className="tool-tile-desc">{desc}</p>
      {children}
    </div>
  );
}

function ConnectedTile({
  server,
  onRemove,
  removing,
}: {
  readonly server: McpServerRow;
  readonly onRemove: () => void;
  readonly removing: boolean;
}) {
  const official = MCP_SERVER_CATALOG.some((entry) => entry.handle === server.handle);
  const agents = server.agentNames.length === 0 ? "" : ` · ${server.agentNames.join(", ")}`;
  return (
    <ToolTile
      mark={server.name.slice(0, 1).toLocaleUpperCase()}
      name={server.name}
      desc={`${toolHost(server.url)}${agents}`}
      official={official}
    >
      <div className="tool-tile-foot">
        <span className="tool-live">{`${String(server.tools.length)} tools live`}</span>
        <span style={{ flex: 1 }} />
        <ConfirmButton
          size="sm"
          disabled={removing}
          confirmLabel="Disconnect?"
          onConfirm={onRemove}
        >
          Disconnect
        </ConfirmButton>
      </div>
    </ToolTile>
  );
}

function AvailableTile({
  entry,
  onConnect,
  busy,
}: {
  readonly entry: McpCatalogEntry;
  readonly onConnect: (token?: string) => void;
  readonly busy: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [token, setToken] = useState("");
  const keyless = entry.auth === "none";

  return (
    <ToolTile
      mark={entry.name.slice(0, 1).toLocaleUpperCase()}
      name={entry.name}
      desc={toolHost(entry.url)}
      official
    >
      {asking ? (
        <form
          className="tool-tile-form"
          onSubmit={(event) => {
            event.preventDefault();
            onConnect(token);
            setAsking(false);
            setToken("");
          }}
        >
          <Input
            aria-label={`${entry.name} token`}
            type="password"
            placeholder="Bearer token"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
            }}
          />
          <div className="tool-tile-form-actions">
            <Button size="sm" variant="outline" type="submit" disabled={busy || token === ""}>
              Connect
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => {
                setAsking(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="tool-tile-foot">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (keyless) onConnect();
              else setAsking(true);
            }}
          >
            Connect
          </Button>
          <span className="tool-tile-hint">{keyless ? "No key needed" : "Token"}</span>
        </div>
      )}
    </ToolTile>
  );
}

function AddByUrl({
  onAdd,
  adding,
}: {
  readonly onAdd: (input: { url: string; name: string; handle: string; token?: string }) => void;
  readonly adding: boolean;
}) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  function submit() {
    let handle: string;
    try {
      handle = handleFromUrl(url);
    } catch {
      toast("That doesn't look like a server URL.");
      return;
    }
    onAdd({
      url,
      handle,
      name: handle,
      ...(token === "" ? {} : { token }),
    });
    setUrl("");
    setToken("");
  }

  return (
    <Card className="tool-card">
      <div>
        <CardTitle>Add a server by URL</CardTitle>
        <CardDescription>Any MCP server that speaks streamable HTTP.</CardDescription>
      </div>
      <Input
        aria-label="Server URL"
        placeholder="https://mcp.example.com/mcp"
        value={url}
        onChange={(event) => {
          setUrl(event.target.value);
        }}
      />
      <Input
        aria-label="Bearer token"
        type="password"
        placeholder="Bearer token (optional)"
        value={token}
        onChange={(event) => {
          setToken(event.target.value);
        }}
      />
      <Button
        size="sm"
        className="tool-add-submit"
        disabled={adding || url === ""}
        onClick={submit}
      >
        Add
      </Button>
    </Card>
  );
}

// `tenantId` is the tenant every read is scoped to.
export function ToolsPage({ tenantId }: { readonly tenantId: string | null }) {
  const packagesQuery = useDeployedToolPackages(tenantId);
  const serversQuery = useMcpServers(tenantId);
  const add = useAddMcpServer(tenantId);
  const remove = useRemoveMcpServer(tenantId);
  const [filter, setFilter] = useState("");
  const crumbs = [{ label: "Tools" }];
  const needle = filter.trim().toLocaleLowerCase();
  const matches = (item: { readonly name: string }) =>
    needle === "" || item.name.toLocaleLowerCase().includes(needle);

  function stage(body: React.ReactNode) {
    return (
      <div className="page-frame">
        <StageTopBar crumbs={crumbs} />
        <div className="page-scroll">
          <PageLayout
            title="Tools"
            subtitle="Official servers first. Secrets never touch your workers."
          >
            {body}
          </PageLayout>
        </div>
      </div>
    );
  }

  if (tenantId === null) {
    return stage(<p className="page-note">Pick a workbench to see its tools.</p>);
  }

  function addServer(input: { url: string; name: string; handle: string; token?: string }) {
    add.mutate(input, {
      onSuccess: (result) => {
        toast(`${result.server.name} connected — ${describeRedeployResult(result)}`);
      },
      onError: (cause: unknown) => {
        toast(describeApiError(cause, "adding this server"));
      },
    });
  }

  return stage(
    <div className="tools-sections">
      <Input
        className="tools-filter"
        aria-label="Filter tools"
        placeholder="Filter tools"
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value);
        }}
      />

      <QueryView query={serversQuery} label="the workspace's MCP servers" skeleton="rows">
        {(servers) => {
          const connected = servers.filter(matches);
          const available = MCP_SERVER_CATALOG.filter(
            (entry) => !servers.some((server) => server.handle === entry.handle) && matches(entry),
          );
          return (
            <>
              <Section
                title="Connected"
                description="The workspace catalog, shared by every workbench: a server's tools reach the agents whose definitions bind it."
              >
                {connected.length === 0 ? (
                  <p className="page-note">Nothing connected yet.</p>
                ) : (
                  <div className="tools-grid">
                    {connected.map((server) => (
                      <ConnectedTile
                        key={server.credentialId}
                        server={server}
                        removing={remove.isPending}
                        onRemove={() => {
                          remove.mutate(server, {
                            onSuccess: (result) => {
                              toast(
                                `${server.name} disconnected — ${describeRedeployResult(result)}`,
                              );
                            },
                            onError: (cause: unknown) => {
                              toast(describeApiError(cause, "disconnecting this server"));
                            },
                          });
                        }}
                      />
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Available" description="Official servers first.">
                <div className="tools-grid">
                  {available.map((entry) => (
                    <AvailableTile
                      key={entry.handle}
                      entry={entry}
                      busy={add.isPending}
                      onConnect={(token) => {
                        addServer({
                          url: entry.url,
                          name: entry.name,
                          handle: entry.handle,
                          ...(token === undefined ? {} : { token }),
                        });
                      }}
                    />
                  ))}
                  <AddByUrl onAdd={addServer} adding={add.isPending} />
                </div>
              </Section>
            </>
          );
        }}
      </QueryView>

      <Section
        title="Tool packages"
        description="Read-only here — deploy an agent to add or change one."
      >
        <QueryView query={packagesQuery} label="your tools" skeleton="rows">
          {(toolPackages) =>
            toolPackages.length === 0 ? (
              <RichEmptyState
                icon={<Plugs />}
                title="No tools yet"
                description="A tool package gives an agent in this workbench a new capability. Deploy an agent that carries one to see it here."
              />
            ) : (
              <Table aria-label="Tool packages">
                <TableHeader>
                  <TableRow>
                    <TableHead>Tool package</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Agents</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {toolPackages.map((tool) => (
                    <TableRow key={tool.name}>
                      <TableCell className="tools-cell-name">{tool.name}</TableCell>
                      <TableCell className="tools-cell-soft">{tool.version ?? "—"}</TableCell>
                      <TableCell className="tools-cell-soft">
                        {tool.agentNames.join(", ")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          }
        </QueryView>
      </Section>
    </div>,
  );
}

// A thin adapter that resolves which workbench's registry is listed.
export function ToolsRoute() {
  const { selectedTenantId } = useBench();
  const fromBench = useFromBench();

  return <ToolsPage tenantId={fromBench ?? selectedTenantId} />;
}
