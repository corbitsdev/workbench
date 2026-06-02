import { useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { motion } from 'framer-motion';
import StepSidebar from '../components/StepSidebar';
import { useWorkflow, useRunStep } from '../hooks/use-workflow';
import { buildSteps } from '../lib/steps';

const STEP_LABELS = {
  intake: 'Call source',
  analyze: 'Agent review',
  generate: 'Approve collateral',
  improve: 'Improve approved',
  export: 'Final package',
};

export default function CollateralImprovement() {
  const { id: workflowId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  if (!workflowId) return null;
  const { data: workflow, isLoading: isLoadingWorkflow } = useWorkflow(workflowId);
  const runStep = useRunStep(workflowId);
  const [feedback, setFeedback] = useState<Record<string, string>>({});

  const painPoints = (workflow?.steps?.analyze?.painPoints as any[]) ?? [];
  const approvedCollateral = (workflow?.steps?.generate?.collateral as any[]) ?? [];

  const isLoading = isLoadingWorkflow || runStep.isPending;

  const handleAssemble = async () => {
    const pending = Object.entries(feedback).filter(([, v]) => v.trim().length > 0);
    for (const [collateralId, text] of pending) {
      await runStep.mutateAsync({ step: 'improve', collateralId, feedback: text });
    }
    navigate(`/workflows/${workflowId}/export`);
  };

  const steps = workflow?.currentStep
    ? buildSteps(workflow.currentStep, STEP_LABELS)
    : buildSteps('improve', STEP_LABELS);

  const sourceLabel = workflow?.steps?.intake?.transcriptId ? 'Pasted transcript' : undefined;

  return (
    <div className="flex h-screen bg-gray-50">
      <StepSidebar steps={steps} sourceLabel={sourceLabel} />

      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel: Context */}
        <motion.div
          className="w-80 bg-amber-50 border-r border-amber-100 flex flex-col overflow-hidden"
          initial={{ x: -40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30, delay: 0.1 }}
        >
          <div className="px-4 py-3 md:p-6 border-b border-amber-100">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Context
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-3">
            {painPoints.map((point: any) => (
              <motion.div
                key={point.id}
                className="border border-amber-200 rounded-lg p-3 bg-white text-sm"
                initial={{ opacity: 0.7 }}
                animate={{ opacity: 1 }}
              >
                <h4 className="font-semibold text-gray-900 line-clamp-2">{point.context}</h4>
                <p className="text-xs text-gray-600 mt-2 line-clamp-2">{point.quote}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Right Panel: Collateral */}
        <motion.div
          className="flex-1 flex flex-col overflow-hidden"
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30, delay: 0.15 }}
        >
          <div className="px-4 py-3 md:p-6 border-b border-gray-200 bg-white">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Approved Collateral
            </div>
            <h2 className="text-xl md:text-2xl font-bold text-gray-900">
              Tune the assets you kept
            </h2>
            <p className="hidden md:block text-sm text-gray-600 mt-1">
              Each approved asset can receive targeted feedback before the final package is
              assembled.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 md:space-y-6">
            {approvedCollateral.map((item: any, i: number) => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className="border border-gray-200 rounded-lg p-6 bg-white"
              >
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      {item.type}
                    </div>
                    <h3 className="text-lg font-bold text-gray-900 mt-1">{item.title}</h3>
                  </div>
                  <span className="text-xs font-semibold text-green-600 bg-green-50 px-2 py-1 rounded">
                    APPROVED
                  </span>
                </div>

                <p className="text-sm text-gray-700 mb-4 leading-relaxed">{item.body}</p>

                <textarea
                  value={feedback[item.id] || ''}
                  onChange={(e) => setFeedback((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  placeholder="Ask for a sharper hook, more executive tone, a shorter version..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  rows={3}
                />
              </motion.div>
            ))}
          </div>

          {/* Actions */}
          <div className="px-4 py-3 md:p-6 border-t border-gray-200 bg-white">
            <button
              onClick={handleAssemble}
              disabled={isLoading}
              className="px-6 py-2 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
            >
              {isLoading ? 'Assembling...' : 'Assemble final package'}
            </button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
