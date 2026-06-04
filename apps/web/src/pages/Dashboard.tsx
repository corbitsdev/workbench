import { useState } from 'react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCreateWorkflow } from '../hooks/use-workflow';
import RecentCallsPicker from '../components/RecentCallsPicker';
import type { IntakeRequest } from '../types/intake';

interface WorkflowRow {
  id: string;
  status: string;
  createdAt: string;
  transcriptId: string;
  companyName: string | null;
  transcriptPreview: string | null;
  painPointCount: number;
  firstPainPoint: string | null;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [transcript, setTranscript] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importError, setImportError] = useState('');
  const [importMode, setImportMode] = useState<'paste' | 'recent'>('paste');

  const { data: workflows, isLoading } = useQuery<WorkflowRow[]>({
    queryKey: ['workflows'],
    queryFn: () => api('GET', '/workflows'),
  });

  const createWorkflow = useCreateWorkflow();

  const handleSubmit = async (data?: IntakeRequest) => {
    setImportError('');
    const payload = data ?? (transcript.trim() ? { source: 'paste' as const, transcript } : null);
    if (!payload) {
      setImportError('Paste a transcript before submitting.');
      return;
    }
    try {
      const result = await createWorkflow.mutateAsync(payload);
      navigate(`/workflows/${result.id}/analyze`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to create workflow.');
    }
  };

  const closeImport = () => {
    setShowImport(false);
    setTranscript('');
    setImportError('');
    setImportMode('paste');
  };

  return (
    <div className="h-full overflow-y-auto bg-page">
      {/* Header */}
      <div className="bg-surface border-b border-border px-8 py-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text">Call Collateral Studio</h1>
          <p className="text-sm text-text-2 mt-0.5">
            Turn sales call transcripts into publishable collateral.
          </p>
        </div>
        <button
          onClick={() => setShowImport(true)}
          className="px-5 py-2 bg-orange text-white font-medium text-sm rounded-lg hover:bg-orange-deep transition-colors cursor-pointer"
        >
          New workflow
        </button>
      </div>

      <div className="px-8 py-8 max-w-6xl mx-auto space-y-8">
        {/* Transcript import modal */}
        <AnimatePresence>
          {showImport && (
            <motion.div
              className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <motion.div
                className="bg-surface rounded-xl shadow-xl w-full max-w-2xl p-6 max-h-[90vh] flex flex-col"
                initial={{ scale: 0.95, y: 10 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.95, y: 10 }}
              >
                <h2 className="text-lg font-bold text-text mb-4">New workflow</h2>

                <div className="flex gap-1 p-1 bg-surface-2 rounded-lg w-56 mb-5">
                  {(['paste', 'recent'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setImportMode(m)}
                      className={`flex-1 px-3 py-1.5 rounded text-sm font-medium transition-colors cursor-pointer ${
                        importMode === m
                          ? 'bg-surface text-text shadow-sm'
                          : 'text-text-2 hover:text-text'
                      }`}
                    >
                      {m === 'paste' ? 'Paste' : 'Recent calls'}
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-y-auto min-h-0">
                  <AnimatePresence mode="wait">
                    {importMode === 'paste' ? (
                      <motion.div
                        key="paste"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.12 }}
                      >
                        <textarea
                          value={transcript}
                          onChange={(e) => {
                            setTranscript(e.target.value);
                            setImportError('');
                          }}
                          placeholder="Speaker 1: Thanks for taking the time today..."
                          className="w-full h-52 text-sm border border-border rounded-lg p-3 resize-none focus:outline-none focus:ring-2 focus:ring-orange font-mono bg-surface-2 text-text"
                        />
                      </motion.div>
                    ) : (
                      <motion.div
                        key="recent"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.12 }}
                      >
                        <RecentCallsPicker
                          onSelect={handleSubmit}
                          isLoading={createWorkflow.isPending}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {importError && <p className="text-sm text-orange mt-2">{importError}</p>}

                <div className="flex gap-3 mt-4 justify-end">
                  <button
                    onClick={closeImport}
                    className="px-4 py-2 text-sm border border-border text-text-2 rounded-lg hover:bg-surface-2 transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  {importMode === 'paste' && (
                    <button
                      onClick={() => handleSubmit()}
                      disabled={createWorkflow.isPending}
                      className="px-5 py-2 text-sm bg-orange text-white font-medium rounded-lg hover:bg-orange-deep transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      {createWorkflow.isPending ? 'Starting...' : 'Start analysis'}
                    </button>
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Recent sessions table */}
        <div>
          <h2 className="text-sm font-semibold text-text-3 uppercase tracking-wide mb-4">
            Recent sessions
          </h2>
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            {isLoading ? (
              <div className="p-12 text-center text-sm text-text-3">Loading sessions...</div>
            ) : !workflows?.length ? (
              <div className="p-12 text-center">
                <p className="text-sm text-text-2 mb-4">No sessions yet.</p>
                <button
                  onClick={() => setShowImport(true)}
                  className="px-5 py-2 bg-orange text-white text-sm font-medium rounded-lg hover:bg-orange-deep transition-colors cursor-pointer"
                >
                  Start your first workflow
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border-strong bg-surface-2">
                      <th className="text-left px-4 py-3 md:px-6 md:py-4 text-xs font-semibold text-text-3 uppercase tracking-wide">
                        Transcript
                      </th>
                      {/* Pain Points: only show at md+ (more complex, less critical on small screens) */}
                      <th className="hidden md:table-cell text-left px-4 py-3 md:px-6 md:py-4 text-xs font-semibold text-text-3 uppercase tracking-wide">
                        Pain Points
                      </th>
                      {/* Date: show from sm+ (secondary but useful info) */}
                      <th className="hidden sm:table-cell text-left px-4 py-3 md:px-6 md:py-4 text-xs font-semibold text-text-3 uppercase tracking-wide">
                        Date
                      </th>
                      <th className="px-4 py-3 md:px-6 md:py-4" />
                    </tr>
                  </thead>
                  <tbody>
                    {workflows.map((wf, i) => (
                      <motion.tr
                        key={wf.id}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.04 }}
                        className="border-b border-border hover:bg-surface-2 transition-colors"
                      >
                        <td className="px-4 py-3 md:px-6 md:py-4">
                          <div className="font-medium text-text truncate max-w-xs sm:max-w-sm md:max-w-md">
                            {wf.companyName ??
                              (wf.firstPainPoint
                                ? wf.firstPainPoint.split(' ').slice(0, 8).join(' ') + '...'
                                : wf.transcriptPreview
                                  ? wf.transcriptPreview + '...'
                                  : 'Untitled session')}
                          </div>
                          <div className="text-xs text-text-3 mt-0.5 font-mono">
                            {wf.id.slice(0, 8)}
                          </div>
                        </td>
                        <td className="hidden md:table-cell px-4 py-3 md:px-6 md:py-4 text-text-2">
                          {wf.painPointCount > 0 ? `${wf.painPointCount} extracted` : '—'}
                        </td>
                        <td className="hidden sm:table-cell px-4 py-3 md:px-6 md:py-4 text-text-3 text-xs md:text-sm">
                          {formatDate(wf.createdAt)}
                        </td>
                        <td className="px-4 py-3 md:px-6 md:py-4 text-right">
                          <button
                            onClick={() => {
                              const stage =
                                wf.status === 'analyzing' || wf.status === 'reviewing'
                                  ? 'analyze'
                                  : 'export';
                              navigate(`/workflows/${wf.id}/${stage}`);
                            }}
                            className="text-xs font-medium text-orange hover:underline focus:outline-none focus:ring-2 focus:ring-offset-0 focus:ring-orange rounded px-2 py-1 transition-colors cursor-pointer"
                          >
                            {wf.status === 'done' ? 'View' : 'Resume'}
                          </button>
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
