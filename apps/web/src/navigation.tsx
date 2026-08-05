// Client-side navigation, sized to what six flat routes need: a navigate
// function provided by the entry point, anchors that intercept plain left
// clicks, and nothing else. Deep links and modified clicks fall through to the
// browser — the hub serves index.html for every non-/api path, so a full page
// load lands on the same route.

import { createContext, useContext } from "react";
import type { ComponentProps, MouseEvent, ReactNode } from "react";

export type Navigate = (to: string) => void;

const NavigateContext = createContext<Navigate>(() => {
  throw new Error("navigation used outside NavigationProvider");
});

export function NavigationProvider({
  navigate,
  children,
}: {
  readonly navigate: Navigate;
  readonly children: ReactNode;
}) {
  return (
    <NavigateContext.Provider value={navigate}>
      {children}
    </NavigateContext.Provider>
  );
}

export function useNavigate(): Navigate {
  return useContext(NavigateContext);
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
