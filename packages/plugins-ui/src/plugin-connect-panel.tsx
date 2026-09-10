// The shared configuration surface (CL-6090) keeps credential and management
// controls out of the catalog grid. It reuses the exact mutations
// `@corbits/settings-ui`'s own
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
  DialogHeader,
  DialogTitle,
  Input,
  toast,
} from "@corbits/react-ui";
import { reportError } from "@corbits/error-sink";
import {
  GranolaWebhookCard,
  completeConnectorCredential,
  deleteCredential,
  fetchOAuthConfigured,
  oauthStartHref,
} from "@corbits/settings-ui";
import { CONNECTOR_REGISTRY } from "@workbench/templates/connectors";
import type { ResolvedPlugin } from "@corbits/connections/plugins";
import { useEffect, useState } from "react";

import { pluginOutcome } from "./plugin-meta";
import {
  connectMcpPreset,
  disconnectMcpServer,
  type McpPreset,
} from "./mcp-servers-api";
import { PLUGINS_STRINGS } from "./strings";

const PLUGINS_RETURN_PATH = "/plugins";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export type PluginPanelSubject =
  | { readonly kind: "connector"; readonly plugin: ResolvedPlugin }
  | {
      readonly kind: "mcp-preset";
      readonly preset: McpPreset;
      readonly toolCount: number | undefined;
    };

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
      .catch(() => setError(PLUGINS_STRINGS.disconnectError))
      .finally(() => setBusy(false));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Badge
          className="self-start"
          tone={plugin.status === "connected" ? "success" : "danger"}
        >
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
      {plugin.provenance === "this-workbench" ? (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <p className="text-sm text-muted-foreground">
            Disconnecting removes this plugin&apos;s access from the workbench.
          </p>
          <ConfirmButton
            size="sm"
            confirmLabel="Disconnect"
            disabled={busy}
            onConfirm={handleDisconnect}
          >
            {busy ? "Disconnecting…" : "Disconnect"}
          </ConfirmButton>
        </div>
      ) : null}
      {error !== null ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function McpPresetPanelContent({
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
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleConnect() {
    setBusy(true);
    setError(null);
    connectMcpPreset(tenantId, preset.slug, token.trim())
      .then((result) => {
        toast(
          `Connected — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available.`,
        );
        onChanged(result.toolCount);
      })
      .catch((cause: unknown) => {
        reportError(cause, {
          operation: "plugins.mcp-preset.connect",
          tenantId,
        });
        setError(messageOf(cause));
      })
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
      .catch((cause: unknown) => {
        reportError(cause, {
          operation: "plugins.mcp-preset.disconnect",
          tenantId,
        });
        setError(PLUGINS_STRINGS.disconnectError);
      })
      .finally(() => setBusy(false));
  }

  if (preset.connected) {
    return (
      <div className="flex flex-col gap-4">
        <Badge className="self-start" tone="success">
          {toolCount === undefined
            ? "Connected"
            : `${toolCount} tool${toolCount === 1 ? "" : "s"}`}
        </Badge>
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <p className="text-sm text-muted-foreground">
            Disconnecting removes this plugin&apos;s access from the workbench.
          </p>
          <ConfirmButton
            size="sm"
            confirmLabel="Disconnect"
            disabled={busy}
            onConfirm={handleDisconnect}
          >
            {busy ? "Disconnecting…" : "Disconnect"}
          </ConfirmButton>
        </div>
        {error !== null ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (preset.connectionMode !== "token") return null;

  const tokenFieldId = `mcp-preset-token-${preset.slug}`;

  return (
    <div className="flex flex-col gap-3">
      <ol className="list-decimal space-y-1 pl-4 text-sm text-muted-foreground">
        {(preset.tokenSteps ?? []).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <a
        href={preset.docsUrl}
        target="_blank"
        rel="noreferrer"
        className="text-sm underline underline-offset-2"
      >
        Create your token
      </a>
      <label
        className="flex flex-col gap-1.5 text-sm font-medium"
        htmlFor={tokenFieldId}
      >
        Personal access token
        <Input
          id={tokenFieldId}
          type="password"
          value={token}
          placeholder="Paste your access token"
          disabled={busy}
          autoComplete="new-password"
          onChange={(event) => {
            setToken(event.target.value);
            setError(null);
          }}
        />
      </label>
      <Button
        type="button"
        variant="primary"
        disabled={busy || token.trim() === ""}
        onClick={handleConnect}
      >
        {busy ? "Connecting…" : "Connect"}
      </Button>
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
  subject,
  onClose,
  onChanged,
}: {
  readonly tenantId: string;
  readonly subject: PluginPanelSubject | null;
  readonly onClose: () => void;
  readonly onChanged: (toolCount?: number) => void;
}) {
  const open = subject !== null;
  const plugin = subject?.kind === "connector" ? subject.plugin : null;
  const preset = subject?.kind === "mcp-preset" ? subject.preset : null;
  const toolCount =
    subject?.kind === "mcp-preset" ? subject.toolCount : undefined;
  // CL-6830: probe is tri-state — never fold a failure into `{}`, which
  // reads as "hosted app absent" and hides one-click connect behind the
  // not-configured token paste.
  const [oauthProbe, setOauthProbe] = useState<
    | { readonly status: "loading" }
    | {
        readonly status: "ready";
        readonly configured: Readonly<Record<string, boolean>>;
      }
    | { readonly status: "error" }
  >({ status: "loading" });
  const [oauthProbeKey, setOauthProbeKey] = useState(0);

  useEffect(() => {
    if (plugin === null) return;
    let cancelled = false;
    setOauthProbe({ status: "loading" });
    fetchOAuthConfigured(tenantId)
      .then((configured) => {
        if (!cancelled) setOauthProbe({ status: "ready", configured });
      })
      .catch(() => {
        if (!cancelled) setOauthProbe({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [plugin, tenantId, oauthProbeKey]);

  const hostedAppAvailable =
    plugin?.descriptor.oauth !== undefined &&
    oauthProbe.status === "ready" &&
    oauthProbe.configured[plugin.descriptor.id] === true;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        side="right"
        className="max-sm:inset-x-3 max-sm:inset-y-3 max-sm:w-auto max-sm:rounded-lg max-sm:border"
        key={plugin?.descriptor.id ?? preset?.slug}
      >
        <DialogHeader>
          <DialogTitle>
            {plugin?.descriptor.displayName ?? preset?.displayName ?? ""}
          </DialogTitle>
          <DialogDescription>
            {plugin !== null
              ? pluginOutcome(
                  plugin.descriptor.id,
                  plugin.descriptor.displayName,
                )
              : (preset?.description ?? "")}
          </DialogDescription>
        </DialogHeader>
        {plugin !== null ? (
          <DialogBody className="max-h-[calc(100dvh-8rem)] flex-none flex flex-col gap-5">
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
              oauthProbe.status === "error" ? (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-destructive" role="alert">
                    Couldn&apos;t check whether one-click connect is available.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setOauthProbeKey((value) => value + 1)}
                  >
                    Try again
                  </Button>
                </div>
              ) : oauthProbe.status === "loading" ? null : (
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
              )
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
        ) : preset !== null ? (
          <DialogBody className="max-h-[calc(100dvh-8rem)] flex-none flex flex-col gap-5">
            <McpPresetPanelContent
              tenantId={tenantId}
              preset={preset}
              toolCount={toolCount}
              onChanged={onChanged}
            />
          </DialogBody>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
