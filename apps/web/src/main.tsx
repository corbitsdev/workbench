import "@corbits/react-ui/styles.css";
import "./app.css";
import "./tailwind.css";

import { ThemeProvider, Toaster, toast } from "@corbits/react-ui";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { getLogger } from "@corbits/client-log";
import { AppErrorBoundary } from "./app-error-boundary";
import { App } from "./app";
import { validatedNextPath } from "./login-next";
import { fetchSession, signOut } from "./session";
import type { SessionState, SessionUser } from "./session";

const log = getLogger("web.session");

function Root() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  const navigate = useCallback((to: string) => {
    window.history.pushState(null, "", to);
    // `path` state is pathname-only (every comparison against it —
    // `matchesRoute`, `LOGIN_PATH`, `ONBOARDING_PATH` — expects a bare
    // path); a query string like `/login?next=...` still lands on the
    // URL bar via `pushState` above, just not in this state.
    setPath(new URL(to, window.location.origin).pathname);
  }, []);

  const [session, setSession] = useState<SessionState>({ kind: "loading" });
  const probe = useCallback(() => {
    setSession({ kind: "loading" });
    void fetchSession().then(setSession);
  }, []);
  useEffect(probe, [probe]);

  const handleSignedIn = useCallback(
    (user: SessionUser) => {
      setSession({ kind: "signed-in", user });
      navigate(validatedNextPath(window.location.search));
    },
    [navigate],
  );

  // 0→1 genesis moved to the client's needs-list (CL-8085): a signed-in
  // session with zero memberships converges its own primary tenant
  // directly over stock routes from inside `BenchProvider`, once the
  // shell mounts — there is no server-side first-login hook left to call
  // here.
  const handleSignOut = useCallback(() => {
    setSession({ kind: "signed-out" });
    toast(
      "Signed out. If you were on a shared computer, close the browser to be sure.",
    );
    void signOut().then((ok) => {
      if (ok) return;
      log.error("Sign-out request to the server failed");
    });
  }, []);

  // Per-user storage when signed in so theme preference follows the account;
  // signed-out / loading share the anonymous host key. Not synced to the
  // preferences store (CL-5922): @corbits/react-ui's ThemeProvider owns mode
  // entirely internally (localStorage read/write on setMode/cycleMode) and
  // exposes no onChange hook or externally-supplied initial value a host
  // could observe or override without forking the component.
  const themeStorageKey =
    session.kind === "signed-in"
      ? `corbits-theme:${session.user.id}`
      : "corbits-theme";

  return (
    <ThemeProvider storageKey={themeStorageKey} defaultMode="light">
      <App
        path={path}
        navigate={navigate}
        session={session}
        onSignedIn={handleSignedIn}
        onSignOut={handleSignOut}
        onRetry={probe}
      />
      <Toaster position="bottom-right" />
    </ThemeProvider>
  );
}

const container = document.getElementById("root");
if (container === null) throw new Error("index.html is missing #root");
createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <Root />
    </AppErrorBoundary>
  </StrictMode>,
);
