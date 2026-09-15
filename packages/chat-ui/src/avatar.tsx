import type { CSSProperties } from "react";

/* Avatar identity pastels (CL-7478). The palette is token references, not
   hex: --avatar-1 through --avatar-4 are defined once in this package's
   stylesheet :root (the proposed upstream contract for @corbits/react-ui's
   theme) and consumed here by reference, so no product code hardcodes a
   color value. Numbered like react-ui's --chart-1..5 series — slot order is
   the deterministic resolution order, not a ranking. */
export const AVATAR_COLORS = [
  "--avatar-1",
  "--avatar-2",
  "--avatar-3",
  "--avatar-4",
] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

export const CORBIT_DEFAULT_COLOR: AvatarColor = "--avatar-1";

export const avatarColorClass: Record<AvatarColor, string> = {
  "--avatar-1": "bg-(--avatar-1) text-black",
  "--avatar-2": "bg-(--avatar-2) text-black",
  "--avatar-3": "bg-(--avatar-3) text-black",
  "--avatar-4": "bg-(--avatar-4) text-black",
};

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

export function avatarClassForPrincipal(principalId: string): string {
  return avatarColorClass[avatarColorForPrincipal(principalId)];
}

export type AvatarFill =
  | { readonly kind: "image"; readonly url: string }
  | { readonly kind: "generated"; readonly className: string };

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
  return { kind: "generated", className: avatarClassForPrincipal(principalId) };
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
        <circle
          cx="50"
          cy="50"
          r="50"
          /* A presentation attribute cannot read var(), so the token
             reference rides the CSS fill property instead. */
          style={{ fill: `var(${color})` }}
        />
        <path
          d="M 11.47 59.04 C 16.17 47.15, 33.73 66.85, 45.03 65.78 C 57.11 71.28, 75.14 64.43, 83.53 71.00 C 78.24 85.08, 58.92 92.65, 44.56 89.83 C 28.55 87.40, 15.10 75.30, 11.47 59.49 Z"
          fill={CORBIT_VISOR_COLOR}
        />
        <circle cx="70.63" cy="76.00" r="4.43" fill={CORBIT_GLINT_COLOR} />
      </svg>
    </span>
  );
}
