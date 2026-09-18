// Only "needs-you" is filled/high-weight — the one chip a person should
// never miss. Built locally: no chip primitive in @corbits/react-ui yet.
import type { ReactNode } from "react";

export type ChipTone = "working" | "ok" | "needs-you";

export function Chip({
  tone,
  children,
}: {
  readonly tone: ChipTone;
  readonly children: ReactNode;
}) {
  return (
    <span className="chip" data-tone={tone}>
      {children}
    </span>
  );
}
