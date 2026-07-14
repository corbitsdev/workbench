import { useId, useState } from "react";
import { Button, inputFieldClass } from "@workbench/ui";
import {
  useGammaTemplates,
  useCreateGammaTemplate,
  useUpdateGammaTemplate,
  useDeleteGammaTemplate,
  useDelegateGammaTemplate,
  type GammaTemplate,
  type GammaTemplateInput,
} from "../hooks/use-gamma-templates";
import { useMembers } from "../hooks/use-members";
import { ApiError } from "../lib/api";

// Gamma presentation-template management (create / edit / delete / share).
// Extracted from the Settings tool-detail page (CL-2884) so the Owner area's
// Templates tab and any other surface share ONE implementation. `tenantId`
// scopes every query/mutation to a workbench via the use-gamma-templates hooks.

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "You don't have permission to do that.";
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong. Please try again.";
}

function TemplateForm({
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: GammaTemplateInput;
  submitLabel: string;
  pending: boolean;
  onSubmit: (input: GammaTemplateInput) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [gammaId, setGammaId] = useState(initial.gammaId);
  const [description, setDescription] = useState(initial.description);
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt ?? "");
  const fieldId = useId();

  const canSubmit =
    name.trim().length > 0 &&
    gammaId.trim().length > 0 &&
    description.trim().length > 0;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit || pending) return;
        onSubmit({
          name: name.trim(),
          gammaId: gammaId.trim(),
          description: description.trim(),
          ...(systemPrompt.trim().length > 0
            ? { systemPrompt: systemPrompt.trim() }
            : {}),
        });
      }}
    >
      <div className="space-y-1">
        <label
          className="block text-[12px] text-text-3"
          htmlFor={`${fieldId}-name`}
        >
          Name
        </label>
        <input
          id={`${fieldId}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputFieldClass}
        />
      </div>
      <div className="space-y-1">
        <label
          className="block text-[12px] text-text-3"
          htmlFor={`${fieldId}-gamma`}
        >
          Gamma template ID
        </label>
        <input
          id={`${fieldId}-gamma`}
          value={gammaId}
          onChange={(e) => setGammaId(e.target.value)}
          placeholder="Gamma template ID"
          className={inputFieldClass}
        />
      </div>
      <div className="space-y-1">
        <label
          className="block text-[12px] text-text-3"
          htmlFor={`${fieldId}-description`}
        >
          Description
        </label>
        <textarea
          id={`${fieldId}-description`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className={inputFieldClass}
        />
      </div>
      <div className="space-y-1">
        <label
          className="block text-[12px] text-text-3"
          htmlFor={`${fieldId}-system-prompt`}
        >
          System prompt (optional)
        </label>
        <textarea
          id={`${fieldId}-system-prompt`}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={4}
          placeholder="Extra authoring guidance applied when generating decks from this template."
          className={inputFieldClass}
        />
        <p className="text-[11px] text-text-3">
          Extra authoring guidance applied when generating decks from this
          template.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!canSubmit || pending}
        >
          {pending ? "Saving…" : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function TemplateRow({
  template,
  tenantId,
}: {
  template: GammaTemplate;
  tenantId: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [delegateTo, setDelegateTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const shareLabelId = useId();

  const updateMutation = useUpdateGammaTemplate(tenantId);
  const deleteMutation = useDeleteGammaTemplate(tenantId);
  const delegateMutation = useDelegateGammaTemplate(tenantId);
  const membersQuery = useMembers(tenantId, { enabled: sharing });

  const handleUpdate = (input: GammaTemplateInput) => {
    setError(null);
    updateMutation
      .mutateAsync({ id: template.id, input })
      .then(() => setEditing(false))
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  const handleDelete = () => {
    setError(null);
    deleteMutation
      .mutateAsync(template.id)
      .then(() => setConfirmingDelete(false))
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  const handleDelegate = () => {
    if (!delegateTo) return;
    setError(null);
    delegateMutation
      .mutateAsync({ id: template.id, principalId: delegateTo })
      .then(() => {
        setSharing(false);
        setDelegateTo("");
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  return (
    <li className="rounded-lg border border-border bg-surface p-4">
      {editing ? (
        <TemplateForm
          key={template.id}
          initial={{
            name: template.name,
            gammaId: template.gammaId,
            description: template.description,
            ...(template.systemPrompt
              ? { systemPrompt: template.systemPrompt }
              : {}),
          }}
          submitLabel="Save changes"
          pending={updateMutation.isPending}
          onSubmit={handleUpdate}
          onCancel={() => {
            setEditing(false);
            setError(null);
          }}
        />
      ) : (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[14px] font-medium text-text">{template.name}</p>
            <p className="mt-0.5 font-mono text-[11px] text-text-3">
              {template.gammaId}
            </p>
            {template.description && (
              <p className="mt-1 text-[12.5px] leading-relaxed text-text-2">
                {template.description}
              </p>
            )}
          </div>
          {template.canManage ? (
            <div className="flex shrink-0 items-center gap-2">
              {confirmingDelete ? (
                <>
                  <span className="text-[12.5px] text-text-2">
                    Confirm delete?
                  </span>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={deleteMutation.isPending}
                    onClick={handleDelete}
                  >
                    {deleteMutation.isPending ? "Deleting…" : "Confirm delete"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setConfirmingDelete(false);
                      setError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditing(true);
                      setError(null);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setConfirmingDelete(true);
                      setError(null);
                    }}
                  >
                    Delete
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSharing((s) => !s);
                      setError(null);
                    }}
                  >
                    Share
                  </Button>
                </>
              )}
            </div>
          ) : (
            <span className="shrink-0 text-[12px] text-text-3">
              Managed by another member
            </span>
          )}
        </div>
      )}

      {template.canManage && sharing && !editing && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <div className="min-w-[200px] flex-1 space-y-1">
            <label
              className="block text-[12px] text-text-3"
              htmlFor={shareLabelId}
            >
              Give a teammate manage access
            </label>
            <select
              id={shareLabelId}
              value={delegateTo}
              onChange={(e) => setDelegateTo(e.target.value)}
              disabled={membersQuery.isLoading}
              className={inputFieldClass}
            >
              <option value="">
                {membersQuery.isLoading
                  ? "Loading teammates…"
                  : "Select a teammate…"}
              </option>
              {membersQuery.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!delegateTo || delegateMutation.isPending}
            onClick={handleDelegate}
          >
            {delegateMutation.isPending ? "Granting…" : "Grant access"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSharing(false);
              setDelegateTo("");
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      {error && (
        <p className="mt-2 text-[12.5px] text-red-500" role="status">
          {error}
        </p>
      )}
    </li>
  );
}

export function GammaTemplateManager({
  tenantId,
}: {
  tenantId: string | null;
}) {
  const templatesQuery = useGammaTemplates(tenantId);
  const createMutation = useCreateGammaTemplate(tenantId);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const handleCreate = (input: GammaTemplateInput) => {
    setCreateError(null);
    createMutation
      .mutateAsync(input)
      .then(() => setShowCreate(false))
      .catch((err: unknown) => setCreateError(errorMessage(err)));
  };

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-text-3">
          Templates
        </h2>
        {!showCreate && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => {
              setShowCreate(true);
              setCreateError(null);
            }}
          >
            New template
          </Button>
        )}
      </div>

      {showCreate && (
        <div className="mt-3 rounded-lg border border-border bg-surface p-4">
          <TemplateForm
            initial={{ name: "", gammaId: "", description: "" }}
            submitLabel="Create template"
            pending={createMutation.isPending}
            onSubmit={handleCreate}
            onCancel={() => {
              setShowCreate(false);
              setCreateError(null);
            }}
          />
          {createError && (
            <p className="mt-2 text-[12.5px] text-red-500" role="status">
              {createError}
            </p>
          )}
        </div>
      )}

      <div className="mt-4">
        {templatesQuery.isLoading && (
          <p className="text-[13px] text-text-3">Loading templates…</p>
        )}
        {templatesQuery.isError && (
          <p className="text-[13px] text-red-500">
            Could not load templates. Please try again.
          </p>
        )}
        {templatesQuery.isSuccess && templatesQuery.data.length === 0 && (
          <p className="text-[13px] text-text-3">
            No templates yet. Add one to use it when creating a presentation.
          </p>
        )}
        {templatesQuery.isSuccess && templatesQuery.data.length > 0 && (
          <ul className="flex flex-col gap-3">
            {templatesQuery.data.map((t) => (
              <TemplateRow key={t.id} template={t} tenantId={tenantId} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
