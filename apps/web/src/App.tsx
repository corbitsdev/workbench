import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import CallSelectionIntake from './pages/CallSelectionIntake';
import LiveAnalysisReview from './pages/LiveAnalysisReview';
import CollateralReview from './pages/CollateralReview';
import CollateralImprovement from './pages/CollateralImprovement';
import FinalExport from './pages/FinalExport';

export type Stage = 'intake' | 'analyze' | 'review' | 'improvement' | 'export';

export default function App() {
  const [stage, setStage] = useState<Stage>('intake');
  const [workflowId, setWorkflowId] = useState<string | null>(null);

  const handleWorkflowCreated = (id: string) => {
    setWorkflowId(id);
    setStage('analyze');
  };

  const handleStageChange = (nextStage: Stage) => {
    setStage(nextStage);
  };

  const handleNewWorkflow = () => {
    setStage('intake');
    setWorkflowId(null);
  };

  if (!workflowId) {
    return <CallSelectionIntake onWorkflowCreated={handleWorkflowCreated} />;
  }

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={stage}
        className="h-screen"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        transition={{ duration: 0.3 }}
      >
        {stage === 'analyze' && (
          <LiveAnalysisReview workflowId={workflowId} onStageChange={handleStageChange} />
        )}

        {stage === 'review' && (
          <CollateralReview workflowId={workflowId} onStageChange={handleStageChange} />
        )}

        {stage === 'improvement' && (
          <CollateralImprovement workflowId={workflowId} onStageChange={handleStageChange} />
        )}

        {stage === 'export' && (
          <FinalExport workflowId={workflowId} onNewWorkflow={handleNewWorkflow} />
        )}
      </motion.div>
    </AnimatePresence>
  );
}
