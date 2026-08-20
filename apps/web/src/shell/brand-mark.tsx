// The sidebar's brand moment, above the create/search row (CL-6089 — the
// switcher used to occupy the footer; the mark now stands in its place at
// the top). A static inline SVG via react-ui's `CorbitsMark`, coloured with
// the primary orange — simple and crisp over clever: the prior
// `DitherBackground`-driven animation rendered as a tiny pixelated square
// at this size (its dither grid needs real screen real estate to read),
// so that wiring is gone rather than tuned.

import { CorbitsMark } from "@corbits/react-ui";

/** Small and quiet — the mark is the brand moment now, not an orange rail. */
export function SidebarBrandMark() {
  return (
    <div className="shell-sidebar-brand-mark" aria-hidden="true">
      <CorbitsMark decorative className="shell-sidebar-brand-mark-icon" />
    </div>
  );
}
