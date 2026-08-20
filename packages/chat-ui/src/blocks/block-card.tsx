// Presentational primitives shared by every block view: the card frame with
// its pulse-dot header and the risk badge. Kept free of chat state and chat
// strings so they can lift into @corbits/react-ui unchanged.

import { Warning } from "@corbits/icons";
import type { ReactNode } from "react";

export function BlockCard({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="chat-block">
      <div className="chat-block-head">
        <span className="chat-block-pulse" aria-hidden="true" />
        <span className="chat-block-title">{title}</span>
      </div>
      <div className="chat-block-body">{children}</div>
    </div>
  );
}

export function RiskBadge({
  level,
  label,
  note,
}: {
  readonly level: "low" | "medium" | "high";
  readonly label: string;
  readonly note?: string | undefined;
}) {
  return (
    <span className="chat-block-risk" data-risk={level}>
      <Warning aria-hidden="true" />
      <span>{label}</span>
      {note !== undefined && (
        <span className="chat-block-risk-note">{note}</span>
      )}
    </span>
  );
}
