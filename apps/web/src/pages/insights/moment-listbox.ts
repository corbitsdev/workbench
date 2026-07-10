import { useEffect, type KeyboardEvent, type RefObject } from "react";

const LISTBOX_NAV_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "j",
  "k",
  "Home",
  "End",
]);

/** Skip listbox stepping when focus is on a nested interactive control. */
export function listboxShouldHandleKeyDown(
  event: KeyboardEvent<HTMLElement>,
): boolean {
  if (!LISTBOX_NAV_KEYS.has(event.key)) return true;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  if (target === event.currentTarget) return true;
  const nested = target.closest(
    "a, button, input, textarea, select, [contenteditable='true']",
  );
  return nested === null || nested === event.currentTarget;
}

export function clampListIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

/** Returns the next selected index, or null when the key was not handled. */
export function stepListIndexOnKeyDown(
  event: KeyboardEvent,
  selected: number,
  length: number,
): number | null {
  if (length <= 0) return null;
  if (event.key === "ArrowDown" || event.key === "j") {
    event.preventDefault();
    return clampListIndex(selected + 1, length);
  }
  if (event.key === "ArrowUp" || event.key === "k") {
    event.preventDefault();
    return clampListIndex(selected - 1, length);
  }
  if (event.key === "Home") {
    event.preventDefault();
    return 0;
  }
  if (event.key === "End") {
    event.preventDefault();
    return length - 1;
  }
  return null;
}

export function useScrollListboxOption(
  listRef: RefObject<HTMLElement | null>,
  optionIdPrefix: string,
  selectedIndex: number,
) {
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const el = list.querySelector<HTMLElement>(
      `#${optionIdPrefix}${selectedIndex}`,
    );
    if (el === null || typeof el.scrollIntoView !== "function") return;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({
      block: "nearest",
      behavior: reduced ? "auto" : "smooth",
    });
  }, [listRef, optionIdPrefix, selectedIndex]);
}
