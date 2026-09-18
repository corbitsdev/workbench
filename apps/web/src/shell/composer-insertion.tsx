// Lets the profile card's Mention action reach the composer without
// either side importing the other — same shape as `canvas-availability.tsx`.

import { useContext, useMemo, useRef } from "react";
import type { ReactNode } from "react";

import { ComposerInsertionContext } from "./composer-insertion-context";
import type { ComposerInsertionHost } from "./composer-insertion-context";

export type { ComposerInsertionHost };

export function ComposerInsertionProvider({ children }: { readonly children: ReactNode }) {
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
    <ComposerInsertionContext.Provider value={value}>{children}</ComposerInsertionContext.Provider>
  );
}

/** `ChatPage` calls this once and hands the result straight to
 * `ChatWorkspace`'s `registerComposerInsert` prop. */
export function useRegisterComposerInsert(): (insert: ((text: string) => void) | null) => void {
  return useContext(ComposerInsertionContext).registerInsert;
}

/** The profile card's Mention action calls this — `false` means no workbench
 * is open right now, so the caller can fall back to an honest "nothing to
 * mention into" message instead of silently doing nothing. */
export function useInsertIntoComposer(): (text: string) => boolean {
  return useContext(ComposerInsertionContext).insertText;
}
