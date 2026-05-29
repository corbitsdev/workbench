import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export interface Step {
  number: number;
  label: string;
  status: 'completed' | 'current' | 'pending';
}

interface StepSidebarProps {
  steps: Step[];
  sourceLabel?: string;
  selectionCount?: number;
}

export default function StepSidebar({ steps, sourceLabel, selectionCount }: StepSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <motion.div
      className="bg-amber-50 border-r border-amber-100 flex flex-col h-screen relative"
      initial={false}
      animate={{ width: collapsed ? 64 : 224 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
    >
      <div className="p-6 border-b border-amber-100 flex items-center justify-between">
        <AnimatePresence>
          {!collapsed && (
            <motion.h1
              className="text-2xl font-bold text-gray-900 whitespace-nowrap"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              Call Collateral Studio
            </motion.h1>
          )}
        </AnimatePresence>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-amber-100 transition-colors text-gray-600"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <motion.svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            animate={{ rotate: collapsed ? 180 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <path
              d="M10 12L6 8L10 4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </motion.svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="p-6 space-y-4">
          {steps.map((step) => (
            <motion.div
              key={step.number}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: step.number * 0.05 }}
            >
              <div
                className={`rounded-lg p-3 transition-all ${
                  step.status === 'current'
                    ? 'bg-white shadow-sm border border-gray-200'
                    : step.status === 'completed'
                      ? 'bg-transparent'
                      : 'bg-transparent opacity-50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-sm font-medium flex-shrink-0 ${
                      step.status === 'completed'
                        ? 'bg-green-500 text-white'
                        : step.status === 'current'
                          ? 'bg-white border-2 border-gray-300'
                          : 'bg-gray-200 text-gray-400'
                    }`}
                  >
                    {step.status === 'completed' ? '✓' : step.number}
                  </div>
                  <AnimatePresence>
                    {!collapsed && (
                      <motion.span
                        className={`text-sm font-medium whitespace-nowrap ${
                          step.status === 'current' ? 'text-gray-900' : 'text-gray-600'
                        }`}
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: 'auto' }}
                        exit={{ opacity: 0, width: 0 }}
                        transition={{ duration: 0.15 }}
                      >
                        {step.label}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      {sourceLabel && (
        <div className="mt-auto p-6 border-t border-amber-100 overflow-hidden">
          <AnimatePresence>
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Stage source
                </div>
                <div className="text-sm font-medium text-gray-900">{sourceLabel}</div>
                {selectionCount !== undefined && (
                  <div className="text-xs text-gray-500 mt-1">
                    {selectionCount} pain point{selectionCount !== 1 ? 's' : ''} selected
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}
