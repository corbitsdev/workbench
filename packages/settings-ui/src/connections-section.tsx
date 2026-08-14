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
  Input,
  SettingsPanel,
  Skeleton,
  toast,
} from "@corbits/react-ui";
import {
  connectorDescriptors,
  type ConnectorDescriptor,
} from "@workbench/connections/registry";
import { workflowDisplayName } from "@corbits/workflow-catalog";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

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
import { errorMessage, type LoadState } from "./load-state";
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

function oauthStartHref(connectorId: string): string {
  return `/api/onboarding/oauth/${connectorId}/start?return=%2Fsettings%2Fconnections`;
}

type ConnectionsData = {
  readonly credentials: readonly Credential[];
  readonly providers: readonly Provider[];
  readonly oauthConfigured: Readonly<Record<string, boolean>>;
};

export function ConnectionsSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [state, setState] = useState<LoadState<ConnectionsData>>({
    kind: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [dialogDescriptor, setDialogDescriptor] =
    useState<ConnectorDescriptor | null>(null);
  const [dialogMode, setDialogMode] = useState<"connect" | "reconnect">(
    "connect",
  );
  const [rowError, setRowError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([
      listCredentials(tenantId),
      listProviders(tenantId),
      fetchOAuthConfigured(tenantId),
    ])
      .then(([credentials, providers, oauthConfigured]) => {
        if (!cancelled)
          setState({
            kind: "ready",
            data: { credentials, providers, oauthConfigured },
          });
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setState({ kind: "error", message: errorMessage(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, reloadKey]);

  if (tenantId === null) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.benchNoneSelectedTitle}
        description={SETTINGS_STRINGS.benchNoneSelectedDescription}
      />
    );
  }
  if (state.kind === "loading") return <Skeleton className="query-skeleton" />;
  if (state.kind === "error") {
    return (
      <EmptyState
        icon={<CircleAlert />}
        title={`Couldn't load ${SETTINGS_STRINGS.connectionsLoadError}`}
        description={state.message}
      />
    );
  }

  const currentTenantId = tenantId;

  function reload() {
    setReloadKey((value) => value + 1);
  }

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
    createCredential(currentTenantId, {
      providerId: input.providerId,
      name: input.name,
      type: input.type,
      secret: input.secret,
      ...(input.description.trim() !== ""
        ? { description: input.description.trim() }
        : {}),
    })
      .then(() => {
        setCreateOpen(false);
        reload();
        toast(SETTINGS_STRINGS.credentialSavedToast);
      })
      .catch(() => setCreateError(SETTINGS_STRINGS.credentialsCreateError))
      .finally(() => setCreating(false));
  }

  const providerNameById = new Map(
    state.data.providers.map((provider) => [provider.id, provider.name]),
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
        {connectorDescriptors()
          // OAuth connectors (openrouter, huggingface) now live in the
          // same registry as of CL-6028's OAuth route factory, but this
          // card still renders only the api-key ones — the OAuth pair
          // below is its own card until CL-6028's OAuth-cards-honesty
          // follow-up folds them into this same loop (registry `oauth`
          // field, "not configured" state, a real Connect action).
          .filter((descriptor) => descriptor.probe !== undefined)
          .map((descriptor) => (
            <ConnectorCard
              key={descriptor.id}
              descriptor={descriptor}
              statusResult={connectorStatus(
                descriptor.displayName,
                state.data.credentials,
                state.data.providers,
              )}
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
        {OAUTH_CARDS.map((card) => (
          <OAuthConnectorCardView
            key={card.id}
            card={card}
            statusResult={connectorStatus(
              card.displayName,
              state.data.credentials,
              state.data.providers,
            )}
            // Absent from the map reads as "not configured" — the
            // conservative default: never render a live Connect button
            // on data this section failed to positively confirm.
            configured={state.data.oauthConfigured[card.id] ?? false}
            onDisconnect={handleDisconnect}
          />
        ))}
      </div>
      <ConnectorCredentialDialog
        descriptor={dialogDescriptor}
        mode={dialogMode}
        tenantId={currentTenantId}
        onClose={() => setDialogDescriptor(null)}
        onConnected={() => {
          setDialogDescriptor(null);
          reload();
        }}
      />
      <details className="settings-connections-advanced">
        <summary>{SETTINGS_STRINGS.connectionsAdvancedSummary}</summary>
        <div className="settings-connections-advanced-body">
          <div className="settings-section-toolbar">
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              {SETTINGS_STRINGS.credentialsCreateAction}
            </Button>
          </div>
          <CredentialsTable
            credentials={state.data.credentials}
            providerNameById={providerNameById}
            onDelete={handleDisconnect}
          />
          <CreateCredentialDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            providers={state.data.providers}
            onCreate={handleCreate}
            submitting={creating}
            error={createError}
          />
        </div>
      </details>
    </SettingsPanel>
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
        <span className="settings-connection-card-pinned">
          {pinnedByLine(descriptor.id)}
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
        <Badge tone="neutral">
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
  const [testedKey, setTestedKey] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState<{
    readonly kind: "success" | "error";
    readonly text: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setApiKey("");
    setShowKey(false);
    setTestedKey(null);
    setTesting(false);
    setTestMessage(null);
    setSaving(false);
    setSaveError(null);
  }, [descriptor]);

  const open = descriptor !== null;
  // The exact string that was tested must be the exact string being
  // saved — any edit after a successful test invalidates it.
  const canSave = testedKey !== null && testedKey === apiKey && !saving;

  function handleTest() {
    if (descriptor === null) return;
    setTesting(true);
    setTestMessage(null);
    testConnectorCredential(tenantId, descriptor.id, apiKey)
      .then((result) => {
        if (result.ok) {
          setTestedKey(apiKey);
          setTestMessage({
            kind: "success",
            text: SETTINGS_STRINGS.connectionsTestSuccess,
          });
        } else {
          setTestedKey(null);
          setTestMessage({ kind: "error", text: result.message });
        }
      })
      .catch((cause: unknown) => {
        setTestedKey(null);
        setTestMessage({ kind: "error", text: errorMessage(cause) });
      })
      .finally(() => setTesting(false));
  }

  function handleSave() {
    if (descriptor === null) return;
    setSaving(true);
    setSaveError(null);
    completeConnectorCredential(tenantId, descriptor.id, apiKey)
      .then(() => {
        toast(
          SETTINGS_STRINGS.connectionsConnectedToast(descriptor.displayName),
        );
        onConnected();
      })
      .catch(() => setSaveError(SETTINGS_STRINGS.connectionsSaveError))
      .finally(() => setSaving(false));
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
            <span>{SETTINGS_STRINGS.connectionsKeyLabel}</span>
            <div className="settings-secret-row">
              <Input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setTestMessage(null);
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
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={apiKey.trim() === "" || testing}
            onClick={handleTest}
          >
            {testing
              ? SETTINGS_STRINGS.connectionsTesting
              : SETTINGS_STRINGS.connectionsTestAction}
          </Button>
          {testMessage !== null && (
            <p
              className={
                testMessage.kind === "error"
                  ? "settings-inline-error"
                  : undefined
              }
              role={testMessage.kind === "error" ? "alert" : undefined}
            >
              {testMessage.text}
            </p>
          )}
          {saveError !== null && (
            <p className="settings-inline-error" role="alert">
              {saveError}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {SETTINGS_STRINGS.connectionsCancel}
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={handleSave}>
            {saving
              ? SETTINGS_STRINGS.connectionsSaving
              : SETTINGS_STRINGS.connectionsSaveAction}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
