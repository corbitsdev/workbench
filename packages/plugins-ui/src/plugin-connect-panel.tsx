// The one-flow connect surface (CL-6090): every plugin — OAuth, api-key, or
// Granola's key-plus-webhook combination — connects from this one
// right-docked panel, never a "create a routine first, then come back"
// detour. It reuses the exact mutations `@corbits/settings-ui`'s own
// Connections section already calls (`completeConnectorCredential`,
// `deleteCredential`, `oauthStartHref`) and,
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
  fetchOAuthConfigured,
  oauthStartHref,
} from "@corbits/settings-ui";
import { CONNECTOR_REGISTRY } from "@workbench/connections/registry";
import type { ResolvedPlugin } from "@workbench/connections/plugins";
import { useEffect, useState } from "react";

import { pluginOutcome } from "./plugin-meta";

const PLUGINS_RETURN_PATH = "/plugins";

function ApiKeyConnectForm({
  tenantId,
  connectorId,
  displayName,
  fieldKind,
  fieldPlaceholder,
  onConnected,
}: {
  readonly tenantId: string;
  readonly connectorId: string;
  readonly displayName: string;
  /** Absent means this connector's single field collects a secret to
   * paste (every connector today). `"url"` means it collects the origin
   * of an already-running instance instead — Ollama needs no key at all
   * — and `fieldPlaceholder` prefills that field. The value still rides
   * the same `apiKey` wire field either way: `routes.ts`'s
   * `credentialInputKind` check on the server decides what to do with
   * it. */
  readonly fieldKind?: "url";
  readonly fieldPlaceholder?: string;
  readonly onConnected: () => void;
}) {
  const isUrl = fieldKind === "url";
  const [value, setValue] = useState(isUrl ? (fieldPlaceholder ?? "") : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One connect action (CL-6377): the server proves the key before ever
  // storing it, so this is the only round-trip — no separate test step.
  function handleSubmit() {
    setSubmitting(true);
    setError(null);
    completeConnectorCredential(tenantId, connectorId, value)
      .then((completed) => {
        // CL-6351: a fresh Ollama connect with only an embedding model
        // pulled still succeeds — `modelGuidance` says so instead of
        // the generic "connected" toast.
        toast(completed.modelGuidance ?? `${displayName} connected.`);
        setValue(isUrl ? (fieldPlaceholder ?? "") : "");
        onConnected();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setSubmitting(false));
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {isUrl ? "URL" : "API key"}
        <Input
          type={isUrl ? "text" : "password"}
          placeholder={isUrl ? fieldPlaceholder : undefined}
          value={value}
          autoComplete="off"
          onChange={(event) => {
            setValue(event.target.value);
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
        disabled={value.trim() === "" || submitting}
        onClick={handleSubmit}
      >
        {submitting ? "Connecting…" : "Connect"}
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
  const [error, setError] = useState<string | null>(null);

  function handleDisconnect() {
    setBusy(true);
    setError(null);
    deleteCredential(tenantId, plugin.credentialId)
      .then(() => {
        toast(`${plugin.descriptor.displayName} disconnected.`);
        onChanged();
      })
      .catch(() => setError("Couldn't disconnect — try again."))
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
          Connected by a parent workbench — reconnecting or disconnecting here
          creates a connection of your own instead of changing theirs.
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
            {busy ? "Disconnecting…" : "Disconnect"}
          </ConfirmButton>
        ) : null}
      </div>
      {error !== null ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
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
  const [oauthConfigured, setOauthConfigured] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    if (!open) return;
    fetchOAuthConfigured(tenantId)
      .then(setOauthConfigured)
      .catch(() => setOauthConfigured({}));
  }, [open, tenantId]);

  const hostedAppAvailable =
    plugin?.descriptor.oauth !== undefined &&
    oauthConfigured[plugin.descriptor.id] === true;

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
              : pluginOutcome(
                  plugin.descriptor.id,
                  plugin.descriptor.displayName,
                )}
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
              plugin.descriptor.authKind === "oauth-code" ||
              hostedAppAvailable ? (
              <Button variant="primary" asChild>
                <a
                  href={oauthStartHref(
                    tenantId,
                    plugin.descriptor.id,
                    PLUGINS_RETURN_PATH,
                  )}
                >
                  Connect with {plugin.descriptor.displayName}
                </a>
              </Button>
            ) : plugin.descriptor.oauth !== undefined ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  This workbench isn&apos;t set up with the one-click GitHub
                  app, so connect with a token instead. Create a token with{" "}
                  <code className="text-xs">repo</code> scope at{" "}
                  <a
                    className="underline"
                    href={plugin.descriptor.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    github.com/settings/tokens
                  </a>{" "}
                  and paste it below.
                </p>
                <ApiKeyConnectForm
                  tenantId={tenantId}
                  connectorId={plugin.descriptor.id}
                  displayName={plugin.descriptor.displayName}
                  onConnected={onChanged}
                />
              </div>
            ) : plugin.descriptor.credentialInputKind === "url" ? (
              <ApiKeyConnectForm
                tenantId={tenantId}
                connectorId={plugin.descriptor.id}
                displayName={plugin.descriptor.displayName}
                fieldKind="url"
                fieldPlaceholder={plugin.descriptor.credentialPlaceholder ?? ""}
                onConnected={onChanged}
              />
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
                  Granola posts finished call notes here — set up or manage the
                  webhook without leaving this panel.
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
