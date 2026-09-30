// The stock credential routes are the only way a key gets stored in this
// repo — no connector registry, no per-provider card. A credential minted
// by signing in is renewed by signing in again, through the same hub-hosted
// login the onboarding step uses.

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
} from "@corbits/react-ui";
import { reportError } from "@corbits/error-sink";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { QueryView, toAPIQuery } from "@/lib/api-query";
import {
  deleteOwnOffering,
  listOwnModelProviders,
  listOwnModels,
  listOwnOfferings,
  mintOfferingForModel,
  readProviderLogin,
  startProviderLogin,
  updateModelProviderBaseURL,
  type ModelOfferingResponse,
  type ModelProviderResponse,
  type ModelResponse,
} from "@/settings/inference";
import { redeployMyraForModelChange } from "@/settings/myra-model-redeploy";
import { tenantKeys } from "@/query-client";
import { finishDeferredMyraSetup } from "@/deferred-myra-setup";
import { useSessionUser } from "@/navigation";
import {
  deleteCredential,
  listCredentials,
  listProviders,
  updateCredential,
  type Credential,
  type Provider,
} from "./credentials-api";
import { SETTINGS_STRINGS } from "./strings";
import { ConfirmButton } from "../components/confirm-button";
import { ProviderConnectStep } from "../onboarding/provider-connect-step";
import { SettingsGroup, SettingsRow } from "./rows";
import { inferenceProviders, providerLabel } from "./inference-providers";

type CatalogProvider = typeof ModelProviderResponse.infer;
type CatalogOffering = typeof ModelOfferingResponse.infer;

/** The tenant-owned catalog provider a credential authenticates, if any —
 * the row inference actually dials (base URL) and reads the model from,
 * as opposed to the credential's own opaque metadata. */
function linkedCatalogProvider(
  credential: Credential,
  catalogProviders: readonly CatalogProvider[],
): CatalogProvider | null {
  return catalogProviders.find((provider) => provider.credentialId === credential.id) ?? null;
}

/** The one offering this repo's connect flow (`shadowOffering`) mints per
 * provider — first match is enough since the edit dialog only ever shows
 * one model field. */
function linkedCatalogOffering(
  provider: CatalogProvider,
  catalogOfferings: readonly CatalogOffering[],
): CatalogOffering | null {
  return catalogOfferings.find((offering) => offering.providerId === provider.id) ?? null;
}

/** The registered OAuth provider a credential was minted by, as
 * `@corbits/oauth-core` records it; absent on a pasted key. */
function oauthProviderOf(credential: Credential): string | null {
  const metadata: unknown = credential.metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const value = (metadata as Record<string, unknown>).oauthProvider;
  return typeof value === "string" && value.length > 0 ? value : null;
}

type CredentialsData = {
  readonly credentials: readonly Credential[];
  readonly providers: readonly Provider[];
  readonly catalogProviders: readonly CatalogProvider[];
  readonly catalogOfferings: readonly CatalogOffering[];
  readonly catalogModels: readonly (typeof ModelResponse.infer)[];
};

export function CredentialsSection({ tenantId }: { readonly tenantId: string | null }) {
  const queryClient = useQueryClient();
  const user = useSessionUser();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Credential | null>(null);
  const [loginId, setLoginId] = useState<string | null>(null);

  // Credentials and their providers load together: creating one needs the
  // provider row for the typed name, so a split read would race the form.
  const result = useQuery<CredentialsData>({
    queryKey: tenantKeys.credentials(tenantId ?? "none"),
    queryFn: async (): Promise<CredentialsData> => {
      if (tenantId === null) {
        return {
          credentials: [],
          providers: [],
          catalogProviders: [],
          catalogOfferings: [],
          catalogModels: [],
        };
      }
      const [credentials, providers, catalogProviders, catalogOfferings, catalogModels] =
        await Promise.all([
          listCredentials(tenantId),
          listProviders(tenantId),
          listOwnModelProviders(tenantId),
          listOwnOfferings(tenantId),
          listOwnModels(tenantId),
        ]);
      return {
        credentials,
        providers,
        catalogProviders,
        catalogOfferings,
        catalogModels,
      };
    },
    enabled: tenantId !== null,
  });
  const query = toAPIQuery(result);
  const catalogProviders = result.data?.catalogProviders ?? [];
  const catalogOfferings = result.data?.catalogOfferings ?? [];
  const catalogModels = result.data?.catalogModels ?? [];

  function reload() {
    if (tenantId === null) return;
    // A provider connected after a skipped onboarding finishes Myra's deploy.
    if (user !== undefined) void finishDeferredMyraSetup(user);
    void queryClient.invalidateQueries({
      queryKey: tenantKeys.credentials(tenantId),
    });
    // The catalog rows this dialog can now rewrite are read by the
    // Inference settings section and by chat's model resolution — both
    // key off the resolved catalog, so a credential edit must bust it too.
    void queryClient.invalidateQueries({
      queryKey: ["tenant", tenantId, "settings-models"],
    });
  }

  // Re-signing in files the tokens under the same credential name, so the
  // hub replaces the material in place and every offering keeps pointing at it.
  const signIn = useMutation({
    mutationFn: (credential: Credential) => {
      const provider = oauthProviderOf(credential);
      if (tenantId === null || provider === null) {
        throw new Error("that credential was not created by signing in");
      }
      return startProviderLogin(tenantId, {
        provider,
        providerId: credential.providerId,
        credentialName: credential.name,
      });
    },
    onSuccess: (started) => {
      setLoginId(started.loginId);
      window.open(started.authorizeUrl, "_blank", "noopener,noreferrer");
    },
  });

  const login = useQuery({
    queryKey: tenantKeys.credentials(tenantId ?? "none").concat("oauth-login", loginId ?? ""),
    enabled: tenantId !== null && loginId !== null,
    queryFn: async () => {
      if (tenantId === null || loginId === null) throw new Error("no sign-in in flight");
      const state = await readProviderLogin(tenantId, loginId);
      if (state.status !== "pending") {
        setLoginId(null);
        reload();
      }
      return state;
    },
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 2000 : false),
  });

  const update = useMutation({
    mutationFn: async (input: {
      readonly credentialId: string;
      readonly name: string;
      readonly description: string;
      readonly baseURL: string;
      readonly model: string;
    }) => {
      if (tenantId === null) throw new Error("no workbench selected");
      await updateCredential(tenantId, input.credentialId, {
        name: input.name,
        description: input.description,
      });
      const credential = result.data?.credentials.find((row) => row.id === input.credentialId);
      const provider =
        credential === undefined ? null : linkedCatalogProvider(credential, catalogProviders);
      if (provider === null) return;
      if (input.baseURL.length > 0 && input.baseURL !== provider.baseURL) {
        await updateModelProviderBaseURL(tenantId, provider.id, input.baseURL);
      }
      const offering = linkedCatalogOffering(provider, catalogOfferings);
      const currentModel = catalogModels.find((row) => row.id === offering?.modelId);
      if (
        offering !== null &&
        input.model.length > 0 &&
        input.model !== currentModel?.canonicalName
      ) {
        const newOffering = await mintOfferingForModel(
          tenantId,
          offering,
          input.model,
          input.model,
        );
        if (newOffering.id !== offering.id) {
          // Myra's own deployed run pins the old offering id — moving her onto
          // the new one first, then retiring the old one, is the only order
          // that never leaves a live run pointed at a dead offering. A failed
          // redeploy throws here and both offerings are left in place.
          await redeployMyraForModelChange({
            tenantId,
            oldOfferingId: offering.id,
            newOfferingId: newOffering.id,
            provider: provider.plugin,
            newCanonicalName: input.model,
          });
          await deleteOwnOffering(tenantId, offering.id);
        }
      }
    },
    onSuccess: () => {
      setEditing(null);
      reload();
    },
    onError: (cause: unknown) => {
      reportError(cause, {
        operation: "settings.credentials.update",
        tenantId: tenantId ?? "none",
      });
    },
  });

  // The stock DELETE route this hits: `vendor/intx/hub-api/src/routes/
  // credentials.ts`'s `app.delete("/:credentialId", ...)`.
  const del = useMutation({
    mutationFn: (credential: Credential) => {
      if (tenantId === null) throw new Error("no workbench selected");
      return deleteCredential(tenantId, credential.id);
    },
    onSuccess: reload,
  });

  const editingProvider =
    editing === null ? null : linkedCatalogProvider(editing, catalogProviders);
  const editingOffering =
    editingProvider === null ? null : linkedCatalogOffering(editingProvider, catalogOfferings);
  const editingModel = catalogModels.find((row) => row.id === editingOffering?.modelId) ?? null;
  const editingLinkage: EditCredentialLinkage | null =
    editingProvider === null
      ? null
      : {
          baseURL: editingProvider.baseURL,
          model: editingModel?.canonicalName ?? "",
        };

  if (tenantId === null) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.benchNoneSelectedTitle}
        description={SETTINGS_STRINGS.benchNoneSelectedDescription}
      />
    );
  }

  return (
    <QueryView query={query} label={SETTINGS_STRINGS.credentialsLoadError}>
      {({ credentials: all, providers }) => {
        const inference = inferenceProviders(providers);
        const credentials = all.filter((row) => inference.some((p) => p.id === row.providerId));
        return (
          <SettingsGroup
            title={SETTINGS_STRINGS.credentialsSectionTitle}
            description={SETTINGS_STRINGS.credentialsSectionDescription}
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                {SETTINGS_STRINGS.credentialsCreateAction}
              </Button>
            }
          >
            {del.error === null || del.error === undefined ? null : (
              <p className="settings-inline-error" role="alert">
                {SETTINGS_STRINGS.credentialsDeleteError}
              </p>
            )}
            {signIn.error === null || signIn.error === undefined ? null : (
              <p className="settings-inline-error" role="alert">
                {SETTINGS_STRINGS.credentialsSignInAgainError}
              </p>
            )}
            <CredentialsTable
              credentials={credentials}
              providers={inference}
              signingIn={signIn.isPending || login.data?.status === "pending"}
              onEdit={setEditing}
              onDelete={(credential) => del.mutate(credential)}
              onSignIn={(credential) => signIn.mutate(credential)}
            />
            <AddProviderDialog
              tenantId={tenantId}
              open={createOpen}
              onOpenChange={setCreateOpen}
              onConnected={() => {
                setCreateOpen(false);
                reload();
              }}
            />
            <EditCredentialDialog
              credential={editing}
              linked={editingLinkage}
              onOpenChange={(open) => {
                if (!open) setEditing(null);
              }}
              onSave={(input) => update.mutate(input)}
              submitting={update.isPending}
              error={update.error === null ? null : SETTINGS_STRINGS.credentialsEditError}
            />
          </SettingsGroup>
        );
      }}
    </QueryView>
  );
}

function CredentialsTable({
  credentials,
  providers,
  signingIn,
  onEdit,
  onDelete,
  onSignIn,
}: {
  readonly credentials: readonly Credential[];
  readonly providers: readonly Provider[];
  readonly signingIn: boolean;
  readonly onEdit: (credential: Credential) => void;
  readonly onDelete: (credential: Credential) => void;
  readonly onSignIn: (credential: Credential) => void;
}) {
  if (credentials.length === 0) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.credentialsEmptyTitle}
        description={SETTINGS_STRINGS.credentialsEmptyDescription}
      />
    );
  }
  return (
    <>
      {credentials.map((credential) => (
        <SettingsRow
          key={credential.id}
          title={providerLabel(providers.find((p) => p.id === credential.providerId))}
          meta={
            <>
              <span>{credential.type}</span>
              <span>{credential.status}</span>
            </>
          }
          actions={
            <>
              {credential.type === "oauth_token" && oauthProviderOf(credential) !== null ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={signingIn}
                  onClick={() => onSignIn(credential)}
                >
                  {signingIn
                    ? SETTINGS_STRINGS.credentialsSignInAgainPending
                    : SETTINGS_STRINGS.credentialsSignInAgainAction}
                </Button>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => onEdit(credential)}>
                {SETTINGS_STRINGS.credentialsEditAction}
              </Button>
              <ConfirmButton
                size="sm"
                confirmLabel={SETTINGS_STRINGS.credentialsDeleteConfirm}
                onConfirm={() => onDelete(credential)}
              >
                {SETTINGS_STRINGS.credentialsDeleteAction}
              </ConfirmButton>
            </>
          }
        />
      ))}
    </>
  );
}

function AddProviderDialog({
  tenantId,
  open,
  onOpenChange,
  onConnected,
}: {
  readonly tenantId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConnected: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setError(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{SETTINGS_STRINGS.credentialsCreateDialogTitle}</DialogTitle>
          <DialogDescription>
            {SETTINGS_STRINGS.credentialsCreateDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ProviderConnectStep tenantId={tenantId} onConnected={onConnected} onError={setError} />
          {error !== null && (
            <p className="settings-inline-error" role="alert">
              {error}
            </p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

type EditCredentialInput = {
  readonly credentialId: string;
  readonly name: string;
  readonly description: string;
  readonly baseURL: string;
  readonly model: string;
};

/** The catalog values this credential's linked provider/offering carry
 * today, or `null` when the credential has no linked provider — the dialog
 * shows base URL/model fields only in the linked case. */
type EditCredentialLinkage = {
  readonly baseURL: string;
  readonly model: string;
};

function EditCredentialDialog({
  credential,
  linked,
  onOpenChange,
  onSave,
  submitting,
  error = null,
}: {
  readonly credential: Credential | null;
  readonly linked: EditCredentialLinkage | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (input: EditCredentialInput) => void;
  readonly submitting: boolean;
  readonly error?: string | null;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // A render-time sync (not an effect): the form's own fields mirror the
  // credential passed in exactly once per open, keyed by id.
  if (credential !== null && loadedFor !== credential.id) {
    setLoadedFor(credential.id);
    setName(credential.name);
    setDescription(credential.description ?? "");
    setBaseURL(linked?.baseURL ?? "");
    setModel(linked?.model ?? "");
  }

  const canSubmit = credential !== null && name.trim().length > 0;

  return (
    <Dialog open={credential !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{SETTINGS_STRINGS.credentialsEditDialogTitle}</DialogTitle>
          <DialogDescription>{SETTINGS_STRINGS.credentialsEditDialogDescription}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="edit-credential-form"
            className="settings-form-field"
            onSubmit={(event) => {
              event.preventDefault();
              if (credential === null || !canSubmit) return;
              onSave({
                credentialId: credential.id,
                name: name.trim(),
                description: description.trim(),
                baseURL: baseURL.trim(),
                model: model.trim(),
              });
            }}
          >
            <label className="settings-form-field">
              <span>{SETTINGS_STRINGS.credentialsNameLabel}</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </label>
            {linked !== null && (
              <>
                <label className="settings-form-field">
                  <span>{SETTINGS_STRINGS.credentialsBaseUrlLabel}</span>
                  <Input
                    type="url"
                    value={baseURL}
                    onChange={(event) => setBaseURL(event.target.value)}
                    placeholder="http://localhost:11434"
                  />
                </label>
                <label className="settings-form-field">
                  <span>{SETTINGS_STRINGS.credentialsModelLabel}</span>
                  <Input
                    type="text"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="qwen2.5:14b"
                  />
                  <span className="settings-field-hint">
                    {SETTINGS_STRINGS.credentialsModelChangeNotice}
                  </span>
                </label>
              </>
            )}
            {error !== null && (
              <p className="settings-inline-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {SETTINGS_STRINGS.credentialsEditCancel}
          </Button>
          <Button
            type="submit"
            form="edit-credential-form"
            variant="primary"
            disabled={!canSubmit || submitting}
          >
            {SETTINGS_STRINGS.credentialsEditSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
