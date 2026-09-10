// Curated MCP preset rows (CL-6152): verified OAuth/DCR and keyless services
// get the catalog's one-click installation path. Presets and previously
// connected custom servers share the same server-side store.

import { reportError } from "@corbits/error-sink";
import { Button, toast } from "@corbits/react-ui";
import {
  CONNECTOR_REGISTRY,
  MCP_PRESETS,
} from "@workbench/templates/connectors";
import { useEffect, useState } from "react";

import {
  connectMcpPreset,
  listMcpPresets,
  mcpOAuthStartPath,
  type McpPreset,
} from "./mcp-servers-api";
import { PluginLogo } from "./plugin-logo";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const MCP_OAUTH_ERROR_COPY: Readonly<Record<string, string>> = {
  discovery_failed: "Couldn't reach that app's sign-in. Try connecting again.",
  client_rejected:
    "That app didn't accept Workbench as a client (redirect URL or registration). Try connecting again.",
  no_authorization_needed:
    "That app didn't start a sign-in. Try connecting again.",
  state_expired:
    "The connection took too long or was already used. Try connecting again.",
  state_mismatch: "The connection was interrupted. Try connecting again.",
  exchange_failed: "That app didn't hand back a token. Try connecting again.",
  connect_failed: "Couldn't finish connecting. Try connecting again.",
  setup_failed:
    "The sign-in worked, but storing the connection failed. Try connecting again.",
  not_found: "That app isn't in this catalog.",
  bad_request: "This app doesn't connect with a sign-in here.",
};

function mcpOauthReturnError(slug: string): string | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get("mcpOauth") !== slug) return null;
  if (params.get("outcome") !== "error") return null;
  const code = params.get("code");
  return (
    (code !== null ? MCP_OAUTH_ERROR_COPY[code] : undefined) ??
    "The connection did not finish. Try connecting again."
  );
}

function mcpOauthConnectedReturn():
  { readonly slug: string; readonly toolCount: number } | undefined {
  const params = new URLSearchParams(window.location.search);
  if (params.get("outcome") !== "connected") return undefined;
  const slug = params.get("mcpOauth");
  const raw = params.get("toolCount");
  if (slug === null || slug === "" || raw === null || raw === "") {
    return undefined;
  }
  const toolCount = Number(raw);
  if (!Number.isInteger(toolCount) || toolCount < 0) return undefined;
  return { slug, toolCount };
}

export function McpPresetCard({
  tenantId,
  preset,
  toolCount,
  onChanged,
  onOpen,
}: {
  readonly tenantId: string;
  readonly preset: McpPreset;
  readonly toolCount: number | undefined;
  readonly onChanged: (toolCount?: number) => void;
  readonly onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    mcpOauthReturnError(preset.slug),
  );
  function submitConnect() {
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

  function handleConnect(trigger: HTMLButtonElement) {
    if (preset.connectionMode === "oauth") {
      window.location.href = mcpOAuthStartPath(tenantId, preset.slug);
      return;
    }
    if (preset.connectionMode === "token") {
      onOpen(trigger);
      return;
    }
    submitConnect();
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
      className="min-w-0 px-2 py-2.5"
      data-plugin-card
      data-plugin-name={preset.displayName}
      data-plugin-slug={preset.slug}
    >
      <div className="flex min-h-11 min-w-0 items-center gap-3">
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
        <div className="flex flex-none items-center gap-2">
          <span className="text-xs text-muted-foreground">{status}</span>
          {preset.connected ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Manage ${preset.displayName}`}
              onClick={(event) => onOpen(event.currentTarget)}
            >
              Manage
              <span className="sr-only"> {preset.displayName}</span>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={`Connect ${preset.displayName}`}
              onClick={(event) => handleConnect(event.currentTarget)}
            >
              {busy ? "Connecting…" : "Connect"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function useMcpPresetCatalog(tenantId: string) {
  const [presets, setPresets] = useState<readonly McpPreset[]>([]);
  const [toolCounts, setToolCounts] = useState<ReadonlyMap<string, number>>(
    () => {
      const returned = mcpOauthConnectedReturn();
      return returned === undefined
        ? new Map()
        : new Map([[returned.slug, returned.toolCount]]);
    },
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    listMcpPresets(tenantId)
      .then((data) => {
        if (!cancelled) {
          setPresets(data);
          setLoadError(null);
        }
      })
      .catch((cause: unknown) => {
        reportError(cause, {
          operation: "plugins.catalog.load-presets",
          tenantId,
        });
        if (!cancelled) {
          setPresets([]);
          setLoadError(messageOf(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, reloadKey]);

  function handleChanged(slug: string, toolCount: number | undefined) {
    if (toolCount !== undefined) {
      setToolCounts((current) => new Map(current).set(slug, toolCount));
    }
    setReloadKey((key) => key + 1);
  }

  return { presets, toolCounts, loaded, loadError, handleChanged };
}
