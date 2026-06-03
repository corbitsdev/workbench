import { useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { motion } from 'framer-motion';
import { useWorkflow, useRunStep } from '../hooks/use-workflow';
import { buildSteps } from '../lib/steps';
import { Button } from '../components/ui/Button';

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
    <div className="flex h-screen bg-page">
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel: Context */}
        <motion.div
          className="w-80 bg-surface border-r border-border flex flex-col overflow-hidden"
          initial={{ x: -40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30, delay: 0.1 }}
        >
          <div className="px-4 py-3 md:p-6 border-b border-border">
            <div className="text-xs font-semibold text-text-3 uppercase tracking-wide mb-2">
              Context
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-3">
            {painPoints.map((point: any) => (
              <motion.div
                key={point.id}
                className="border border-border rounded-lg p-3 bg-surface-2 text-sm"
                initial={{ opacity: 0.7 }}
                animate={{ opacity: 1 }}
              >
                <h4 className="font-semibold text-text line-clamp-2">{point.context}</h4>
                <p className="text-xs text-text-2 mt-2 line-clamp-2">{point.quote}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Right Panel: Collateral */}
        <motion.div
          className="flex-1 flex flex-col overflow-hidden bg-page"
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30, delay: 0.15 }}
        >
          <div className="px-4 py-3 md:p-6 border-b border-border bg-surface">
            <div className="text-xs font-semibold text-text-3 uppercase tracking-wide mb-1">
              Approved Collateral
            </div>
            <h2 className="text-xl md:text-2xl font-bold text-text">Tune the assets you kept</h2>
            <p className="hidden md:block text-sm text-text-2 mt-1">
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
                className="border border-border rounded-lg p-6 bg-surface"
              >
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <div className="text-xs font-semibold text-text-3 uppercase tracking-wide">
                      {item.type}
                    </div>
                    <h3 className="text-lg font-bold text-text mt-1">{item.title}</h3>
                  </div>
                  <span className="text-xs font-semibold text-green bg-green-soft px-2 py-1 rounded">
                    APPROVED
                  </span>
                </div>

                <p className="text-sm text-text-2 mb-4 leading-relaxed">{item.body}</p>

                <textarea
                  value={feedback[item.id] || ''}
                  onChange={(e) => setFeedback((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  placeholder="Ask for a sharper hook, more executive tone, a shorter version..."
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange bg-surface-2 text-text resize-none"
                  rows={3}
                />
              </motion.div>
            ))}
          </div>

          {/* Actions */}
          <div className="px-4 py-3 md:p-6 border-t border-border bg-surface">
            <Button variant="primary" onClick={handleAssemble} disabled={isLoading}>
              {isLoading ? 'Assembling...' : 'Assemble final package'}
            </Button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
