// A right-click that lands on (or behind) an open modal must not also pop
// a context menu — that's the "dialog beats context menu" half of the Esc
// precedence chain, enforced at open time rather than by racing keydown
// handlers. Every dialog in this codebase (react-ui's Dialog, and the
// command palette it's built from) renders Radix's `role="dialog"` while
// open and unmounts it on close, so presence in the DOM is exactly "is a
// modal open" — a stable ARIA contract, not an internal implementation
// detail. The `Escape`-closes-topmost-layer behavior itself needs no code
// here: Dialog and the context menu's own Menu are both Radix primitives
// sharing Radix's dismissable-layer stack, which already closes only the
// topmost one.
export function isBlockingOverlayOpen(
  doc: Pick<Document, "querySelector"> = document,
): boolean {
  return doc.querySelector('[role="dialog"]') !== null;
}

export function isInsideInteractiveInput(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, [contenteditable=true]") !== null
  );
}
