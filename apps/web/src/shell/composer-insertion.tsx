// A shell-level seam between two independent surfaces: the canvas column's
// ProfileCard (this app) and the active workbench's composer (mounted deep
// inside `@corbits/chat-ui`'s `ChatWorkspace`, a sibling tree). The profile
// card's Mention action (CL-5914) needs to land `@handle` in whatever
// composer is on screen without either side importing the other — the same
// "shell context exposing a callback hook" shape `canvas-availability.tsx`
// already uses for opening a profile.

import { createContext, useContext, useMemo, useRef } from "react";
import type { ReactNode } from "react";

export type ComposerInsertionHost = {
  readonly registerInsert: (insert: ((text: string) => void) | null) => void;
  /** Returns whether a composer was actually mounted to receive the text. */
  readonly insertText: (text: string) => boolean;
};

const ComposerInsertionContext = createContext<ComposerInsertionHost>({
  registerInsert: () => undefined,
  insertText: () => false,
});

export function ComposerInsertionProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const insertRef = useRef<((text: string) => void) | null>(null);
  const value = useMemo<ComposerInsertionHost>(
    () => ({
      registerInsert: (insert) => {
        insertRef.current = insert;
      },
      insertText: (text) => {
        if (insertRef.current === null) return false;
        insertRef.current(text);
        return true;
      },
    }),
    [],
  );
  return (
    <ComposerInsertionContext.Provider value={value}>
      {children}
    </ComposerInsertionContext.Provider>
  );
}

/** `ChatPage` calls this once and hands the result straight to
 * `ChatWorkspace`'s `registerComposerInsert` prop. */
export function useRegisterComposerInsert(): (
  insert: ((text: string) => void) | null,
) => void {
  return useContext(ComposerInsertionContext).registerInsert;
}

/** The profile card's Mention action calls this — `false` means no workbench
 * is open right now, so the caller can fall back to an honest "nothing to
 * mention into" message instead of silently doing nothing. */
export function useInsertIntoComposer(): (text: string) => boolean {
  return useContext(ComposerInsertionContext).insertText;
}
