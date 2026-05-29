import { motion } from 'framer-motion';

const DEFAULT_ANALYSIS_TASKS = [
  'Reading transcript turns and speaker roles',
  'Clustering repeated objections and urgency cues',
  'Pulling exact customer language for reuse',
  'Drafting pain-point summaries for approval',
];

export interface ProgressChecklistProps {
  tasks?: string[];
}

export default function ProgressChecklist({ tasks }: ProgressChecklistProps) {
  const displayTasks = tasks ?? DEFAULT_ANALYSIS_TASKS;

  if (displayTasks.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 px-4 bg-gray-50 rounded-lg">
        <p className="text-sm text-gray-600">No tasks to display</p>
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
          <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center text-white text-xs">
            ✓
          </div>
          <span className="text-gray-700">{task}</span>
        </motion.div>
      ))}
    </div>
  );
}
