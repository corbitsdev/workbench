import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AuthProvider, useAuth } from './components/AuthProvider';
import Dashboard from './pages/Dashboard';
import LiveAnalysisReview from './pages/LiveAnalysisReview';
import CollateralReview from './pages/CollateralReview';
import CollateralImprovement from './pages/CollateralImprovement';
import FinalExport from './pages/FinalExport';

export type Stage = 'dashboard' | 'analyze' | 'review' | 'improvement' | 'export';

function AppContent() {
  const { signOut } = useAuth();
  const [stage, setStage] = useState<Stage>('dashboard');
  const [workflowId, setWorkflowId] = useState<string | null>(null);

  const handleWorkflowCreated = (id: string) => {
    setWorkflowId(id);
    setStage('analyze');
  };

  const handleResumeWorkflow = (id: string, status?: string) => {
    setWorkflowId(id);
    if (status === 'analyzing' || status === 'reviewing') {
      setStage('analyze');
    } else {
      setStage('export');
    }
  };

  const handleStageChange = (nextStage: Stage) => {
    setStage(nextStage);
  };

  const handleDashboard = () => {
    setStage('dashboard');
    setWorkflowId(null);
  };

  const handleNewWorkflow = () => {
    setStage('dashboard');
    setWorkflowId(null);
  };

  return (
    <div className="h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white px-6 py-3 flex justify-end">
        <button
          onClick={() => signOut()}
          className="text-sm text-slate-600 hover:text-slate-900 underline"
        >
          Sign out
        </button>
      </header>
      <div className="flex-1 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={stage}
            className="h-full"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.25 }}
          >
            {stage === 'dashboard' && (
              <Dashboard
                onWorkflowCreated={handleWorkflowCreated}
                onResumeWorkflow={handleResumeWorkflow}
              />
            )}
            {stage === 'analyze' && workflowId && (
              <LiveAnalysisReview workflowId={workflowId} onStageChange={handleStageChange} />
            )}

            {stage === 'review' && workflowId && (
              <CollateralReview workflowId={workflowId} onStageChange={handleStageChange} />
            )}

            {stage === 'improvement' && workflowId && (
              <CollateralImprovement workflowId={workflowId} onStageChange={handleStageChange} />
            )}

            {stage === 'export' && workflowId && (
              <FinalExport
                workflowId={workflowId}
                onNewWorkflow={handleNewWorkflow}
                onDashboard={handleDashboard}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
