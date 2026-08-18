// The workbench Plugins section (CL-6215, following CL-6099 workstream 1):
// a marketplace-style directory, not a grid of cards — one row per
// registered TOOL/plugin connector (Granola, Exa, Linear, GitHub,
// ScrapeCreators, ...), with provenance ("Inherited" vs owned here) straight
// from `@workbench/connections/plugins`'s `listPluginsForTenant` — the same
// chain-aware resolver the global Connections settings section and the
// Plugins gallery both already read, so this view can never disagree with
// theirs about what "inherited" means. A connected-here plugin can be
// removed; an inherited one can be overridden by connecting this
// workbench's own key, which shadows the ancestor's from that point on.
// "Active" (connected here or inherited) lists first; "Available" (nothing
// connected anywhere) lists below — plugins can be added at any time, so
// the page always shows the full catalog, not just what's already wired up.
//
// `listPluginsForTenant`'s registry also carries the inference-provider
// connectors (Anthropic, OpenAI, Groq, Ollama, Opencode Zen, ...) — those
// now live only in Shared Settings' Connections section, never here.
// `feedsTools` is the one field that tells the two apart: every tool/plugin
// connector names at least one tool package it feeds; every inference
// provider names none (see `packages/connections/src/registry.ts`).
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
import type { ConnectorDescriptor } from "@workbench/connections/registry";
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
  return plugin.status !== "not_connected" && plugin.provenance === "this-workbench";
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

/** Every registered tool connector, split into what's already active
 * (connected here or inherited from an ancestor workbench) and what's
 * merely available to add — the marketplace framing the owner asked for:
 * plugins can be added at any time, so the catalog is always the whole
 * list, not just what's wired up. */
export function splitPluginDirectory(plugins: readonly ResolvedPlugin[]): {
  readonly active: readonly ResolvedPlugin[];
  readonly available: readonly ResolvedPlugin[];
} {
  return {
    active: plugins.filter((plugin) => plugin.status !== "not_connected"),
    available: plugins.filter((plugin) => plugin.status === "not_connected"),
  };
}

function matchesQuery(plugin: ResolvedPlugin, query: string): boolean {
  if (query === "") return true;
  const haystack =
    `${plugin.descriptor.displayName} ${plugin.descriptor.description ?? ""}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function PluginLogo({
  descriptor,
}: {
  readonly descriptor: ConnectorDescriptor;
}) {
  if (descriptor.icon !== undefined) {
    return (
      <span className="plugins-directory-logo" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill={`#${descriptor.icon.hex}`}
        >
          <path d={descriptor.icon.path} />
        </svg>
      </span>
    );
  }
  return (
    <span
      className="plugins-directory-logo plugins-directory-logo-initial"
      aria-hidden="true"
    >
      {descriptor.displayName.charAt(0).toUpperCase()}
    </span>
  );
}

function PluginRow({
  plugin,
  onConnect,
  onRemove,
}: {
  readonly plugin: ResolvedPlugin;
  readonly onConnect: (plugin: ResolvedPlugin) => void;
  readonly onRemove: (plugin: ResolvedPlugin) => void;
}) {
  return (
    <div className="plugins-directory-row">
      <PluginLogo descriptor={plugin.descriptor} />
      <div className="plugins-directory-text">
        <div className="plugins-directory-name-row">
          <span className="plugins-directory-name">
            {plugin.descriptor.displayName}
          </span>
          {needsAttention(plugin) ? (
            <span className="plugins-directory-needs-attention">
              Needs attention
            </span>
          ) : isInherited(plugin) ? (
            <span className="plugins-directory-ownership">Inherited</span>
          ) : null}
        </div>
        {plugin.descriptor.description !== undefined ? (
          <p className="plugins-directory-description">
            {plugin.descriptor.description}
          </p>
        ) : null}
      </div>
      <div className="plugins-directory-action">
        {ownedHere(plugin) ? (
          <ConfirmButton
            variant="ghost"
            size="sm"
            className="plugins-directory-remove-action"
            confirmLabel="Click again to remove"
            onConfirm={() => onRemove(plugin)}
          >
            Remove
          </ConfirmButton>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="plugins-directory-connect-action"
            onClick={() => onConnect(plugin)}
          >
            {plugin.provenance === "inherited" ? "Override" : "Connect"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function PluginsSection({
  tenantId,
}: {
  readonly tenantId: string;
}) {
  const [query, setQuery] = useState<APIQuery<readonly ResolvedPlugin[]>>({
    kind: "loading",
  });
  const [rowError, setRowError] = useState<string | null>(null);
  const [connectTarget, setConnectTarget] = useState<ResolvedPlugin | null>(
    null,
  );
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

  useEffect(load, [tenantId]);

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

  return (
    <QueryView query={query} label="Plugins">
      {(plugins) => {
        const filtered = plugins.filter((plugin) => matchesQuery(plugin, search));
        const { active, available } = splitPluginDirectory(filtered);
        return (
          <div className="channel-settings-pane plugins-directory">
            <p className="chat-settings-field-hint">
              Connections added here are used only by this workbench.
              Inference provider keys live in Shared Settings, not here.
            </p>
            {rowError !== null ? (
              <p className="chat-dialog-error" role="alert">
                {rowError}
              </p>
            ) : null}
            <Input
              className="plugins-directory-search"
              placeholder="Search plugins"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search plugins"
            />
            {active.length === 0 && available.length === 0 ? (
              <p className="chat-settings-field-hint">
                No plugins match &ldquo;{search}&rdquo;.
              </p>
            ) : null}
            {active.length > 0 ? (
              <div className="plugins-directory-group">
                <div className="plugins-directory-group-label">Active</div>
                <div className="plugins-directory-list">
                  {active.map((plugin) => (
                    <PluginRow
                      key={plugin.descriptor.id}
                      plugin={plugin}
                      onConnect={setConnectTarget}
                      onRemove={handleRemove}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {available.length > 0 ? (
              <div className="plugins-directory-group">
                <div className="plugins-directory-group-label">Available</div>
                <div className="plugins-directory-list">
                  {available.map((plugin) => (
                    <PluginRow
                      key={plugin.descriptor.id}
                      plugin={plugin}
                      onConnect={setConnectTarget}
                      onRemove={handleRemove}
                    />
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
