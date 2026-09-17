import "@corbits/react-ui/styles.css";
import "./app.css";
import "./tailwind.css";

import { ThemeProvider, Toaster, toast } from "@corbits/react-ui";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { getLogger } from "@corbits/client-log";
import { AppErrorBoundary } from "./app-error-boundary";
import { App } from "./app";
import {
  logBootstrapResult,
  logBootstrapThrown,
  runPortableClientBootstrap,
} from "./client-bootstrap";
import { validatedNextPath } from "./login-next";
import { triggerFirstLoginProvisioning } from "./onboarding";
import { ONBOARDING_PATH } from "./routes";
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

  // The first-login hook: once per session that reaches signed-in, ask
  // the hub's native setup-status route whether any bench exists yet. An
  // empty hub reports setup-required so we route into the setup screen;
  // a hub with tenants loads the shell normally. Read-only on purpose
  // (CL-8112) — this never mints anything. A failure blocks the shell
  // entirely rather than leaving the user silently benchless.
  const [provisioningError, setProvisioningError] = useState<{
    message: string;
    refId?: string | undefined;
  } | null>(null);
  const provisionedUserId =
    session.kind === "signed-in" ? session.user.id : null;
  const runProvisioning = useCallback(() => {
    if (provisionedUserId === null) return () => undefined;
    let cancelled = false;
    setProvisioningError(null);
    void triggerFirstLoginProvisioning().then((result) => {
      if (cancelled) return;
      if (result.kind === "needs-onboarding") {
        navigate(ONBOARDING_PATH);
      } else if (result.kind === "error") {
        setProvisioningError({ message: result.message, refId: result.refId });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [provisionedUserId, navigate]);
  useEffect(runProvisioning, [runProvisioning]);
  const handleRetryProvisioning = useCallback(() => {
    runProvisioning();
  }, [runProvisioning]);

  // The portable client lane: every signed-in open also converges the
  // client's needs-list against stock Interchange routes and persists the
  // child tenant ids it created (scoped by hub origin and account). It
  // never gates the shell — stock hubs cannot project workflow principals
  // into child rooms by refId yet, so a capability gap is the normal
  // outcome until that lands upstream; it is logged, not shown.
  const signedInUser = session.kind === "signed-in" ? session.user : null;
  useEffect(() => {
    if (signedInUser === null) return;
    let cancelled = false;
    void runPortableClientBootstrap(signedInUser).then(
      (result) => {
        if (cancelled) return;
        logBootstrapResult(log, result);
      },
      (error) => {
        if (cancelled) return;
        logBootstrapThrown(log, error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [signedInUser]);
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
        provisioningError={provisioningError?.message ?? null}
        provisioningErrorRefId={provisioningError?.refId}
        onRetryProvisioning={handleRetryProvisioning}
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
