import { motion } from 'framer-motion';
import { cn } from '@workbench/ui';

export interface FloatingChatProps {
  /** Render the panel only when open. */
  open: boolean;
  /** The chat surface, typically a <ChatPanel />. */
  children: React.ReactNode;
  className?: string;
}

/**
 * A floating overlay container for the chat panel. Animates in/out and pins
 * itself near the launcher. Pure presentation; open/closed is owned by the host.
 */
export function FloatingChat({ open, children, className }: FloatingChatProps) {
  if (!open) return null;

  return (
    <motion.div
      role="dialog"
      aria-label="Chat"
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.18 }}
      className={cn(
        'fixed bottom-24 right-6 z-40 flex h-[32rem] max-h-[80vh] w-96 max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-panel border border-border shadow-xl',
        className
      )}
    >
      {children}
    </motion.div>
  );
}
