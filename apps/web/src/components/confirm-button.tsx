import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, type ButtonProps } from "@corbits/react-ui";

export type ConfirmButtonProps = Omit<ButtonProps, "onClick" | "children" | "variant"> & {
  /** Fires on the second, confirming click only. */
  readonly onConfirm: () => void;
  readonly children: ReactNode;
  /** Armed label, e.g. "Delete X permanently". */
  readonly confirmLabel: ReactNode;
};

/**
 * Two-step destructive action: the first click arms it (solid red plus a
 * Cancel), the second commits. Escape, Cancel, or focus leaving disarms.
 */
export function ConfirmButton({ onConfirm, children, confirmLabel, ...props }: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  return (
    <span
      ref={rootRef}
      className="inline-actions"
      onKeyDown={(e) => {
        if (e.key === "Escape") setArmed(false);
      }}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setArmed(false);
      }}
    >
      {armed ? (
        <Button
          type="button"
          variant="ghost"
          size={props.size ?? "sm"}
          onClick={() => setArmed(false)}
        >
          Cancel
        </Button>
      ) : null}
      <Button
        type="button"
        {...props}
        variant={armed ? "destructive" : "ghost"}
        className={armed ? props.className : `btn-danger-ghost ${props.className ?? ""}`}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          setArmed(false);
          onConfirm();
        }}
      >
        <span aria-live="polite">{armed ? confirmLabel : children}</span>
      </Button>
    </span>
  );
}
