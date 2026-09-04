import type { CSSProperties } from "react";

export const CORBIT_DEFAULT_COLOR = "#C5D2DE";
export const AVATAR_COLORS = [
  CORBIT_DEFAULT_COLOR,
  "#C1D1BE",
  "#F7EAD5",
  "#F2B277",
] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

export const avatarColorClass: Record<AvatarColor, string> = {
  "#C5D2DE": "bg-[#C5D2DE]",
  "#C1D1BE": "bg-[#C1D1BE]",
  "#F7EAD5": "bg-[#F7EAD5]",
  "#F2B277": "bg-[#F2B277]",
};

/**
 * A person's generated fallback fill. The custom properties can be applied
 * on an ancestor and consumed with Tailwind's arbitrary-value utilities.
 */
export type GeneratedAvatarStyle = {
  readonly "--avatar-identity-bg": string;
  readonly "--avatar-identity-fg": string;
};

const HEX_PATTERN = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i;
const HSL_PATTERN =
  /^hsl\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%\)$/;

function hslToRgb(
  h: number,
  s: number,
  l: number,
): readonly [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) =>
    light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [
    Math.round(f(0) * 255),
    Math.round(f(8) * 255),
    Math.round(f(4) * 255),
  ];
}

function parseColorToRgb(
  color: string,
): readonly [number, number, number] | null {
  const hexMatch = HEX_PATTERN.exec(color);
  if (hexMatch !== null) {
    const r = hexMatch[1];
    const g = hexMatch[2];
    const b = hexMatch[3];
    if (r !== undefined && g !== undefined && b !== undefined) {
      return [
        Number.parseInt(r, 16),
        Number.parseInt(g, 16),
        Number.parseInt(b, 16),
      ];
    }
  }
  const hslMatch = HSL_PATTERN.exec(color);
  if (hslMatch !== null) {
    const [, h, s, l] = hslMatch;
    return hslToRgb(Number(h), Number(s), Number(l));
  }
  return null;
}

function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Returns black or white text for a parsed avatar color. */
export function readableTextOn(background: string): string {
  const rgb = parseColorToRgb(background);
  if (rgb === null) return "#000000";
  const [r, g, b] = rgb;
  return relativeLuminance(r, g, b) > 0.4 ? "#000000" : "#ffffff";
}

export function hashPrincipal(principalId: string): number {
  let hash = 0;
  for (let index = 0; index < principalId.length; index += 1) {
    hash = (hash * 31 + principalId.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function avatarColorForPrincipal(principalId: string): AvatarColor {
  const hash = hashPrincipal(principalId);
  const index = hash % AVATAR_COLORS.length;
  const color = AVATAR_COLORS[index];
  if (color === undefined) {
    throw new Error("Avatar color palette is empty");
  }
  return color;
}

/** Builds deterministic human avatar colors from a principal ID. */
export function generatedAvatarStyle(
  principalId: string,
): GeneratedAvatarStyle {
  const background = avatarColorForPrincipal(principalId);
  return {
    "--avatar-identity-bg": background,
    "--avatar-identity-fg": readableTextOn(background),
  };
}

export type AvatarFill =
  | { readonly kind: "image"; readonly url: string }
  | { readonly kind: "generated"; readonly style: GeneratedAvatarStyle };

/**
 * Which fallback an avatar should render: an explicit image always wins
 * over the generated fill, when one is on hand (e.g. `UserProfile.image`
 * from better-auth) — the generated look is a fallback, not a
 * replacement for a real picture.
 */
export function resolveAvatarFill(
  principalId: string,
  explicitImageUrl?: string | null,
): AvatarFill {
  if (
    explicitImageUrl !== undefined &&
    explicitImageUrl !== null &&
    explicitImageUrl.length > 0
  ) {
    return { kind: "image", url: explicitImageUrl };
  }
  return { kind: "generated", style: generatedAvatarStyle(principalId) };
}

export const CORBIT_VISOR_COLOR = "#22252A";
export const CORBIT_GLINT_COLOR = "#F7EAD5";

export type CorbitAvatarSize = "xs" | "sm" | "md" | "lg" | "xl" | number;

export interface CorbitAvatarProps {
  readonly ariaLabel?: string;
  readonly size?: CorbitAvatarSize;
  readonly color?: AvatarColor;
  readonly className?: string;
  readonly style?: CSSProperties;
}

const CORBIT_SIZE_CLASS = {
  xs: "size-4",
  sm: "size-6",
  md: "size-8",
  lg: "size-10",
  xl: "size-20",
} as const;

export function CorbitAvatar({
  ariaLabel = "Agent",
  size = "md",
  color = CORBIT_DEFAULT_COLOR,
  className,
  style,
}: CorbitAvatarProps) {
  const sizeClass =
    typeof size === "number" ? undefined : CORBIT_SIZE_CLASS[size];
  const sizeStyle: CSSProperties =
    typeof size === "number" ? { width: `${size}px`, height: `${size}px` } : {};

  return (
    <span
      role="img"
      aria-label={ariaLabel}
      data-corbit="true"
      className={[
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full",
        sizeClass,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ ...sizeStyle, ...style }}
    >
      <svg
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="block size-full"
        aria-hidden="true"
      >
        <circle cx="50" cy="50" r="50" fill={color} />
        <path
          d="M 11.47 59.04 C 16.17 47.15, 33.73 66.85, 45.03 65.78 C 57.11 71.28, 75.14 64.43, 83.53 71.00 C 78.24 85.08, 58.92 92.65, 44.56 89.83 C 28.55 87.40, 15.10 75.30, 11.47 59.49 Z"
          fill={CORBIT_VISOR_COLOR}
        />
        <circle cx="70.63" cy="76.00" r="4.43" fill={CORBIT_GLINT_COLOR} />
      </svg>
    </span>
  );
}
