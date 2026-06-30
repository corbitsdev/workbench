import { useEffect, useRef } from "react";

// Global keybind to attach the active surface into Myra (CL-2495). Cmd/Ctrl+I —
// chosen over the ticket's Cmd+A to avoid hijacking the browser's select-all.
// Inert while focus is inside a text field so typing is never intercepted, and
// the handler only consumes the event when `onAttach` reports it attached
// something (returns true) — otherwise the native shortcut is left alone.

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export function useAttachShortcut(onAttach: () => boolean): void {
  const onAttachRef = useRef(onAttach);
  onAttachRef.current = onAttach;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "i") return;
      if (isEditableTarget(event.target)) return;
      const attached = onAttachRef.current();
      if (attached) event.preventDefault();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
}
