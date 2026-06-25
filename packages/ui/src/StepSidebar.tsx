import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { type WorkflowStep } from "./workflow-step-types";

interface StepSidebarProps {
  steps: WorkflowStep[];
  sourceLabel?: string;
  selectionCount?: number;
  /**
   * Invoked when the user activates the sign-out control. Router and auth
   * wiring stay in the consuming app; this package is stateless and only
   * emits the intent. Optional: when omitted, no sign-out control renders.
   */
  onSignOut?: () => void;
}

export default function StepSidebar({
  steps,
  sourceLabel,
  selectionCount,
  onSignOut,
}: StepSidebarProps) {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 768);

  return (
    <motion.div
      className="bg-surface border-r border-border flex flex-col h-screen relative"
      initial={false}
      animate={{ width: collapsed ? 64 : 224 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
    >
      <div className="p-4 border-b border-border flex items-center justify-between gap-2 overflow-hidden">
        <AnimatePresence>
          {!collapsed && (
            <motion.h1
              className="text-sm font-semibold text-text truncate min-w-0"
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
          className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-surface-2 transition-colors text-text-2"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
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
        <div className="p-4 md:p-6 space-y-4">
          {steps.map((step) => (
            <motion.div
              key={step.number}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: step.number * 0.05 }}
              className="overflow-hidden"
            >
              <div
                className={`rounded-lg p-3 transition-all overflow-hidden ${
                  step.status === "current"
                    ? "bg-surface-2 shadow-sm border border-border-strong"
                    : step.status === "completed"
                      ? "bg-transparent"
                      : "bg-transparent opacity-50"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-sm font-medium flex-shrink-0 ${
                      step.status === "completed"
                        ? "bg-green text-white"
                        : step.status === "current"
                          ? "bg-surface-2 border-2 border-border-strong"
                          : "bg-surface text-text-3"
                    }`}
                  >
                    {step.status === "completed" ? "✓" : step.number}
                  </div>
                  <AnimatePresence>
                    {!collapsed && (
                      <motion.span
                        className={`text-sm font-medium truncate min-w-0 ${
                          step.status === "current"
                            ? "text-text"
                            : "text-text-2"
                        }`}
                        title={step.label}
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: "auto" }}
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

      <div className="mt-auto border-t border-border">
        {sourceLabel && (
          <div className="p-6 border-b border-border overflow-hidden">
            <AnimatePresence>
              {!collapsed && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <div className="text-xs font-semibold text-text-3 uppercase tracking-wide mb-2">
                    Stage source
                  </div>
                  <div className="text-sm font-medium text-text">
                    {sourceLabel}
                  </div>
                  {selectionCount !== undefined && (
                    <div className="text-xs text-text-3 mt-1">
                      {selectionCount} pain point
                      {selectionCount !== 1 ? "s" : ""} selected
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {onSignOut && (
          <div className="p-4 flex flex-col gap-2">
            <button
              onClick={onSignOut}
              className="w-8 h-8 md:w-full flex items-center justify-center md:justify-start gap-2 px-3 py-2 rounded-lg text-text-2 hover:bg-surface-2 transition-colors text-sm font-medium"
              title="Sign out"
              aria-label="Sign out"
            >
              <span className="text-lg">⎙</span>
              <AnimatePresence>
                {!collapsed && (
                  <motion.span
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: "auto" }}
                    exit={{ opacity: 0, width: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    Sign out
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
