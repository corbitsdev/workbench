import "@corbits/react-ui/styles.css";
import "./app.css";

import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
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
