// MCP servers (CL-6142): unlike the rest of the gallery, these aren't
// entries in the static `CONNECTOR_REGISTRY` grid — a tenant can connect
// any number of them, each named by whoever adds it — so this section
// owns its own fetch/connect/disconnect loop rather than routing through
// `ResolvedPlugin`/`PluginCard`'s static-registry rendering path.
//
// Catalog installation is intentionally handled only by curated presets.
// This section keeps already-connected custom servers manageable without
// advertising a URL/token form as an installation path.

import { ConfirmButton, toast } from "@corbits/react-ui";
import { MCP_PRESETS } from "@workbench/templates/connectors";
import { PuzzlePiece } from "@corbits/icons";
import { useEffect, useState } from "react";

import {
  disconnectMcpServer,
  listMcpServers,
  type McpServer,
} from "./mcp-servers-api";
import { PLUGINS_STRINGS } from "./strings";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
      .catch(() => setError(PLUGINS_STRINGS.disconnectError))
      .finally(() => setBusy(false));
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-2 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center border border-border text-muted-foreground"
        >
          <PuzzlePiece className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{server.name}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <ConfirmButton
          variant="destructive"
          size="sm"
          confirmLabel="Disconnect"
          disabled={busy}
          aria-label={`Disconnect ${server.name}`}
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

export function McpServersSection({ tenantId }: { readonly tenantId: string }) {
  const [servers, setServers] = useState<readonly McpServer[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

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
  }, [tenantId]);

  const presetSlugs = new Set(MCP_PRESETS.map((preset) => preset.slug));
  const customServers = servers.filter(
    (server) => !presetSlugs.has(server.slug),
  );

  if (customServers.length === 0 && loadError === null) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Connected custom servers
      </h3>
      {loadError !== null ? (
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      ) : null}
      <div className="border border-border [&>*:last-child]:border-b-0">
        {customServers.map((server) => (
          <ConnectedMcpServerRow
            key={server.slug}
            tenantId={tenantId}
            server={server}
            onChanged={reload}
          />
        ))}
      </div>
    </section>
  );
}
