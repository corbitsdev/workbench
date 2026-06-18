import { useState } from 'react';
import { Button } from '@workbench/ui';
import { useCreateWorkflow } from '../../hooks/use-workflow';
import type { WorkflowNewPaneProps } from '../registry';

export function RedditOpportunityNewPane({
  workflowKind,
  tenantId,
  onCreated,
  onClose,
}: WorkflowNewPaneProps) {
  const createWorkflow = useCreateWorkflow();
  const [inputUrl, setInputUrl] = useState('');
  const [brandName, setBrandName] = useState('');
  const [targetGeography, setTargetGeography] = useState('');
  const [icpHints, setIcpHints] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isLoading = createWorkflow.isPending;

  const handleSubmit = () => {
    setError(null);
    const url = inputUrl.trim();
    if (!url) {
      setError('Website URL is required');
      return;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setError('URL must use http:// or https://');
        return;
      }
    } catch {
      setError('Please enter a valid URL');
      return;
    }
    createWorkflow.mutate(
      {
        workflowKind,
        tenantId: tenantId ?? undefined,
        inputUrl: inputUrl.trim(),
        brandName: brandName.trim() || undefined,
        targetGeography: targetGeography.trim() || undefined,
        icpHints: icpHints.trim() || undefined,
      },
      {
        onSuccess: (workflow) => onCreated(workflow.id),
        onError: (err) =>
          setError(err instanceof Error ? err.message : 'Could not start the workflow'),
      }
    );
  };

  return (
    <div className="flex flex-col h-full overflow-hidden rounded-panel border border-border bg-bg">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
        <p className="text-[14px] font-semibold text-text">Reddit Opportunity Scanner</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close new workflow"
          className="grid h-[28px] w-[28px] place-items-center rounded-[8px] border border-border text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
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
          Enter a website URL to scan for Reddit opportunities. We will analyze the site, suggest
          keywords and subreddits, then search Reddit for high-value threads.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-[13px] font-medium text-text mb-1">
              Website URL <span className="text-orange">*</span>
            </label>
            <input
              type="url"
              value={inputUrl}
              onChange={(e) => {
                setInputUrl(e.target.value);
                setError(null);
              }}
              placeholder="https://example.com"
              disabled={isLoading}
              className="w-full px-3 py-2 text-[13px] border border-border rounded-lg bg-surface-2 text-text placeholder-text-3 focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text mb-1">Brand name</label>
            <input
              type="text"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
              placeholder="Optional"
              disabled={isLoading}
              className="w-full px-3 py-2 text-[13px] border border-border rounded-lg bg-surface-2 text-text placeholder-text-3 focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text mb-1">Target geography</label>
            <input
              type="text"
              value={targetGeography}
              onChange={(e) => setTargetGeography(e.target.value)}
              placeholder="Optional"
              disabled={isLoading}
              className="w-full px-3 py-2 text-[13px] border border-border rounded-lg bg-surface-2 text-text placeholder-text-3 focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text mb-1">
              ICP / audience hints
            </label>
            <textarea
              value={icpHints}
              onChange={(e) => setIcpHints(e.target.value)}
              placeholder="Optional hints about your ideal customer or audience"
              rows={3}
              disabled={isLoading}
              className="w-full px-3 py-2 text-[13px] border border-border rounded-lg bg-surface-2 text-text placeholder-text-3 focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50 resize-none"
            />
          </div>
        </div>

        {error && <p className="text-[12px] text-orange-deep">{error}</p>}
      </div>

      <div className="shrink-0 border-t border-border px-5 py-4">
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={!inputUrl.trim() || isLoading}
          className="w-full"
        >
          {isLoading ? 'Starting…' : 'Start scan'}
        </Button>
      </div>
    </div>
  );
}
