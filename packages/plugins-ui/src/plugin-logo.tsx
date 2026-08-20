import type { Icon } from "@corbits/icons";

export type PluginBrandIcon = {
  readonly path: string;
  readonly hex: string;
  readonly viewBox?: string;
};

export function PluginLogo({
  name,
  icon,
  fallbackIcon: FallbackIcon,
}: {
  readonly name: string;
  readonly icon?: PluginBrandIcon | undefined;
  readonly fallbackIcon?: Icon | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center border border-border bg-background text-muted-foreground"
    >
      {icon !== undefined ? (
        <svg
          className="size-5"
          viewBox={icon.viewBox ?? "0 0 24 24"}
          fill={`#${icon.hex}`}
        >
          <path d={icon.path} />
        </svg>
      ) : FallbackIcon !== undefined ? (
        <FallbackIcon className="size-4" />
      ) : (
        <span className="text-sm font-semibold">{name.charAt(0)}</span>
      )}
    </span>
  );
}
