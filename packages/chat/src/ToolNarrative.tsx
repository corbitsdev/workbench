import { useState } from 'react';
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

// A concise, human-readable summary of what the tool was invoked with, e.g.
// the search query, so the narrative shows "exa search · minimax m3" rather
// than a bare label.
function summarizeArgs(args?: Record<string, unknown>): string | null {
  if (args === undefined) return null;
  const keys = Object.keys(args);
  if (keys.length === 0) return null;
  for (const key of ['query', 'q', 'url', 'prompt', 'text', 'path', 'name']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return `${key}: ${String(value)}`;
    }
  }
  return null;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={cn('h-3 w-3 shrink-0 text-text-3 transition-transform', open && 'rotate-90')}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ToolRow({ call, summary }: { call: ToolCall; summary: string }) {
  const [open, setOpen] = useState(false);
  const pending = call.result === undefined && !call.isError;
  const argsSummary = summarizeArgs(call.arguments);
  const hasArgs = call.arguments !== undefined && Object.keys(call.arguments).length > 0;
  const expandable = !pending && (call.result !== undefined || hasArgs);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        className={cn('flex items-start gap-2.5 text-left', expandable && 'cursor-pointer')}
      >
        <span className="mt-0.5">
          {pending ? <ActiveIcon /> : <DoneIcon isError={call.isError === true} />}
        </span>
        <span
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-sm leading-snug',
            pending ? 'text-text-2' : call.isError ? 'text-red-600' : 'text-text-3'
          )}
        >
          <span className="shrink-0">{summary}</span>
          {argsSummary !== null && <span className="truncate text-text-3/70">· {argsSummary}</span>}
          {expandable && <ChevronIcon open={open} />}
        </span>
      </button>
      {open && (
        <div className="mt-1.5 ml-[26px] space-y-2 text-xs">
          {hasArgs && (
            <pre className="overflow-x-auto rounded bg-surface-2 px-2 py-1.5 font-mono text-text-2">
              {JSON.stringify(call.arguments, null, 2)}
            </pre>
          )}
          {call.result !== undefined && call.result !== '' && (
            <pre
              className={cn(
                'max-h-60 overflow-auto whitespace-pre-wrap break-words rounded px-2 py-1.5 font-mono',
                call.isError ? 'bg-red-500/10 text-red-600' : 'bg-surface-2 text-text-2'
              )}
            >
              {call.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolNarrative({ toolCalls, formatSummary, className }: ToolNarrativeProps) {
  if (toolCalls.length === 0) return null;

  const fmt = formatSummary ?? defaultSummary;

  return (
    <div className={cn('space-y-2', className)} data-testid="tool-narrative">
      {toolCalls.map((call) => {
        const pending = call.result === undefined && !call.isError;
        const summary = pending ? (call.label ?? call.name) : fmt(call);
        return <ToolRow key={call.id} call={call} summary={summary} />;
      })}
    </div>
  );
}
