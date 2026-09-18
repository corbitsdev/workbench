// The composer-insertion context object, apart from the provider and hooks
// around it — see `../bench-context-value.ts` for why a `createContext`
// call never shares a module with a component.

import { createContext } from "react";

export type ComposerInsertionHost = {
  readonly registerInsert: (insert: ((text: string) => void) | null) => void;
  /** Returns whether a composer was actually mounted to receive the text. */
  readonly insertText: (text: string) => boolean;
};

export const ComposerInsertionContext = createContext<ComposerInsertionHost>({
  registerInsert: () => undefined,
  insertText: () => false,
});
