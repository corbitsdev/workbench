// A static inline SVG via react-ui's `CorbitsMark`, coloured with the
// primary orange — simple and crisp over clever: an animated dither
// background renders as a tiny pixelated square at this size, since its
// dither grid needs real screen real estate to read.

import { CorbitsMark } from "@corbits/react-ui";

/** Small and quiet — the mark is the brand moment now, not an orange rail. */
export function SidebarBrandMark() {
  return (
    <div className="shell-sidebar-brand-mark" aria-hidden="true">
      <CorbitsMark decorative className="shell-sidebar-brand-mark-icon" />
    </div>
  );
}
