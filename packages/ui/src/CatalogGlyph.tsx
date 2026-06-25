import { cn } from "./utils";

const W = "rgba(255,255,255,.9)";
const W2 = "rgba(255,255,255,.45)";

export const CATALOG_GLYPH_KINDS = ["code", "doc", "grid", "nodes"] as const;
export type CatalogGlyphKind = (typeof CATALOG_GLYPH_KINDS)[number];

// White glyphs/badges require a dark fill — mirrors the artifact gallery palette,
// which deliberately omits the light `bg-cream` for this reason.
export const CATALOG_GLYPH_FILLS = [
  "bg-orange",
  "bg-blue",
  "bg-green",
  "bg-charcoal",
] as const;

// Deterministic, stable hash so a catalog grid looks varied but never reshuffles
// between renders.
export function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// Card shell shared by the Tools/Skills catalog tiles. The lift/rotate/scale
// transforms are gated to fine-pointer devices so a tap on touch does not flash
// motion before the click navigates away.
export const catalogCardClassName =
  "group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-surface transition-transform duration-300 ease-spring hover:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-orange [@media(hover:hover)_and_(pointer:fine)]:hover:-translate-y-1.5 [@media(hover:hover)_and_(pointer:fine)]:hover:rotate-[-1deg] [@media(hover:hover)_and_(pointer:fine)]:hover:scale-[1.02]";

function Glyph({ kind }: { kind: CatalogGlyphKind }) {
  switch (kind) {
    case "code":
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          <path
            d="M44 26 L28 40 L44 54"
            fill="none"
            stroke={W}
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M76 26 L92 40 L76 54"
            fill="none"
            stroke={W}
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <line
            x1="66"
            y1="22"
            x2="54"
            y2="58"
            stroke={W2}
            strokeWidth="5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "doc":
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
  }
}

// Decorative glyph behind a catalog tile's hero area. Expects a parent `.group`
// for the hover scale, which is gated to fine-pointer devices.
export function CatalogGlyph({
  kind,
  className,
}: {
  kind: CatalogGlyphKind;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "h-full w-full transition-transform duration-300 ease-spring [@media(hover:hover)_and_(pointer:fine)]:group-hover:scale-[1.06]",
        className,
      )}
    >
      <Glyph kind={kind} />
    </div>
  );
}
