import { motion } from 'framer-motion';
import StepSidebar from '../components/StepSidebar';
import { useWorkflow } from '../hooks/use-workflow';
import { buildSteps } from '../lib/steps';

interface FinalExportProps {
  workflowId: string;
  onNewWorkflow?: () => void;
}

const STEP_LABELS = {
  intake: 'Call source',
  analyze: 'Agent review',
  generate: 'Approve collateral',
  improve: 'Improve approved',
  export: 'Final package',
};

export default function FinalExport({ workflowId, onNewWorkflow }: FinalExportProps) {
  const { data: workflow } = useWorkflow(workflowId);
  const collateral = (workflow?.steps?.generate?.collateral as any[]) ?? [];

  const handleCopy = () => {
    const text = collateral
      .map((item) => `${item.title.toUpperCase()}\n\n${item.body}`)
      .join('\n\n');

    navigator.clipboard.writeText(text).catch(() => {
      alert('Failed to copy to clipboard. Please try again.');
    });
  };

  const getTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      email: 'FOLLOW-UP EMAIL',
      linkedin: 'SOCIAL POST',
      'one-pager': 'ONE-PAGER INTRO',
      battlecard: 'BATTLE CARD',
    };
    return labels[type] || type;
  };

  const isDone = workflow?.status === 'done';
  const steps = workflow?.currentStep
    ? buildSteps(workflow.currentStep, STEP_LABELS, isDone)
    : buildSteps('export', STEP_LABELS, true);

  const sourceLabel = workflow?.steps?.intake?.transcriptId ? 'Pasted transcript' : undefined;

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
        <div className="p-6 border-b border-gray-200 bg-white flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Ready to use
            </div>
            <h2 className="text-3xl font-bold text-gray-900">Final collateral package</h2>
            <p className="text-sm text-gray-600 mt-1">
              Copy this into Typefully, email, or a sales enablement doc with the usage notes
              attached.
            </p>
          </div>
          <button
            onClick={handleCopy}
            className="px-6 py-2 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 transition-colors"
          >
            Copy text
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* How to use */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-amber-50 border border-amber-200 rounded-lg p-6"
          >
            <h3 className="font-bold text-gray-900 mb-3">How to use it</h3>
            <ul className="text-sm text-gray-700 space-y-2 list-disc list-inside">
              <li>Lead with the pain point in the next customer touch.</li>
              <li>Keep the buyer's phrasing intact where possible.</li>
              <li>Use the email version first, then repurpose the post as social proof</li>
            </ul>
          </motion.div>

          {/* Collateral Items */}
          {collateral.map((item: any, i: number) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
              className="bg-white border border-gray-200 rounded-lg p-6"
            >
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                {getTypeLabel(item.type)}
              </div>
              <h3 className="text-2xl font-bold text-gray-900 mb-4">{item.title}</h3>
              <p className="text-base text-gray-700 leading-relaxed whitespace-pre-wrap">
                {item.body}
              </p>
            </motion.div>
          ))}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-200 bg-white flex gap-4">
          <button
            onClick={onNewWorkflow}
            className="px-6 py-2 border border-gray-300 text-gray-900 font-medium rounded-lg hover:bg-gray-50 transition-colors"
          >
            Start new workflow
          </button>
        </div>
      </motion.div>
    </div>
  );
}
