// Two idioms, per DESIGN.md: a data table for what this workbench already
// carries, and a card catalog for the servers it could add.

import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardTitle,
  ConfirmButton,
  Input,
  PageShell,
  RichEmptyState,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@corbits/react-ui";
import { QueryView } from "@/lib/api-query";
import { Plugs } from "@/lib/icons";

import { describeApiError } from "@/lib/api-query";
import { MCP_SERVER_CATALOG, type McpCatalogEntry, type McpServer } from "../mcp-servers";
import {
  useAddMcpServer,
  useMcpServers,
  useRemoveMcpServer,
  type McpServerRow,
} from "../tools/mcp-servers-query";
import { useDeployedToolPackages } from "../tools/deployed-tool-packages";
import { useBench } from "../bench-context";
import { StageTopBar } from "../shell/stage-top-bar";

const AUTH_LABEL: Record<McpServer["auth"], string> = {
  none: "No sign-in",
  oauth: "Sign in",
  token: "Token",
};

/** The handle a pasted URL's server is stored under; the host's first label
 * reads better than a random id and is what a person would have typed. */
function handleFromUrl(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const label = host.split(".")[0] ?? host;
  return label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function McpServersTable({
  servers,
  onRemove,
  removing,
}: {
  readonly servers: readonly McpServerRow[];
  readonly onRemove: (server: McpServerRow) => void;
  readonly removing: boolean;
}) {
  return (
    <Table aria-label="MCP servers">
      <TableHeader>
        <TableRow>
          <TableHead>Server</TableHead>
          <TableHead>URL</TableHead>
          <TableHead>Auth</TableHead>
          <TableHead>Tools</TableHead>
          <TableHead>Agents</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {servers.map((server) => (
          <TableRow key={server.credentialId}>
            <TableCell className="font-medium">{server.name}</TableCell>
            <TableCell className="text-muted-foreground">{server.url}</TableCell>
            <TableCell className="text-muted-foreground">{AUTH_LABEL[server.auth]}</TableCell>
            <TableCell className="text-right tabular-nums">{server.tools.length}</TableCell>
            <TableCell className="text-muted-foreground">
              {server.agentNames.length === 0 ? "—" : server.agentNames.join(", ")}
            </TableCell>
            <TableCell className="text-right">
              <ConfirmButton
                variant="ghost"
                size="sm"
                disabled={removing}
                confirmLabel="Remove?"
                onConfirm={() => {
                  onRemove(server);
                }}
              >
                Remove
              </ConfirmButton>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DiscoverCard({
  entry,
  added,
  onAdd,
  adding,
}: {
  readonly entry: McpCatalogEntry;
  readonly added: boolean;
  readonly onAdd: () => void;
  readonly adding: boolean;
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div>
        <CardTitle>{entry.name}</CardTitle>
        <CardDescription>{entry.url}</CardDescription>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3">
        <Badge tone={entry.auth === "none" ? "neutral" : "info"}>
          {entry.auth === "none" ? "No sign-in needed" : "Sign-in required"}
        </Badge>
        {added ? (
          <span className="text-sm text-muted-foreground">Added</span>
        ) : entry.auth === "none" ? (
          <Button size="sm" disabled={adding} onClick={onAdd}>
            Add
          </Button>
        ) : (
          <Button size="sm" disabled title="Signing in to an MCP server isn't wired up yet.">
            Sign in
          </Button>
        )}
      </div>
      {entry.auth !== "none" && !added ? (
        <p className="text-xs text-muted-foreground">
          Until sign-in lands, add this server below with a token you already have.
        </p>
      ) : null}
    </Card>
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
    <Card className="flex flex-col gap-3 p-4">
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
      <Button size="sm" className="self-start" disabled={adding || url === ""} onClick={submit}>
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

  function addServer(input: { url: string; name: string; handle: string; token?: string }) {
    add.mutate(input, {
      onSuccess: (server) => {
        toast(
          `${server.name} added — Myra was redeployed with its ${String(server.tools.length)} tools.`,
        );
      },
      onError: (cause: unknown) => {
        toast(describeApiError(cause, "adding this server"));
      },
    });
  }

  return stage(
    <div className="flex flex-col gap-8 px-4 pb-5 sm:px-7">
      <Section
        title="MCP servers"
        description="A server's tools reach the agents whose definitions bind it."
      >
        <QueryView query={serversQuery} label="this workbench's MCP servers" skeleton="rows">
          {(servers) =>
            servers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No MCP servers yet. Add one from Discover below.
              </p>
            ) : (
              <McpServersTable
                servers={servers}
                removing={remove.isPending}
                onRemove={(server) => {
                  remove.mutate(server, {
                    onSuccess: () => {
                      toast(`${server.name} removed — Myra was redeployed without it.`);
                    },
                    onError: (cause: unknown) => {
                      toast(describeApiError(cause, "removing this server"));
                    },
                  });
                }}
              />
            )
          }
        </QueryView>
      </Section>

      <Section title="Discover" description="Servers this workbench can add.">
        <div className="grid gap-4 sm:grid-cols-2">
          {MCP_SERVER_CATALOG.map((entry) => (
            <DiscoverCard
              key={entry.handle}
              entry={entry}
              adding={add.isPending}
              added={
                serversQuery.kind === "ready" &&
                serversQuery.data.some((server) => server.handle === entry.handle)
              }
              onAdd={() => {
                addServer({ url: entry.url, name: entry.name, handle: entry.handle });
              }}
            />
          ))}
          <AddByUrl onAdd={addServer} adding={add.isPending} />
        </div>
      </Section>

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
                      <TableCell className="font-medium">{tool.name}</TableCell>
                      <TableCell className="text-muted-foreground">{tool.version ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">
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

  return <ToolsPage tenantId={selectedTenantId} />;
}
