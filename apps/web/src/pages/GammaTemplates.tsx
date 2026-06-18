import { useState } from 'react';
import type { GammaTemplate } from '@workbench/workflow';
import {
  useManageGammaTemplates,
  useCreateGammaTemplate,
  useUpdateGammaTemplate,
  useDeleteGammaTemplate,
} from '../hooks/use-presentation-workflow';

type FormState = {
  name: string;
  gammaId: string;
  systemPrompt: string;
};

const EMPTY_FORM: FormState = { name: '', gammaId: '', systemPrompt: '' };

function TemplateForm({
  initial,
  onSave,
  onCancel,
  isSaving,
}: {
  initial: FormState;
  onSave: (values: FormState) => void;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const [values, setValues] = useState<FormState>(initial);
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!values.name.trim() || !values.gammaId.trim() || !values.systemPrompt.trim()) {
      setError('All fields are required');
      return;
    }
    setError('');
    onSave(values);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-[12px] font-medium text-text-2 mb-1">Name</label>
        <input
          type="text"
          value={values.name}
          onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          placeholder="e.g. Sales Deck"
          disabled={isSaving}
          className="w-full px-3 py-2 text-[13px] border border-border rounded-lg bg-surface-2 text-text focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50"
        />
      </div>
      <div>
        <label className="block text-[12px] font-medium text-text-2 mb-1">Gamma template ID</label>
        <input
          type="text"
          value={values.gammaId}
          onChange={(e) => setValues((v) => ({ ...v, gammaId: e.target.value }))}
          placeholder="e.g. abc123xyz"
          disabled={isSaving}
          className="w-full px-3 py-2 text-[13px] border border-border rounded-lg bg-surface-2 text-text font-mono focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50"
        />
        <p className="mt-1 text-[11px] text-text-3">
          Open the template in Gamma, then copy the ID from the URL (the part after{' '}
          <code className="font-mono">/deck/</code>).
        </p>
      </div>
      <div>
        <label className="block text-[12px] font-medium text-text-2 mb-1">System prompt</label>
        <textarea
          value={values.systemPrompt}
          onChange={(e) => setValues((v) => ({ ...v, systemPrompt: e.target.value }))}
          placeholder="Describe the purpose and structure of this template so the agent knows how to use it…"
          rows={4}
          disabled={isSaving}
          className="w-full px-3 py-2 text-[13px] border border-border rounded-lg bg-surface-2 text-text resize-none focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50"
        />
      </div>
      {error && <p className="text-[12px] text-orange">{error}</p>}
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={isSaving}
          className="px-3 py-1.5 text-[13px] text-text-2 hover:text-text transition-[color] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isSaving}
          className="px-4 py-1.5 text-[13px] bg-orange text-white rounded-lg font-medium hover:bg-orange-deep transition-[background-color] disabled:opacity-50"
        >
          {isSaving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function TemplateCard({
  template,
  onEdit,
  onDelete,
  isDeleting,
}: {
  template: GammaTemplate;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-text">{template.name}</p>
          <p className="text-[11px] font-mono text-text-3 truncate">{template.gammaId}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onEdit}
            className="text-[12px] text-text-3 hover:text-text-2 transition-[color]"
          >
            Edit
          </button>
          {confirmDelete ? (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={onDelete}
                disabled={isDeleting}
                className="text-[12px] text-orange hover:underline disabled:opacity-50"
              >
                {isDeleting ? 'Deleting…' : 'Confirm'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="text-[12px] text-text-3 hover:text-text-2 transition-[color]"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="text-[12px] text-text-3 hover:text-orange transition-[color]"
            >
              Delete
            </button>
          )}
        </div>
      </div>
      <p className="text-[12px] text-text-3 line-clamp-3">{template.systemPrompt}</p>
    </div>
  );
}

export default function GammaTemplates() {
  const templates = useManageGammaTemplates();
  const createTemplate = useCreateGammaTemplate();
  const updateTemplate = useUpdateGammaTemplate();
  const deleteTemplate = useDeleteGammaTemplate();

  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pageError, setPageError] = useState('');

  const handleCreate = (values: FormState) => {
    createTemplate
      .mutateAsync(values)
      .then(() => setShowAddForm(false))
      .catch((err: unknown) => {
        setPageError(err instanceof Error ? err.message : 'Failed to create template');
      });
  };

  const handleUpdate = (id: string, values: FormState) => {
    updateTemplate
      .mutateAsync({ id, ...values })
      .then(() => setEditingId(null))
      .catch((err: unknown) => {
        setPageError(err instanceof Error ? err.message : 'Failed to update template');
      });
  };

  const handleDelete = (id: string) => {
    deleteTemplate.mutateAsync(id).catch((err: unknown) => {
      setPageError(err instanceof Error ? err.message : 'Failed to delete template');
    });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[16px] font-semibold text-text">Presentation Templates</h1>
            <p className="text-[13px] text-text-3 mt-0.5">
              Shared across the workbench. Each template pairs a Gamma deck structure with a system
              prompt that guides the presentation agent.
            </p>
          </div>
          {!showAddForm && (
            <button
              type="button"
              onClick={() => {
                setShowAddForm(true);
                setPageError('');
              }}
              className="px-3 py-1.5 text-[13px] bg-orange text-white rounded-lg font-medium hover:bg-orange-deep transition-[background-color] shrink-0"
            >
              Add template
            </button>
          )}
        </div>

        {pageError && <p className="text-[12px] text-orange">{pageError}</p>}

        {showAddForm && (
          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="text-[13px] font-medium text-text mb-3">New template</p>
            <TemplateForm
              initial={EMPTY_FORM}
              onSave={handleCreate}
              onCancel={() => {
                setShowAddForm(false);
                setPageError('');
              }}
              isSaving={createTemplate.isPending}
            />
          </div>
        )}

        {templates.isLoading && <p className="text-[13px] text-text-3">Loading templates…</p>}

        {!templates.isLoading &&
          !templates.isError &&
          (templates.data ?? []).length === 0 &&
          !showAddForm && (
            <div className="rounded-lg border border-border bg-surface-2 px-4 py-6 text-center">
              <p className="text-[13px] text-text-2">No templates yet.</p>
              <p className="text-[12px] text-text-3 mt-1">
                Add a template to make it available when creating presentations.
              </p>
            </div>
          )}

        {!templates.isLoading &&
          !templates.isError &&
          (templates.data ?? []).map((tmpl) => {
            if (editingId === tmpl.id) {
              return (
                <div key={tmpl.id} className="rounded-lg border border-border bg-surface p-4">
                  <p className="text-[13px] font-medium text-text mb-3">Edit template</p>
                  <TemplateForm
                    initial={{
                      name: tmpl.name,
                      gammaId: tmpl.gammaId,
                      systemPrompt: tmpl.systemPrompt,
                    }}
                    onSave={(values) => handleUpdate(tmpl.id, values)}
                    onCancel={() => setEditingId(null)}
                    isSaving={updateTemplate.isPending}
                  />
                </div>
              );
            }
            return (
              <TemplateCard
                key={tmpl.id}
                template={tmpl}
                onEdit={() => {
                  setEditingId(tmpl.id);
                  setPageError('');
                }}
                onDelete={() => handleDelete(tmpl.id)}
                isDeleting={deleteTemplate.isPending && deleteTemplate.variables === tmpl.id}
              />
            );
          })}
      </div>
    </div>
  );
}
