import { motion } from 'framer-motion';
import { type ProgressStatus } from './types';

const DEFAULT_ANALYSIS_TASKS = [
  'Reading transcript turns and speaker roles',
  'Clustering repeated objections and urgency cues',
  'Pulling exact customer language for reuse',
  'Drafting pain-point summaries for approval',
];

export interface ProgressChecklistProps {
  tasks?: string[];
  status?: ProgressStatus;
}

export default function ProgressChecklist({ tasks, status = 'idle' }: ProgressChecklistProps) {
  const displayTasks = tasks ?? DEFAULT_ANALYSIS_TASKS;

  if (displayTasks.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 px-4 bg-surface-2 rounded-lg">
        <p className="text-sm text-text-3">No tasks to display</p>
      </div>
    );
  }

  if (status === 'idle') {
    return (
      <div className="space-y-2 mb-6">
        {displayTasks.map((task, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.1 }}
            className="flex items-center gap-3 text-sm"
          >
            <div className="w-5 h-5 rounded-full border-2 border-border-strong flex items-center justify-center text-text-3 text-xs">
              {i + 1}
            </div>
            <span className="text-text-2">{task}</span>
          </motion.div>
        ))}
        <div className="mt-3 p-3 bg-blue-soft border border-blue text-blue-deep rounded-lg">
          <p className="text-sm">
            Click "Run analysis" to extract pain points from your transcript.
          </p>
        </div>
      </div>
    );
  }

  if (status === 'running') {
    return (
      <div className="space-y-2 mb-6">
        {displayTasks.map((task, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.1 }}
            className="flex items-center gap-3 text-sm"
          >
            <div className="w-5 h-5 rounded-full border-2 border-blue flex items-center justify-center">
              <motion.div
                className="w-2 h-2 rounded-full bg-blue"
                animate={{ scale: [1, 0.5, 1] }}
                transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.2 }}
              />
            </div>
            <span className="text-text">{task}</span>
          </motion.div>
        ))}
        <div className="mt-3 p-3 bg-blue-soft border border-blue text-blue-deep rounded-lg">
          <p className="text-sm animate-pulse">Analyzing transcript... This may take a moment.</p>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="space-y-2 mb-6">
        {displayTasks.map((task, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.1 }}
            className="flex items-center gap-3 text-sm"
          >
            <div className="w-5 h-5 rounded-full bg-orange flex items-center justify-center text-white text-xs">
              ✕
            </div>
            <span className="text-text line-through">{task}</span>
          </motion.div>
        ))}
        <div className="mt-3 p-3 bg-orange-soft border border-orange text-orange-deep rounded-lg">
          <p className="text-sm">Analysis failed. Check the console for details and try again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 mb-6">
      {displayTasks.map((task, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.1 }}
          className="flex items-center gap-3 text-sm"
        >
          <div className="w-5 h-5 rounded-full bg-green flex items-center justify-center text-white text-xs">
            ✓
          </div>
          <span className="text-text">{task}</span>
        </motion.div>
      ))}
    </div>
  );
}
