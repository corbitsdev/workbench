import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { useCreateWorkflow, useUploadFile, type UploadResult } from '../../hooks/use-workflow';
import type { WorkflowNewPaneProps } from '../registry';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SeoEnrichmentNewPane({
  workflowKind,
  tenantId,
  onCreated,
  onClose,
}: WorkflowNewPaneProps) {
  const uploadFile = useUploadFile();
  const createWorkflow = useCreateWorkflow();
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    uploadFile.mutate(file, {
      onSuccess: (result) => setUpload(result),
      onError: (err) => setError(err instanceof Error ? err.message : 'Upload failed'),
    });
  };

  const handleSubmit = () => {
    if (!upload) return;
    setError(null);
    createWorkflow.mutate(
      { workflowKind, uploadId: upload.uploadId, ...(tenantId ? { tenantId } : {}) },
      {
        onSuccess: (workflow) => onCreated(workflow.id),
        onError: (err) =>
          setError(err instanceof Error ? err.message : 'Could not start the workflow'),
      }
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-text mb-2">Resource file (.xlsx)</label>
        <input
          type="file"
          accept=".xlsx"
          onChange={handleFileChange}
          disabled={uploadFile.isPending}
          className="block w-full text-sm text-text-2"
        />
        {uploadFile.isPending && <p className="text-sm text-text-3 mt-2">Uploading…</p>}
        {upload && (
          <p className="text-sm text-text-2 mt-2">
            {upload.filename} · {formatSize(upload.size)}
          </p>
        )}
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-text-3">
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!upload || createWorkflow.isPending}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {createWorkflow.isPending ? 'Starting…' : 'Start enrichment'}
        </button>
      </div>
    </div>
  );
}
