// The whole interface as a pure function of the current path and session
// state. The entry point owns the browser history and the one session probe;
// screens that talk to the hub only mount once the session is confirmed, so
// a signed-out browser fires no authenticated request anywhere.

import { BootScreen, Button, CorbitsMark, EmptyState } from "@corbits/react-ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useEffect, useMemo } from "react";

import { AuthScreen } from "./auth-screen";
import { BenchProvider } from "./bench-context";
import { CommandPaletteProvider } from "./command-palette-provider";
import { buildLoginRedirect } from "./login-next";
import { NavigationProvider, type Navigate } from "./navigation";
import { NotFoundPage } from "./pages/not-found-page";
import { OnboardingPage } from "./pages/onboarding-page";
import { ProvisioningErrorPage } from "./pages/provisioning-error-page";
import { createAppQueryClient } from "./query-client";
import {
  APP_ROUTES,
  LOGIN_PATH,
  matchesRoute,
  ONBOARDING_PATH,
} from "./routes";
import type { SessionState, SessionUser } from "./session";
import { AppShell } from "./shell/app-shell";
import { ComposerInsertionProvider } from "./shell/composer-insertion";
import { ProviderHealthProvider } from "./shell/provider-health-context";
import { ShellChromeProvider } from "./shell/shell-chrome-provider";

/** Any signed-out request for a path other than `/login` itself bounces
 * there with `?next=` so a successful sign-in returns to where the visitor
 * meant to go — the URL is the source of truth for "where was I headed",
 * not an implicit conditional swap in `App`. */
function LoginRedirect({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: Navigate;
}) {
  useEffect(() => {
    navigate(buildLoginRedirect(path));
  }, [path, navigate]);
  return null;
}

/** An already-authed visit to `/login` (a stale tab, a bookmark) bounces
 * home rather than showing the sign-in form to someone already signed in. */
function LoginBounceHome({ navigate }: { readonly navigate: Navigate }) {
  useEffect(() => {
    navigate("/");
  }, [navigate]);
  return null;
}

/**
 * Onboarding renders above the shell entirely — no rail, no col2, no bench
 * dock, nothing that implies a workbench already exists. A signed-in
 * account with no completed onboarding must never see "Select a workbench";
 * the wizard is the only thing on screen until it hands off to `/`.
 */
function OnboardingGate({
  navigate,
  user,
}: {
  readonly navigate: Navigate;
  readonly user: SessionUser;
}) {
  return (
    <NavigationProvider navigate={navigate}>
      <OnboardingPage user={user} />
    </NavigationProvider>
  );
}

function Brand() {
  return (
    <>
      <CorbitsMark decorative className="app-mark" />
      <span className="app-wordmark">Workbench</span>
    </>
  );
}

function Shell({
  path,
  navigate,
  user,
  onSignOut,
}: {
  readonly path: string;
  readonly navigate: Navigate;
  readonly user: SessionUser;
  readonly onSignOut: () => void;
}) {
  // One client per signed-in shell mount — above BenchProvider so principals
  // and every tenant-scoped page share the same cache. Wired to the same
  // `onSignOut` the account menu uses: any query or mutation that
  // discovers the session is no longer valid (a hub restarted on an empty
  // DB, a cookie for a deleted user, an expired session) routes the whole
  // shell back to login instead of leaving one panel stuck showing "sign
  // in required" beside chrome that still renders as if signed in.
  const queryClient = useMemo(
    () => createAppQueryClient(onSignOut),
    [onSignOut],
  );
  const route = APP_ROUTES.find((candidate) =>
    matchesRoute(candidate.path, path),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <NavigationProvider navigate={navigate} onSignOut={onSignOut}>
        <BenchProvider>
          <ProviderHealthProvider>
            <ComposerInsertionProvider>
              <ShellChromeProvider path={path} navigate={navigate}>
                <CommandPaletteProvider path={path} navigate={navigate} />
                <AppShell path={path} user={user} onSignOut={onSignOut}>
                  {route === undefined ? (
                    <NotFoundPage />
                  ) : (
                    route.render(path, navigate)
                  )}
                </AppShell>
              </ShellChromeProvider>
            </ComposerInsertionProvider>
          </ProviderHealthProvider>
        </BenchProvider>
      </NavigationProvider>
    </QueryClientProvider>
  );
}

/**
 * The whole interface as a pure function of the current path and session
 * state. The entry point owns the browser history and the one session probe;
 * screens that talk to the hub only mount once the session is confirmed, so
 * a signed-out browser fires no authenticated request anywhere.
 */
export function App({
  path,
  navigate,
  session,
  onSignedIn,
  onSignOut,
  onRetry,
  provisioningError,
  provisioningErrorRefId,
  onRetryProvisioning,
}: {
  readonly path: string;
  readonly navigate: Navigate;
  readonly session: SessionState;
  readonly onSignedIn: (user: SessionUser) => void;
  readonly onSignOut: () => void;
  readonly onRetry: () => void;
  readonly provisioningError?: string | null;
  readonly provisioningErrorRefId?: string | undefined;
  readonly onRetryProvisioning?: () => void;
}) {
  if (session.kind === "signed-in" && provisioningError) {
    return (
      <ProvisioningErrorPage
        message={provisioningError}
        refId={provisioningErrorRefId}
        onRetry={onRetryProvisioning ?? onRetry}
      />
    );
  }
  switch (session.kind) {
    case "loading":
      return (
        <div className="app-boot-frame">
          <BootScreen message="Loading workbench" brand={<Brand />} />
        </div>
      );
    case "signed-out":
      if (path !== LOGIN_PATH) {
        return <LoginRedirect path={path} navigate={navigate} />;
      }
      return <AuthScreen onSignedIn={onSignedIn} />;
    case "error":
      return (
        <div className="app-boot-frame">
          <EmptyState
            icon={<CircleAlert />}
            title="Connection lost"
            description={session.message}
            action={
              <Button variant="outline" onClick={onRetry}>
                Try again
              </Button>
            }
          />
        </div>
      );
    case "signed-in":
      if (path === LOGIN_PATH) {
        return <LoginBounceHome navigate={navigate} />;
      }
      if (path === ONBOARDING_PATH) {
        return <OnboardingGate navigate={navigate} user={session.user} />;
      }
      return (
        <Shell
          path={path}
          navigate={navigate}
          user={session.user}
          onSignOut={onSignOut}
        />
      );
  }
}
