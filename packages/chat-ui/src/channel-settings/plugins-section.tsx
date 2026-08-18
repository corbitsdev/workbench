// The workbench Plugins section (CL-6215, following CL-6099 workstream 1;
// extended by CL-6261/CL-6256): a marketplace-style directory, not a grid
// of cards — one row per registered TOOL/plugin connector (Granola, Exa,
// Linear, GitHub, ScrapeCreators, ...), with provenance ("Inherited" vs
// owned here) straight from `@workbench/connections/plugins`'s
// `listPluginsForTenant` — the same chain-aware resolver the global
// Connections settings section and the Plugins gallery both already read,
// so this view can never disagree with theirs about what "inherited"
// means. A connected-here plugin can be removed; an inherited one can be
// overridden by connecting this workbench's own key, which shadows the
// ancestor's from that point on. "Active" (connected here or inherited)
// lists first; "Available" (nothing connected anywhere) lists below —
// plugins can be added at any time, so the page always shows the full
// catalog, not just what's already wired up.
//
// `listPluginsForTenant`'s registry also carries the inference-provider
// connectors (Anthropic, OpenAI, Groq, Ollama, Opencode Zen, ...) — those
// now live only in Shared Settings' Connections section, never here.
// `feedsTools` is the one field that tells the two apart: every tool/plugin
// connector names at least one tool package it feeds; every inference
// provider names none (see `packages/connections/src/registry.ts`).
//
// CL-6261 adds "any MCP server, dynamically": a person can paste a full
// MCP endpoint URL and, once the server-side probe (`mcp-probe.ts`) proves
// it's real — detecting either OAuth+DCR support or plain API-key/open
// access — it becomes a row here exactly like any curated connector. A
// curated MCP preset (Granola, Exa, Linear, ScrapeCreators, Sumble —
// `mcp-presets.ts`) and a hand-added server both resolve through the same
// `mcp-server-routes.ts` store; `directoryEntryFromMcpPreset` and
// `directoryEntryFromMcpServer` below only adapt each into the one
// `DirectoryEntry` shape this page already renders everything through —
// there is no second row-rendering path. CL-6256's roster names with no
// endpoint known-good or owner-supplied from here render as
// `directoryEntryFromSuggestion` rows instead: a name and a logo whose one
// action opens the same "Add MCP server" dialog, prefilled, rather than a
// Connect button pointed at nothing.
import {
  Button,
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
import {
  listPluginsForTenant,
  type ResolvedPlugin,
} from "@workbench/connections/plugins";
import { MCP_PRESET_CONNECTOR_IDS } from "@workbench/connections/mcp-presets";
import { MCP_SUGGESTIONS } from "@workbench/connections/mcp-suggestions";
import { useEffect, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import {
  completeConnectorCredential,
  PluginsApiError,
  removeWorkbenchCredential,
  testConnectorCredential,
} from "./plugins-api";
import {
  connectMcpPreset,
  connectMcpServer,
  disconnectMcpServer,
  listMcpPresets,
  listMcpServers,
  mcpOAuthStartPath,
  mcpOAuthStartPathForServer,
  McpServersApiError,
  type McpPresetRow,
  type McpServer,
} from "./mcp-servers-api";

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof PluginsApiError ? cause.message : fallback;
}

function isToolConnector(plugin: ResolvedPlugin): boolean {
  return plugin.descriptor.feedsTools.length > 0;
}

/** Whether a plugin has anything to remove or override — a connected-here
 * credential can be removed outright; everything else (inherited, broken,
 * or never connected) only ever gets a Connect/Override action. */
function ownedHere(plugin: ResolvedPlugin): boolean {
  return (
    plugin.status !== "not_connected" && plugin.provenance === "this-workbench"
  );
}

/** Needs-attention is the one colored state on this page (owner rule: grey
 * is for text/structure, orange is the only accent, and it only ever marks
 * something to act on) — everything else, including ownership, reads as
 * plain caption text. */
function needsAttention(plugin: ResolvedPlugin): boolean {
  return plugin.status === "needs_attention";
}

function isInherited(plugin: ResolvedPlugin): boolean {
  return plugin.status !== "not_connected" && plugin.provenance === "inherited";
}

/** The one row shape this whole directory renders through, regardless of
 * whether the entry came from the static connector registry, a curated MCP
 * preset, a hand-added MCP server, or a roster suggestion with no endpoint
 * yet — CL-6261's "dynamic and curated entries share the same row shape,
 * no parallel path" rule, made concrete as a type every adapter below
 * produces and `PluginRow` is the only thing that reads. */
type DirectoryEntry = {
  readonly key: string;
  readonly displayName: string;
  readonly description?: string;
  readonly icon?: { readonly path: string; readonly hex: string };
  readonly status: "connected" | "needs_attention" | "not_connected";
  readonly inherited: boolean;
  /** A connected-here entry that this page can remove outright — an
   * inherited connector, a suggestion, or a not-yet-connected preset never
   * is. */
  readonly removable: boolean;
  readonly connectLabel: string;
  readonly onConnect: () => void;
  readonly onRemove: () => void;
};

function directoryEntryFromResolvedPlugin(
  plugin: ResolvedPlugin,
  onConnect: (plugin: ResolvedPlugin) => void,
  onRemove: (plugin: ResolvedPlugin) => void,
): DirectoryEntry {
  return {
    key: `connector:${plugin.descriptor.id}`,
    displayName: plugin.descriptor.displayName,
    ...(plugin.descriptor.description !== undefined
      ? { description: plugin.descriptor.description }
      : {}),
    ...(plugin.descriptor.icon !== undefined
      ? { icon: plugin.descriptor.icon }
      : {}),
    status: needsAttention(plugin)
      ? "needs_attention"
      : plugin.status === "not_connected"
        ? "not_connected"
        : "connected",
    inherited: isInherited(plugin),
    removable: ownedHere(plugin),
    connectLabel: plugin.provenance === "inherited" ? "Override" : "Connect",
    onConnect: () => onConnect(plugin),
    onRemove: () => onRemove(plugin),
  };
}

function directoryEntryFromMcpServer(
  server: McpServer,
  onRemove: (server: McpServer) => void,
): DirectoryEntry {
  return {
    key: `mcp-server:${server.slug}`,
    displayName: server.name,
    description: server.url,
    status: "connected",
    inherited: false,
    removable: true,
    connectLabel: "Connect",
    onConnect: () => undefined,
    onRemove: () => onRemove(server),
  };
}

function directoryEntryFromMcpPreset(
  preset: McpPresetRow,
  onConnect: (preset: McpPresetRow) => void,
  onRemove: (preset: McpPresetRow) => void,
): DirectoryEntry {
  return {
    key: `mcp-preset:${preset.slug}`,
    displayName: preset.displayName,
    description: preset.description,
    status: preset.connected ? "connected" : "not_connected",
    inherited: false,
    removable: preset.connected,
    connectLabel: "Connect",
    onConnect: () => onConnect(preset),
    onRemove: () => onRemove(preset),
  };
}

function directoryEntryFromSuggestion(
  suggestion: (typeof MCP_SUGGESTIONS)[number],
  onConnect: (suggestion: (typeof MCP_SUGGESTIONS)[number]) => void,
): DirectoryEntry {
  return {
    key: `mcp-suggestion:${suggestion.slug}`,
    displayName: suggestion.displayName,
    description: "Available via Add MCP server.",
    ...(suggestion.icon !== undefined ? { icon: suggestion.icon } : {}),
    status: "not_connected",
    inherited: false,
    removable: false,
    connectLabel: "Connect",
    onConnect: () => onConnect(suggestion),
    onRemove: () => undefined,
  };
}

/** Every directory entry, split into what's already active (connected here
 * or inherited from an ancestor workbench) and what's merely available to
 * add — the marketplace framing the owner asked for: plugins can be added
 * at any time, so the catalog is always the whole list, not just what's
 * wired up. Generic so the same split serves `ResolvedPlugin`s (existing
 * tests) and the unified `DirectoryEntry` this page renders. */
export function splitPluginDirectory<T extends { readonly status: string }>(
  plugins: readonly T[],
): {
  readonly active: readonly T[];
  readonly available: readonly T[];
} {
  return {
    active: plugins.filter((plugin) => plugin.status !== "not_connected"),
    available: plugins.filter((plugin) => plugin.status === "not_connected"),
  };
}

function matchesQuery(entry: DirectoryEntry, query: string): boolean {
  if (query === "") return true;
  const haystack =
    `${entry.displayName} ${entry.description ?? ""}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function EntryLogo({ entry }: { readonly entry: DirectoryEntry }) {
  if (entry.icon !== undefined) {
    return (
      <span className="plugins-directory-logo" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill={`#${entry.icon.hex}`}
        >
          <path d={entry.icon.path} />
        </svg>
      </span>
    );
  }
  return (
    <span
      className="plugins-directory-logo plugins-directory-logo-initial"
      aria-hidden="true"
    >
      {entry.displayName.charAt(0).toUpperCase()}
    </span>
  );
}

function PluginRow({ entry }: { readonly entry: DirectoryEntry }) {
  return (
    <div className="plugins-directory-row">
      <EntryLogo entry={entry} />
      <div className="plugins-directory-text">
        <div className="plugins-directory-name-row">
          <span className="plugins-directory-name">{entry.displayName}</span>
          {entry.status === "needs_attention" ? (
            <span className="plugins-directory-needs-attention">
              Needs attention
            </span>
          ) : entry.inherited ? (
            <span className="plugins-directory-ownership">Inherited</span>
          ) : null}
        </div>
        {entry.description !== undefined ? (
          <p className="plugins-directory-description">{entry.description}</p>
        ) : null}
      </div>
      <div className="plugins-directory-action">
        {entry.removable ? (
          <ConfirmButton
            variant="ghost"
            size="sm"
            className="plugins-directory-remove-action"
            confirmLabel="Click again to remove"
            onConfirm={entry.onRemove}
          >
            Remove
          </ConfirmButton>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="plugins-directory-connect-action"
            onClick={entry.onConnect}
          >
            {entry.connectLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

/** What `AddMcpServerDialog` is doing — a hand-typed server (name and URL
 * both editable, optionally prefilled with a suggestion's name), or a
 * curated preset (name and URL fixed, only the token field is live). Both
 * branches end at the same probe-then-store route; this only decides which
 * fields the dialog shows and which client call it makes. */
type AddMcpServerTarget =
  | { readonly kind: "custom"; readonly initialName: string }
  | { readonly kind: "preset"; readonly preset: McpPresetRow };

export function PluginsSection({ tenantId }: { readonly tenantId: string }) {
  const [query, setQuery] = useState<APIQuery<readonly ResolvedPlugin[]>>({
    kind: "loading",
  });
  const [mcpServers, setMcpServers] = useState<readonly McpServer[]>([]);
  const [mcpPresets, setMcpPresets] = useState<readonly McpPresetRow[]>([]);
  const [rowError, setRowError] = useState<string | null>(null);
  const [connectTarget, setConnectTarget] = useState<ResolvedPlugin | null>(
    null,
  );
  const [addServerTarget, setAddServerTarget] =
    useState<AddMcpServerTarget | null>(null);
  const [search, setSearch] = useState("");

  function load() {
    setQuery({ kind: "loading" });
    listPluginsForTenant(tenantId)
      .then((plugins) =>
        setQuery({ kind: "ready", data: plugins.filter(isToolConnector) }),
      )
      .catch((cause: unknown) => {
        if (cause instanceof UnauthenticatedError) {
          setQuery({ kind: "unauthenticated" });
          return;
        }
        setQuery({
          kind: "error",
          message: describeQueryError(cause),
          retry: load,
        });
      });
  }

  function loadMcp() {
    listMcpServers(tenantId)
      .then(setMcpServers)
      .catch(() => undefined);
    listMcpPresets(tenantId)
      .then(setMcpPresets)
      .catch(() => undefined);
  }

  useEffect(load, [tenantId]);
  useEffect(loadMcp, [tenantId]);

  function handleRemove(plugin: ResolvedPlugin) {
    if (plugin.credentialId === null) return;
    setRowError(null);
    removeWorkbenchCredential(tenantId, plugin.credentialId)
      .then(() => {
        load();
        toast(`Removed ${plugin.descriptor.displayName} from this workbench.`);
      })
      .catch((cause: unknown) =>
        setRowError(errorMessage(cause, "Couldn't remove that connection.")),
      );
  }

  function handleRemoveMcpServer(server: McpServer) {
    setRowError(null);
    disconnectMcpServer(tenantId, server.slug)
      .then(() => {
        loadMcp();
        toast(`${server.name} disconnected.`);
      })
      .catch(() => setRowError("Couldn't disconnect — try again."));
  }

  function handleRemoveMcpPreset(preset: McpPresetRow) {
    setRowError(null);
    disconnectMcpServer(tenantId, preset.slug)
      .then(() => {
        loadMcp();
        toast(`${preset.displayName} disconnected.`);
      })
      .catch(() => setRowError("Couldn't disconnect — try again."));
  }

  function handleConnectMcpPreset(preset: McpPresetRow) {
    if (!preset.keyOptional) {
      setAddServerTarget({ kind: "preset", preset });
      return;
    }
    setRowError(null);
    connectMcpPreset(tenantId, preset.slug, undefined)
      .then((result) => {
        loadMcp();
        toast(
          `Connected — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available.`,
        );
      })
      .catch((cause: unknown) => {
        if (
          cause instanceof McpServersApiError &&
          cause.code === "oauth_required"
        ) {
          window.location.href = mcpOAuthStartPath(tenantId, preset.slug);
          return;
        }
        setAddServerTarget({ kind: "preset", preset });
      });
  }

  return (
    <QueryView query={query} label="Plugins">
      {(plugins) => {
        const connectorEntries = plugins
          .filter(
            (plugin) =>
              !MCP_PRESET_CONNECTOR_IDS.includes(plugin.descriptor.id),
          )
          .map((plugin) =>
            directoryEntryFromResolvedPlugin(
              plugin,
              setConnectTarget,
              handleRemove,
            ),
          );
        const mcpServerSlugs = new Set(mcpServers.map((server) => server.slug));
        const mcpServerEntries = mcpServers.map((server) =>
          directoryEntryFromMcpServer(server, handleRemoveMcpServer),
        );
        const presetEntries = mcpPresets.map((preset) =>
          directoryEntryFromMcpPreset(
            preset,
            handleConnectMcpPreset,
            handleRemoveMcpPreset,
          ),
        );
        const suggestionEntries = MCP_SUGGESTIONS.filter(
          (suggestion) => !mcpServerSlugs.has(suggestion.slug),
        ).map((suggestion) =>
          directoryEntryFromSuggestion(suggestion, (picked) =>
            setAddServerTarget({
              kind: "custom",
              initialName: picked.displayName,
            }),
          ),
        );
        const allEntries = [
          ...connectorEntries,
          ...presetEntries,
          ...mcpServerEntries,
          ...suggestionEntries,
        ];
        const filtered = allEntries.filter((entry) =>
          matchesQuery(entry, search),
        );
        const { active, available } = splitPluginDirectory(filtered);
        return (
          <div className="channel-settings-pane plugins-directory">
            <p className="chat-settings-field-hint">
              Connections added here are used only by this workbench. Inference
              provider keys live in Shared Settings, not here.
            </p>
            {rowError !== null ? (
              <p className="chat-dialog-error" role="alert">
                {rowError}
              </p>
            ) : null}
            <div className="plugins-directory-toolbar">
              <Input
                className="plugins-directory-search"
                placeholder="Search plugins"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Search plugins"
              />
              <Button
                variant="ghost"
                size="sm"
                className="plugins-directory-add-mcp-action"
                onClick={() =>
                  setAddServerTarget({ kind: "custom", initialName: "" })
                }
              >
                Add MCP server
              </Button>
            </div>
            {active.length === 0 && available.length === 0 ? (
              <p className="chat-settings-field-hint">
                No plugins match &ldquo;{search}&rdquo;.
              </p>
            ) : null}
            {active.length > 0 ? (
              <div className="plugins-directory-group">
                <div className="plugins-directory-group-label">Active</div>
                <div className="plugins-directory-list">
                  {active.map((entry) => (
                    <PluginRow key={entry.key} entry={entry} />
                  ))}
                </div>
              </div>
            ) : null}
            {available.length > 0 ? (
              <div className="plugins-directory-group">
                <div className="plugins-directory-group-label">Available</div>
                <div className="plugins-directory-list">
                  {available.map((entry) => (
                    <PluginRow key={entry.key} entry={entry} />
                  ))}
                </div>
              </div>
            ) : null}

            <ConnectDialog
              tenantId={tenantId}
              plugin={connectTarget}
              onClose={() => setConnectTarget(null)}
              onConnected={() => {
                setConnectTarget(null);
                load();
              }}
            />
            <AddMcpServerDialog
              tenantId={tenantId}
              target={addServerTarget}
              onClose={() => setAddServerTarget(null)}
              onConnected={() => {
                setAddServerTarget(null);
                loadMcp();
              }}
            />
          </div>
        );
      }}
    </QueryView>
  );
}

function ConnectDialog({
  tenantId,
  plugin,
  onClose,
  onConnected,
}: {
  readonly tenantId: string;
  readonly plugin: ResolvedPlugin | null;
  readonly onClose: () => void;
  readonly onConnected: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setApiKey("");
    setSubmitting(false);
    setError(null);
  }, [plugin]);

  function handleSubmit() {
    if (plugin === null || apiKey.trim() === "") return;
    setSubmitting(true);
    setError(null);
    testConnectorCredential(tenantId, plugin.descriptor.id, apiKey)
      .then((result) => {
        if (!result.ok) {
          setError(result.message);
          return;
        }
        return completeConnectorCredential(
          tenantId,
          plugin.descriptor.id,
          apiKey,
        ).then(() => {
          toast(
            `Connected ${plugin.descriptor.displayName} for this workbench.`,
          );
          onConnected();
        });
      })
      .catch((cause: unknown) =>
        setError(errorMessage(cause, "Couldn't save that key.")),
      )
      .finally(() => setSubmitting(false));
  }

  return (
    <Dialog
      open={plugin !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {plugin === null
              ? ""
              : plugin.provenance === "inherited"
                ? `Override ${plugin.descriptor.displayName} for this workbench`
                : `Connect ${plugin.descriptor.displayName}`}
          </DialogTitle>
          <DialogDescription>
            This key is only used for this workbench.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="settings-form-stack">
          <label className="settings-form-field">
            <span>API key</span>
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setError(null);
              }}
              autoComplete="off"
            />
          </label>
          {error !== null ? (
            <p className="settings-inline-error" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={apiKey.trim() === "" || submitting}
            onClick={handleSubmit}
          >
            {submitting ? "Saving…" : "Test & Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The "Add MCP server" dialog CL-6261 asks for: paste a full endpoint URL
 * (never truncated to origin — a bare origin dies at the CDN, the CloudFront
 * lesson `mcp-server-routes.ts` already documents) and the server-side probe
 * decides what happens next. Doubles as the curated-preset connect dialog
 * (`target.kind === "preset"`) so a preset needing a token — unlike Exa,
 * which connects with one click — gets the exact same field, never a second
 * form. */
function AddMcpServerDialog({
  tenantId,
  target,
  onClose,
  onConnected,
}: {
  readonly tenantId: string;
  readonly target: AddMcpServerTarget | null;
  readonly onClose: () => void;
  readonly onConnected: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target === null) return;
    setName(
      target.kind === "preset" ? target.preset.displayName : target.initialName,
    );
    setUrl(target.kind === "preset" ? target.preset.url : "");
    setToken("");
    setError(null);
    setSubmitting(false);
  }, [target]);

  function handleSubmit() {
    if (target === null) return;
    if (target.kind === "custom" && (name.trim() === "" || url.trim() === "")) {
      return;
    }
    setSubmitting(true);
    setError(null);
    const trimmedToken = token.trim();
    const connect =
      target.kind === "preset"
        ? connectMcpPreset(
            tenantId,
            target.preset.slug,
            trimmedToken === "" ? undefined : trimmedToken,
          )
        : connectMcpServer(tenantId, {
            name: name.trim(),
            url: url.trim(),
            token: trimmedToken === "" ? undefined : trimmedToken,
          });
    connect
      .then((result) => {
        toast(
          `Connected — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available.`,
        );
        onConnected();
      })
      .catch((cause: unknown) => {
        if (
          cause instanceof McpServersApiError &&
          cause.code === "oauth_required"
        ) {
          window.location.href =
            target.kind === "preset"
              ? mcpOAuthStartPath(tenantId, target.preset.slug)
              : mcpOAuthStartPathForServer(tenantId, name.trim(), url.trim());
          return;
        }
        setError(
          cause instanceof McpServersApiError
            ? cause.message
            : "Couldn't connect that MCP server.",
        );
      })
      .finally(() => setSubmitting(false));
  }

  const isPreset = target?.kind === "preset";

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isPreset && target?.kind === "preset"
              ? `Connect ${target.preset.displayName}`
              : "Add MCP server"}
          </DialogTitle>
          <DialogDescription>
            {isPreset
              ? "This key is only used for this workbench."
              : "Paste any MCP server's full endpoint URL — its tools become available to every agent here once it checks out."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="settings-form-stack">
          {!isPreset ? (
            <>
              <label className="settings-form-field">
                <span>Name</span>
                <Input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setError(null);
                  }}
                />
              </label>
              <label className="settings-form-field">
                <span>URL</span>
                <Input
                  type="url"
                  placeholder="https://example.com/mcp"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setError(null);
                  }}
                />
              </label>
            </>
          ) : null}
          <label className="settings-form-field">
            <span>
              Access token
              {!isPreset ||
              (target?.kind === "preset" && target.preset.keyOptional)
                ? " (optional)"
                : ""}
            </span>
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
            <p className="settings-inline-error" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              submitting ||
              (target?.kind === "custom" &&
                (name.trim() === "" || url.trim() === ""))
            }
            onClick={handleSubmit}
          >
            {submitting ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
