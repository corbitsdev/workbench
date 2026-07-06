import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";

export interface ConfirmButtonProps {
  /** Fired only on the SECOND (confirming) click. */
  onConfirm: () => void;
  /** Idle label. */
  children: ReactNode;
  /** Label shown once armed (after the first click). */
  confirmLabel?: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "library";
  size?: "sm" | "md" | "lg" | "library";
  disabled?: boolean;
  className?: string;
  /** Auto-disarm window in ms if the second click never comes. */
  resetMs?: number;
}

/**
 * A button that guards a destructive or privilege-changing action behind a
 * second, explicit confirm click — no accidental single-click elevate/demote.
 * The first click arms the button (swapping to `confirmLabel` and the primary
 * accent); the second click within `resetMs` fires `onConfirm`. Blur or the
 * timeout disarms it. A lightweight, dependency-free stand-in until a full
 * dialog primitive lands.
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "Click to confirm",
  variant = "secondary",
  size,
  disabled,
  className,
  resetMs = 3000,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clear, []);

  const disarm = () => {
    clear();
    setArmed(false);
  };

  const handleClick = () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), resetMs);
      return;
    }
    disarm();
    onConfirm();
  };

  return (
    <Button
      type="button"
      variant={armed ? "primary" : variant}
      size={size}
      disabled={disabled}
      className={className}
      onClick={handleClick}
      onBlur={disarm}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}
