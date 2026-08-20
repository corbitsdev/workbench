// Radix's DropdownMenu restores focus to its trigger on close. Our trigger
// is an inert, unfocusable 1px anchor at the click point — restoring focus
// to it is a no-op that drops focus to `<body>`. This module finds the real
// element worth focusing instead: the right-clicked row itself, or its
// nearest focusable ancestor.

const FOCUSABLE_SELECTOR =
  "a[href], button, input, select, textarea, [tabindex]";

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
