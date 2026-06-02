import { useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { motion } from 'framer-motion';
import StepSidebar from '../components/StepSidebar';
import CollateralBody from '../components/CollateralBody';
import { useWorkflow } from '../hooks/use-workflow';
import { buildSteps } from '../lib/steps';
import type { CollateralType } from '@gtm/workbench-shared';

const STEP_LABELS = {
  intake: 'Call source',
  analyze: 'Agent review',
  generate: 'Approve collateral',
  improve: 'Improve approved',
  export: 'Final package',
};

const TYPE_LABELS: Record<CollateralType, string> = {
  email: 'Follow-up Email',
  linkedin: 'LinkedIn Post',
  'one-pager': 'One-Pager',
  battlecard: 'Paid Ad Copy',
};

export default function FinalExport() {
  const { id: workflowId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  if (!workflowId) return null;
  const { data: workflow } = useWorkflow(workflowId);
  const collateral = (workflow?.steps?.generate?.collateral as any[]) ?? [];

  const steps = buildSteps('export', STEP_LABELS, true);
  const sourceLabel = workflow?.steps?.intake?.transcriptId ? 'Pasted transcript' : undefined;

  const [copiedId, setCopiedId] = useState<string | null>(null);

  const markCopied = (id: string) => {
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCopyAll = () => {
    const text = collateral
      .map(
        (item) =>
          `${TYPE_LABELS[item.type as CollateralType] ?? item.type}\n${item.title}\n\n${item.body}`
      )
      .join('\n\n---\n\n');
    navigator.clipboard
      .writeText(text)
      .then(() => markCopied('all'))
      .catch(() => {
        alert('Failed to copy to clipboard. Please try again.');
      });
  };

  const handleCopyItem = (item: any) => {
    const text = `${item.title}\n\n${item.body}`;
    navigator.clipboard
      .writeText(text)
      .then(() => markCopied(item.id))
      .catch(() => {
        alert('Failed to copy. Please try again.');
      });
  };

  return (
    <div className="flex h-screen bg-gray-50">
      <StepSidebar steps={steps} sourceLabel={sourceLabel} />

      <motion.div
        className="flex-1 flex flex-col overflow-hidden"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30, delay: 0.1 }}
      >
        {/* Header */}
        <div className="px-4 py-3 md:p-6 border-b border-gray-200 bg-white flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Ready to use
            </div>
            <h2 className="text-xl md:text-3xl font-bold text-gray-900">
              Final collateral package
            </h2>
            <p className="hidden md:block text-sm text-gray-600 mt-1">
              Copy individual pieces or grab everything at once.
            </p>
          </div>
          <button
            onClick={handleCopyAll}
            className="px-6 py-2 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 transition-colors cursor-pointer"
          >
            {copiedId === 'all' ? 'Copied!' : 'Copy all'}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 md:space-y-6">
          {/* How to use */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-amber-50 border border-amber-200 rounded-lg p-6"
          >
            <h3 className="font-bold text-gray-900 mb-3">How to use it</h3>
            <ul className="text-sm text-gray-700 space-y-2 list-disc list-inside">
              <li>Lead with the email — it is the most direct follow-up path.</li>
              <li>Hand the ad copy variants to your paid media contact as-is.</li>
              <li>Repurpose the LinkedIn post for organic reach after the deal moves.</li>
              <li>Share the one-pager with internal champions at the prospect.</li>
            </ul>
          </motion.div>

          {/* Collateral Items */}
          {collateral.map((item: any, i: number) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.07 }}
              className="bg-white border border-gray-200 rounded-lg overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <div className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold uppercase tracking-wide mb-1">
                    {TYPE_LABELS[item.type as CollateralType] ?? item.type}
                  </div>
                  <h3 className="text-lg font-bold text-gray-900">{item.title}</h3>
                </div>
                <button
                  onClick={() => handleCopyItem(item)}
                  className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors cursor-pointer shrink-0"
                >
                  {copiedId === item.id ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div className="p-6">
                <CollateralBody body={item.body} type={item.type as CollateralType} />
              </div>
            </motion.div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 md:p-6 border-t border-gray-200 bg-white flex gap-3">
          <button
            onClick={() => navigate('/dashboard')}
            className="px-6 py-2 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 transition-colors cursor-pointer"
          >
            Back to home
          </button>
          <button
            onClick={() => navigate('/dashboard')}
            className="px-6 py-2 border border-gray-300 text-gray-900 font-medium rounded-lg hover:bg-gray-50 transition-colors cursor-pointer"
          >
            Start new workflow
          </button>
        </div>
      </motion.div>
    </div>
  );
}
