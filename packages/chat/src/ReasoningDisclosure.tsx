import { useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { cn, Markdown } from "@workbench/ui";

// Height/opacity reveal matching ToolNarrative's ExpandReveal: reduced-motion
// users get an instant toggle with no AnimatePresence — this matters here
// because the disclosure auto-collapses (uninvoked motion) when the answer
// starts.
function ReasoningReveal({
  open,
  reduceMotion,
  children,
}: {
  open: boolean;
  reduceMotion: boolean;
  children: ReactNode;
}) {
  if (reduceMotion) return open ? <div>{children}</div> : null;
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="content"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: EASE_OUT }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export interface ReasoningDisclosureProps {
  /** The agent's reasoning text. */
  reasoning: string;
  /** True while reasoning is still streaming (no answer yet). */
  streaming: boolean;
}

// Brand ease-out (DESIGN.md): snappy settle for small disclosures.
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/**
 * Collapsible "Reasoning" disclosure — the first row of the agent turn's
 * process trace, sharing the tool rows' marker column and type scale.
 *
 * Auto-opens while reasoning is the only live content (streaming, no answer
 * yet) and collapses back to its label the moment the answer starts, so the
 * user watches the thinking live but reads the settled turn answer-first. A
 * manual toggle always wins over the auto behavior.
 *
 * The label is "Reasoning" (not "Thinking"/"Thoughts") — the brand word list
 * prohibits anthropomorphizing agents; the pulsing marker, not the word,
 * signals that it is active.
 */
export function ReasoningDisclosure({
  reasoning,
  streaming,
}: ReasoningDisclosureProps) {
  const reduceMotion = useReducedMotion();
  const [manuallyToggled, setManuallyToggled] = useState<boolean | null>(null);
  const open = manuallyToggled ?? streaming;

  return (
    <div className="flex w-full flex-col gap-1" data-testid="reasoning-row">
      <button
        type="button"
        onClick={() => setManuallyToggled(!open)}
        className={cn(
          "relative flex items-start gap-2.5 self-start text-left text-sm text-text-3",
          "transition-[transform,color] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
          "hover:text-text-2 active:scale-[0.97] cursor-pointer",
          // Expand the hit area to ~40px without inflating the visual height.
          "after:absolute after:inset-0 after:-m-2 after:content-['']",
        )}
        aria-expanded={open}
      >
        {/* Marker slot — pulses while streaming, empty when settled, keeping
            the reasoning row aligned with the tool rows below it. */}
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
          {streaming ? (
            <span
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 leading-snug">
          <span>Reasoning</span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "h-3 w-3 shrink-0 transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
              open && "rotate-90",
            )}
          />
        </span>
      </button>
      <ReasoningReveal open={open} reduceMotion={reduceMotion === true}>
        <div className="ml-[26px] border-l border-border pl-3">
          <Markdown
            mode={streaming ? "streaming" : "static"}
            className="text-xs leading-relaxed text-text-3"
          >
            {reasoning}
          </Markdown>
        </div>
      </ReasoningReveal>
    </div>
  );
}
