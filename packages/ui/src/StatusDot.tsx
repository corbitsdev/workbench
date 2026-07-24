import PulsingRing from "./PulsingRing";

interface StatusDotProps {
  /** Tailwind background class for the dot's solid fill, e.g. "bg-blue". */
  colorClassName: string;
  /** Whether this status is live and should carry the pulsing-ring motion. */
  pulsing?: boolean;
  size?: "xs" | "sm";
  reduceMotion?: boolean;
  className?: string;
}

const SIZE_CLASSNAME: Record<NonNullable<StatusDotProps["size"]>, string> = {
  xs: "h-1.5 w-1.5",
  sm: "h-2 w-2",
};

// Tailwind v4's `@source` scanner only generates utilities for class strings
// it can see literally in source — it cannot see a runtime-concatenated
// `${colorClassName}/60`. Every supported dot color needs its ring variant
// spelled out here so the scanner emits it.
const RING_CLASSNAME: Record<string, string> = {
  "bg-blue": "bg-blue/60",
  "bg-green": "bg-green/60",
  "bg-orange": "bg-orange/60",
  "bg-red": "bg-red/60",
  "bg-text-3": "bg-text-3/60",
};

// A status dot (used by the workflow/subagent docks and the active-runs
// strip) that reuses the shared PulsingRing (CL-4394) for its "live" motion
// instead of Tailwind's `animate-pulse`, so every "currently active"
// indicator in the app shares one physical motion language and one
// reduced-motion fallback.
export default function StatusDot({
  colorClassName,
  pulsing = false,
  size = "sm",
  reduceMotion,
  className,
}: StatusDotProps) {
  const ringClassName = RING_CLASSNAME[colorClassName];
  if (pulsing && ringClassName === undefined) {
    throw new Error(
      `StatusDot: no pulsing-ring class mapped for colorClassName "${colorClassName}". Add it to RING_CLASSNAME in StatusDot.tsx so Tailwind's scanner can see the literal.`,
    );
  }

  return (
    <span
      className={`relative inline-flex shrink-0 ${SIZE_CLASSNAME[size]} ${className ?? ""}`}
    >
      {pulsing && ringClassName !== undefined && (
        <PulsingRing
          colorClassName={ringClassName}
          {...(reduceMotion !== undefined ? { reduceMotion } : {})}
        />
      )}
      <span
        className={`relative h-full w-full rounded-full ${colorClassName}`}
        aria-hidden
      />
    </span>
  );
}
