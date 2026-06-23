import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@workbench/ui';

export interface FloatingChatProps {
  /** Render the panel only when open. */
  open: boolean;
  /** The chat surface, typically a <ChatPanel />. */
  children: React.ReactNode;
  /** Close the panel — wired to Escape so a full-screen panel is never a trap. */
  onClose?: () => void;
  className?: string;
}

/**
 * A full-screen overlay container for the chat panel. When the chat is not
 * docked, expanding it fills the viewport. Sits at z-40 so app modals (z-50+)
 * still layer above it. Animates in/out; open/closed is owned by the host.
 */
export function FloatingChat({ open, children, onClose, className }: FloatingChatProps) {
  useEffect(() => {
    if (!open || onClose === undefined) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <motion.div
      role="dialog"
      aria-label="Chat"
      initial={{ opacity: 0, scale: 0.99 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
      className={cn('fixed inset-0 z-40 flex flex-col overflow-hidden bg-surface', className)}
    >
      {children}
    </motion.div>
  );
}
