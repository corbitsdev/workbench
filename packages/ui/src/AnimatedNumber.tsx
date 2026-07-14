import {
  motion,
  useReducedMotion,
  useSpring,
  useTransform,
} from "framer-motion";
import { useEffect } from "react";
import { springNumberTransition } from "./motion";
import { cn } from "./utils";

export interface AnimatedNumberProps {
  value: number;
  className?: string;
  /** Override default fixed-decimal formatting. */
  format?: (value: number) => string;
  decimals?: number;
}

function formatValue(value: number, decimals: number, format?: (n: number) => string) {
  if (format) return format(value);
  return value.toFixed(decimals);
}

/**
 * Numeric readout that springs between values. Uses `tabular-nums` so columns
 * do not jitter while digits animate. Honors `prefers-reduced-motion`.
 */
export function AnimatedNumber({
  value,
  className,
  format,
  decimals = 0,
}: AnimatedNumberProps) {
  const reduce = useReducedMotion() === true;
  const spring = useSpring(value, springNumberTransition(reduce));
  const display = useTransform(spring, (v) => formatValue(v, decimals, format));

  useEffect(() => {
    spring.set(value);
  }, [value, spring]);

  if (reduce) {
    return (
      <span className={cn("tabular-nums", className)}>
        {formatValue(value, decimals, format)}
      </span>
    );
  }

  return (
    <motion.span className={cn("tabular-nums", className)}>{display}</motion.span>
  );
}