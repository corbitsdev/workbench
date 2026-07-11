import type { Variants } from "framer-motion";

// Light staggered fade for the dashboard sections as they mount after the
// loading skeleton, instead of a hard cut. Subtle (short durations + small
// offset); reduced-motion collapses it to an instant show (see orchestrator).
export const SECTIONS_CONTAINER: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.03 } },
};

export const SECTION_ITEM: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: "easeOut" } },
};
