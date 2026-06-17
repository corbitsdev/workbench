import { useRef, useState } from 'react';
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadFile = useUploadFile();
  const createWorkflow = useCreateWorkflow();
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    uploadFile.mutate(
      { file, tenantId },
      {
        onSuccess: (result) => setUpload(result),
        onError: (err) => setError(err instanceof Error ? err.message : 'Upload failed'),
      }
    );
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

  const isLoading = uploadFile.isPending || createWorkflow.isPending;

  return (
    <div className="flex flex-col h-full overflow-hidden rounded-panel border border-border bg-bg">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
        <p className="text-[14px] font-semibold text-text">SEO Enrichment</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close new workflow"
          className="grid h-[28px] w-[28px] flex-none place-items-center rounded-[8px] border border-border text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-4 w-4"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <p className="text-[13px] text-text-2">
          Upload a product catalog spreadsheet (.xlsx). Each row will get SEO titles, descriptions,
          and summaries to review before export.
        </p>

        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            onChange={handleFileChange}
            disabled={isLoading}
            className="sr-only"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            className="w-full rounded-[10px] border border-dashed border-border bg-surface-2 px-4 py-6 text-[13px] font-medium text-text-2 transition-colors hover:border-orange/60 hover:text-text disabled:opacity-50"
          >
            {uploadFile.isPending ? 'Uploading…' : 'Choose .xlsx file'}
          </button>
          {upload && (
            <p className="text-[12px] text-text-2 mt-2">
              {upload.filename} · {formatSize(upload.size)}
            </p>
          )}
        </div>

        {error && <p className="text-[12px] text-orange">{error}</p>}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!upload || isLoading}
          className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {createWorkflow.isPending ? 'Starting…' : 'Start enrichment'}
        </button>
      </div>
    </div>
  );
}