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
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { credentialTypes } from "@intx/types";
import type { CredentialType } from "@intx/types";
import { CircleAlert, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";

import {
  createCredential,
  deleteCredential,
  listCredentials,
  listProviders,
  type Credential,
  type Provider,
} from "./credentials-api";
import { errorMessage, type LoadState } from "./load-state";
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

type CredentialsData = {
  readonly credentials: readonly Credential[];
  readonly providers: readonly Provider[];
};

export function CredentialsSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [state, setState] = useState<LoadState<CredentialsData>>({
    kind: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([listCredentials(tenantId), listProviders(tenantId)])
      .then(([credentials, providers]) => {
        if (!cancelled)
          setState({ kind: "ready", data: { credentials, providers } });
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
        title={`Couldn't load ${SETTINGS_STRINGS.credentialsLoadError}`}
        description={state.message}
      />
    );
  }

  function reload() {
    setReloadKey((value) => value + 1);
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
    createCredential(tenantId, {
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
      })
      .catch(() => setCreateError(SETTINGS_STRINGS.credentialsCreateError))
      .finally(() => setCreating(false));
  }

  function handleDelete(credential: Credential) {
    if (tenantId === null) return;
    setRowError(null);
    deleteCredential(tenantId, credential.id)
      .then(reload)
      .catch(() => setRowError(SETTINGS_STRINGS.credentialsDeleteError));
  }

  const providerNameById = new Map(
    state.data.providers.map((provider) => [provider.id, provider.name]),
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
        credentials={state.data.credentials}
        providerNameById={providerNameById}
        onDelete={handleDelete}
      />
      <CreateCredentialDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        providers={state.data.providers}
        onCreate={handleCreate}
        submitting={creating}
        error={createError}
      />
    </SettingsPanel>
  );
}

export function CredentialsTable({
  credentials,
  providerNameById,
  onDelete,
}: {
  readonly credentials: readonly Credential[];
  readonly providerNameById: ReadonlyMap<string, string>;
  readonly onDelete: (credential: Credential) => void;
}) {
  if (credentials.length === 0) {
    return (
      <EmptyState
        icon={<KeyRound />}
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
                credential.providerId}
            </TableCell>
            <TableCell>
              <code>{credential.type}</code>
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
              >
                {SETTINGS_STRINGS.credentialsDelete}
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

  useEffect(() => {
    if (!open) return;
    setProviderId(providers[0]?.id ?? "");
    setName("");
    setType("api_key");
    setSecret("");
    setDescription("");
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
          <label className="settings-field">
            <span>{SETTINGS_STRINGS.credentialsProviderLabel}</span>
            <select
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
              disabled={providers.length === 0}
            >
              {providers.length === 0 ? (
                <option value="">
                  {SETTINGS_STRINGS.credentialsNoProviders}
                </option>
              ) : (
                providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="settings-field">
            <span>{SETTINGS_STRINGS.credentialsNameLabel}</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={SETTINGS_STRINGS.credentialsNamePlaceholder}
            />
          </label>
          <label className="settings-field">
            <span>{SETTINGS_STRINGS.credentialsTypeLabel}</span>
            <select
              value={type}
              onChange={(event) =>
                setType(event.target.value as CredentialType)
              }
            >
              {credentialTypes.map((credType) => (
                <option key={credType} value={credType}>
                  {credType}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>{SETTINGS_STRINGS.credentialsSecretLabel}</span>
            <Input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="settings-field">
            <span>{SETTINGS_STRINGS.credentialsDescriptionLabel}</span>
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
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
