import "@corbits/react-ui/styles.css";
import "./app.css";
import "./tailwind.css";

import { ThemeProvider, Toaster, toast } from "@corbits/react-ui";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { getLogger } from "@corbits/client-log";
import { App } from "./app";
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
    setPath(to);
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
      navigate("/");
    },
    [navigate],
  );

  // The first-login hook: once per session that reaches signed-in, ask
  // the hub whether this is a session with zero principals anywhere.
  // Without a display name the hub does not mint a bench — it returns
  // needs-onboarding so we route into the naming wizard. Existing members
  // cost one read. A failure blocks the shell entirely.
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
      if (result.kind === "needs-onboarding" || result.kind === "provisioned") {
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
  const handleSignOut = useCallback(() => {
    setSession({ kind: "signed-out" });
    void signOut().then((ok) => {
      if (ok) return;
      log.error("Sign-out request to the server failed");
      toast("Couldn't fully sign out on the server — you're signed out here.");
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
      <Toaster />
    </ThemeProvider>
  );
}

const container = document.getElementById("root");
if (container === null) throw new Error("index.html is missing #root");
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
