// The workbench Plugins section (CL-6215, following CL-6099 workstream 1):
// every registered TOOL/plugin connector's status for this exact workbench
// tenant (Granola, Exa, Linear, GitHub, ScrapeCreators, ...), with
// provenance ("Connected here" vs "Using shared key") straight from
// `@workbench/connections/plugins`'s `listPluginsForTenant` — the same
// chain-aware resolver the global Connections settings section and the
// Plugins gallery both already read, so this view can never disagree with
// theirs about what "inherited" means. A connected-here plugin can be
// removed; an inherited one can be overridden by connecting this
// workbench's own key, which shadows the ancestor's from that point on.
//
// `listPluginsForTenant`'s registry also carries the inference-provider
// connectors (Anthropic, OpenAI, Groq, Ollama, Opencode Zen, ...) — those
// now live only in Shared Settings' Connections section, never here.
// `feedsTools` is the one field that tells the two apart: every tool/plugin
// connector names at least one tool package it feeds; every inference
// provider names none (see `packages/connections/src/registry.ts`).
import {
  Badge,
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

/** One status per card, not two: an actionable problem ("Needs attention")
 * always wins, since it's the thing to act on regardless of whose key is
 * in use; otherwise a connected offering reads by provenance ("Connected
 * here" vs "Using shared key"), and nothing connected anywhere reads
 * "Not connected". Replaces the old two-badge layout (a connection-status
 * chip plus a separate "Set here"/"Workbench default" provenance chip) —
 * a person reading the card only ever needs the one word that matters. */
export function pluginCardStatus(plugin: ResolvedPlugin): {
  readonly label: string;
  readonly tone: "success" | "danger" | "neutral";
} {
  if (plugin.status === "needs_attention") {
    return { label: "Needs attention", tone: "danger" };
  }
  if (plugin.provenance === "this-workbench") {
    return { label: "Connected here", tone: "success" };
  }
  if (plugin.provenance === "inherited") {
    return { label: "Using shared key", tone: "neutral" };
  }
  return { label: "Not connected", tone: "neutral" };
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
      {(plugins) => (
        <div className="channel-settings-pane">
          <p className="chat-settings-field-hint">
            Connections added here are used only by this workbench. Inference
            provider keys live in Shared Settings, not here.
          </p>
          {rowError !== null ? (
            <p className="chat-dialog-error" role="alert">
              {rowError}
            </p>
          ) : null}
          <div className="settings-connections-grid">
            {plugins.map((plugin) => {
              const status = pluginCardStatus(plugin);
              return (
                <div
                  key={plugin.descriptor.id}
                  className="settings-connection-card"
                >
                  <span className="settings-connection-card-title">
                    {plugin.descriptor.displayName}
                  </span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <div className="settings-connection-card-actions">
                    {plugin.status !== "not_connected" &&
                    plugin.provenance === "this-workbench" ? (
                      <ConfirmButton
                        variant="destructive"
                        size="sm"
                        confirmLabel="Remove"
                        onConfirm={() => handleRemove(plugin)}
                      >
                        Remove
                      </ConfirmButton>
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setConnectTarget(plugin)}
                      >
                        {plugin.provenance === "inherited"
                          ? "Override"
                          : "Connect"}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

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
      )}
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
