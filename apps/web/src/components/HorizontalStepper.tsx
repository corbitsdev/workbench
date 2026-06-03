import { motion } from 'framer-motion';
import type { Step } from './StepSidebar';

interface HorizontalStepperProps {
  steps: Step[];
}

export default function HorizontalStepper({ steps }: HorizontalStepperProps) {
  return (
    <div className="bg-surface border-b border-border px-6 py-5">
      <div className="flex items-center gap-2 md:gap-3">
        {steps.map((step, idx) => (
          <motion.div
            key={step.number}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.05 }}
            className="flex items-center gap-2 md:gap-3"
          >
            {/* Step indicator */}
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium flex-shrink-0 ${
                step.status === 'completed'
                  ? 'bg-green text-white'
                  : step.status === 'current'
                    ? 'bg-orange text-white'
                    : 'bg-surface-2 text-text-3'
              }`}
            >
              {step.status === 'completed' ? '✓' : step.number}
            </div>

            {/* Step label */}
            <span
              className={`text-sm font-medium whitespace-nowrap ${
                step.status === 'current'
                  ? 'text-text'
                  : step.status === 'completed'
                    ? 'text-text-2'
                    : 'text-text-3'
              }`}
            >
              {step.label}
            </span>

            {/* Connector (except last step) */}
            {idx < steps.length - 1 && <div className="w-2 h-0.5 bg-border-strong mx-1" />}
          </motion.div>
        ))}
      </div>
    </div>
  );
}
