import type { ReactNode } from "react";
import { cn } from "./cn";
import type { GateKind, GateShellModel } from "./types";

const GATE_KICKER: Record<GateKind, string> = {
  reviewList: "Needs you · review",
  choice: "Needs you · choice",
  form: "Needs you · form",
  multiSelect: "Needs you · select",
};

/**
 * Presentational chrome for a pending gate. Interactive payload (review list,
 * choice buttons, form fields) is supplied by the host via `children` so the
 * same resume-payload rules as dock/run hosts stay in the app layer.
 */
export function GateBlock({
  gate,
  children,
  footer,
  className,
  kicker,
}: {
  gate: GateShellModel;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  kicker?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-[12px] border border-accent/30 bg-accent/[0.06] px-3.5 py-3",
        className,
      )}
      data-gate-kind={gate.kind}
      aria-label={kicker ?? GATE_KICKER[gate.kind]}
    >
      <div className="text-[10.5px] font-bold uppercase tracking-[0.05em] text-accent-deep">
        {kicker ?? GATE_KICKER[gate.kind]}
      </div>
      <h3 className="mt-1 text-[14px] font-bold text-text">{gate.title}</h3>
      {gate.prompt ? (
        <p className="mt-1 text-[12.5px] leading-snug text-text-2">
          {gate.prompt}
        </p>
      ) : null}
      {children ? <div className="mt-3">{children}</div> : null}
      {footer ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">{footer}</div>
      ) : null}
    </section>
  );
}
