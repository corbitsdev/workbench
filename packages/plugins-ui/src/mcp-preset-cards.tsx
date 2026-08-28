// Curated MCP preset rows (CL-6152): verified OAuth/DCR and keyless services
// get the catalog's one-click installation path. Presets and previously
// connected custom servers share the same server-side store.

import { Button, ConfirmButton, Input, toast } from "@corbits/react-ui";
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
import { PLUGINS_STRINGS } from "./strings";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const MCP_OAUTH_ERROR_COPY: Readonly<Record<string, string>> = {
  discovery_failed: "Couldn't reach that app's sign-in. Try connecting again.",
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
  const [error, setError] = useState<string | null>(() =>
    mcpOauthReturnError(preset.slug),
  );
  const [tokenFieldOpen, setTokenFieldOpen] = useState(false);
  const [token, setToken] = useState("");

  function submitConnect(pastedToken: string | undefined) {
    setBusy(true);
    setError(null);
    connectMcpPreset(tenantId, preset.slug, pastedToken)
      .then((result) => {
        toast(
          `Connected — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available.`,
        );
        setTokenFieldOpen(false);
        setToken("");
        onChanged(result.toolCount);
      })
      .catch((cause: unknown) => setError(messageOf(cause)))
      .finally(() => setBusy(false));
  }

  function handleConnect() {
    if (preset.connectionMode === "oauth") {
      window.location.href = mcpOAuthStartPath(tenantId, preset.slug);
      return;
    }
    if (preset.connectionMode === "token") {
      setTokenFieldOpen(true);
      return;
    }
    submitConnect(undefined);
  }

  function handleDisconnect() {
    setBusy(true);
    setError(null);
    disconnectMcpServer(tenantId, preset.slug)
      .then(() => {
        toast(`${preset.displayName} disconnected.`);
        onChanged();
      })
      .catch(() => setError(PLUGINS_STRINGS.disconnectError))
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

  const tokenFieldId = `mcp-preset-token-${preset.slug}`;

  return (
    <div
      className="border-b border-border px-2 py-2.5"
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
        <span className="hidden shrink-0 text-xs text-muted-foreground xl:block">
          {status}
        </span>
        {preset.connected ? (
          <ConfirmButton
            variant="destructive"
            size="sm"
            confirmLabel="Disconnect"
            disabled={busy}
            aria-label={`Disconnect ${preset.displayName}`}
            onConfirm={handleDisconnect}
          >
            {busy ? "Disconnecting…" : "Disconnect"}
          </ConfirmButton>
        ) : tokenFieldOpen ? null : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={`Connect ${preset.displayName}`}
            onClick={handleConnect}
          >
            {busy ? "Connecting…" : "Connect"}
          </Button>
        )}
      </div>
      {tokenFieldOpen && !preset.connected ? (
        <div className="mt-2 flex flex-col gap-2 pl-11">
          <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
            {(preset.tokenSteps ?? []).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <a
            href={preset.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs underline underline-offset-2"
          >
            Create your token
          </a>
          <label className="sr-only" htmlFor={tokenFieldId}>
            {`${preset.displayName} access token`}
          </label>
          <Input
            id={tokenFieldId}
            type="password"
            value={token}
            placeholder="Paste your access token"
            disabled={busy}
            onChange={(event) => {
              setToken(event.target.value);
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || token.trim() === ""}
              aria-label={`Connect ${preset.displayName}`}
              onClick={() => {
                submitConnect(token.trim());
              }}
            >
              {busy ? "Connecting…" : "Connect"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setTokenFieldOpen(false);
                setToken("");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function McpPresetCardsSection({
  tenantId,
  query = "",
  autoConnectSlug = null,
  onAutoConnectHandled,
}: {
  readonly tenantId: string;
  readonly query?: string;
  /** A preset slug named by a `/plugins?connect=mcp:<slug>` deep link
   * (CL-7141) — once the catalog has loaded, that preset's row gets
   * focused so a person lands on the right card without hunting for it.
   * Never auto-fires the connect action itself: connecting still takes
   * a person's own click, the same as every other card here. */
  readonly autoConnectSlug?: string | null;
  readonly onAutoConnectHandled?: () => void;
}) {
  const [presets, setPresets] = useState<readonly McpPreset[]>([]);
  const [toolCounts, setToolCounts] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  // Whether the presets fetch has resolved at least once — distinct from
  // "zero presets": this catalog is the same ~10 curated apps for every
  // tenant, so an empty `presets` array before this flips true is a
  // loading gap, never a real "nothing to connect" state (CL-6472). The
  // section used to `return null` whenever presets were empty regardless
  // of why, which let a load-in-progress render as if the whole catalog
  // had vanished — this component must never go quiet like that again.
  const [loaded, setLoaded] = useState(false);

  function reload() {
    listMcpPresets(tenantId)
      .then((data) => {
        setPresets(data);
        setLoadError(null);
      })
      .catch((cause: unknown) => setLoadError(messageOf(cause)))
      .finally(() => setLoaded(true));
  }

  useEffect(() => {
    reload();
  }, [tenantId]);

  useEffect(() => {
    if (!loaded || autoConnectSlug === null) return;
    if (presets.some((preset) => preset.slug === autoConnectSlug)) {
      const row = document.querySelector(
        `[data-plugin-slug="${autoConnectSlug}"] button`,
      );
      (row as HTMLButtonElement | null)?.focus();
    }
    onAutoConnectHandled?.();
  }, [loaded, autoConnectSlug, presets, onAutoConnectHandled]);

  const needle = query.trim().toLowerCase();
  const visiblePresets = presets.filter(
    (preset) =>
      needle === "" ||
      `${preset.displayName} ${preset.description}`
        .toLowerCase()
        .includes(needle),
  );

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Connect apps
      </h3>
      {loadError !== null ? (
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      ) : !loaded ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : visiblePresets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {presets.length === 0
            ? "No apps to connect right now."
            : `No app matches "${query.trim()}".`}
        </p>
      ) : (
        <div className="border border-border [&>*:last-child]:border-b-0">
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
      )}
    </section>
  );
}
