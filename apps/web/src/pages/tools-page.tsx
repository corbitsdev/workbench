// Two idioms: a dense icon grid for the workspace MCP catalog — connected
// servers first, then the popular official ones — and a data table for the
// tool packages the workbench's agents already carry.

import { useState } from "react";

import "../tools/tools-page.css";
import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  EmptyState,
  Input,
  RichEmptyState,
  Section,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { toast } from "@corbits/react-ui/ui/toast";
import { QueryView } from "@/lib/api-query";
import { MagnifyingGlass, Plugs, type Icon } from "@/lib/icons";

import { describeApiError } from "@/lib/api-query";
import { MCP_SERVER_CATALOG, type McpCatalogEntry } from "../mcp-servers";
import {
  describeRedeployResult,
  useAddMcpServer,
  useMcpServers,
  useRemoveMcpServer,
  useSignInMcpServer,
  type McpServerRow,
} from "../tools/mcp-servers-query";
import { mcpServerIcon } from "../tools/mcp-server-icons";
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
  icon: TileIcon,
  name,
  desc,
  official,
  children,
}: {
  readonly icon: Icon;
  readonly name: string;
  readonly desc: string;
  readonly official: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="tool-tile">
      <div className="tool-tile-mark" aria-hidden="true">
        <TileIcon />
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
      icon={mcpServerIcon(server.handle)}
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

function PopularTile({
  entry,
  onConnect,
  busy,
  waiting,
}: {
  readonly entry: McpCatalogEntry;
  readonly onConnect: () => void;
  readonly busy: boolean;
  readonly waiting: boolean;
}) {
  const keyless = entry.auth === "none";

  return (
    <ToolTile
      icon={mcpServerIcon(entry.handle)}
      name={entry.name}
      desc={toolHost(entry.url)}
      official
    >
      <div className="tool-tile-foot">
        <Button size="sm" variant="outline" disabled={busy} onClick={onConnect}>
          {keyless ? "Connect" : "Sign in"}
        </Button>
        <span className="tool-tile-hint">
          {waiting ? "Waiting for sign-in…" : keyless ? "No key needed" : "OAuth"}
        </span>
      </div>
    </ToolTile>
  );
}

function AddByUrl({
  onAdd,
  onSignIn,
  adding,
  waiting,
}: {
  readonly onAdd: (input: { url: string; name: string; handle: string; token?: string }) => void;
  readonly onSignIn: (input: { url: string; name: string; handle: string }) => void;
  readonly adding: boolean;
  readonly waiting: boolean;
}) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  function parsedHandle(): string | null {
    try {
      return handleFromUrl(url);
    } catch {
      toast("That doesn't look like a server URL.");
      return null;
    }
  }

  function signIn() {
    const handle = parsedHandle();
    if (handle === null) return;
    onSignIn({ url, handle, name: handle });
    setUrl("");
  }

  function submit() {
    const handle = parsedHandle();
    if (handle === null) return;
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
      <div className="tool-add-actions">
        <Button size="sm" disabled={adding || url === ""} onClick={submit}>
          Add
        </Button>
        {token === "" ? (
          <Button size="sm" variant="outline" disabled={adding || url === ""} onClick={signIn}>
            Sign in
          </Button>
        ) : null}
        {waiting ? <span className="tool-tile-hint">Waiting for sign-in…</span> : null}
      </div>
    </Card>
  );
}

// `tenantId` is the tenant every read is scoped to.
export function ToolsPage({ tenantId }: { readonly tenantId: string | null }) {
  const packagesQuery = useDeployedToolPackages(tenantId);
  const serversQuery = useMcpServers(tenantId);
  const add = useAddMcpServer(tenantId);
  const remove = useRemoveMcpServer(tenantId);
  const signIn = useSignInMcpServer(tenantId, {
    onConnected: (result) => {
      toast(`${result.server.name} connected — ${describeRedeployResult(result)}`);
    },
    onFailed: (cause: unknown) => {
      toast(describeApiError(cause, "signing in to this server"));
    },
  });
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

      <QueryView
        query={serversQuery}
        label="the workspace's MCP servers"
        skeleton="rows"
        loadingContent={
          <div className="tools-grid" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="tool-tile-skeleton" />
            ))}
          </div>
        }
      >
        {(servers) => {
          const connected = servers.filter(matches);
          const available = MCP_SERVER_CATALOG.filter(
            (entry) => !servers.some((server) => server.handle === entry.handle) && matches(entry),
          );
          const filtered = needle !== "";
          if (connected.length === 0 && available.length === 0) {
            return filtered ? (
              <EmptyState
                icon={<MagnifyingGlass />}
                title={`No tools match "${filter.trim()}"`}
                description="Try a different search."
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      setFilter("");
                    }}
                  >
                    Clear filter
                  </Button>
                }
              />
            ) : (
              <RichEmptyState
                icon={<Plugs />}
                title="No servers connected"
                description="Connect a popular server below and its tools reach every workbench's worker."
              />
            );
          }
          return (
            <>
              <Section
                title="Connected"
                description="The workspace catalog, shared by every workbench: a server's tools reach the agents whose definitions bind it."
              >
                {connected.length === 0 ? (
                  <p className="page-note">
                    {filtered
                      ? "No connected servers match this filter."
                      : "Nothing connected yet — pick a popular server below."}
                  </p>
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

              <Section
                title="Popular"
                description="The official catalog — connecting one shares it with every workbench."
              >
                {available.length === 0 ? (
                  <p className="page-note">
                    {filtered
                      ? "No popular servers match this filter."
                      : "Every official server is already connected."}
                  </p>
                ) : null}
                <div className="tools-grid">
                  {available.map((entry) => (
                    <PopularTile
                      key={entry.handle}
                      entry={entry}
                      busy={add.isPending || signIn.busy}
                      waiting={signIn.waitingHandle === entry.handle}
                      onConnect={() => {
                        const server = { url: entry.url, name: entry.name, handle: entry.handle };
                        if (entry.auth === "oauth") signIn.start.mutate(server);
                        else addServer(server);
                      }}
                    />
                  ))}
                  <AddByUrl
                    onAdd={addServer}
                    onSignIn={(server) => {
                      signIn.start.mutate(server);
                    }}
                    adding={add.isPending || signIn.busy}
                    waiting={signIn.waitingHandle !== null}
                  />
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
