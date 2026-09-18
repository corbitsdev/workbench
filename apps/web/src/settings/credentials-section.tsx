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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { QueryView, toAPIQuery } from "@/lib/api-query";
import { tenantKeys } from "@/query-client";
import {
  createCredential,
  createProvider,
  credentialTypes,
  deleteCredential,
  listCredentials,
  listProviders,
  updateCredential,
  type Credential,
  type Provider,
} from "./credentials-api";
import { SETTINGS_STRINGS } from "./strings";

type CredentialsData = {
  readonly credentials: readonly Credential[];
  readonly providers: readonly Provider[];
};

export function CredentialsSection({ tenantId }: { readonly tenantId: string | null }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Credential | null>(null);

  // Credentials and their providers load together: creating one needs the
  // provider row for the typed name, so a split read would race the form.
  const result = useQuery<CredentialsData>({
    queryKey: tenantKeys.credentials(tenantId ?? "none"),
    queryFn: async (): Promise<CredentialsData> => {
      if (tenantId === null) return { credentials: [], providers: [] };
      const [credentials, providers] = await Promise.all([
        listCredentials(tenantId),
        listProviders(tenantId),
      ]);
      return { credentials, providers };
    },
    enabled: tenantId !== null,
  });
  const query = toAPIQuery(result);
  const providers = result.data?.providers ?? [];

  function reload() {
    if (tenantId === null) return;
    void queryClient.invalidateQueries({ queryKey: tenantKeys.credentials(tenantId) });
  }

  const create = useMutation({
    mutationFn: async ({
      name,
      type,
      secret,
    }: {
      readonly name: string;
      readonly type: CredentialType;
      readonly secret: string;
    }) => {
      if (tenantId === null) throw new Error("no workbench selected");
      const existing = providers.find((provider) => provider.name === name);
      const provider = existing !== undefined ? existing : await createProvider(tenantId, name);
      return createCredential(tenantId, { providerId: provider.id, name, type, secret });
    },
    onSuccess: () => {
      setCreateOpen(false);
      reload();
    },
  });

  const update = useMutation({
    mutationFn: (input: {
      readonly credentialId: string;
      readonly name: string;
      readonly description: string;
      readonly baseURL: string;
      readonly model: string;
    }) => {
      if (tenantId === null) throw new Error("no workbench selected");
      return updateCredential(tenantId, input.credentialId, {
        name: input.name,
        description: input.description,
        metadata: { baseURL: input.baseURL, model: input.model },
      });
    },
    onSuccess: () => {
      setEditing(null);
      reload();
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
      {({ credentials }) => (
        <SettingsPanel
          title={SETTINGS_STRINGS.credentialsSectionTitle}
          description={SETTINGS_STRINGS.credentialsSectionDescription}
        >
          <div className="settings-section-toolbar">
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              {SETTINGS_STRINGS.credentialsCreateAction}
            </Button>
          </div>
          {del.error === null || del.error === undefined ? null : (
            <p className="settings-inline-error" role="alert">
              {SETTINGS_STRINGS.credentialsDeleteError}
            </p>
          )}
          <CredentialsTable
            credentials={credentials}
            onEdit={setEditing}
            onDelete={(credential) => del.mutate(credential)}
          />
          <CreateCredentialDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            onCreate={(name, type, secret) => create.mutate({ name, type, secret })}
            submitting={create.isPending}
            error={create.error === null ? null : SETTINGS_STRINGS.credentialsCreateError}
          />
          <EditCredentialDialog
            credential={editing}
            onOpenChange={(open) => {
              if (!open) setEditing(null);
            }}
            onSave={(input) => update.mutate(input)}
            submitting={update.isPending}
            error={update.error === null ? null : SETTINGS_STRINGS.credentialsEditError}
          />
        </SettingsPanel>
      )}
    </QueryView>
  );
}

function CredentialsTable({
  credentials,
  onEdit,
  onDelete,
}: {
  readonly credentials: readonly Credential[];
  readonly onEdit: (credential: Credential) => void;
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
              <Button variant="outline" size="sm" onClick={() => onEdit(credential)}>
                {SETTINGS_STRINGS.credentialsEditAction}
              </Button>
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

type EditCredentialInput = {
  readonly credentialId: string;
  readonly name: string;
  readonly description: string;
  readonly baseURL: string;
  readonly model: string;
};

function readMetadataString(metadata: Credential["metadata"], key: string): string {
  if (metadata === null || metadata === undefined) return "";
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/** Edits a credential through the stock `PATCH` route. `Base URL` and
 * `Model` are this form's own metadata convention for a local, Ollama-style
 * credential — they round-trip through the credential's opaque `metadata`
 * field, nothing platform-specific. */
function EditCredentialDialog({
  credential,
  onOpenChange,
  onSave,
  submitting,
  error = null,
}: {
  readonly credential: Credential | null;
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
    setBaseURL(readMetadataString(credential.metadata, "baseURL"));
    setModel(readMetadataString(credential.metadata, "model"));
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
