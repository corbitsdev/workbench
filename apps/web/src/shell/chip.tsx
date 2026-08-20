// Mock's `.chip[data-tone]` (workbench-flow-mock.html:262-273): a quiet
// status pill with three tones. Ambient machine activity ("working") and a
// resolved state ("ok") stay outlined; only a human-blocking ask
// ("needs-you") gets a filled, high-weight treatment — the one chip a
// person should never miss.
//
// No chip primitive exists yet in @corbits/react-ui (checked: `Badge` is
// the closest sibling, but it's an uppercase rounded-sm label for
// categorical tags, not this outlined/filled status-pill idiom with a
// radius-0 floor) — built locally. Worth extracting upstream once a
// second consumer needs it.
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
