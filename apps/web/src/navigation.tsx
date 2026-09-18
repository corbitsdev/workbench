// Deep links and modified clicks fall through to the browser — the hub
// serves index.html for every non-/api path, so a full page load still
// lands on the same route.

import { useContext } from "react";
import type { ComponentProps, MouseEvent, ReactNode } from "react";

import { NavigateContext, SessionUserContext, SignOutContext } from "./navigation-context";
import type { Navigate } from "./navigation-context";
import type { SessionUser } from "./session";

export type { Navigate };

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
        <SessionUserContext.Provider value={user}>{children}</SessionUserContext.Provider>
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

// Modified clicks (new tab, download) and already-cancelled clicks keep
// their native behavior.
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

export function Link({ to, onClick, ...props }: ComponentProps<"a"> & { readonly to: string }) {
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
