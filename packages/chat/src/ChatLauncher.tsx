import { motion } from 'framer-motion';
import { MessageCircle, X } from 'lucide-react';
import { cn } from '@workbench/ui';

export interface ChatLauncherProps {
  /** Toggle the chat panel open/closed. */
  onClick: () => void;
  /** Whether the panel is currently open (affects icon/label). */
  open?: boolean;
  /** Show a small unread badge when greater than zero. */
  unreadCount?: number;
  /** Accessible label. */
  label?: string;
  className?: string;
}

/**
 * A floating, draggable launcher button. Dragging is purely presentational
 * (framer-motion `drag`); the host decides what opening the panel does.
 */
export function ChatLauncher({ onClick, open, unreadCount, label, className }: ChatLauncherProps) {
  return (
    <motion.button
      type="button"
      drag
      dragMomentum={false}
      onClick={onClick}
      aria-label={label ?? (open === true ? 'Close chat' : 'Open chat')}
      aria-expanded={open === true}
      whileTap={{ scale: 0.95 }}
      className={cn(
        'fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-orange text-white shadow-lg hover:bg-orange-deep cursor-pointer',
        className
      )}
    >
      {open === true ? (
        <X size={24} strokeWidth={2} />
      ) : (
        <MessageCircle size={24} strokeWidth={2} />
      )}
      {unreadCount !== undefined && unreadCount > 0 && (
        <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-blue px-1 text-xs text-white">
          {unreadCount}
        </span>
      )}
    </motion.button>
  );
}
