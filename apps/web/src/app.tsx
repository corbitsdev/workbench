// The whole interface as a pure function of the current path and session
// state. The entry point owns the browser history and the one session probe;
// screens that talk to the hub only mount once the session is confirmed, so
// a signed-out browser fires no authenticated request anywhere.

import { BootScreen, Button, CorbitsMark, EmptyState } from "@corbits/react-ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useMemo } from "react";
import { Toaster } from "sonner";

import { AuthScreen } from "./auth-screen";
import { BenchProvider } from "./bench-context";
import { CommandPaletteProvider } from "./command-palette-provider";
import { NavigationProvider, type Navigate } from "./navigation";
import { NotFoundPage } from "./pages/not-found-page";
import { OnboardingPage } from "./pages/onboarding-page";
import { ProvisioningErrorPage } from "./pages/provisioning-error-page";
import { createAppQueryClient } from "./query-client";
import { APP_ROUTES, matchesRoute, ONBOARDING_PATH } from "./routes";
import type { SessionState, SessionUser } from "./session";
import { AppShell } from "./shell/app-shell";
import { ShellChromeProvider } from "./shell/shell-chrome-provider";

/**
 * Onboarding renders above the shell entirely — no rail, no col2, no bench
 * dock, nothing that implies a workbench already exists. A signed-in
 * account with no completed onboarding must never see "Select a workbench";
 * the wizard is the only thing on screen until it hands off to `/`.
 */
function OnboardingGate({ navigate }: { readonly navigate: Navigate }) {
  return (
    <NavigationProvider navigate={navigate}>
      <OnboardingPage />
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
  // and every tenant-scoped page share the same cache.
  const queryClient = useMemo(() => createAppQueryClient(), []);
  const route = APP_ROUTES.find((candidate) =>
    matchesRoute(candidate.path, path),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <NavigationProvider navigate={navigate}>
        <BenchProvider>
          <ShellChromeProvider path={path} navigate={navigate}>
            <CommandPaletteProvider path={path} navigate={navigate} />
            <AppShell path={path} user={user} onSignOut={onSignOut}>
              {route === undefined ? (
                <NotFoundPage path={path} />
              ) : (
                route.render(path, navigate)
              )}
            </AppShell>
          </ShellChromeProvider>
          <Toaster />
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
  onRetryProvisioning,
}: {
  readonly path: string;
  readonly navigate: Navigate;
  readonly session: SessionState;
  readonly onSignedIn: (user: SessionUser) => void;
  readonly onSignOut: () => void;
  readonly onRetry: () => void;
  readonly provisioningError?: string | null;
  readonly onRetryProvisioning?: () => void;
}) {
  if (session.kind === "signed-in" && provisioningError) {
    return (
      <ProvisioningErrorPage
        message={provisioningError}
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
      return <AuthScreen onSignedIn={onSignedIn} />;
    case "error":
      return (
        <div className="app-boot-frame">
          <EmptyState
            icon={<CircleAlert />}
            title="Couldn't reach the hub"
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
      if (path === ONBOARDING_PATH) {
        return <OnboardingGate navigate={navigate} />;
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
