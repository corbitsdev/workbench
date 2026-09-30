// The top of the React tree: browser history, the one session probe, the
// first-login hook, and the theme shell everything else renders inside.
// Kept out of `main.tsx` so the entry module owns nothing but the mount.

import { Toaster, toast } from "@corbits/react-ui/ui/toast";
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

import { getLogger } from "@/lib/client-log";
import { App } from "./app";
import { validatedNextPath } from "./login-next";
import { finishDeferredWorkerSetup } from "./deferred-worker-setup";
import { triggerFirstLoginProvisioning } from "./onboarding";
import { isProviderSkipped } from "./provider-skip";
import { getPath, navigateTo, subscribeToPath } from "./router-store";
import { ONBOARDING_PATH } from "./routes";
import { fetchSession, signOut } from "./session";
import type { SessionState, SessionUser } from "./session";
import { setThemeStorageKey } from "./theme-store";

const log = getLogger("web.session");

export function Root() {
  // History lives outside React (`./router-store`), so the path is a
  // subscription, not an effect that starts listening after first paint.
  const path = useSyncExternalStore(subscribeToPath, getPath);
  const navigate = navigateTo;

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

  // Read-only on purpose — never mints anything. A failure blocks the
  // shell rather than leaving the user silently benchless.
  const [provisioningError, setProvisioningError] = useState<{
    message: string;
    refId?: string | undefined;
  } | null>(null);
  const provisionedUser = session.kind === "signed-in" ? session.user : null;
  const runProvisioning = useCallback(() => {
    if (provisionedUser === null) return () => undefined;
    let cancelled = false;
    setProvisioningError(null);
    void triggerFirstLoginProvisioning().then((result) => {
      if (cancelled) return;
      if (result.kind === "needs-onboarding") {
        // A skipped provider step keeps the shell; Worker deploys once a model exists.
        if (isProviderSkipped(provisionedUser.id)) {
          void finishDeferredWorkerSetup(provisionedUser);
          return;
        }
        navigate(ONBOARDING_PATH);
      } else if (result.kind === "error") {
        setProvisioningError({ message: result.message, refId: result.refId });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [provisionedUser, navigate]);
  useEffect(runProvisioning, [runProvisioning]);
  const handleRetryProvisioning = useCallback(() => {
    runProvisioning();
  }, [runProvisioning]);

  const handleSignOut = useCallback(() => {
    setSession({ kind: "signed-out" });
    toast("Signed out. If you were on a shared computer, close the browser to be sure.");
    void signOut().then((ok) => {
      if (ok) return;
      log.error("Sign-out request to the server failed");
    });
  }, []);

  // Per-user storage key so the theme follows the account.
  const themeStorageKey =
    session.kind === "signed-in" ? `corbits-theme:${session.user.id}` : "corbits-theme";
  useLayoutEffect(() => {
    setThemeStorageKey(themeStorageKey);
  }, [themeStorageKey]);

  return (
    <>
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
    </>
  );
}
