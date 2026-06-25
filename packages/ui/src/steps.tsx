import * as React from "react";
import { cn } from "./utils";

interface StepsProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  orientation?: "horizontal" | "vertical";
}

const Steps = React.forwardRef<HTMLDivElement, StepsProps>(
  (
    { className, value: _value = 0, orientation = "horizontal", ...props },
    ref,
  ) => (
    <div
      ref={ref}
      className={cn(
        "flex",
        orientation === "horizontal" ? "gap-2" : "flex-col gap-4",
        className,
      )}
      {...props}
    />
  ),
);
Steps.displayName = "Steps";

interface StepProps extends React.HTMLAttributes<HTMLDivElement> {
  status?: "complete" | "active" | "incomplete";
  index?: number;
}

const Step = React.forwardRef<HTMLDivElement, StepProps>(
  ({ className, status: _status = "incomplete", ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex items-center gap-3", className)}
      {...props}
    />
  ),
);
Step.displayName = "Step";

interface StepIndicatorProps extends React.HTMLAttributes<HTMLDivElement> {
  status?: "complete" | "active" | "incomplete";
  index?: number;
}

const StepIndicator = React.forwardRef<HTMLDivElement, StepIndicatorProps>(
  ({ className, status = "incomplete", index, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold",
        status === "complete" && "bg-green text-white",
        status === "active" && "border-2 border-orange text-orange",
        status === "incomplete" && "border-2 border-border text-text-3",
        className,
      )}
      {...props}
    >
      {status === "complete" ? "✓" : index !== undefined ? index + 1 : ""}
    </div>
  ),
);
StepIndicator.displayName = "StepIndicator";

interface StepLabelProps extends React.HTMLAttributes<HTMLDivElement> {}

const StepLabel = React.forwardRef<HTMLDivElement, StepLabelProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex flex-col gap-1", className)}
      {...props}
    />
  ),
);
StepLabel.displayName = "StepLabel";

interface StepTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {}

const StepTitle = React.forwardRef<HTMLHeadingElement, StepTitleProps>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn("text-sm font-semibold text-text", className)}
      {...props}
    />
  ),
);
StepTitle.displayName = "StepTitle";

interface StepDescriptionProps
  extends React.HTMLAttributes<HTMLParagraphElement> {}

const StepDescription = React.forwardRef<
  HTMLParagraphElement,
  StepDescriptionProps
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("text-xs text-text-2", className)} {...props} />
));
StepDescription.displayName = "StepDescription";

export { Steps, Step, StepIndicator, StepLabel, StepTitle, StepDescription };
