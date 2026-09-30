// Presentational primitive shared by every block view: the card frame with
// its pulse-dot header. Kept free of chat state and chat strings so it can
// lift into @corbits/react-ui unchanged.

import type { ReactNode } from "react";

export function BlockCard({
  title,
  attention = false,
  children,
}: {
  readonly title: string;
  /** The one attention moment in view: an orange ring around the card. */
  readonly attention?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className={attention ? "chat-block chat-block-attention" : "chat-block"}>
      <div className="chat-block-head">
        <span className="chat-block-pulse" aria-hidden="true" />
        <span className="chat-block-title">{title}</span>
      </div>
      <div className="chat-block-body">{children}</div>
    </div>
  );
}
