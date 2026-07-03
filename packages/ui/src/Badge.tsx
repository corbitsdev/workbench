import { type ComponentPropsWithoutRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

/**
 * A compact, token-driven status/label chip. Tones map to the brand palette:
 * `identity` (Summit Blue) marks who/what an actor is; `neutral` is a quiet
 * metadata chip; `accent` is reserved for the single orange action tone;
 * `positive`/`danger` carry semantic state. All tones share the caption
 * treatment (uppercase, tracked, small) so a row of badges reads as one system.
 */
export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]",
  {
    variants: {
      tone: {
        neutral: "border-border bg-surface-2 text-text-3",
        identity: "border-blue/40 bg-blue/10 text-blue",
        accent: "border-accent/40 bg-accent/10 text-accent",
        positive: "border-green/40 bg-green/10 text-green",
        danger: "border-red/40 bg-red/10 text-red",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

interface BadgeProps
  extends ComponentPropsWithoutRef<"span">,
    VariantProps<typeof badgeVariants> {}

export function Badge({ tone, className, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
