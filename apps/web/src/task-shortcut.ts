// The global Cmd+T / Ctrl+T "New task" shortcut's guard, pulled out as
// a pure predicate so it's unit-testable without mounting
// `CommandPaletteProvider`'s full dependency tree (bench context, the
// command palette itself, entity search, …). Mirrors react-ui's
// `useCommandShortcut` guard exactly (see command-palette-provider.tsx's
// own doc comment on the effect that calls this): `event.repeat`
// skipped, an editable target skipped, `metaKey || ctrlKey` accepted
// so both mac and non-mac fire without OS-sniffing.
//
// Caveat (documented again here, next to the logic it doesn't and
// can't fix): browsers and OSes reserve Cmd+T/Ctrl+T for "new tab" and
// intercept the keystroke before it reaches any page's JavaScript in
// many browser/OS combinations. This predicate only decides what
// happens on the keydown events that actually reach the page — it
// cannot make the browser deliver events it has already claimed.
export type ShortcutKeyEvent = {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly repeat: boolean;
  readonly target: EventTarget | null;
};

export function isNewTaskShortcutEvent(event: ShortcutKeyEvent): boolean {
  if (
    event.key.toLowerCase() !== "t" ||
    !(event.metaKey || event.ctrlKey) ||
    event.repeat
  ) {
    return false;
  }
  const target = event.target as HTMLElement | null;
  if (
    target?.isContentEditable === true ||
    /^(input|textarea|select)$/i.test(target?.tagName ?? "")
  ) {
    return false;
  }
  return true;
}
