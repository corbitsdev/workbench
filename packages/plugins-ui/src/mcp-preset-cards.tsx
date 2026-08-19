// Curated MCP preset rows (CL-6152): verified OAuth/DCR and keyless services
// get the catalog's one-click installation path. Presets and previously
// connected custom servers share the same server-side store.

import { Button, ConfirmButton, toast } from "@corbits/react-ui";
import { CONNECTOR_REGISTRY } from "@workbench/connections/registry";
import { MCP_PRESETS } from "@workbench/connections/mcp-presets";
import { useEffect, useState } from "react";

import {
  connectMcpPreset,
  disconnectMcpServer,
  listMcpPresets,
  mcpOAuthStartPath,
  type McpPreset,
} from "./mcp-servers-api";
import { PluginLogo } from "./plugin-logo";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function McpPresetCard({
  tenantId,
  preset,
  toolCount,
  onChanged,
}: {
  readonly tenantId: string;
  readonly preset: McpPreset;
  readonly toolCount: number | undefined;
  readonly onChanged: (toolCount?: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleConnect() {
    if (preset.connectionMode === "oauth") {
      window.location.href = mcpOAuthStartPath(tenantId, preset.slug);
      return;
    }
    setBusy(true);
    setError(null);
    connectMcpPreset(tenantId, preset.slug, undefined)
      .then((result) => {
        toast(
          `Connected — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available.`,
        );
        onChanged(result.toolCount);
      })
      .catch((cause: unknown) => setError(messageOf(cause)))
      .finally(() => setBusy(false));
  }

  function handleDisconnect() {
    setBusy(true);
    setError(null);
    disconnectMcpServer(tenantId, preset.slug)
      .then(() => {
        toast(`${preset.displayName} disconnected.`);
        onChanged();
      })
      .catch(() => setError("Couldn't disconnect — try again."))
      .finally(() => setBusy(false));
  }

  const presetDefinition = MCP_PRESETS.find(
    (definition) => definition.slug === preset.slug,
  );
  const connector =
    presetDefinition?.nativeConnectorId === undefined
      ? undefined
      : CONNECTOR_REGISTRY[presetDefinition.nativeConnectorId];
  const status = preset.connected
    ? toolCount === undefined
      ? "Connected"
      : `${toolCount} tool${toolCount === 1 ? "" : "s"}`
    : "Not connected";

  return (
    <div
      className="flex min-h-16 min-w-0 items-center gap-3 border-b border-border px-2 py-2.5"
      data-plugin-slug={preset.slug}
    >
      <PluginLogo
        name={preset.displayName}
        icon={preset.icon ?? connector?.icon}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">
          {preset.displayName}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {preset.description}
        </span>
        {error !== null ? (
          <span className="truncate text-xs text-destructive" role="alert">
            {error}
          </span>
        ) : null}
      </div>
      <span className="hidden shrink-0 text-xs text-muted-foreground xl:block">
        {status}
      </span>
      {preset.connected ? (
        <ConfirmButton
          variant="destructive"
          size="sm"
          confirmLabel="Disconnect"
          disabled={busy}
          onConfirm={handleDisconnect}
        >
          {busy ? "Disconnecting…" : "Disconnect"}
        </ConfirmButton>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={handleConnect}
        >
          {busy ? "Connecting…" : "Connect"}
        </Button>
      )}
    </div>
  );
}

export function McpPresetCardsSection({
  tenantId,
  query = "",
}: {
  readonly tenantId: string;
  readonly query?: string;
}) {
  const [presets, setPresets] = useState<readonly McpPreset[]>([]);
  const [toolCounts, setToolCounts] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  function reload() {
    listMcpPresets(tenantId)
      .then((data) => {
        setPresets(data);
        setLoadError(null);
      })
      .catch((cause: unknown) => setLoadError(messageOf(cause)));
  }

  useEffect(() => {
    reload();
  }, [tenantId]);

  const needle = query.trim().toLowerCase();
  const visiblePresets = presets.filter(
    (preset) =>
      needle === "" ||
      `${preset.displayName} ${preset.description}`
        .toLowerCase()
        .includes(needle),
  );

  if (visiblePresets.length === 0 && loadError === null) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Connect apps
      </h3>
      {loadError !== null ? (
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2 xl:grid-cols-3">
        {visiblePresets.map((preset) => (
          <McpPresetCard
            key={preset.slug}
            tenantId={tenantId}
            preset={preset}
            toolCount={toolCounts.get(preset.slug)}
            onChanged={(toolCount) => {
              if (toolCount !== undefined) {
                setToolCounts((prev) =>
                  new Map(prev).set(preset.slug, toolCount),
                );
              }
              reload();
            }}
          />
        ))}
      </div>
    </section>
  );
}
