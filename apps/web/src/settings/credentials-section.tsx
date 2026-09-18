// The "Credentials" settings section: a plain list-plus-create surface
// over Interchange's own stock credential routes
// (`vendor/intx/hub-api/src/routes/credentials.ts`) — the only way a key
// gets stored in this repo. No connector registry, no OAuth connect
// flow, no per-provider card: just the credentials this bench owns,
// named and typed, with a form to add one and a button to delete it.

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
  Input,
  SettingsPanel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import type { CredentialType } from "@intx/types";
import { useEffect, useState } from "react";

import type { APIQuery } from "@/lib/api-query";
import { QueryView, UnauthenticatedError, describeQueryError } from "@/lib/api-query";
import {
  createCredential,
  createProvider,
  credentialTypes,
  deleteCredential,
  listCredentials,
  listProviders,
  type Credential,
  type Provider,
} from "./credentials-api";
import { SETTINGS_STRINGS } from "./strings";

export function CredentialsSection({ tenantId }: { readonly tenantId: string | null }) {
  const [query, setQuery] = useState<APIQuery<readonly Credential[]>>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [providers, setProviders] = useState<readonly Provider[]>([]);

  function reload() {
    setReloadKey((value) => value + 1);
  }

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setQuery({ kind: "loading" });
    Promise.all([listCredentials(tenantId), listProviders(tenantId)])
      .then(([credentials, providerRows]) => {
        if (cancelled) return;
        setProviders(providerRows);
        setQuery({ kind: "ready", data: credentials });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof UnauthenticatedError) {
          setQuery({ kind: "unauthenticated" });
          return;
        }
        setQuery({ kind: "error", message: describeQueryError(cause), retry: reload });
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

  function handleCreate(name: string, type: CredentialType, secret: string) {
    if (tenantId === null) return;
    setCreating(true);
    setCreateError(null);
    const existing = providers.find((provider) => provider.name === name);
    (existing !== undefined ? Promise.resolve(existing) : createProvider(tenantId, name))
      .then((provider) =>
        createCredential(tenantId, { providerId: provider.id, name, type, secret }),
      )
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

  return (
    <QueryView query={query} label={SETTINGS_STRINGS.credentialsLoadError}>
      {(credentials) => (
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
          <CredentialsTable credentials={credentials} onDelete={handleDelete} />
          <CreateCredentialDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            onCreate={handleCreate}
            submitting={creating}
            error={createError}
          />
        </SettingsPanel>
      )}
    </QueryView>
  );
}

function CredentialsTable({
  credentials,
  onDelete,
}: {
  readonly credentials: readonly Credential[];
  readonly onDelete: (credential: Credential) => void;
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{SETTINGS_STRINGS.credentialsNameLabel}</TableHead>
          <TableHead>{SETTINGS_STRINGS.credentialsTypeLabel}</TableHead>
          <TableHead>{SETTINGS_STRINGS.credentialsStatusLabel}</TableHead>
          <TableHead className="settings-actions-cell">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {credentials.map((credential) => (
          <TableRow key={credential.id}>
            <TableCell>{credential.name}</TableCell>
            <TableCell>{credential.type}</TableCell>
            <TableCell>{credential.status}</TableCell>
            <TableCell className="settings-actions-cell">
              <ConfirmButton
                variant="destructive"
                size="sm"
                confirmLabel={SETTINGS_STRINGS.credentialsDeleteConfirm}
                onConfirm={() => onDelete(credential)}
              >
                {SETTINGS_STRINGS.credentialsDeleteAction}
              </ConfirmButton>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CreateCredentialDialog({
  open,
  onOpenChange,
  onCreate,
  submitting,
  error = null,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (name: string, type: CredentialType, secret: string) => void;
  readonly submitting: boolean;
  readonly error?: string | null;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<CredentialType>("api_key");
  const [secret, setSecret] = useState("");
  const canSubmit = name.trim().length > 0 && secret.trim().length > 0;

  function reset() {
    setName("");
    setType("api_key");
    setSecret("");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
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
          <form
            id="create-credential-form"
            className="settings-form-field"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) onCreate(name.trim(), type, secret);
            }}
          >
            <label className="settings-form-field">
              <span>{SETTINGS_STRINGS.credentialsNameLabel}</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </label>
            <label className="settings-form-field">
              <span>{SETTINGS_STRINGS.credentialsTypeLabel}</span>
              <select
                className="settings-select"
                value={type}
                onChange={(event) => setType(event.target.value as CredentialType)}
              >
                {credentialTypes.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-form-field">
              <span>{SETTINGS_STRINGS.credentialsSecretLabel}</span>
              <Input
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={SETTINGS_STRINGS.credentialsSecretPlaceholder}
              />
            </label>
            {error !== null && (
              <p className="settings-inline-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {SETTINGS_STRINGS.credentialsCreateCancel}
          </Button>
          <Button
            type="submit"
            form="create-credential-form"
            variant="primary"
            disabled={!canSubmit || submitting}
          >
            {SETTINGS_STRINGS.credentialsCreateSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
