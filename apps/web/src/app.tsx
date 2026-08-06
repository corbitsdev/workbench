import {
  BootScreen,
  Button,
  CorbitsMark,
  EmptyState,
  Sidebar,
  SidebarCollapseToggle,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarItem,
  SidebarSection,
} from "@corbits/react-ui";
import { CircleAlert, LogOut } from "lucide-react";
import { useState } from "react";

import { AuthScreen } from "./auth-screen";
import {
  handleLinkClick,
  NavigationProvider,
  useNavigate,
  type Navigate,
} from "./navigation";
import { NotFoundPage } from "./pages/not-found-page";
import { OnboardingPage } from "./pages/onboarding-page";
import { APP_ROUTES } from "./routes";
import type { SessionState, SessionUser } from "./session";

function AppNav({ path }: { readonly path: string }) {
  const navigate = useNavigate();
  return (
    <SidebarSection label="Workbench">
      {APP_ROUTES.map((route) => (
        <SidebarItem
          key={route.path}
          href={route.path}
          onClick={(event) => handleLinkClick(event, route.path, navigate)}
          active={path === route.path}
          icon={route.icon}
        >
          {route.label}
        </SidebarItem>
      ))}
    </SidebarSection>
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
  const [collapsed, setCollapsed] = useState(false);
  const route = APP_ROUTES.find((candidate) => candidate.path === path);
  return (
    <NavigationProvider navigate={navigate}>
      <div className="app-frame">
        <Sidebar collapsed={collapsed}>
          <SidebarHeader>
            <SidebarCollapseToggle
              collapsed={collapsed}
              onToggle={() => setCollapsed((value) => !value)}
            />
            <Brand />
          </SidebarHeader>
          <SidebarContent>
            <AppNav path={path} />
          </SidebarContent>
          <SidebarFooter>
            <div className="app-session">
              <span className="app-session-email">{user.email}</span>
              <Button variant="ghost" size="sm" onClick={onSignOut}>
                <LogOut />
                <span className="app-session-label">Sign out</span>
              </Button>
            </div>
          </SidebarFooter>
        </Sidebar>
        <main className="app-main">
          {path === "/onboarding" ? (
            <OnboardingPage />
          ) : route === undefined ? (
            <NotFoundPage path={path} />
          ) : (
            route.render()
          )}
        </main>
      </div>
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
}: {
  readonly path: string;
  readonly navigate: Navigate;
  readonly session: SessionState;
  readonly onSignedIn: (user: SessionUser) => void;
  readonly onSignOut: () => void;
  readonly onRetry: () => void;
}) {
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
