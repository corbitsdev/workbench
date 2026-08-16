// The workspace-level "Config profiles" settings section (Everyone group):
// list, create-from-scratch or edit, delete with consequence copy, and
// "Save current setup as a profile" (capture). Follows
// `@corbits/settings-ui`'s own section patterns (`GrantsSection`,
// `PeopleSection`) exactly — a `LoadState` fetch, a toolbar, a table, a
// dialog for create/edit — without depending on that package directly, so
// this stays a plain domain package a host app composes in via
// `insertEveryoneSections`, the same way it already composes Agents and
// Skills (see `apps/web/src/settings-everyone-sections.tsx`).
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
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@corbits/react-ui";
import { useEffect, useState } from "react";

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

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly profiles: readonly ConfigProfile[] };

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ConfigProfilesApiError ? cause.message : fallback;
}

export function ProfilesSettingsSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<ConfigProfile | "new" | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  useEffect(() => {
    if (tenantId === null) return;
    setState({ kind: "loading" });
    listProfiles(tenantId)
      .then((profiles) => setState({ kind: "ready", profiles }))
      .catch((cause: unknown) =>
        setState({
          kind: "error",
          message: errorMessage(cause, "Couldn't load profiles."),
        }),
      );
  }, [tenantId, reloadKey]);

  if (tenantId === null) {
    return (
      <EmptyState
        title="No workbench selected"
        description="Select a workbench to manage its profiles."
      />
    );
  }
  if (state.kind === "loading") return <Skeleton className="query-skeleton" />;
  if (state.kind === "error") {
    return (
      <EmptyState title="Couldn't load profiles" description={state.message} />
    );
  }

  function reload() {
    setReloadKey((value) => value + 1);
  }

  function handleDelete(profile: ConfigProfile) {
    if (tenantId === null) return;
    setRowError(null);
    deleteProfile(tenantId, profile.id)
      .then(() => {
        reload();
        toast(`Deleted ${profile.name}.`);
      })
      .catch((cause: unknown) =>
        setRowError(errorMessage(cause, "Couldn't delete that profile.")),
      );
  }

  return (
    <div className="channel-settings-pane">
      <div className="settings-section-toolbar">
        <Button variant="primary" onClick={() => setEditing("new")}>
          Create a profile
        </Button>
        <Button variant="outline" onClick={() => setCaptureOpen(true)}>
          Save current setup as a profile
        </Button>
      </div>
      {rowError !== null ? (
        <p className="settings-inline-error" role="alert">
          {rowError}
        </p>
      ) : null}
      {state.profiles.length === 0 ? (
        <EmptyState
          title="No profiles yet"
          description="Create a profile from scratch, or save a workbench's current setup as one."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Providers</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.profiles.map((profile) => (
              <TableRow key={profile.id}>
                <TableCell>
                  <strong>{profile.name}</strong>
                  {profile.description !== null ? (
                    <p className="chat-settings-field-hint">
                      {profile.description}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell>{profile.entries.length}</TableCell>
                <TableCell>
                  <div className="settings-connection-card-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(profile)}
                    >
                      Edit
                    </Button>
                    <ConfirmButton
                      variant="destructive"
                      size="sm"
                      confirmLabel="Workbenches keep their current setup; this only removes the preset. Delete?"
                      onConfirm={() => handleDelete(profile)}
                    >
                      Delete
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
        toast(profile === "new" ? "Profile created." : "Profile saved.");
      })
      .catch((cause: unknown) =>
        setError(errorMessage(cause, "Couldn't save that profile.")),
      )
      .finally(() => setSubmitting(false));
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {profile === "new" ? "Create a profile" : "Edit profile"}
          </DialogTitle>
          <DialogDescription>
            An ordered provider/model fallback list a workbench can apply in one
            action.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="settings-form-field">
            <label className="settings-form-field">
              <span>Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="settings-form-field">
              <span>Description (optional)</span>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <div className="settings-form-field">
              <span>Fallback order</span>
              {entries.map((entry, index) => (
                <div key={index} className="settings-connection-card-actions">
                  <Input
                    value={entry.provider}
                    placeholder="Provider"
                    onChange={(e) => {
                      const next = [...entries];
                      next[index] = { ...entry, provider: e.target.value };
                      setEntries(next);
                    }}
                  />
                  <Input
                    value={entry.model}
                    placeholder="Model"
                    onChange={(e) => {
                      const next = [...entries];
                      next[index] = { ...entry, model: e.target.value };
                      setEntries(next);
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEntries(entries.filter((_, i) => i !== index))
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEntries([...entries, emptyEntryRow()])}
              >
                Add a provider
              </Button>
            </div>
            {error !== null ? (
              <p className="settings-inline-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit || submitting}
            onClick={handleSubmit}
          >
            {submitting ? "Saving…" : "Save"}
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
      workbenchTenantId: tenantId,
      name: name.trim(),
    })
      .then(() => {
        onSaved();
        toast("Saved this workbench's setup as a profile.");
      })
      .catch((cause: unknown) =>
        setError(errorMessage(cause, "Couldn't save the current setup.")),
      )
      .finally(() => setSubmitting(false));
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save current setup as a profile</DialogTitle>
          <DialogDescription>
            Captures this workbench's fallback order as a new profile, so it can
            be applied to any workbench in one action.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <label className="settings-form-field">
            <span>Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          {error !== null ? (
            <p className="settings-inline-error" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={name.trim() === "" || submitting}
            onClick={handleSubmit}
          >
            {submitting ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
