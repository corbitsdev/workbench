// Decorative chart glyph drawn behind a gallery tile's hero area. Pure,
// presentational, driven entirely by the `kind` prop.

import type { VizKind } from "./types";

const W = "rgba(255,255,255,.9)";
const W2 = "rgba(255,255,255,.45)";

export function ArtifactViz({ kind }: { kind: VizKind }) {
  switch (kind) {
    case "bars":
      return (
        <svg
          className="h-full w-full"
          viewBox="0 0 120 80"
          preserveAspectRatio="none"
        >
          <rect x="14" y="44" width="14" height="30" fill={W2} />
          <rect x="36" y="30" width="14" height="44" fill={W} />
          <rect x="58" y="38" width="14" height="36" fill={W2} />
          <rect x="80" y="18" width="14" height="56" fill={W} />
        </svg>
      );
    case "donut":
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          <circle
            cx="60"
            cy="40"
            r="24"
            fill="none"
            stroke={W2}
            strokeWidth="11"
          />
          <circle
            cx="60"
            cy="40"
            r="24"
            fill="none"
            stroke={W}
            strokeWidth="11"
            strokeDasharray="100 150"
            transform="rotate(-90 60 40)"
          />
        </svg>
      );
    case "grid":
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          {Array.from({ length: 15 }).map((_, i) => (
            <rect
              key={i}
              x={12 + (i % 5) * 20}
              y={14 + Math.floor(i / 5) * 20}
              width="15"
              height="15"
              rx="2"
              fill={i % 3 ? W2 : W}
            />
          ))}
        </svg>
      );
    case "lines":
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          {Array.from({ length: 5 }).map((_, i) => (
            <rect
              key={i}
              x="16"
              y={16 + i * 11}
              width={i % 2 ? 60 : 88}
              height="5"
              rx="2.5"
              fill={i ? W2 : W}
            />
          ))}
        </svg>
      );
    case "nodes":
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          <line x1="30" y1="26" x2="70" y2="50" stroke={W2} strokeWidth="2" />
          <line x1="70" y1="50" x2="94" y2="24" stroke={W2} strokeWidth="2" />
          <line x1="30" y1="26" x2="40" y2="60" stroke={W2} strokeWidth="2" />
          <circle cx="30" cy="26" r="7" fill={W} />
          <circle cx="70" cy="50" r="9" fill={W} />
          <circle cx="94" cy="24" r="6" fill={W2} />
          <circle cx="40" cy="60" r="6" fill={W2} />
        </svg>
      );
    case "heat":
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          {Array.from({ length: 24 }).map((_, i) => (
            <rect
              key={i}
              x={14 + (i % 6) * 16}
              y={16 + Math.floor(i / 6) * 13}
              width="13"
              height="10"
              rx="2"
              fill={`rgba(255,255,255,${(0.2 + ((i * 37) % 80) / 100).toFixed(2)})`}
            />
          ))}
        </svg>
      );
    case "deck":
      return (
        <svg className="h-full w-full" viewBox="0 0 120 120">
          <rect x="22" y="20" width="76" height="46" rx="4" fill={W} />
          <rect
            x="30"
            y="30"
            width="40"
            height="6"
            rx="3"
            fill="rgba(43,38,39,.4)"
          />
          <rect
            x="30"
            y="42"
            width="56"
            height="4"
            rx="2"
            fill="rgba(43,38,39,.25)"
          />
          <rect x="22" y="74" width="36" height="26" rx="4" fill={W2} />
          <rect x="62" y="74" width="36" height="26" rx="4" fill={W2} />
        </svg>
      );
    case "cal":
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          {Array.from({ length: 14 }).map((_, i) => (
            <rect
              key={i}
              x={12 + (i % 7) * 15}
              y={20 + Math.floor(i / 7) * 22}
              width="12"
              height="18"
              rx="2"
              fill={[2, 5, 9].includes(i) ? W : W2}
            />
          ))}
        </svg>
      );
  }
}
