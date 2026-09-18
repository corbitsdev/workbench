// Enforced at open time, not by racing keydown handlers: every dialog
// renders Radix's `role="dialog"` while open, so DOM presence is exactly
// "is a modal open."
export function isBlockingOverlayOpen(doc?: Pick<Document, "querySelector">): boolean {
  const target = doc ?? globalThis.document;
  return target.querySelector('[role="dialog"]') !== null;
}

export function isInsideInteractiveInput(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest("input, textarea, [contenteditable=true]") !== null
  );
}
