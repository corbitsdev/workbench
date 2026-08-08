// Column 4: the optional canvas. Collapsed, it takes no space at all — the
// main pane gets the width back — and open, it hosts whatever a running
// agent, a live workflow walkthrough, or an analytics view will render
// later. Today nothing runs, so it says exactly that: no fabricated
// activity, no id standing in for content that doesn't exist yet.
//
// The collapse/expand motion lives entirely in `shell.css` as a CSS
// transition on `transform`/`opacity` (plus width, so the main pane
// actually reflows) triggered by the `data-open` attribute — never a JS
// animation — so rapid toggling is inherently interruptible: the browser
// just reverses whichever transition is already in flight, there is no
// queue to get stuck. `prefers-reduced-motion` is handled the same way, in
// CSS, by shortening the transition to near-zero.

import { Button, EmptyState } from "@corbits/react-ui";
import { LayoutPanelLeft, PanelRightClose } from "lucide-react";

export function CanvasToggle({
  open,
  onToggle,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      aria-pressed={open}
      aria-label={open ? "Hide canvas" : "Show canvas"}
      title={open ? "Hide canvas" : "Show canvas"}
    >
      {open ? <PanelRightClose /> : <LayoutPanelLeft />}
    </Button>
  );
}

export function CanvasColumn({ open }: { readonly open: boolean }) {
  // `inert` rather than `aria-hidden`: a collapsed column has to be out of
  // both the accessibility tree and the tab order, and `aria-hidden` alone
  // only does the first — a focusable descendant inside an `aria-hidden`
  // subtree is an ARIA violation, and the browser moves focus out of an
  // `inert` subtree for us when it closes. The placeholder holds nothing
  // focusable today; the running-agent content this column is being built
  // for will.
  return (
    <div className="shell-canvas-column" data-open={open} inert={!open}>
      <div className="shell-canvas-inner">
        <EmptyState
          title="Nothing running yet"
          description="Agent runs, live workflow walkthroughs, and analytics will open here once something is in progress."
        />
      </div>
    </div>
  );
}
