// The navigation context objects, apart from the provider and hooks that
// use them — see `bench-context-value.ts` for why a `createContext` call
// never shares a module with a component.

import { createContext } from "react";

import type { SessionUser } from "./session";

export type Navigate = (to: string) => void;

export const NavigateContext = createContext<Navigate>(() => {
  throw new Error("navigation used outside NavigationProvider");
});

/** Absent outside a signed-in shell (the onboarding wizard has no account
 * menu, no settings surface) — `undefined` rather than a throwing default,
 * so a reader like `AccountSection` (mounted in package tests with no
 * provider at all) can simply omit the Sign out action instead of
 * crashing. */
export const SignOutContext = createContext<(() => void) | undefined>(undefined);

/** Same availability rule as `SignOutContext`: present in the signed-in
 * shell so surfaces like `ChatPage` can label the reader's own avatar from
 * the auth account, undefined outside that shell. */
export const SessionUserContext = createContext<SessionUser | undefined>(undefined);
