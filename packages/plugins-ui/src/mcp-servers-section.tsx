// MCP servers (CL-6142): unlike the rest of the gallery, these aren't
// entries in the static `CONNECTOR_REGISTRY` grid — a tenant can connect
// any number of them, each named by whoever adds it — so this section
// owns its own fetch/connect/disconnect loop rather than routing through
// `ResolvedPlugin`/`PluginCard`'s static-registry rendering path.
//
// `autoOpenAdd` is the `/plugins?connect=mcp` deep link's landing spot
// (the "request a connection" tool hands a human this link when an agent
// asks for an MCP server that isn't connected yet) — the composing page
// reads the query string and passes the flag down; this component owns
// opening its own dialog off of it, same self-contained-card shape as
// `@corbits/settings-ui`'s `GranolaWebhookCard`.

import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  ConfirmButton,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  toast,
} from "@corbits/react-ui";
import { Plug, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import {
  connectMcpServer,
  disconnectMcpServer,
  listMcpServers,
  type McpServer,
} from "./mcp-servers-api";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function AddMcpServerDialog({
  tenantId,
  open,
  onOpenChange,
  onConnected,
}: {
  readonly tenantId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConnected: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setName("");
    setUrl("");
    setToken("");
    setError(null);
    setSubmitting(false);
  }, [open]);

  function handleSubmit() {
    setSubmitting(true);
    setError(null);
    const trimmedToken = token.trim();
    connectMcpServer(tenantId, {
      name: name.trim(),
      url: url.trim(),
      token: trimmedToken === "" ? undefined : trimmedToken,
    })
      .then((result) => {
        toast(
          `Connected — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available.`,
        );
        onConnected();
        onOpenChange(false);
      })
      .catch((cause: unknown) => setError(messageOf(cause)))
      .finally(() => setSubmitting(false));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent side="right">
        <DialogHeader>
          <DialogTitle>MCP server</DialogTitle>
          <DialogDescription>
            Connect any MCP server — its tools become available to every agent
            here.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Name
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            URL
            <Input
              type="url"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Access token (optional)
            <Input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setError(null);
              }}
            />
          </label>
          {error !== null ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={name.trim() === "" || url.trim() === "" || submitting}
            onClick={handleSubmit}
          >
            {submitting ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectedMcpServerRow({
  tenantId,
  server,
  onChanged,
}: {
  readonly tenantId: string;
  readonly server: McpServer;
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleDisconnect() {
    setBusy(true);
    setError(null);
    disconnectMcpServer(tenantId, server.slug)
      .then(() => {
        toast(`${server.name} disconnected.`);
        onChanged();
      })
      .catch(() => setError("Couldn't disconnect — try again."))
      .finally(() => setBusy(false));
  }

  return (
    <div className="flex items-center justify-between gap-3 border border-border p-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center border border-border text-muted-foreground"
        >
          <Plug className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{server.name}</span>
          <span className="truncate text-sm text-muted-foreground">
            {server.url}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <ConfirmButton
          variant="destructive"
          size="sm"
          confirmLabel="Disconnect"
          disabled={busy}
          onConfirm={handleDisconnect}
        >
          {busy ? "Disconnecting…" : "Disconnect"}
        </ConfirmButton>
        {error !== null ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function McpServersSection({
  tenantId,
  autoOpenAdd = false,
}: {
  readonly tenantId: string;
  readonly autoOpenAdd?: boolean;
}) {
  const [servers, setServers] = useState<readonly McpServer[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [autoOpenHandled, setAutoOpenHandled] = useState(false);

  function reload() {
    listMcpServers(tenantId)
      .then((data) => {
        setServers(data);
        setLoadError(null);
      })
      .catch((cause: unknown) => setLoadError(messageOf(cause)));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => {
    if (!autoOpenAdd || autoOpenHandled) return;
    setDialogOpen(true);
    setAutoOpenHandled(true);
  }, [autoOpenAdd, autoOpenHandled]);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        MCP servers
      </h3>
      {loadError !== null ? (
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {servers.map((server) => (
          <ConnectedMcpServerRow
            key={server.slug}
            tenantId={tenantId}
            server={server}
            onChanged={reload}
          />
        ))}
        <Card
          className="cursor-pointer flex-row items-center gap-3 p-4"
          role="button"
          tabIndex={0}
          onClick={() => setDialogOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setDialogOpen(true);
            }
          }}
        >
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center border border-border text-muted-foreground"
          >
            <Plus className="size-4" />
          </span>
          <div className="flex flex-col gap-1">
            <CardTitle>Add MCP server</CardTitle>
            <CardDescription>
              Connect any MCP server — its tools become available to every agent
              here.
            </CardDescription>
          </div>
        </Card>
      </div>
      <AddMcpServerDialog
        tenantId={tenantId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={reload}
      />
    </section>
  );
}
