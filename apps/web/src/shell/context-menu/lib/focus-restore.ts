// Our trigger is an inert 1px anchor, so Radix's default focus-restore
// drops to `<body>`. This finds the real element worth focusing instead.

const FOCUSABLE_SELECTOR = "a[href], button, input, select, textarea, [tabindex]";

export function findFocusable(element: Element | null): HTMLElement | null {
  if (element === null) return null;
  const candidate = element.matches(FOCUSABLE_SELECTOR)
    ? element
    : element.closest(FOCUSABLE_SELECTOR);
  return candidate instanceof HTMLElement ? candidate : null;
}

export function restoreFocus(element: Element | null): void {
  findFocusable(element)?.focus();
}
