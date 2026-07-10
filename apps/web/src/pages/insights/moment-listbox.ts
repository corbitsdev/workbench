import { useEffect, type KeyboardEvent, type RefObject } from "react";

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
  optionId: (index: number) => string,
  selectedIndex: number,
) {
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const el = list.querySelector<HTMLElement>(`#${optionId(selectedIndex)}`);
    if (el === null || typeof el.scrollIntoView !== "function") return;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({
      block: "nearest",
      behavior: reduced ? "auto" : "smooth",
    });
  }, [listRef, optionId, selectedIndex]);
}
