import { cn } from '@workbench/ui';

export interface DockedChatProps {
  /** The chat surface to dock, typically a <ChatPanel />. */
  children: React.ReactNode;
  /** Which edge to dock against. Defaults to the right. */
  side?: 'left' | 'right';
  /** Width of the docked column. Defaults to a comfortable reading width. */
  width?: number | string;
  className?: string;
}

/**
 * A docked-mode layout wrapper: a fixed-width side column that hosts the chat
 * panel alongside the main app content. Pure layout; no state.
 */
export function DockedChat({ children, side = 'right', width = 360, className }: DockedChatProps) {
  const resolvedWidth = typeof width === 'number' ? `${width}px` : width;

  return (
    <aside
      data-side={side}
      style={{ width: resolvedWidth }}
      className={cn(
        'flex h-full shrink-0 flex-col bg-surface',
        side === 'right' ? 'border-l border-border' : 'border-r border-border',
        className
      )}
    >
      {children}
    </aside>
  );
}
