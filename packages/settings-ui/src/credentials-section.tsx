// The "Credentials" settings section: tenant-owned secrets (API keys,
// tokens) listed without the secret material, creatable, and revocable
// over the native `/api/tenants/:tenantId/credentials` routes.

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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@corbits/react-ui";
import { credentialTypes } from "@intx/types";
import type { CredentialType } from "@intx/types";
import { Key } from "@corbits/icons";
import { useEffect, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import {
  createCredential,
  deleteCredential,
  listCredentials,
  listProviders,
  type Credential,
  type Provider,
} from "./credentials-api";
import { KindCards } from "./kind-cards";
import { SETTINGS_STRINGS } from "./strings";

const STATUS_TONE: Record<
  Credential["status"],
  "success" | "danger" | "neutral" | "info"
> = {
  active: "success",
  expired: "neutral",
  revoked: "danger",
  error: "danger",
};

const CREDENTIAL_TYPE_LABEL: Record<CredentialType, string> = {
  api_key: "API key",
  oauth_token: "OAuth token",
  certificate: "Certificate",
  other: "Other",
};

type CredentialsData = {
  readonly credentials: readonly Credential[];
  readonly providers: readonly Provider[];
};

export function CredentialsSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [query, setQuery] = useState<APIQuery<CredentialsData>>({
    kind: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  function reload() {
    setReloadKey((value) => value + 1);
  }

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setQuery({ kind: "loading" });
    Promise.all([listCredentials(tenantId), listProviders(tenantId)])
      .then(([credentials, providers]) => {
        if (!cancelled)
          setQuery({ kind: "ready", data: { credentials, providers } });
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

  function handleCreate(input: {
    readonly providerId: string;
    readonly name: string;
    readonly type: CredentialType;
    readonly secret: string;
    readonly description: string;
  }) {
    if (tenantId === null) return;
    setCreating(true);
    setCreateError(null);
    const base = {
      providerId: input.providerId,
      name: input.name,
      type: input.type,
      secret: input.secret,
    };
    createCredential(
      tenantId,
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

  function handleDelete(credential: Credential) {
    if (tenantId === null) return;
    if (deletingIds.has(credential.id)) return;
    setRowError(null);
    setDeletingIds((current) => new Set(current).add(credential.id));
    deleteCredential(tenantId, credential.id)
      .then(() => {
        reload();
        toast(SETTINGS_STRINGS.credentialRevokedToast);
      })
      .catch(() => setRowError(SETTINGS_STRINGS.credentialsDeleteError))
      .finally(() => {
        setDeletingIds((current) => {
          const next = new Set(current);
          next.delete(credential.id);
          return next;
        });
      });
  }

  return (
    <QueryView query={query} label={SETTINGS_STRINGS.credentialsLoadError}>
      {({ credentials, providers }) => {
        const providerNameById = new Map(
          providers.map((provider) => [provider.id, provider.name]),
        );
        return (
          <SettingsPanel
            title={SETTINGS_STRINGS.credentialsSectionTitle}
            description={SETTINGS_STRINGS.credentialsSectionDescription}
          >
            <div className="settings-section-toolbar">
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                {SETTINGS_STRINGS.credentialsCreateAction}
              </Button>
            </div>
            {rowError !== null && (
              <p className="settings-inline-error" role="alert">
                {rowError}
              </p>
            )}
            <CredentialsTable
              credentials={credentials}
              providerNameById={providerNameById}
              onDelete={handleDelete}
              deletingIds={deletingIds}
            />
            <CreateCredentialDialog
              open={createOpen}
              onOpenChange={setCreateOpen}
              providers={providers}
              onCreate={handleCreate}
              submitting={creating}
              error={createError}
            />
          </SettingsPanel>
        );
      }}
    </QueryView>
  );
}

export function CredentialsTable({
  credentials,
  providerNameById,
  onDelete,
  deletingIds = new Set(),
}: {
  readonly credentials: readonly Credential[];
  readonly providerNameById: ReadonlyMap<string, string>;
  readonly onDelete: (credential: Credential) => void;
  readonly deletingIds?: ReadonlySet<string>;
}) {
  if (credentials.length === 0) {
    return (
      <EmptyState
        icon={<Key />}
        title={SETTINGS_STRINGS.credentialsEmptyTitle}
        description={SETTINGS_STRINGS.credentialsEmptyDescription}
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Provider</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {credentials.map((credential) => (
          <TableRow key={credential.id}>
            <TableCell>{credential.name}</TableCell>
            <TableCell>
              {providerNameById.get(credential.providerId) ??
                SETTINGS_STRINGS.credentialsRemovedProvider}
            </TableCell>
            <TableCell>
              <span title={credential.type}>
                {CREDENTIAL_TYPE_LABEL[credential.type]}
              </span>
            </TableCell>
            <TableCell>
              <Badge tone={STATUS_TONE[credential.status]}>
                {credential.status}
              </Badge>
            </TableCell>
            <TableCell>
              <ConfirmButton
                variant="destructive"
                size="sm"
                confirmLabel={SETTINGS_STRINGS.credentialsDeleteConfirm}
                onConfirm={() => onDelete(credential)}
                disabled={deletingIds.has(credential.id)}
              >
                {deletingIds.has(credential.id)
                  ? SETTINGS_STRINGS.credentialsDeleting
                  : SETTINGS_STRINGS.credentialsDelete}
              </ConfirmButton>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
export function CreateCredentialDialog({
  open,
  onOpenChange,
  providers,
  onCreate,
  submitting,
  error,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly providers: readonly Provider[];
  readonly onCreate: (input: {
    readonly providerId: string;
    readonly name: string;
    readonly type: CredentialType;
    readonly secret: string;
    readonly description: string;
  }) => void;
  readonly submitting: boolean;
  readonly error: string | null;
}) {
  const [providerId, setProviderId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<CredentialType>("api_key");
  const [secret, setSecret] = useState("");
  const [description, setDescription] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProviderId(providers[0]?.id ?? "");
    setName("");
    setType("api_key");
    setSecret("");
    setDescription("");
    setShowSecret(false);
  }, [open, providers]);

  const canSubmit =
    providerId !== "" &&
    name.trim() !== "" &&
    secret.trim() !== "" &&
    !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {SETTINGS_STRINGS.credentialsCreateDialogTitle}
          </DialogTitle>
          <DialogDescription>
            {SETTINGS_STRINGS.credentialsCreateDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="settings-form-stack">
          <div className="settings-form-field">
            <span>{SETTINGS_STRINGS.credentialsProviderLabel}</span>
            {providers.length === 0 ? (
              <p className="settings-field-hint">
                {SETTINGS_STRINGS.credentialsNoProviders}
              </p>
            ) : (
              <KindCards
                label={SETTINGS_STRINGS.credentialsProviderLabel}
                columns={2}
                value={providerId}
                onChange={setProviderId}
                options={providers.map((provider) => ({
                  id: provider.id,
                  title: provider.name,
                  description: provider.id,
                }))}
              />
            )}
          </div>
          <label className="settings-form-field">
            <span>{SETTINGS_STRINGS.credentialsNameLabel}</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={SETTINGS_STRINGS.credentialsNamePlaceholder}
            />
          </label>
          <label className="settings-form-field">
            <span>{SETTINGS_STRINGS.credentialsTypeLabel}</span>
            <select
              className="settings-select"
              value={type}
              onChange={(event) =>
                setType(event.target.value as CredentialType)
              }
            >
              {credentialTypes.map((credType) => (
                <option key={credType} value={credType}>
                  {CREDENTIAL_TYPE_LABEL[credType]}
                </option>
              ))}
            </select>
          </label>
          <div className="settings-form-field">
            <span>{SETTINGS_STRINGS.credentialsSecretLabel}</span>
            <div className="settings-secret-row">
              <Input
                type={showSecret ? "text" : "password"}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowSecret((value) => !value)}
              >
                {showSecret ? "Hide" : "Show"}
              </Button>
            </div>
            <p className="settings-field-hint">
              Sealed on save — this secret is never shown again after create.
            </p>
          </div>
          <label className="settings-form-field">
            <span>{SETTINGS_STRINGS.credentialsDescriptionLabel}</span>
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <p className="settings-field-hint">
            Who can use it defaults to this workbench&apos;s agents and tools
            that hold a grant for the provider.
          </p>
          {error !== null && (
            <p className="settings-inline-error" role="alert">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {SETTINGS_STRINGS.credentialsCreateCancel}
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit}
            onClick={() =>
              onCreate({
                providerId,
                name: name.trim(),
                type,
                secret,
                description,
              })
            }
          >
            {submitting
              ? SETTINGS_STRINGS.credentialsCreateSubmitting
              : SETTINGS_STRINGS.credentialsCreateSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
