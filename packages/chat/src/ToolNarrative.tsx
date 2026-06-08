import { cn } from '@workbench/ui';
import { motion } from 'framer-motion';
import type { ToolCall } from './types';

function DoneIcon({ isError }: { isError?: boolean }) {
  return (
    <span
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
        isError ? 'bg-red-500' : 'bg-text-3'
      )}
    >
      {isError ? (
        <svg
          className="h-2.5 w-2.5 text-white"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ) : (
        <svg
          className="h-2.5 w-2.5 text-white"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );
}

function ActiveIcon() {
  return (
    <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
      <motion.span
        className="absolute inline-flex h-full w-full rounded-full bg-orange opacity-60"
        animate={{ scale: [1, 1.6, 1], opacity: [0.6, 0, 0.6] }}
        transition={{ repeat: Infinity, duration: 1.4, ease: 'easeInOut' }}
      />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-orange" />
    </span>
  );
}

export interface ToolNarrativeProps {
  toolCalls: ToolCall[];
  /**
   * Optional formatter the host supplies to turn a tool name + result into a
   * human-readable summary line. Falls back to the call's `label` or `name`.
   */
  formatSummary?: (call: ToolCall) => string;
  className?: string;
}

function defaultSummary(call: ToolCall): string {
  if (call.label !== undefined) return call.label;
  // Anthropic raw call IDs look like "call_01_AbCdEf…" — not readable
  if (/^call_[0-9A-Za-z_]{10,}$/.test(call.name)) return 'Tool call';
  return call.name.replace(/_/g, ' ');
}

export function ToolNarrative({ toolCalls, formatSummary, className }: ToolNarrativeProps) {
  if (toolCalls.length === 0) return null;

  const fmt = formatSummary ?? defaultSummary;

  return (
    <div className={cn('space-y-2', className)} data-testid="tool-narrative">
      {toolCalls.map((call) => {
        const pending = call.result === undefined && !call.isError;
        const label = pending ? (call.label ?? call.name) : fmt(call);
        return (
          <div key={call.id} className="flex items-start gap-2.5">
            <span className="mt-0.5">
              {pending ? <ActiveIcon /> : <DoneIcon isError={call.isError === true} />}
            </span>
            <p
              className={cn(
                'text-sm leading-snug',
                pending ? 'text-text-2' : call.isError ? 'text-red-600' : 'text-text-3'
              )}
            >
              {label}
            </p>
          </div>
        );
      })}
    </div>
  );
}
