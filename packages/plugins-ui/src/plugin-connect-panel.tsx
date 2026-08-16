// The one-flow connect surface (CL-6090): every plugin — OAuth, api-key, or
// Granola's key-plus-webhook combination — connects from this one
// right-docked panel, never a "create a routine first, then come back"
// detour. It reuses the exact mutations `@corbits/settings-ui`'s own
// Connections section already calls (`testConnectorCredential`,
// `completeConnectorCredential`, `deleteCredential`, `oauthStartHref`) and,
// for Granola's webhook half, mounts `GranolaWebhookCard` wholesale rather
// than forking its dialog — see that component's own header comment for
// why a routine picker is deliberately not offered when zero `granola-call`
// routines exist yet. That one remaining gap (an inline "set up the
// call-notes routine" affordance) is CL-6079's to close, not re-implemented
// here — see this package's CL-6090 report for the disposition.

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
  GranolaWebhookCard,
  completeConnectorCredential,
  deleteCredential,
  oauthStartHref,
  testConnectorCredential,
} from "@corbits/settings-ui";
import { CONNECTOR_REGISTRY } from "@workbench/connections/registry";
import type { ResolvedPlugin } from "@workbench/connections/plugins";
import { useState } from "react";

import { pluginOutcome } from "./plugin-meta";

const PLUGINS_RETURN_PATH = "/plugins";

function ApiKeyConnectForm({
  tenantId,
  connectorId,
  displayName,
  onConnected,
}: {
  readonly tenantId: string;
  readonly connectorId: string;
  readonly displayName: string;
  readonly onConnected: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit() {
    setSubmitting(true);
    setError(null);
    testConnectorCredential(tenantId, connectorId, apiKey)
      .then((result) => {
        if (!result.ok) {
          setError(result.message);
          return;
        }
        return completeConnectorCredential(tenantId, connectorId, apiKey).then(
          () => {
            toast(`${displayName} connected.`);
            setApiKey("");
            onConnected();
          },
        );
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setSubmitting(false));
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        API key
        <Input
          type="password"
          value={apiKey}
          autoComplete="off"
          onChange={(event) => {
            setApiKey(event.target.value);
            setError(null);
          }}
        />
      </label>
      {error !== null ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        variant="primary"
        disabled={apiKey.trim() === "" || submitting}
        onClick={handleSubmit}
      >
        {submitting ? "Testing & connecting…" : "Test & connect"}
      </Button>
    </div>
  );
}

function ConnectedSummary({
  tenantId,
  plugin,
  onChanged,
}: {
  readonly tenantId: string;
  readonly plugin: Extract<
    ResolvedPlugin,
    { readonly status: "connected" | "needs_attention" }
  >;
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  function handleDisconnect() {
    setBusy(true);
    deleteCredential(tenantId, plugin.credentialId)
      .then(() => {
        toast(`${plugin.descriptor.displayName} disconnected.`);
        onChanged();
      })
      .finally(() => setBusy(false));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Badge tone={plugin.status === "connected" ? "success" : "danger"}>
          {plugin.status === "connected" ? "Connected" : "Needs attention"}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {plugin.credentialName}
        </span>
      </div>
      {plugin.provenance === "inherited" ? (
        <p className="text-sm text-muted-foreground">
          Connected by a parent workbench — reconnecting or disconnecting
          here creates a connection of your own instead of changing theirs.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {plugin.provenance === "this-workbench" ? (
          <ConfirmButton
            variant="destructive"
            size="sm"
            confirmLabel="Disconnect"
            disabled={busy}
            onConfirm={handleDisconnect}
          >
            Disconnect
          </ConfirmButton>
        ) : null}
      </div>
    </div>
  );
}

export function PluginConnectPanel({
  tenantId,
  plugin,
  onClose,
  onChanged,
}: {
  readonly tenantId: string;
  readonly plugin: ResolvedPlugin | null;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const open = plugin !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent side="right" key={plugin?.descriptor.id}>
        <DialogHeader>
          <DialogTitle>{plugin?.descriptor.displayName ?? ""}</DialogTitle>
          <DialogDescription>
            {plugin === null
              ? ""
              : pluginOutcome(plugin.descriptor.id, plugin.descriptor.displayName)}
          </DialogDescription>
        </DialogHeader>
        {plugin === null ? null : (
          <DialogBody className="flex flex-col gap-5">
            {plugin.status !== "not_connected" ? (
              <ConnectedSummary
                tenantId={tenantId}
                plugin={plugin}
                onChanged={onChanged}
              />
            ) : plugin.descriptor.authKind === "oauth-pkce" ||
              plugin.descriptor.authKind === "oauth-code" ? (
              <Button variant="primary" asChild>
                <a
                  href={oauthStartHref(
                    plugin.descriptor.id,
                    PLUGINS_RETURN_PATH,
                  )}
                >
                  Connect with {plugin.descriptor.displayName}
                </a>
              </Button>
            ) : (
              <ApiKeyConnectForm
                tenantId={tenantId}
                connectorId={plugin.descriptor.id}
                displayName={plugin.descriptor.displayName}
                onConnected={onChanged}
              />
            )}
            {plugin.descriptor.id === "granola" ? (
              <div className="flex flex-col gap-2 border-t border-border pt-4">
                <p className="text-sm font-medium">Inbound webhook</p>
                <p className="text-sm text-muted-foreground">
                  Granola posts finished call notes here — set up or manage
                  the webhook without leaving this panel.
                </p>
                {CONNECTOR_REGISTRY["granola-webhook"] !== undefined ? (
                  <GranolaWebhookCard
                    tenantId={tenantId}
                    descriptor={CONNECTOR_REGISTRY["granola-webhook"]}
                  />
                ) : null}
              </div>
            ) : null}
          </DialogBody>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
