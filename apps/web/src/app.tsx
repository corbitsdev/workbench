import { BootScreen, Button, CorbitsMark, EmptyState } from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";

import { AuthScreen } from "./auth-screen";
import { BenchProvider } from "./bench-context";
import { CommandPaletteProvider } from "./command-palette-provider";
import { NavigationProvider, type Navigate } from "./navigation";
import { NotFoundPage } from "./pages/not-found-page";
import { OnboardingPage } from "./pages/onboarding-page";
import { ProvisioningErrorPage } from "./pages/provisioning-error-page";
import { APP_ROUTES, matchesRoute, ONBOARDING_PATH } from "./routes";
import type { SessionState, SessionUser } from "./session";
import { AppShell } from "./shell/app-shell";

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
  const route = APP_ROUTES.find((candidate) =>
    matchesRoute(candidate.path, path),
  );
  return (
    <NavigationProvider navigate={navigate}>
      <BenchProvider>
        <CommandPaletteProvider navigate={navigate} />
        <AppShell path={path} user={user} onSignOut={onSignOut}>
          {path === ONBOARDING_PATH ? (
            <OnboardingPage />
          ) : route === undefined ? (
            <NotFoundPage path={path} />
          ) : (
            route.render(path, navigate)
          )}
        </AppShell>
      </BenchProvider>
    </NavigationProvider>
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
