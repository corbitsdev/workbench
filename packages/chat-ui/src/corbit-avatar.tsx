import type { CSSProperties } from "react";

export const CORBIT_DEFAULT_BACKGROUND = "#C5D2DE"; // Summit Blue
export const CORBIT_VISOR_COLOR = "#22252A";
export const CORBIT_GLINT_COLOR = "#F7EAD5"; // Canvas Cream

export type CorbitAvatarSize = "xs" | "sm" | "md" | "lg" | "xl" | number;

export interface CorbitAvatarProps {
  readonly label?: string;
  readonly size?: CorbitAvatarSize;
  readonly background?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly tenantMonogram?: string;
  readonly title?: string;
}

const SIZE_CLASS: Record<string, string> = {
  xs: "size-4", // 16px
  sm: "size-6", // 24px
  md: "size-8", // 32px
  lg: "size-10", // 40px
  xl: "size-20", // 80px
};

const BADGE_SIZE: Record<string, string> = {
  xs: "size-2.5 text-[6px]",
  sm: "size-3 text-[7px]",
  md: "size-3.5 text-[8px]",
  lg: "size-4 text-[9px]",
  xl: "size-5 text-[11px]",
};

export function CorbitAvatar({
  label = "Agent",
  size = "md",
  background = CORBIT_DEFAULT_BACKGROUND,
  className,
  style,
  tenantMonogram,
  title,
}: CorbitAvatarProps) {
  const isNamedSize = typeof size === "string";
  const sizeClass = isNamedSize
    ? (SIZE_CLASS[size] ?? SIZE_CLASS.md)
    : undefined;
  const badgeClass = isNamedSize
    ? (BADGE_SIZE[size] ?? BADGE_SIZE.md)
    : BADGE_SIZE.md;

  const dimensionStyle: CSSProperties =
    typeof size === "number" ? { width: `${size}px`, height: `${size}px` } : {};

  const combinedStyle: CSSProperties = {
    ...dimensionStyle,
    ...style,
  };

  const combinedClass = [
    "relative inline-flex shrink-0 items-center justify-center rounded-full overflow-hidden select-none",
    sizeClass,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      role="img"
      aria-label={label}
      title={title ?? label}
      data-corbit="true"
      className={combinedClass}
      style={combinedStyle}
    >
      <svg
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="size-full block"
        aria-hidden="true"
      >
        <circle cx="50" cy="50" r="50" fill={background} />
        <path
          d="M 11.47 59.04 C 16.17 47.15, 33.73 66.85, 45.03 65.78 C 57.11 71.28, 75.14 64.43, 83.53 71.00 C 78.24 85.08, 58.92 92.65, 44.56 89.83 C 28.55 87.40, 15.10 75.30, 11.47 59.49 Z"
          fill={CORBIT_VISOR_COLOR}
        />
        <circle cx="70.63" cy="76.00" r="4.43" fill={CORBIT_GLINT_COLOR} />
      </svg>
      {tenantMonogram !== undefined ? (
        <span
          aria-hidden="true"
          className={`absolute -right-0.5 -bottom-0.5 inline-flex items-center justify-center border border-background bg-muted font-bold uppercase text-muted-foreground ${badgeClass}`}
        >
          {tenantMonogram.slice(0, 1)}
        </span>
      ) : null}
    </span>
  );
}
