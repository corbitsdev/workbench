import { useState } from 'react';
import { cn } from '@workbench/ui';
import { type CollapsedGroupItem } from './compactMessages';
import { MessageBubble } from './MessageBubble';

export interface CollapsedGroupProps {
  group: CollapsedGroupItem;
  className?: string;
}

/**
 * A summary row for a collapsed run of tool messages. Clicking it reveals
 * the full messages inline.
 */
export function CollapsedGroup({ group, className }: CollapsedGroupProps) {
  const [expanded, setExpanded] = useState(false);

  const label = group.count === 1 ? '1 tool message' : `${group.count} tool messages`;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={cn(
          'flex w-fit items-center gap-2 rounded-full border border-border',
          'bg-surface-2 px-3 py-1 text-xs text-text-3',
          'cursor-pointer transition-colors hover:bg-surface hover:text-text-2'
        )}
      >
        <span
          className={cn('inline-block transition-transform', expanded ? 'rotate-90' : 'rotate-0')}
          aria-hidden="true"
        >
          ›
        </span>
        {expanded ? 'Hide' : 'Show'} {label}
      </button>
      {expanded && (
        <div className="flex flex-col gap-3 pl-2 border-l border-border">
          {group.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </div>
      )}
    </div>
  );
}
