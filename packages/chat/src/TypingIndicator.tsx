import { motion } from "framer-motion";

export interface TypingIndicatorProps {
  /** Optional label, e.g. "Ada is typing". */
  label?: string;
}

/** Three pulsing dots shown while the agent composes a reply. */
export function TypingIndicator({ label }: TypingIndicatorProps) {
  return (
    <div
      data-testid="typing-indicator"
      className="flex items-center gap-2"
      aria-live="polite"
    >
      <div className="flex items-center gap-1 rounded-lg bg-surface-2 px-3 py-2">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="block h-1.5 w-1.5 rounded-full bg-text-3"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.2 }}
          />
        ))}
      </div>
      {label !== undefined && (
        <span className="text-xs text-text-3">{label}</span>
      )}
    </div>
  );
}
