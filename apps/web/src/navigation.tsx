// Client-side navigation, sized to what six flat routes need: a navigate
// function provided by the entry point, anchors that intercept plain left
// clicks, and nothing else. Deep links and modified clicks fall through to the
// browser — the hub serves index.html for every non-/api path, so a full page
// load lands on the same route.

import { createContext, useContext } from "react";
import type { ComponentProps, MouseEvent, ReactNode } from "react";

import type { SessionUser } from "./session";

export type Navigate = (to: string) => void;

const NavigateContext = createContext<Navigate>(() => {
  throw new Error("navigation used outside NavigationProvider");
});

/** Absent outside a signed-in shell (the onboarding wizard has no account
 * menu, no settings surface) — `undefined` rather than a throwing default,
 * so a reader like `AccountSection` (mounted in package tests with no
 * provider at all) can simply omit the Sign out action instead of
 * crashing. */
const SignOutContext = createContext<(() => void) | undefined>(undefined);

/** Same availability rule as `SignOutContext`: present in the signed-in
 * shell so surfaces like `ChatPage` can label the reader's own avatar from
 * the auth account (CL-6655), undefined outside that shell. */
const SessionUserContext = createContext<SessionUser | undefined>(undefined);

export function NavigationProvider({
  navigate,
  onSignOut,
  user,
  children,
}: {
  readonly navigate: Navigate;
  readonly onSignOut?: () => void;
  readonly user?: SessionUser;
  readonly children: ReactNode;
}) {
  return (
    <NavigateContext.Provider value={navigate}>
      <SignOutContext.Provider value={onSignOut}>
        <SessionUserContext.Provider value={user}>
          {children}
        </SessionUserContext.Provider>
      </SignOutContext.Provider>
    </NavigateContext.Provider>
  );
}

export function useNavigate(): Navigate {
  return useContext(NavigateContext);
}

/** The same sign-out the account menu's "Sign out" item calls — `undefined`
 * where no `onSignOut` was given to `NavigationProvider` (onboarding). */
export function useSignOut(): (() => void) | undefined {
  return useContext(SignOutContext);
}

/** The signed-in account from the shell session probe — `undefined` outside
 * a signed-in `NavigationProvider` (onboarding, package tests). */
export function useSessionUser(): SessionUser | undefined {
  return useContext(SessionUserContext);
}

/**
 * Intercepts a plain left click on an in-app anchor. Modified clicks (new
 * tab, download) and clicks a handler already cancelled keep their native
 * behavior.
 */
export function handleLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  to: string,
  navigate: Navigate,
): void {
  if (event.defaultPrevented) return;
  if (event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(to);
}

export function Link({
  to,
  onClick,
  ...props
}: ComponentProps<"a"> & { readonly to: string }) {
  const navigate = useNavigate();
  return (
    <a
      href={to}
      onClick={(event) => {
        onClick?.(event);
        handleLinkClick(event, to, navigate);
      }}
      {...props}
    />
  );
}
