import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  usePreferenceSettings,
  useUpdatePreference,
} from "../../hooks/use-preference-settings";
import { TOUR_STEPS, type TourStep } from "./tour-steps";

const TOUR_DONE_KEY = "onboardingTourDone";
const POPOVER_WIDTH = 320;
const POPOVER_GAP = 12;
const TARGET_POLL_MS = 120;
const TARGET_POLL_ATTEMPTS = 15;

type TourLauncher = { startTour: () => void };

const TourContext = createContext<TourLauncher | null>(null);

export function useTourLauncher(): TourLauncher {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTourLauncher requires OnboardingTourProvider");
  return ctx;
}

type Rect = { top: number; left: number; width: number; height: number };

function toRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/**
 * Tracks the step target's viewport rect: polls briefly (the target's page may
 * still be rendering after navigation) then follows window resizes. `null`
 * means no target was found and the popover centers itself.
 */
function useTargetRect(step: TourStep): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    setRect(null);
    const selector = step.targetSelector;
    if (!selector) return;
    let attempts = 0;
    let found: Element | null = null;

    const measure = () => {
      if (found) setRect(toRect(found));
    };
    const interval = window.setInterval(() => {
      attempts += 1;
      const el = document.querySelector(selector);
      if (el) {
        found = el;
        measure();
        window.clearInterval(interval);
        return;
      }
      if (attempts >= TARGET_POLL_ATTEMPTS) window.clearInterval(interval);
    }, TARGET_POLL_MS);

    const immediate = document.querySelector(selector);
    if (immediate) {
      found = immediate;
      measure();
      window.clearInterval(interval);
    }

    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("resize", measure);
    };
  }, [step]);

  return rect;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function popoverStyle(rect: Rect | null, step: TourStep): CSSProperties {
  if (!rect) {
    return {
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: POPOVER_WIDTH,
    };
  }
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  let top: number;
  let left: number;
  if (step.placement === "top") {
    top = rect.top - POPOVER_GAP;
    left = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
    return {
      top: clamp(top, POPOVER_GAP, viewportH - POPOVER_GAP),
      left: clamp(left, POPOVER_GAP, viewportW - POPOVER_WIDTH - POPOVER_GAP),
      transform: "translateY(-100%)",
      width: POPOVER_WIDTH,
    };
  }
  if (step.placement === "bottom") {
    top = rect.top + rect.height + POPOVER_GAP;
    left = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
  } else if (step.placement === "right") {
    top = rect.top;
    left = rect.left + rect.width + POPOVER_GAP;
  } else {
    top = rect.top;
    left = rect.left - POPOVER_WIDTH - POPOVER_GAP;
  }
  return {
    top: clamp(top, POPOVER_GAP, viewportH - POPOVER_GAP),
    left: clamp(left, POPOVER_GAP, viewportW - POPOVER_WIDTH - POPOVER_GAP),
    width: POPOVER_WIDTH,
  };
}

type OverlayProps = {
  readonly step: TourStep;
  readonly index: number;
  readonly total: number;
  readonly onNext: () => void;
  readonly onBack: () => void;
  readonly onSkip: () => void;
};

function TourOverlay({
  step,
  index,
  total,
  onNext,
  onBack,
  onSkip,
}: OverlayProps) {
  const rect = useTargetRect(step);
  const reduceMotion = useReducedMotion() ?? false;
  const isLast = index === total - 1;
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onSkip();
      if (event.key === "ArrowRight") onNext();
      if (event.key === "ArrowLeft") onBack();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onSkip, onNext, onBack]);

  useEffect(() => {
    popoverRef.current?.focus();
  }, [step]);

  return (
    <div className="fixed inset-0 z-[90]">
      <button
        type="button"
        aria-label="Dismiss tour"
        onClick={onSkip}
        className="fixed inset-0 z-0 cursor-default bg-black/55"
        tabIndex={-1}
      />
      {rect && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-lg"
          style={{
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55)",
          }}
        />
      )}
      <AnimatePresence mode="wait">
        <motion.div
          key={step.id}
          ref={popoverRef}
          tabIndex={-1}
          role="dialog"
          aria-label={step.title}
          aria-modal="true"
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
          transition={{ duration: reduceMotion ? 0 : 0.18 }}
          className="fixed z-10 rounded-xl border border-border bg-surface p-4 shadow-xl focus:outline-none"
          style={popoverStyle(rect, step)}
        >
          <p className="text-xs font-medium text-text-3">
            {index + 1} of {total}
          </p>
          <h2 className="mt-1 text-base font-semibold text-text">
            {step.title}
          </h2>
          <p className="mt-1.5 text-sm text-text-2">{step.body}</p>
          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              onClick={onSkip}
              className="text-sm text-text-3 transition-colors hover:text-text"
            >
              Skip tour
            </button>
            <div className="flex items-center gap-2">
              {index > 0 && (
                <button
                  type="button"
                  onClick={onBack}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm text-text transition-colors hover:bg-page"
                >
                  Back
                </button>
              )}
              <button
                type="button"
                onClick={onNext}
                className="rounded-lg bg-orange px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-orange-deep"
              >
                {isLast ? "Done" : "Next"}
              </button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export function OnboardingTourProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const autoLaunched = useRef(false);
  const navigate = useNavigate();
  const settingsQuery = usePreferenceSettings();
  const update = useUpdatePreference();

  const goTo = useCallback(
    (index: number) => {
      const step = TOUR_STEPS[index];
      if (!step) return;
      setStepIndex(index);
      void navigate(step.route);
    },
    [navigate],
  );

  const startTour = useCallback(() => {
    goTo(0);
  }, [goTo]);

  const finish = useCallback(() => {
    setStepIndex(null);
    update.mutate({ key: TOUR_DONE_KEY, value: true });
  }, [update]);

  useEffect(() => {
    if (autoLaunched.current || stepIndex !== null) return;
    const setting = settingsQuery.data?.find((s) => s.key === TOUR_DONE_KEY);
    if (setting && setting.value === false) {
      autoLaunched.current = true;
      goTo(0);
    }
  }, [settingsQuery.data, stepIndex, goTo]);

  const launcher = useMemo(() => ({ startTour }), [startTour]);

  const step = stepIndex === null ? null : TOUR_STEPS[stepIndex];

  return (
    <TourContext.Provider value={launcher}>
      {children}
      {step && stepIndex !== null && (
        <TourOverlay
          step={step}
          index={stepIndex}
          total={TOUR_STEPS.length}
          onNext={() => {
            if (stepIndex >= TOUR_STEPS.length - 1) finish();
            else goTo(stepIndex + 1);
          }}
          onBack={() => {
            if (stepIndex > 0) goTo(stepIndex - 1);
          }}
          onSkip={finish}
        />
      )}
    </TourContext.Provider>
  );
}
