import type { TargetAndTransition, Transition, Variants } from "framer-motion";

/** Cubic-bezier control points for `styles.css` `--spring`. */
export const SPRING_EASE = [0.34, 1.56, 0.64, 1] as const;

/** Cubic-bezier control points for `styles.css` `--ease`. */
export const EASE_CURVE = [0.22, 0.61, 0.36, 1] as const;

const DEFAULT_SPRING_DURATION = 0.35;
const DEFAULT_STAGGER_STEP = 0.05;

/** Props safe to spread onto `motion.*` (empty when reduced). */
export type MotionPresenceProps =
  | Record<string, never>
  | {
      initial: TargetAndTransition;
      animate: TargetAndTransition;
      exit?: TargetAndTransition;
      transition?: Transition;
    };

/** Keyframed transition using the brand spring curve (CSS `--spring`). */
export function springTransition(options?: {
  duration?: number;
  delay?: number;
}): Transition {
  const transition: Transition = {
    duration: options?.duration ?? DEFAULT_SPRING_DURATION,
    ease: [...SPRING_EASE],
  };
  if (options?.delay !== undefined) {
    transition.delay = options.delay;
  }
  return transition;
}

/** Transition using the standard ease curve (CSS `--ease`). */
export function easeTransition(options?: {
  duration?: number;
  delay?: number;
}): Transition {
  const transition: Transition = {
    duration: options?.duration ?? 0.22,
    ease: [...EASE_CURVE],
  };
  if (options?.delay !== undefined) {
    transition.delay = options.delay;
  }
  return transition;
}

/** Per-index delay for manual stagger (e.g. mapped lists). */
export function staggerItemTransition(
  index: number,
  step = DEFAULT_STAGGER_STEP,
): Transition {
  return springTransition({ delay: index * step });
}

/** Parent variants: children stagger in with `staggerItemVariants`. */
export const staggerContainerVariants: Variants = {
  hidden: { opacity: 1 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: DEFAULT_STAGGER_STEP,
      delayChildren: 0,
    },
  },
};

/** Child variants paired with `staggerContainerVariants`. */
export const staggerItemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: springTransition(),
  },
};

/** Reveal upward (opacity + y). */
export const revealUp = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 6 },
  transition: springTransition(),
} satisfies Exclude<MotionPresenceProps, Record<string, never>>;

/** Crossfade for `AnimatePresence` children (no positional shift). */
export function crossfadePresence(reduceMotion: boolean): MotionPresenceProps {
  if (reduceMotion) return {};
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: 0.2 },
  } satisfies MotionPresenceProps;
}

/** Slide-in from the left for checklist-style rows. */
export function staggerSlideIn(
  reduceMotion: boolean,
  index: number,
  step = 0.1,
): MotionPresenceProps {
  if (reduceMotion) return {};
  return {
    initial: { opacity: 0, x: -10 },
    animate: { opacity: 1, x: 0 },
    transition: { delay: index * step },
  };
}

/** Floating panel enter, settle, and exit. */
export function popupPanelMotion(reduceMotion: boolean): MotionPresenceProps {
  if (reduceMotion) return {};
  return {
    initial: { opacity: 0, y: 12, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: 10, scale: 0.98 },
    transition: easeTransition({ duration: 0.18 }),
  };
}

/** Bottom-docked chat bar enter (deeper slide than floating popup). */
export function dockedPanelMotion(reduceMotion: boolean): MotionPresenceProps {
  if (reduceMotion) return {};
  return {
    initial: { opacity: 0, y: 20, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1 },
    transition: easeTransition({ duration: 0.22 }),
  };
}

/** Drop motion props when the user prefers reduced motion. */
export function motionPropsWhen(
  reduceMotion: boolean,
  props: Exclude<MotionPresenceProps, Record<string, never>>,
): MotionPresenceProps {
  if (reduceMotion) return {};
  return props;
}

/** Spring config for `useSpring` on numeric displays. */
export function springNumberTransition(reduceMotion: boolean) {
  if (reduceMotion) {
    return { duration: 0 };
  }
  return {
    stiffness: 120,
    damping: 20,
    mass: 0.4,
  };
}
