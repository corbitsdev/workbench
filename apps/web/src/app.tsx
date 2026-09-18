// The entry point owns the browser history and the one session probe;
// screens mount only once the session is confirmed, so a signed-out
// browser fires no authenticated request anywhere.

import { Button, EmptyState } from "@corbits/react-ui";
import { WorkbenchLoadingState } from "@/chat";
import { QueryClientProvider } from "@tanstack/react-query";
import { BoldIconProvider, WarningCircle } from "@/lib/icons";
import { useMemo } from "react";

import { AuthScreen } from "./auth-screen";
import { BenchProvider } from "./bench-context";
import { CommandPaletteProvider } from "./command-palette-provider";
import { buildLoginRedirect } from "./login-next";
import { NavigationProvider, type Navigate } from "./navigation";
import { NotFoundPage } from "./pages/not-found-page";
import { OnboardingPage } from "./pages/onboarding-page";
import { ProvisioningErrorPage } from "./pages/provisioning-error-page";
import { createAppQueryClient } from "./query-client";
import { Redirect } from "./redirect";
import { APP_ROUTES, LOGIN_PATH, matchesRoute, ONBOARDING_PATH } from "./routes";
import type { SessionState, SessionUser } from "./session";
import { AppShell } from "./shell/app-shell";
import { ComposerInsertionProvider } from "./shell/composer-insertion";
import { ShellChromeProvider } from "./shell/shell-chrome-provider";

// Renders above the shell entirely — no rail, no dock, nothing that
// implies a workbench already exists, until it hands off to `/`.
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
  // One client per shell mount so every tenant-scoped page shares the same
  // cache; wired to `onSignOut` so a session going invalid anywhere routes
  // the whole shell back to login, not just one stuck panel.
  const queryClient = useMemo(() => createAppQueryClient(onSignOut), [onSignOut]);
  const route = APP_ROUTES.find((candidate) => matchesRoute(candidate.path, path));
  return (
    <QueryClientProvider client={queryClient}>
      <NavigationProvider navigate={navigate} onSignOut={onSignOut} user={user}>
        <BenchProvider>
          <ComposerInsertionProvider>
            <ShellChromeProvider path={path} navigate={navigate}>
              <CommandPaletteProvider path={path} navigate={navigate}>
                <AppShell path={path} user={user} onSignOut={onSignOut}>
                  {route === undefined ? <NotFoundPage /> : route.render(path, navigate)}
                </AppShell>
              </CommandPaletteProvider>
            </ShellChromeProvider>
          </ComposerInsertionProvider>
        </BenchProvider>
      </NavigationProvider>
    </QueryClientProvider>
  );
}

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
  return <BoldIconProvider>{renderApp()}</BoldIconProvider>;

  function renderApp() {
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
            <WorkbenchLoadingState delayMs={0} />
          </div>
        );
      case "signed-out":
        // The URL is the source of truth for "where was I headed": a
        // signed-out request for another path carries `?next=` to login.
        if (path !== LOGIN_PATH) {
          return <Redirect to={buildLoginRedirect(path)} from={path} navigate={navigate} />;
        }
        return <AuthScreen onSignedIn={onSignedIn} />;
      case "error":
        return (
          <div className="app-boot-frame">
            <EmptyState
              icon={<WarningCircle />}
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
        // An already-authed visit to `/login` (a stale tab, a bookmark)
        // bounces home rather than showing the sign-in form again.
        if (path === LOGIN_PATH) {
          return <Redirect to="/" from={path} navigate={navigate} />;
        }
        if (path === ONBOARDING_PATH) {
          return <OnboardingGate navigate={navigate} user={session.user} />;
        }
        return <Shell path={path} navigate={navigate} user={session.user} onSignOut={onSignOut} />;
    }
  }
}
