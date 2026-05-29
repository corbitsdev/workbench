import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import StepSidebar from '../components/StepSidebar';
import { useWorkflow } from '../hooks/use-workflow';
import { buildSteps } from '../lib/steps';
import type { Stage } from '../App';

interface CollateralReviewProps {
  workflowId: string;
  onStageChange?: (stage: Stage) => void;
}

const STEP_LABELS = {
  intake: 'Call source',
  analyze: 'Agent review',
  generate: 'Approve collateral',
  improve: 'Improve approved',
  export: 'Final package',
};

export default function CollateralReview({ workflowId, onStageChange }: CollateralReviewProps) {
  const { data: workflow, isLoading } = useWorkflow(workflowId);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());

  const painPoints = (workflow?.steps?.analyze?.painPoints as any[]) ?? [];
  const collateral = (workflow?.steps?.generate?.collateral as any[]) ?? [];
  const current = collateral[currentIndex];
  const currentPainPoint = painPoints.find((p: any) => p.id === current?.painPointId);
  const isLast = currentIndex === collateral.length - 1;

  const handleApprove = () => {
    if (current) {
      const next = new Set(approvedIds).add(current.id);
      setApprovedIds(next);
      if (isLast) {
        onStageChange?.('improvement');
      } else {
        setCurrentIndex(currentIndex + 1);
      }
    }
  };

  const handleReject = () => {
    if (isLast) {
      onStageChange?.('improvement');
    } else {
      setCurrentIndex(currentIndex + 1);
    }
  };

  const steps = workflow?.currentStep
    ? buildSteps(workflow.currentStep, STEP_LABELS)
    : buildSteps('generate', STEP_LABELS);

  const sourceLabel = workflow?.steps?.intake?.transcriptId ? 'Pasted transcript' : undefined;

  return (
    <div className="flex h-screen bg-gray-50">
      <StepSidebar steps={steps} sourceLabel={sourceLabel} selectionCount={approvedIds.size} />

      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel: Context */}
        <motion.div
          className="w-80 bg-amber-50 border-r border-amber-100 flex flex-col overflow-hidden"
          initial={{ x: -40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30, delay: 0.1 }}
        >
          <div className="p-6 border-b border-amber-100">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Context
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {painPoints.map((point: any) => (
              <motion.div
                key={point.id}
                className="border border-amber-200 rounded-lg p-3 bg-white text-sm"
                initial={{ opacity: 0.7 }}
                animate={{
                  opacity: point.id === currentPainPoint?.id ? 1 : 0.6,
                  scale: point.id === currentPainPoint?.id ? 1.02 : 1,
                }}
              >
                <h4 className="font-semibold text-gray-900">
                  {point.context.split(' ').slice(0, 5).join(' ')}
                </h4>
                <p className="text-xs text-gray-600 mt-2 line-clamp-2">{point.quote}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Right Panel: Card */}
        <motion.div
          className="flex-1 flex flex-col overflow-hidden bg-white"
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30, delay: 0.15 }}
        >
          <div className="p-6 border-b border-gray-200 flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Card {currentIndex + 1} of {collateral.length}
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mt-1">
                {current?.title || 'Loading...'}
              </h2>
            </div>
            <div className="text-right">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                {current?.type}
              </div>
              <div className="text-sm font-medium text-gray-700 mt-1">
                {currentPainPoint?.context.split(' ').slice(0, 5).join(' ')}
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            <AnimatePresence mode="wait">
              {current && (
                <motion.div
                  key={current.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                  className="bg-gray-50 rounded-lg p-6"
                >
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                    Pain point
                  </div>
                  <h3 className="text-2xl font-bold text-gray-900 mb-6">
                    {currentPainPoint?.context}
                  </h3>

                  <p className="text-base text-gray-700 leading-relaxed whitespace-pre-wrap">
                    {current.body}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Actions */}
          <div className="p-6 border-t border-gray-200 bg-white flex items-center justify-center gap-4">
            <button
              onClick={handleReject}
              disabled={isLoading}
              aria-label="Reject this collateral item"
              className="w-12 h-12 rounded-full border-2 border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-50"
              title="Reject"
            >
              ✕
            </button>
            <button
              onClick={handleApprove}
              disabled={isLoading}
              aria-label="Approve this collateral item"
              className="w-12 h-12 rounded-full bg-green-500 text-white font-bold hover:bg-green-600 transition-colors disabled:opacity-50 flex items-center justify-center"
              title="Approve"
            >
              ✓
            </button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
