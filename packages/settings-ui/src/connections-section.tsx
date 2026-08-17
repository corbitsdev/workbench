// The "Connections" settings section: a status grid over every connector
// this bench can talk to (inference providers, tool-package api keys, and
// the two existing OAuth connectors), plus the raw credentials table as an
// "Advanced" escape hatch for credential types no connector card covers
// (a certificate, an `other`-typed row).

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
  EmptyState,
  InfoTooltip,
  Input,
  SettingsPanel,
  toast,
} from "@corbits/react-ui";
import {
  CONNECTOR_REGISTRY,
  connectorDescriptors,
  type ConnectorDescriptor,
} from "@workbench/connections/registry";
import { MCP_PRESET_CONNECTOR_IDS } from "@workbench/connections/mcp-presets";
import { workflowDisplayName } from "@corbits/workflow-catalog";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import {
  completeConnectorCredential,
  fetchOAuthConfigured,
  testConnectorCredential,
} from "./connections-api";
import { CONNECTOR_PINNED_WORKFLOWS } from "./connections-pinned-by";
import {
  connectorStatus,
  type ConnectorStatusResult,
} from "./connections-status";
import {
  createCredential,
  deleteCredential,
  listCredentials,
  listProviders,
  type Credential,
  type CreateCredentialInput,
  type Provider,
} from "./credentials-api";
import {
  CreateCredentialDialog,
  CredentialsTable,
} from "./credentials-section";
import { GranolaWebhookCard } from "./granola-webhook-card";
import { SETTINGS_STRINGS } from "./strings";

// `@workbench/connections/registry` is the only subpath this browser
// bundle may import — its main export pulls in server-only hono routing.

type OAuthConnectorCard = {
  readonly id: "openrouter" | "huggingface";
  readonly displayName: string;
};

// The generalized `/api/connections/:id/oauth/start` factory is out of
// scope for Track A — these two ride the existing onboarding OAuth routes.
const OAUTH_CARDS: readonly OAuthConnectorCard[] = [
  { id: "openrouter", displayName: "OpenRouter" },
  { id: "huggingface", displayName: "Hugging Face" },
];

/**
 * Exported so other surfaces (the plugins gallery's connect panel) can send
 * the same OAuth connectors through the same existing onboarding route
 * instead of re-deriving this URL — see the comment above `OAUTH_CARDS` for
 * why this still targets `/api/onboarding/oauth/...` rather than the
 * generalized per-connector factory.
 */
export function oauthStartHref(
  connectorId: string,
  returnPath = "/settings/connections",
): string {
  return `/api/onboarding/oauth/${connectorId}/start?return=${encodeURIComponent(returnPath)}`;
}

type ConnectionsData = {
  readonly credentials: readonly Credential[];
  readonly providers: readonly Provider[];
  readonly oauthConfigured: Readonly<Record<string, boolean>>;
};

/**
 * The api-key connector card grid, on its own: every credentials/providers
 * fetch, the connect/reconnect dialog, and disconnect all owned here so
 * a caller only supplies the data it already has and a place to send a
 * reload/error signal. `ConnectionsSection` composes this with the OAuth
 * card row and the advanced credentials table for the full Settings >
 * Connections page — its one consumer today. The onboarding wizard's own
 * "Connect your tools" step (CL-6028), which once rendered this alone
 * filtered to `feedsTools`-bearing connectors, was dropped in CL-6104:
 * connecting tools now lives only in Settings and the Plugins gallery,
 * never in onboarding. Renders bare `ConnectorCard`s — not wrapped in
 * `.settings-connections-grid` itself — so a caller controls the grid
 * container (and can put other cards, like the OAuth pair, in the same
 * grid alongside these).
 */
export function ConnectorCardGrid({
  tenantId,
  credentials,
  providers,
  filter,
  onReload,
  onError,
  onConnected,
}: {
  readonly tenantId: string;
  readonly credentials: readonly Credential[];
  readonly providers: readonly Provider[];
  /** Narrows which registry entries render a card. Defaults to every
   * api-key connector (every entry with a `probe`) — OAuth connectors
   * are never included here regardless of filter, since this grid has
   * no OAuth flow of its own. */
  readonly filter?: (descriptor: ConnectorDescriptor) => boolean;
  readonly onReload: () => void;
  readonly onError?: (message: string | null) => void;
  /** Fires only on a successful connect — never on disconnect/revoke —
   * for callers that need to distinguish "something got connected this
   * session" from "the list changed." */
  readonly onConnected?: () => void;
}) {
  const [dialogDescriptor, setDialogDescriptor] =
    useState<ConnectorDescriptor | null>(null);
  const [dialogMode, setDialogMode] = useState<"connect" | "reconnect">(
    "connect",
  );

  function handleDisconnect(credential: Credential) {
    onError?.(null);
    deleteCredential(tenantId, credential.id)
      .then(() => {
        onReload();
        toast(SETTINGS_STRINGS.credentialRevokedToast);
      })
      .catch(() => onError?.(SETTINGS_STRINGS.connectionsDisconnectError));
  }

  const descriptors = connectorDescriptors()
    .filter((descriptor) => descriptor.probe !== undefined)
    .filter((descriptor) => !MCP_PRESET_CONNECTOR_IDS.includes(descriptor.id))
    .filter(filter ?? (() => true));

  return (
    <>
      {descriptors.map((descriptor) => (
        <ConnectorCard
          key={descriptor.id}
          descriptor={descriptor}
          statusResult={connectorStatus(descriptor.id, credentials, providers)}
          onConnect={() => {
            setDialogMode("connect");
            setDialogDescriptor(descriptor);
          }}
          onReconnect={() => {
            setDialogMode("reconnect");
            setDialogDescriptor(descriptor);
          }}
          onDisconnect={handleDisconnect}
        />
      ))}
      <ConnectorCredentialDialog
        descriptor={dialogDescriptor}
        mode={dialogMode}
        tenantId={tenantId}
        onClose={() => setDialogDescriptor(null)}
        onConnected={() => {
          setDialogDescriptor(null);
          onReload();
          onConnected?.();
        }}
      />
    </>
  );
}

export function ConnectionsSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [query, setQuery] = useState<APIQuery<ConnectionsData>>({
    kind: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function reload() {
    setReloadKey((value) => value + 1);
  }

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setQuery({ kind: "loading" });
    Promise.all([
      listCredentials(tenantId),
      listProviders(tenantId),
      fetchOAuthConfigured(tenantId),
    ])
      .then(([credentials, providers, oauthConfigured]) => {
        if (!cancelled)
          setQuery({
            kind: "ready",
            data: { credentials, providers, oauthConfigured },
          });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof UnauthenticatedError) {
          setQuery({ kind: "unauthenticated" });
          return;
        }
        setQuery({
          kind: "error",
          message: describeQueryError(cause),
          retry: reload,
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, reloadKey]);

  if (tenantId === null) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.benchNoneSelectedTitle}
        description={SETTINGS_STRINGS.benchNoneSelectedDescription}
      />
    );
  }

  const currentTenantId = tenantId;

  function handleDisconnect(credential: Credential) {
    setRowError(null);
    deleteCredential(currentTenantId, credential.id)
      .then(() => {
        reload();
        toast(SETTINGS_STRINGS.credentialRevokedToast);
      })
      .catch(() => setRowError(SETTINGS_STRINGS.connectionsDisconnectError));
  }

  function handleCreate(input: {
    readonly providerId: string;
    readonly name: string;
    readonly type: CreateCredentialInput["type"];
    readonly secret: string;
    readonly description: string;
  }) {
    setCreating(true);
    setCreateError(null);
    const base = {
      providerId: input.providerId,
      name: input.name,
      type: input.type,
      secret: input.secret,
    };
    createCredential(
      currentTenantId,
      input.description.trim() !== ""
        ? { ...base, description: input.description.trim() }
        : base,
    )
      .then(() => {
        setCreateOpen(false);
        reload();
        toast(SETTINGS_STRINGS.credentialSavedToast);
      })
      .catch(() => setCreateError(SETTINGS_STRINGS.credentialsCreateError))
      .finally(() => setCreating(false));
  }

  return (
    <QueryView query={query} label={SETTINGS_STRINGS.connectionsLoadError}>
      {({ credentials, providers, oauthConfigured }) => {
        const providerNameById = new Map(
          providers.map((provider) => [provider.id, provider.name]),
        );
        return (
          <SettingsPanel
            title={SETTINGS_STRINGS.connectionsSectionTitle}
            description={SETTINGS_STRINGS.connectionsSectionDescription}
          >
            {rowError !== null && (
              <p className="settings-inline-error" role="alert">
                {rowError}
              </p>
            )}
            <div className="settings-connections-grid">
              <ConnectorCardGrid
                tenantId={currentTenantId}
                credentials={credentials}
                providers={providers}
                onReload={reload}
                onError={setRowError}
              />
              {OAUTH_CARDS.map((card) => (
                <OAuthConnectorCardView
                  key={card.id}
                  card={card}
                  statusResult={connectorStatus(
                    card.id,
                    credentials,
                    providers,
                  )}
                  // Absent from the map reads as "not configured" — the
                  // conservative default: never render a live Connect button
                  // on data this section failed to positively confirm.
                  configured={oauthConfigured[card.id] ?? false}
                  onDisconnect={handleDisconnect}
                />
              ))}
              {(() => {
                const granolaWebhookDescriptor =
                  CONNECTOR_REGISTRY["granola-webhook"];
                return granolaWebhookDescriptor === undefined ? null : (
                  <GranolaWebhookCard
                    tenantId={currentTenantId}
                    descriptor={granolaWebhookDescriptor}
                  />
                );
              })()}
            </div>
            <details className="settings-advanced-disclosure">
              <summary>
                <ChevronRight
                  size={14}
                  aria-hidden
                  className="settings-advanced-disclosure-chevron"
                />
                {SETTINGS_STRINGS.connectionsAdvancedSummary}
              </summary>
              <div className="settings-advanced-disclosure-body">
                <div className="settings-section-toolbar">
                  <Button variant="primary" onClick={() => setCreateOpen(true)}>
                    {SETTINGS_STRINGS.credentialsCreateAction}
                  </Button>
                </div>
                <CredentialsTable
                  credentials={credentials}
                  providerNameById={providerNameById}
                  onDelete={handleDisconnect}
                />
                <CreateCredentialDialog
                  open={createOpen}
                  onOpenChange={setCreateOpen}
                  providers={providers}
                  onCreate={handleCreate}
                  submitting={creating}
                  error={createError}
                />
              </div>
            </details>
          </SettingsPanel>
        );
      }}
    </QueryView>
  );
}

function pinnedByLine(connectorId: string): string {
  const assetNames = CONNECTOR_PINNED_WORKFLOWS[connectorId] ?? [];
  if (assetNames.length === 0) return SETTINGS_STRINGS.connectionsPinnedByNone;
  const names = assetNames.map((assetName) => workflowDisplayName(assetName));
  return `${SETTINGS_STRINGS.connectionsPinnedByPrefix}${names.join(", ")}`;
}

function StatusChip({
  statusResult,
}: {
  readonly statusResult: ConnectorStatusResult;
}) {
  if (statusResult.status === "connected") {
    return (
      <Badge tone="success">
        {SETTINGS_STRINGS.connectionsStatusConnected}
      </Badge>
    );
  }
  if (statusResult.status === "needs_attention") {
    return (
      <Badge tone="danger">
        {SETTINGS_STRINGS.connectionsStatusNeedsAttention}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral">
      {SETTINGS_STRINGS.connectionsStatusNotConnected}
    </Badge>
  );
}

function ConnectorCard({
  descriptor,
  statusResult,
  onConnect,
  onReconnect,
  onDisconnect,
}: {
  readonly descriptor: ConnectorDescriptor;
  readonly statusResult: ConnectorStatusResult;
  readonly onConnect: () => void;
  readonly onReconnect: () => void;
  readonly onDisconnect: (credential: Credential) => void;
}) {
  return (
    <div className="settings-connection-card">
      <span className="settings-connection-card-title">
        {descriptor.displayName}
      </span>
      <StatusChip statusResult={statusResult} />
      {statusResult.status === "connected" && (
        <span className="settings-connection-card-name">
          {statusResult.credential.name}
        </span>
      )}
      {descriptor.feedsTools.length > 0 && (
        <span className="settings-connection-card-pinned-row">
          <span className="settings-connection-card-pinned">
            {pinnedByLine(descriptor.id)}
          </span>
          {(CONNECTOR_PINNED_WORKFLOWS[descriptor.id]?.length ?? 0) > 0 && (
            <InfoTooltip
              label={SETTINGS_STRINGS.connectionsPinnedByApproximationNote}
              triggerLabel={`How "${pinnedByLine(descriptor.id)}" is determined`}
            />
          )}
        </span>
      )}
      <div className="settings-connection-card-actions">
        {statusResult.status === "connected" && (
          <ConfirmButton
            variant="destructive"
            size="sm"
            confirmLabel={SETTINGS_STRINGS.connectionsDisconnectConfirm}
            onConfirm={() => onDisconnect(statusResult.credential)}
          >
            {SETTINGS_STRINGS.connectionsDisconnectAction}
          </ConfirmButton>
        )}
        {statusResult.status === "not_connected" && (
          <Button variant="primary" size="sm" onClick={onConnect}>
            {SETTINGS_STRINGS.connectionsConnectAction}
          </Button>
        )}
        {statusResult.status === "needs_attention" && (
          <Button variant="primary" size="sm" onClick={onReconnect}>
            {SETTINGS_STRINGS.connectionsReconnectAction}
          </Button>
        )}
      </div>
    </div>
  );
}

function OAuthConnectorCardView({
  card,
  statusResult,
  configured,
  onDisconnect,
}: {
  readonly card: OAuthConnectorCard;
  readonly statusResult: ConnectorStatusResult;
  /** Whether an operator has registered this connector's OAuth app
   * (a client id present server-side) — distinct from `statusResult`,
   * which is about whether *this tenant* has connected, not whether
   * connecting is even possible yet. */
  readonly configured: boolean;
  readonly onDisconnect: (credential: Credential) => void;
}) {
  // An unconfigured connector never gets a live Connect button, even
  // when this tenant already holds a (now-orphaned) credential for it —
  // there is no OAuth app to round-trip through until an operator
  // registers one, so the muted state wins regardless of `statusResult`.
  if (!configured) {
    return (
      <div className="settings-connection-card settings-connection-card-muted">
        <span className="settings-connection-card-title">
          {card.displayName}
        </span>
        <Badge tone="warning">
          {SETTINGS_STRINGS.connectionsStatusNotConfigured}
        </Badge>
        <p className="settings-connection-card-hint">
          {SETTINGS_STRINGS.connectionsNotConfiguredHint}
        </p>
      </div>
    );
  }

  return (
    <div className="settings-connection-card">
      <span className="settings-connection-card-title">{card.displayName}</span>
      <StatusChip statusResult={statusResult} />
      {statusResult.status === "connected" && (
        <span className="settings-connection-card-name">
          {statusResult.credential.name}
        </span>
      )}
      <div className="settings-connection-card-actions">
        {statusResult.status === "connected" ? (
          <ConfirmButton
            variant="destructive"
            size="sm"
            confirmLabel={SETTINGS_STRINGS.connectionsDisconnectConfirm}
            onConfirm={() => onDisconnect(statusResult.credential)}
          >
            {SETTINGS_STRINGS.connectionsDisconnectAction}
          </ConfirmButton>
        ) : (
          <Button variant="primary" size="sm" asChild>
            <a href={oauthStartHref(card.id)}>
              {statusResult.status === "needs_attention"
                ? SETTINGS_STRINGS.connectionsReconnectAction
                : SETTINGS_STRINGS.connectionsConnectAction}
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

export function ConnectorCredentialDialog({
  descriptor,
  mode,
  tenantId,
  onClose,
  onConnected,
}: {
  readonly descriptor: ConnectorDescriptor | null;
  readonly mode: "connect" | "reconnect";
  readonly tenantId: string;
  readonly onClose: () => void;
  readonly onConnected: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isUrlField = descriptor?.credentialInputKind === "url";

  useEffect(() => {
    setApiKey(
      descriptor?.credentialInputKind === "url"
        ? (descriptor.credentialPlaceholder ?? "")
        : "",
    );
    setShowKey(false);
    setSubmitting(false);
    setSubmitError(null);
  }, [descriptor]);

  const open = descriptor !== null;
  const canSubmit = apiKey.trim() !== "" && !submitting;

  // One primary action, not test-then-save: it proves the key with a real
  // call before ever storing it, so a rejected key never reaches
  // `completeConnectorCredential` and nothing gets sealed on a bad key.
  function handleSubmit() {
    if (descriptor === null) return;
    setSubmitting(true);
    setSubmitError(null);
    testConnectorCredential(tenantId, descriptor.id, apiKey)
      .then((result) => {
        if (!result.ok) {
          setSubmitError(result.message);
          return;
        }
        return completeConnectorCredential(
          tenantId,
          descriptor.id,
          apiKey,
        ).then(() => {
          toast(
            SETTINGS_STRINGS.connectionsConnectedToast(descriptor.displayName),
          );
          onConnected();
        });
      })
      .catch((cause: unknown) => setSubmitError(describeQueryError(cause)))
      .finally(() => setSubmitting(false));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {descriptor === null
              ? ""
              : mode === "reconnect"
                ? SETTINGS_STRINGS.connectionsDialogReconnectTitle(
                    descriptor.displayName,
                  )
                : SETTINGS_STRINGS.connectionsDialogConnectTitle(
                    descriptor.displayName,
                  )}
          </DialogTitle>
          <DialogDescription>
            {SETTINGS_STRINGS.connectionsDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="settings-form-stack">
          <div className="settings-form-field">
            <span>
              {isUrlField ? "URL" : SETTINGS_STRINGS.connectionsKeyLabel}
            </span>
            {isUrlField ? (
              <Input
                type="text"
                placeholder={descriptor?.credentialPlaceholder}
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setSubmitError(null);
                }}
                autoComplete="off"
              />
            ) : (
              <div className="settings-secret-row">
                <Input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setSubmitError(null);
                  }}
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowKey((value) => !value)}
                >
                  {showKey ? "Hide" : "Show"}
                </Button>
              </div>
            )}
          </div>
          {submitError !== null && (
            <p className="settings-inline-error" role="alert">
              {submitError}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {SETTINGS_STRINGS.connectionsCancel}
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {submitting
              ? SETTINGS_STRINGS.connectionsTestAndSaving
              : SETTINGS_STRINGS.connectionsTestAndSaveAction}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
