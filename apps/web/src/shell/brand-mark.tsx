// The sidebar's brand moment, above the create/search row (CL-6089 — the
// switcher used to occupy the footer; the mark now stands in its place at
// the top). Composed from two react-ui primitives rather than a bespoke
// canvas: `CORBITS_MARK_PATH`/`CORBITS_MARK_VIEWBOX` build a static inline
// SVG of the mountain mark, which is then handed to `DitherBackground` as
// its source image — the same dithered-drift animation react-ui already
// gives a full-bleed panel, just fed a brand-shaped source instead of a
// photo. `DitherBackground` already owns `prefers-reduced-motion` (a
// single static frame, warp disabled) and pauses off-screen/hidden-tab, so
// nothing here has to duplicate that. No new react-ui primitive was
// needed for this composition.

import {
  CORBITS_MARK_PATH,
  CORBITS_MARK_VIEWBOX,
  DitherBackground,
} from "@corbits/react-ui";
import { useMemo } from "react";

const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${CORBITS_MARK_VIEWBOX.x} ${CORBITS_MARK_VIEWBOX.y} ${CORBITS_MARK_VIEWBOX.width} ${CORBITS_MARK_VIEWBOX.height}"><path d="${CORBITS_MARK_PATH}" fill="#f4762a"/></svg>`;

const MARK_DATA_URI = `data:image/svg+xml;utf8,${encodeURIComponent(MARK_SVG)}`;

/** Small and quiet — the mark is the brand moment now, not an orange rail. */
export function SidebarBrandMark() {
  const src = useMemo(() => MARK_DATA_URI, []);
  return (
    <div className="shell-sidebar-brand-mark" aria-hidden="true">
      <DitherBackground src={src} cell={3} warp={6} />
    </div>
  );
}
