import type { ReactNode } from "react";

// A quiet line between messages, e.g. "Voice with X · 3 turns". Wrap names in <b>.
export function SystemLine({ children }: { readonly children: ReactNode }) {
  return <p className="chat-system-line">{children}</p>;
}
