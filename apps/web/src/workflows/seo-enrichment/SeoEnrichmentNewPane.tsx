import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { Button, FileInput } from '@workbench/ui';
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close new workflow"
          className="grid h-[28px] w-[28px] flex-none place-items-center rounded-[8px] border border-border p-0 text-text-2 hover:text-text hover:bg-surface-2"
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
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <p className="text-[13px] text-text-2">
          Upload a product catalog spreadsheet (.xlsx). Each row will get SEO titles, descriptions,
          and summaries to review before export.
        </p>

        <div>
          <FileInput
            accept=".xlsx"
            onChange={handleFileChange}
            disabled={isLoading}
            isPending={uploadFile.isPending}
            triggerLabel="Choose .xlsx file"
            pendingLabel="Uploading…"
          />
          {upload && (
            <p className="text-[12px] text-text-2 mt-2">
              {upload.filename} · {formatSize(upload.size)}
            </p>
          )}
        </div>

        {error && <p className="text-[12px] text-orange">{error}</p>}
      </div>

      <div className="shrink-0 border-t border-border px-5 py-4">
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={!upload || isLoading}
          className="w-full"
        >
          {createWorkflow.isPending ? 'Starting…' : 'Start enrichment'}
        </Button>
      </div>
    </div>
  );
}
