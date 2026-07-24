import { motion, useReducedMotion } from "framer-motion";

interface PulsingRingProps {
  /** Tailwind background class for the ring, e.g. "bg-blue/25". */
  colorClassName: string;
  reduceMotion?: boolean;
}

// Shared "currently active" pulse used by both the phase stepper and the
// substep timeline (CL-4394) — one set of physical params so the two
// surfaces read as the same motion language, not two hand-tuned rings.
export default function PulsingRing({
  colorClassName,
  reduceMotion,
}: PulsingRingProps) {
  const hookReduceMotion = useReducedMotion() === true;
  const isReduced = reduceMotion ?? hookReduceMotion;

  if (isReduced) {
    return null;
  }

  return (
    <motion.span
      className={`absolute inset-0 rounded-full ${colorClassName}`}
      animate={{ scale: [1, 1.5], opacity: [0.6, 0] }}
      transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
      aria-hidden
    />
  );
}
