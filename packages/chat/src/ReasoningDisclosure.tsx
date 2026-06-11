import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { Streamdown } from 'streamdown';
import { cn } from '@workbench/ui';

export interface ReasoningDisclosureProps {
  /** The agent's reasoning text. */
  reasoning: string;
  /** True while reasoning is still streaming (no answer yet). */
  streaming: boolean;
}

// Brand ease-out (DESIGN.md): snappy settle for small disclosures.
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/**
 * Collapsible "Reasoning" disclosure that streams the agent's reasoning.
 *
 * While the agent is still reasoning (streaming, no answer yet) it auto-expands
 * so the user watches the reasoning form. Once the answer starts — or for a
 * past turn — it collapses to a toggle so the thread isn't dominated by it.
 * Visually subordinate to the answer: narrower, muted, smaller, no bubble
 * chrome, so it reads as a quiet aside rather than a second message.
 *
 * The label is "Reasoning" (not "Thinking"/"Thoughts") — the brand word list
 * prohibits anthropomorphizing agents; the pulsing dot, not the word, signals
 * that it is active.
 */
export function ReasoningDisclosure({ reasoning, streaming }: ReasoningDisclosureProps) {
  const [manuallyToggled, setManuallyToggled] = useState<boolean | null>(null);
  // Auto-expanded while actively reasoning; collapsed otherwise — unless the
  // user has explicitly toggled, in which case respect their choice.
  const open = manuallyToggled ?? streaming;

  return (
    <div className="flex w-full max-w-[68%] flex-col gap-1">
      <button
        type="button"
        onClick={() => setManuallyToggled(!open)}
        className={cn(
          'relative flex items-center gap-1.5 self-start text-xs text-text-3',
          'transition-[transform,color] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]',
          'hover:text-text-2 active:scale-[0.97]',
          // Expand the hit area to ~40px without inflating the visual height.
          "after:absolute after:inset-0 after:-m-2 after:content-['']"
        )}
        aria-expanded={open}
      >
        {streaming && (
          <span className="size-1.5 animate-pulse rounded-full bg-text-3" aria-hidden="true" />
        )}
        <span>Reasoning</span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]',
            open && 'rotate-90'
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="border-l border-border pl-3 text-xs leading-relaxed text-text-3">
              <div className="chat-md chat-md-reasoning">
                <Streamdown mode={streaming ? 'streaming' : 'static'}>{reasoning}</Streamdown>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
