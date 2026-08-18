// The "Connections" settings section: a status grid over every connector
// this bench can talk to (inference providers, tool-package api keys, and
// the two existing OAuth connectors), plus the raw credentials table as an
// "Advanced" escape hatch for credential types no connector card covers
// (a certificate, an `other`-typed row).

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
import {
  buildEffectiveInferenceRows,
  computeMakeDefaultPatches,
  defaultModelForProvider,
  getResolvedCatalog,
  listOwnOfferings,
  updateOwnOffering,
  type DefaultProviderModel,
  type EffectiveInferenceRow,
} from "@corbits/inference-settings";
import type { ModelInfo } from "@intx/types";
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
  disconnectConnector,
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
  /** The resolved model catalog — read only to derive each connected
   * inference provider's one default model (CL-6258's replacement for
   * the removed Models settings page; see `defaultModelForProvider`'s
   * own header for why this is never a second, hand-maintained notion of
   * "the" model). */
  readonly models: readonly ModelInfo[];
  /** This tenant's own offering ids — the provenance source for which of
   * `models`' offerings a default-model pick can actually PATCH (only a
   * "set-here" offering; see `computeMakeDefaultPatches`). */
  readonly ownOfferingIds: ReadonlySet<string>;
};

/**
 * The api-key connector row list, on its own: every credentials/providers
 * fetch, the connect/reconnect dialog, and disconnect all owned here so
 * a caller only supplies the data it already has and a place to send a
 * reload/error signal. `ConnectionsSection` composes this with the OAuth
 * row pair and the advanced credentials table for the full Settings >
 * Connections page — its one consumer today. The onboarding wizard's own
 * "Connect your tools" step (CL-6028), which once rendered this alone
 * filtered to `feedsTools`-bearing connectors, was dropped in CL-6104:
 * connecting tools now lives only in Settings and the Plugins gallery,
 * never in onboarding. Renders bare `ConnectorRow`s — not wrapped in
 * `.settings-connections-list` itself — so a caller controls the list
 * container (and can put other rows, like the OAuth pair, in the same
 * list alongside these).
 */
export function ConnectorRowList({
  tenantId,
  credentials,
  providers,
  models,
  ownOfferingIds,
  filter,
  onReload,
  onError,
  onConnected,
}: {
  readonly tenantId: string;
  readonly credentials: readonly Credential[];
  readonly providers: readonly Provider[];
  readonly models: readonly ModelInfo[];
  readonly ownOfferingIds: ReadonlySet<string>;
  /** Narrows which registry entries render a row. Defaults to every
   * api-key connector (every entry with a `probe`) — OAuth connectors
   * are never included here regardless of filter, since this list has
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

  function handleDisconnect(connectorId: string) {
    onError?.(null);
    disconnectConnector(tenantId, connectorId)
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

  const effectiveRows = buildEffectiveInferenceRows(models, ownOfferingIds);

  function handlePickDefault(offeringId: string, providerName: string) {
    onError?.(null);
    const providerOfferings = effectiveRows.filter(
      (row) => row.providerName === providerName,
    );
    const patches = computeMakeDefaultPatches(providerOfferings, offeringId);
    if (patches === null) {
      onError?.(SETTINGS_STRINGS.connectionsSetDefaultModelError);
      return;
    }
    Promise.all(
      patches.map((patch) =>
        updateOwnOffering(tenantId, patch.offeringId, {
          priority: patch.priority,
        }),
      ),
    )
      .then(() => onReload())
      .catch(() => onError?.(SETTINGS_STRINGS.connectionsSetDefaultModelError));
  }

  return (
    <>
      {descriptors.map((descriptor) => (
        <ConnectorRow
          key={descriptor.id}
          descriptor={descriptor}
          statusResult={connectorStatus(descriptor.id, credentials, providers)}
          defaultModel={
            descriptor.feedsTools.length === 0
              ? defaultModelForProvider(models, descriptor.id)
              : null
          }
          providerOfferings={
            descriptor.feedsTools.length === 0
              ? effectiveRows.filter(
                  (row) => row.providerName === descriptor.id,
                )
              : []
          }
          onPickDefault={(offeringId) =>
            handlePickDefault(offeringId, descriptor.id)
          }
          onConnect={() => {
            setDialogMode("connect");
            setDialogDescriptor(descriptor);
          }}
          onReconnect={() => {
            setDialogMode("reconnect");
            setDialogDescriptor(descriptor);
          }}
          onDisconnect={() => handleDisconnect(descriptor.id)}
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
      getResolvedCatalog(tenantId),
      listOwnOfferings(tenantId),
    ])
      .then(
        ([credentials, providers, oauthConfigured, models, ownOfferings]) => {
          if (!cancelled)
            setQuery({
              kind: "ready",
              data: {
                credentials,
                providers,
                oauthConfigured,
                models,
                ownOfferingIds: new Set(
                  ownOfferings.map((offering) => offering.id),
                ),
              },
            });
        },
      )
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

  // The row list's and OAuth pair's disconnect action — a connector, not
  // a raw credential, so it goes through `disconnectConnector`'s
  // orchestrated cleanup (catalog provider, then credential provider —
  // see that function's own header for why a direct credential delete
  // 500s for an inference provider, CL-6258).
  function handleDisconnectConnector(connectorId: string) {
    setRowError(null);
    disconnectConnector(currentTenantId, connectorId)
      .then(() => {
        reload();
        toast(SETTINGS_STRINGS.credentialRevokedToast);
      })
      .catch(() => setRowError(SETTINGS_STRINGS.connectionsDisconnectError));
  }

  // The Advanced disclosure's raw credentials table has no connector to
  // orchestrate around — a certificate or `other`-typed row is never
  // planted through `/complete`/`seedCatalog`, so it never has a catalog
  // provider row to clean up first. A plain credential delete stays
  // correct for exactly this escape hatch.
  function handleDeleteCredential(credential: Credential) {
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
      {({ credentials, providers, oauthConfigured, models, ownOfferingIds }) => {
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
            <div className="settings-connections-list">
              <ConnectorRowList
                tenantId={currentTenantId}
                credentials={credentials}
                providers={providers}
                models={models}
                ownOfferingIds={ownOfferingIds}
                onReload={reload}
                onError={setRowError}
              />
              {OAUTH_CARDS.map((card) => (
                <OAuthConnectorRow
                  key={card.id}
                  card={card}
                  statusResult={connectorStatus(
                    card.id,
                    credentials,
                    providers,
                  )}
                  defaultModel={defaultModelForProvider(models, card.id)}
                  // Absent from the map reads as "not configured" — the
                  // conservative default: never render a live Connect button
                  // on data this section failed to positively confirm.
                  configured={oauthConfigured[card.id] ?? false}
                  onDisconnect={() => handleDisconnectConnector(card.id)}
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
                  onDelete={handleDeleteCredential}
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

/** Plain, uppercase status text — never a colored pill. Needs-attention is
 * the one accent-colored state on this row (the owner's brand rule: grey
 * for text/structure, the accent color only ever marks something to act
 * on), matching the plugins directory's own `plugins-directory-needs-
 * attention` convention. */
function StatusCaption({
  statusResult,
}: {
  readonly statusResult: ConnectorStatusResult;
}) {
  if (statusResult.status === "connected") {
    return (
      <span className="settings-connection-row-status">
        {SETTINGS_STRINGS.connectionsStatusConnected}
      </span>
    );
  }
  if (statusResult.status === "needs_attention") {
    return (
      <span className="settings-connection-row-status settings-connection-row-status-attention">
        {SETTINGS_STRINGS.connectionsStatusNeedsAttention}
      </span>
    );
  }
  return (
    <span className="settings-connection-row-status">
      {SETTINGS_STRINGS.connectionsStatusNotConnected}
    </span>
  );
}

/** The row's brand mark: a connector's `simple-icons` path where the
 * registry has one, a monochrome initial tile otherwise — the same tile
 * pattern (zero radius, hairline border) the plugins directory's own
 * `PluginLogo` uses (`packages/chat-ui/src/channel-settings/plugins-
 * section.tsx`), reused here rather than re-derived (CL-6258). */
function ConnectorLogo({
  displayName,
  icon,
}: {
  readonly displayName: string;
  readonly icon?: { readonly path: string; readonly hex: string };
}) {
  if (icon !== undefined) {
    return (
      <span className="settings-connection-row-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill={`#${icon.hex}`}>
          <path d={icon.path} />
        </svg>
      </span>
    );
  }
  return (
    <span
      className="settings-connection-row-logo settings-connection-row-logo-initial"
      aria-hidden="true"
    >
      {displayName.charAt(0).toUpperCase()}
    </span>
  );
}

function defaultModelCaption(defaultModel: DefaultProviderModel | null) {
  if (defaultModel === null) return null;
  const label = defaultModel.displayName ?? defaultModel.canonicalName;
  return SETTINGS_STRINGS.connectionsDefaultModelLine(label);
}

/** The offering `defaultModelForProvider` would pick for this same row
 * set — lowest priority wins, first occurrence breaks a tie — so the
 * select's initial value always names the offering actually in effect,
 * never a second, independently-computed notion of "current." */
function winningOffering(
  rows: readonly EffectiveInferenceRow[],
): EffectiveInferenceRow | null {
  let best: EffectiveInferenceRow | null = null;
  for (const row of rows) {
    if (best === null || row.priority < best.priority) best = row;
  }
  return best;
}

/**
 * The default-model caption, made pickable (CL-6258 follow-up: "set
 * default models"). Renders a quiet, unstyled-as-a-button `<select>` —
 * matching the row's other captions, never button chrome — listing this
 * provider's own resolved offerings; `null` when the provider has none
 * to choose between (nothing resolved yet, same case
 * `defaultModelCaption` already returns `null` for).
 */
function DefaultModelPicker({
  providerOfferings,
  onPick,
}: {
  readonly providerOfferings: readonly EffectiveInferenceRow[];
  readonly onPick: (offeringId: string) => void;
}) {
  if (providerOfferings.length === 0) return null;
  const current = winningOffering(providerOfferings);
  return (
    <p className="settings-connection-row-caption">
      {SETTINGS_STRINGS.connectionsDefaultModelLabel}{" "}
      <select
        className="settings-connection-row-default-model-select"
        value={current?.offeringId ?? ""}
        onChange={(event) => onPick(event.target.value)}
      >
        {providerOfferings.map((row) => (
          <option key={row.offeringId} value={row.offeringId}>
            {row.modelDisplayName ?? row.canonicalName}
          </option>
        ))}
      </select>
    </p>
  );
}

function ConnectorRow({
  descriptor,
  statusResult,
  defaultModel,
  providerOfferings,
  onPickDefault,
  onConnect,
  onReconnect,
  onDisconnect,
}: {
  readonly descriptor: ConnectorDescriptor;
  readonly statusResult: ConnectorStatusResult;
  /** This provider's one resolved default model — see
   * `defaultModelForProvider`'s own header. `null` for a tool/plugin
   * connector (`feedsTools.length > 0`, which shows "Used by workflows"
   * instead) or an inference provider that resolves nothing yet. */
  readonly defaultModel: DefaultProviderModel | null;
  /** This provider's own resolved offerings — the pick list
   * `DefaultModelPicker` renders. Empty for a tool/plugin connector, same
   * case `defaultModel` is `null` for. */
  readonly providerOfferings: readonly EffectiveInferenceRow[];
  readonly onPickDefault: (offeringId: string) => void;
  readonly onConnect: () => void;
  readonly onReconnect: () => void;
  readonly onDisconnect: () => void;
}) {
  return (
    <div className="settings-connection-row">
      <ConnectorLogo
        displayName={descriptor.displayName}
        {...(descriptor.icon !== undefined ? { icon: descriptor.icon } : {})}
      />
      <div className="settings-connection-row-text">
        <div className="settings-connection-row-name-row">
          <span className="settings-connection-row-name">
            {descriptor.displayName}
          </span>
          <StatusCaption statusResult={statusResult} />
        </div>
        {statusResult.status === "connected" &&
          defaultModelCaption(defaultModel) !== null && (
            <DefaultModelPicker
              providerOfferings={providerOfferings}
              onPick={onPickDefault}
            />
          )}
        {descriptor.feedsTools.length > 0 && (
          <span className="settings-connection-row-pinned-row">
            <span className="settings-connection-row-caption">
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
      </div>
      <div className="settings-connection-row-action">
        {statusResult.status === "connected" && (
          <ConfirmButton
            variant="ghost"
            size="sm"
            className="settings-connection-row-disconnect-action"
            confirmLabel={SETTINGS_STRINGS.connectionsDisconnectConfirm}
            onConfirm={onDisconnect}
          >
            {SETTINGS_STRINGS.connectionsDisconnectAction}
          </ConfirmButton>
        )}
        {statusResult.status === "not_connected" && (
          <Button
            variant="ghost"
            size="sm"
            className="settings-connection-row-connect-action"
            onClick={onConnect}
          >
            {SETTINGS_STRINGS.connectionsConnectAction}
          </Button>
        )}
        {statusResult.status === "needs_attention" && (
          <Button
            variant="ghost"
            size="sm"
            className="settings-connection-row-connect-action"
            onClick={onReconnect}
          >
            {SETTINGS_STRINGS.connectionsReconnectAction}
          </Button>
        )}
      </div>
    </div>
  );
}

function OAuthConnectorRow({
  card,
  statusResult,
  defaultModel,
  configured,
  onDisconnect,
}: {
  readonly card: OAuthConnectorCard;
  readonly statusResult: ConnectorStatusResult;
  readonly defaultModel: DefaultProviderModel | null;
  /** Whether an operator has registered this connector's OAuth app
   * (a client id present server-side) — distinct from `statusResult`,
   * which is about whether *this tenant* has connected, not whether
   * connecting is even possible yet. */
  readonly configured: boolean;
  readonly onDisconnect: () => void;
}) {
  const icon = CONNECTOR_REGISTRY[card.id]?.icon;

  // An unconfigured connector never gets a live Connect button, even
  // when this tenant already holds a (now-orphaned) credential for it —
  // there is no OAuth app to round-trip through until an operator
  // registers one, so the muted state wins regardless of `statusResult`.
  if (!configured) {
    return (
      <div className="settings-connection-row settings-connection-row-muted">
        <ConnectorLogo
          displayName={card.displayName}
          {...(icon !== undefined ? { icon } : {})}
        />
        <div className="settings-connection-row-text">
          <div className="settings-connection-row-name-row">
            <span className="settings-connection-row-name">
              {card.displayName}
            </span>
            <span className="settings-connection-row-status">
              {SETTINGS_STRINGS.connectionsStatusNotConfigured}
            </span>
          </div>
          <p className="settings-connection-row-caption">
            {SETTINGS_STRINGS.connectionsNotConfiguredHint}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-connection-row">
      <ConnectorLogo
        displayName={card.displayName}
        {...(icon !== undefined ? { icon } : {})}
      />
      <div className="settings-connection-row-text">
        <div className="settings-connection-row-name-row">
          <span className="settings-connection-row-name">
            {card.displayName}
          </span>
          <StatusCaption statusResult={statusResult} />
        </div>
        {statusResult.status === "connected" &&
          defaultModelCaption(defaultModel) !== null && (
            <p className="settings-connection-row-caption">
              {defaultModelCaption(defaultModel)}
            </p>
          )}
      </div>
      <div className="settings-connection-row-action">
        {statusResult.status === "connected" ? (
          <ConfirmButton
            variant="ghost"
            size="sm"
            className="settings-connection-row-disconnect-action"
            confirmLabel={SETTINGS_STRINGS.connectionsDisconnectConfirm}
            onConfirm={onDisconnect}
          >
            {SETTINGS_STRINGS.connectionsDisconnectAction}
          </ConfirmButton>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="settings-connection-row-connect-action"
            asChild
          >
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
