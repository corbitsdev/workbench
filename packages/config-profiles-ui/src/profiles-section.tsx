// The workspace-level "Config profiles" settings section (Everyone group):
// list, create-from-scratch or edit, delete with consequence copy, and
// "Save current setup as a profile" (capture). Follows
// `@corbits/settings-ui`'s own section patterns (`GrantsSection`,
// `PeopleSection`) exactly — a `LoadState` fetch, a toolbar, a table, a
// dialog for create/edit — without depending on that package directly, so
// this stays a plain domain package a host app composes in via
// `insertEveryoneSections`, the same way it already composes Agents and
// Skills (see `apps/web/src/settings-everyone-sections.tsx`). `tenantId`
// here is the bench selected in the app's chrome — the same tenant a
// captured/applied profile's `targetTenantId` is filled in with today,
// since this workstream has no separate workbench picker yet (see
// `apply-profile-panel.tsx`'s own module doc).
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@corbits/react-ui";
import { useEffect, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import {
  captureProfile,
  ConfigProfilesApiError,
  createProfile,
  deleteProfile,
  listProfiles,
  updateProfile,
  type ConfigProfile,
  type ConfigProfileEntry,
} from "./api";
import { CONFIG_PROFILES_STRINGS } from "./strings";

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ConfigProfilesApiError ? cause.message : fallback;
}

export function ProfilesSettingsSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [query, setQuery] = useState<APIQuery<readonly ConfigProfile[]>>({
    kind: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<ConfigProfile | "new" | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  function reload() {
    setReloadKey((value) => value + 1);
  }

  useEffect(() => {
    if (tenantId === null) return;
    setQuery({ kind: "loading" });
    listProfiles(tenantId)
      .then((profiles) => setQuery({ kind: "ready", data: profiles }))
      .catch((cause: unknown) => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, reloadKey]);

  if (tenantId === null) {
    return (
      <EmptyState
        title={CONFIG_PROFILES_STRINGS.benchNoneSelectedTitle}
        description={CONFIG_PROFILES_STRINGS.benchNoneSelectedDescription}
      />
    );
  }

  function handleDelete(profile: ConfigProfile) {
    if (tenantId === null) return;
    setRowError(null);
    deleteProfile(tenantId, profile.id)
      .then(() => {
        reload();
        toast(CONFIG_PROFILES_STRINGS.deletedToast(profile.name));
      })
      .catch((cause: unknown) =>
        setRowError(errorMessage(cause, CONFIG_PROFILES_STRINGS.deleteError)),
      );
  }

  return (
    <QueryView query={query} label={CONFIG_PROFILES_STRINGS.loadError}>
      {(profiles) => (
        <div className="config-profiles-pane">
          <div className="config-profiles-toolbar">
            <Button variant="primary" onClick={() => setEditing("new")}>
              {CONFIG_PROFILES_STRINGS.createButton}
            </Button>
            <Button variant="outline" onClick={() => setCaptureOpen(true)}>
              {CONFIG_PROFILES_STRINGS.captureButton}
            </Button>
          </div>
          {rowError !== null ? (
            <p className="config-profiles-error" role="alert">
              {rowError}
            </p>
          ) : null}
          {profiles.length === 0 ? (
            <EmptyState
              title={CONFIG_PROFILES_STRINGS.emptyTitle}
              description={CONFIG_PROFILES_STRINGS.emptyDescription}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{CONFIG_PROFILES_STRINGS.columnName}</TableHead>
                  <TableHead>
                    {CONFIG_PROFILES_STRINGS.columnProviders}
                  </TableHead>
                  <TableHead>{CONFIG_PROFILES_STRINGS.columnActions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profiles.map((profile) => (
                  <TableRow key={profile.id}>
                    <TableCell>
                      <strong>{profile.name}</strong>
                      {profile.description !== null ? (
                        <p className="config-profiles-field-hint">
                          {profile.description}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>{profile.entries.length}</TableCell>
                    <TableCell>
                      <div className="config-profiles-row-actions">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEditing(profile)}
                        >
                          {CONFIG_PROFILES_STRINGS.editButton}
                        </Button>
                        <ConfirmButton
                          variant="destructive"
                          size="sm"
                          confirmLabel={CONFIG_PROFILES_STRINGS.deleteConfirm}
                          onConfirm={() => handleDelete(profile)}
                        >
                          {CONFIG_PROFILES_STRINGS.deleteButton}
                        </ConfirmButton>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <EditProfileDialog
            profile={editing}
            tenantId={tenantId}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
          />
          <CaptureProfileDialog
            open={captureOpen}
            tenantId={tenantId}
            onClose={() => setCaptureOpen(false)}
            onSaved={() => {
              setCaptureOpen(false);
              reload();
            }}
          />
        </div>
      )}
    </QueryView>
  );
}

function emptyEntryRow(): ConfigProfileEntry {
  return { provider: "", model: "" };
}

function EditProfileDialog({
  profile,
  tenantId,
  onClose,
  onSaved,
}: {
  readonly profile: ConfigProfile | "new" | null;
  readonly tenantId: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [entries, setEntries] = useState<ConfigProfileEntry[]>([
    emptyEntryRow(),
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSubmitting(false);
    setError(null);
    if (profile === null) return;
    if (profile === "new") {
      setName("");
      setDescription("");
      setEntries([emptyEntryRow()]);
      return;
    }
    setName(profile.name);
    setDescription(profile.description ?? "");
    setEntries(
      profile.entries.length > 0 ? [...profile.entries] : [emptyEntryRow()],
    );
  }, [profile]);

  if (profile === null) return null;

  const validEntries = entries.filter(
    (entry) => entry.provider.trim() !== "" && entry.model.trim() !== "",
  );
  const canSubmit = name.trim() !== "" && validEntries.length > 0;

  function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const trimmedDescription = description.trim();
    const request =
      profile === "new" || profile === null
        ? createProfile(tenantId, {
            name: name.trim(),
            entries: validEntries,
            ...(trimmedDescription !== ""
              ? { description: trimmedDescription }
              : {}),
          })
        : updateProfile(tenantId, profile.id, {
            name: name.trim(),
            entries: validEntries,
            description: trimmedDescription === "" ? null : trimmedDescription,
          });
    request
      .then(() => {
        onSaved();
        toast(
          profile === "new"
            ? CONFIG_PROFILES_STRINGS.createdToast
            : CONFIG_PROFILES_STRINGS.savedToast,
        );
      })
      .catch((cause: unknown) =>
        setError(errorMessage(cause, CONFIG_PROFILES_STRINGS.saveError)),
      )
      .finally(() => setSubmitting(false));
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {profile === "new"
              ? CONFIG_PROFILES_STRINGS.createProfileTitle
              : CONFIG_PROFILES_STRINGS.editProfileTitle}
          </DialogTitle>
          <DialogDescription>
            {CONFIG_PROFILES_STRINGS.profileDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="config-profiles-field">
            <label className="config-profiles-field">
              <span>{CONFIG_PROFILES_STRINGS.nameLabel}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="config-profiles-field">
              <span>{CONFIG_PROFILES_STRINGS.descriptionLabel}</span>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <div className="config-profiles-field">
              <span>{CONFIG_PROFILES_STRINGS.fallbackOrderLabel}</span>
              {entries.map((entry, index) => (
                <div key={index} className="config-profiles-row-actions">
                  <Input
                    value={entry.provider}
                    placeholder={CONFIG_PROFILES_STRINGS.providerPlaceholder}
                    onChange={(e) => {
                      const next = [...entries];
                      next[index] = { ...entry, provider: e.target.value };
                      setEntries(next);
                    }}
                  />
                  <Input
                    value={entry.model}
                    placeholder={CONFIG_PROFILES_STRINGS.modelPlaceholder}
                    onChange={(e) => {
                      const next = [...entries];
                      next[index] = { ...entry, model: e.target.value };
                      setEntries(next);
                    }}
                  />
                  <label className="config-profiles-disabled-toggle">
                    <input
                      type="checkbox"
                      checked={entry.disabled ?? false}
                      onChange={(e) => {
                        const next = [...entries];
                        next[index] = { ...entry, disabled: e.target.checked };
                        setEntries(next);
                      }}
                    />
                    {CONFIG_PROFILES_STRINGS.disabledEntryLabel}
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEntries(entries.filter((_, i) => i !== index))
                    }
                  >
                    {CONFIG_PROFILES_STRINGS.removeEntryButton}
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEntries([...entries, emptyEntryRow()])}
              >
                {CONFIG_PROFILES_STRINGS.addEntryButton}
              </Button>
            </div>
            {error !== null ? (
              <p className="config-profiles-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {CONFIG_PROFILES_STRINGS.cancelButton}
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit || submitting}
            onClick={handleSubmit}
          >
            {submitting
              ? CONFIG_PROFILES_STRINGS.savingButton
              : CONFIG_PROFILES_STRINGS.saveButton}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CaptureProfileDialog({
  open,
  tenantId,
  onClose,
  onSaved,
}: {
  readonly open: boolean;
  readonly tenantId: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setSubmitting(false);
    setError(null);
  }, [open]);

  if (!open) return null;

  function handleSubmit() {
    if (name.trim() === "") return;
    setSubmitting(true);
    setError(null);
    captureProfile(tenantId, {
      targetTenantId: tenantId,
      name: name.trim(),
    })
      .then(() => {
        onSaved();
        toast(CONFIG_PROFILES_STRINGS.capturedToast);
      })
      .catch((cause: unknown) =>
        setError(errorMessage(cause, CONFIG_PROFILES_STRINGS.captureError)),
      )
      .finally(() => setSubmitting(false));
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {CONFIG_PROFILES_STRINGS.captureDialogTitle}
          </DialogTitle>
          <DialogDescription>
            {CONFIG_PROFILES_STRINGS.captureDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <label className="config-profiles-field">
            <span>{CONFIG_PROFILES_STRINGS.captureNameLabel}</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          {error !== null ? (
            <p className="config-profiles-error" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {CONFIG_PROFILES_STRINGS.cancelButton}
          </Button>
          <Button
            variant="primary"
            disabled={name.trim() === "" || submitting}
            onClick={handleSubmit}
          >
            {submitting
              ? CONFIG_PROFILES_STRINGS.savingButton
              : CONFIG_PROFILES_STRINGS.saveButton}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
