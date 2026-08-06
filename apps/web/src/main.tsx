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
  // an existing member costs one read and nothing else.
  const provisionedUserId =
    session.kind === "signed-in" ? session.user.id : null;
  useEffect(() => {
    if (provisionedUserId === null) return;
    let cancelled = false;
    void triggerFirstLoginProvisioning().then((result) => {
      if (!cancelled && result?.kind === "provisioned") navigate("/onboarding");
    });
    return () => {
      cancelled = true;
    };
  }, [provisionedUserId, navigate]);
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
