import "@corbits/react-ui/styles.css";
import "./app.css";

import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { triggerFirstLoginProvisioning } from "./onboarding";
import { fetchSession, signOut } from "./session";
import type { SessionState, SessionUser } from "./session";

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
  // Idempotent on the hub side, so re-running it on a page reload for
  // an existing member costs one read and nothing else. A failure here
  // blocks the shell entirely — a signed-in user with no org and a
  // failed provisioning attempt has nothing useful to do in the app.
  const [provisioningError, setProvisioningError] = useState<string | null>(
    null,
  );
  const provisionedUserId =
    session.kind === "signed-in" ? session.user.id : null;
  const runProvisioning = useCallback(() => {
    if (provisionedUserId === null) return () => undefined;
    let cancelled = false;
    setProvisioningError(null);
    void triggerFirstLoginProvisioning().then((result) => {
      if (cancelled) return;
      if (result.kind === "provisioned") navigate("/onboarding");
      else if (result.kind === "error") setProvisioningError(result.message);
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
    void signOut();
  }, []);

  return (
    <App
      path={path}
      navigate={navigate}
      session={session}
      onSignedIn={handleSignedIn}
      onSignOut={handleSignOut}
      onRetry={probe}
      provisioningError={provisioningError}
      onRetryProvisioning={handleRetryProvisioning}
    />
  );
}

const container = document.getElementById("root");
if (container === null) throw new Error("index.html is missing #root");
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
