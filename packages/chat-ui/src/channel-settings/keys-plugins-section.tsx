// The workbench "Keys & plugins" section (CL-6099 workstream 1): every
// registered connector's status for this exact workbench tenant, with
// provenance ("Set here" vs "Workbench default") straight from
// `@workbench/connections/plugins`'s `listPluginsForTenant` — the same
// chain-aware resolver the global Connections settings section and the
// Plugins gallery both already read, so this view can never disagree with
// theirs about what "inherited" means. A connected-here plugin can be
// removed; an inherited one can be overridden by connecting this
// workbench's own key, which shadows the ancestor's from that point on.

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
  KeysPluginsApiError,
  removeWorkbenchCredential,
  testConnectorCredential,
} from "./keys-plugins-api";

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof KeysPluginsApiError ? cause.message : fallback;
}

export function KeysPluginsSection({
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
      .then((plugins) => setQuery({ kind: "ready", data: plugins }))
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
    <QueryView query={query} label="Keys & plugins">
      {(plugins) => (
        <div className="channel-settings-pane">
          <p className="chat-settings-field-hint">
            A key connected here belongs to this workbench alone. Anything not
            connected here is the workbench default — connect your own key to
            override it.
          </p>
          {rowError !== null ? (
            <p className="chat-dialog-error" role="alert">
              {rowError}
            </p>
          ) : null}
          <div className="settings-connections-grid">
            {plugins.map((plugin) => (
              <div
                key={plugin.descriptor.id}
                className="settings-connection-card"
              >
                <span className="settings-connection-card-title">
                  {plugin.descriptor.displayName}
                </span>
                <Badge
                  tone={
                    plugin.status === "connected"
                      ? "success"
                      : plugin.status === "needs_attention"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {plugin.status === "connected"
                    ? "Connected"
                    : plugin.status === "needs_attention"
                      ? "Needs attention"
                      : "Not connected"}
                </Badge>
                {plugin.provenance !== null ? (
                  <Badge
                    tone={
                      plugin.provenance === "this-workbench"
                        ? "success"
                        : "neutral"
                    }
                  >
                    {plugin.provenance === "this-workbench"
                      ? "Set here"
                      : "Workbench default"}
                  </Badge>
                ) : null}
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
            ))}
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
