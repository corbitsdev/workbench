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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { toast } from "@corbits/react-ui/ui/toast";
import { QueryView } from "@/lib/api-query";
import { CircleNotch, MagnifyingGlass, Plugs, type Icon } from "@/lib/icons";

import { describeApiError } from "@/lib/api-query";
import { MCP_SERVER_CATALOG, probeMcpServer, resolveWorkspaceTenantId } from "../mcp-servers";
import type { McpCatalogEntry } from "../mcp-servers";
import { toolCountLabel } from "../tools/tool-count";
import {
  dedupeMcpHandle,
  dedupeMcpName,
  handleFromUrl,
  redirectUrlName,
  suggestMcpServerName,
} from "../mcp-server-name";
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
import { ListCard, ListFilter } from "./library-list";

function toolHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
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

function ConnectedRow({
  server,
  onRemove,
  removing,
}: {
  readonly server: McpServerRow;
  readonly onRemove: () => void;
  readonly removing: boolean;
}) {
  const official = MCP_SERVER_CATALOG.some((entry) => entry.handle === server.handle);
  const RowIcon = mcpServerIcon(server.handle);
  const agents = server.agentNames.length === 0 ? "" : ` · ${server.agentNames.join(", ")}`;
  return (
    <li className="lib-row">
      <div className="lib-cell tools-row-main">
        <span className="tools-row-mark" aria-hidden="true">
          <RowIcon />
        </span>
        <span className="tools-row-text">
          <span className="tools-row-name">
            <span className="tools-row-name-text">{server.name}</span>
            <span className="tool-kind">{official ? "Official" : "Custom"}</span>
          </span>
          <span className="tools-row-desc">{`${toolHost(server.url)}${agents}`}</span>
        </span>
      </div>
      <span className="lib-cell">
        <span className="tool-live">{`${toolCountLabel(server.tools.length)} live`}</span>
      </span>
      <span className="lib-cell lib-cell--end">
        <ConfirmButton
          size="lg"
          disabled={removing}
          confirmLabel="Disconnect?"
          onConfirm={onRemove}
        >
          Disconnect
        </ConfirmButton>
      </span>
    </li>
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
        <Button size="lg" variant="outline" disabled={busy} onClick={onConnect}>
          {waiting ? (
            <>
              <CircleNotch className="tool-spin" aria-hidden="true" />
              Waiting for sign-in…
            </>
          ) : keyless ? (
            "Connect"
          ) : (
            "Sign in"
          )}
        </Button>
        {waiting ? null : (
          <span className="tool-tile-hint">{keyless ? "No key needed" : "OAuth"}</span>
        )}
      </div>
    </ToolTile>
  );
}

function AddByUrl({
  onAdd,
  onSignIn,
  onProbeName,
  existingNames,
  existingHandles,
  adding,
  waiting,
}: {
  readonly onAdd: (input: { url: string; name: string; handle: string; token?: string }) => void;
  readonly onSignIn: (input: { url: string; name: string; handle: string }) => void;
  /** The server's self-reported `serverInfo` for a pasted URL; rejects when
   * the server cannot answer (bad URL, auth-gated, offline). */
  readonly onProbeName: (url: string) => Promise<unknown>;
  readonly existingNames: readonly string[];
  readonly existingHandles: readonly string[];
  readonly adding: boolean;
  readonly waiting: boolean;
}) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  /** Typed text is never overwritten by a suggestion; clearing the field
   * hands the suggestion back. */
  const [edited, setEdited] = useState(false);
  /** The last looked-up `serverInfo` for this URL; cleared with the URL, so
   * a suggestion never leaks across servers. */
  const [serverInfo, setServerInfo] = useState<unknown>(undefined);
  const [probing, setProbing] = useState(false);

  const hasUrl = url.trim() !== "";
  const suggestion = suggestMcpServerName({ url, serverInfo, existingNames });
  const shown = edited ? name : hasUrl ? suggestion.name : "";
  const typed = shown.trim();
  /** A URL pasted into the name field is never saved raw: the hint below
   * says so, and the extracted suggestion is what gets stored. */
  const typedUrlName = edited ? redirectUrlName(typed, existingNames) : null;
  const finalName =
    typedUrlName ?? (typed === "" ? suggestion.name : dedupeMcpName(typed, existingNames));

  let hint: string;
  if (!hasUrl) {
    hint = "Paste a server URL and the name fills in.";
  } else if (!edited) {
    hint =
      suggestion.source === "server"
        ? "From the server itself — edit as you like."
        : "Suggested from the URL — edit as you like.";
  } else if (typedUrlName !== null) {
    hint = `Looks like a URL — will be saved as "${typedUrlName}".`;
  } else if (typed === "") {
    hint = `Will be saved as "${suggestion.name}".`;
  } else if (finalName !== typed) {
    hint = `"${typed}" is taken — will be saved as "${finalName}".`;
  } else {
    hint = "Custom name.";
  }

  function changeUrl(value: string) {
    setUrl(value);
    setServerInfo(undefined);
  }

  function parsedHandle(): string | null {
    const base = handleFromUrl(url);
    if (base === null) {
      toast("That doesn't look like a server URL.");
      return null;
    }
    return dedupeMcpHandle(base, existingHandles);
  }

  function reset() {
    setUrl("");
    setToken("");
    setName("");
    setEdited(false);
    setServerInfo(undefined);
  }

  async function lookUp() {
    const trimmed = url.trim();
    if (trimmed === "" || probing) return;
    setProbing(true);
    try {
      const info = await onProbeName(trimmed);
      const next = suggestMcpServerName({ url: trimmed, serverInfo: info, existingNames });
      setServerInfo(info);
      setEdited(false);
      if (next.source !== "server") {
        toast("That server didn't share a name — the URL suggestion stands.");
      }
    } catch {
      toast("That server didn't answer — check the URL.");
    } finally {
      setProbing(false);
    }
  }

  function signIn() {
    const handle = parsedHandle();
    if (handle === null) return;
    onSignIn({ url: url.trim(), handle, name: finalName });
    reset();
  }

  function submit() {
    const handle = parsedHandle();
    if (handle === null) return;
    onAdd({
      url: url.trim(),
      handle,
      name: finalName,
      ...(token === "" ? {} : { token }),
    });
    reset();
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
          changeUrl(event.target.value);
        }}
      />
      <Input
        aria-label="Server name"
        placeholder="A name for this server"
        value={shown}
        onChange={(event) => {
          setName(event.target.value);
          setEdited(true);
        }}
      />
      <div className="tool-add-actions">
        <span className="tool-tile-hint">{hint}</span>
        <span style={{ flex: 1 }} />
        <Button
          size="sm"
          variant="outline"
          disabled={probing || !hasUrl}
          onClick={() => {
            void lookUp();
          }}
        >
          {probing ? "Looking up…" : "Look up name"}
        </Button>
      </div>
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
        <Button size="lg" disabled={adding || url === ""} onClick={submit}>
          {waiting && token !== "" ? (
            <>
              <CircleNotch className="tool-spin" aria-hidden="true" />
              Waiting for sign-in…
            </>
          ) : (
            "Add"
          )}
        </Button>
        {token === "" ? (
          <Button size="lg" variant="outline" disabled={adding || url === ""} onClick={signIn}>
            {waiting ? (
              <>
                <CircleNotch className="tool-spin" aria-hidden="true" />
                Waiting for sign-in…
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        ) : null}
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

  /** The name lookup behind "Look up name": asks the pasted server what it
   * calls itself, storing nothing. */
  async function probeServerName(probeUrl: string): Promise<unknown> {
    const workspaceTenantId = await resolveWorkspaceTenantId(tenantId as string);
    return (await probeMcpServer({ tenantId: workspaceTenantId, url: probeUrl })).serverInfo;
  }

  return stage(
    <div className="tools-sections">
      <ListFilter label="Filter tools" value={filter} onChange={setFilter} />

      <QueryView query={serversQuery} label="the workspace's MCP servers" skeleton="rows">
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
                title="Nothing connected yet"
                description="Connect a popular server below and its tools reach every workbench's worker."
                actions={[
                  {
                    label: "Browse popular servers",
                    href: "#popular-servers",
                    variant: "primary",
                  },
                ]}
              />
            );
          }
          return (
            <>
              <Section
                title="Connected"
                description="The workspace catalog, shared by every workbench: a server's tools reach the agents whose definitions bind it."
                {...(connected.length === 0 ? {} : { count: connected.length })}
              >
                {connected.length === 0 ? (
                  filtered ? (
                    <p className="page-note">No connected servers match this filter.</p>
                  ) : (
                    <RichEmptyState
                      icon={<Plugs />}
                      title="Nothing connected yet"
                      description="Connect a popular server below and its tools reach every workbench's worker."
                      actions={[
                        {
                          label: "Browse popular servers",
                          href: "#popular-servers",
                          variant: "primary",
                        },
                      ]}
                    />
                  )
                ) : (
                  <ListCard
                    label="Connected servers"
                    columns="minmax(0, 1fr) auto auto"
                    heads={["Server", "Tools", ""]}
                  >
                    {connected.map((server) => (
                      <ConnectedRow
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
                  </ListCard>
                )}
              </Section>

              <div id="popular-servers">
                <Section
                  title="Popular"
                  description="The official catalog — connecting one shares it with every workbench."
                  {...(available.length === 0 ? {} : { count: available.length })}
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
                      onProbeName={probeServerName}
                      existingNames={servers.map((server) => server.name)}
                      existingHandles={servers.map((server) => server.handle)}
                      adding={add.isPending || signIn.busy}
                      waiting={signIn.waitingHandle !== null}
                    />
                  </div>
                </Section>
              </div>
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
