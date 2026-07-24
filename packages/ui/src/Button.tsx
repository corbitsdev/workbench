import { type ComponentPropsWithoutRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

const buttonVariants = cva(
  "px-4 py-2 rounded-lg font-medium transition-[background-color,border-color,color,transform] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-0 focus-visible:ring-orange active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 cursor-pointer",
  {
    variants: {
      variant: {
        primary: "bg-orange text-white hover:bg-orange-deep",
        secondary:
          "bg-surface-2 text-text border border-border hover:bg-surface-2",
        ghost: "text-text hover:bg-surface-2",
        library:
          "rounded-input border border-border bg-transparent text-text hover:bg-surface",
      },
      size: {
        sm: "flex items-center gap-[7px] px-3 py-1.5 text-sm",
        md: "flex items-center gap-[7px] px-4 py-2 text-base",
        lg: "flex items-center gap-[7px] px-6 py-3 text-lg",
        library:
          "flex items-center gap-[7px] px-[13px] py-[7px] text-[12.5px] font-semibold",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

interface ButtonProps
  extends ComponentPropsWithoutRef<"button">,
    VariantProps<typeof buttonVariants> {}

const Button = ({ variant, size, className, ...props }: ButtonProps) => (
  <button
    className={cn(buttonVariants({ variant, size }), className)}
    {...props}
  />
);

export { Button, buttonVariants };
