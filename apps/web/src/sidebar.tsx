// The sidebar's composable pieces: the top nav list and the two bottom
// docks — the bench switcher and the identity row. Kept as small parts
// rather than one component so other sidebar variants (a dynamic-slot
// rail, a two-column layout) can compose from the same anatomy later.

import { Button } from "@corbits/react-ui";
import { BenchSwitcher } from "@corbits/bench-ui";
import { LogOut, Settings } from "lucide-react";

import { useBench } from "./bench-context";
import { handleLinkClick, useNavigate } from "./navigation";
import { SETTINGS_PATH, matchesRoute } from "./routes";
import type { SessionUser } from "./session";

/**
 * Initials for the identity dock's avatar, derived locally — the app is
 * CSP-strict, so there is never a network fetch for an avatar image.
 * Prefers the account name; an account with no usable name falls back
 * to the email's local part, and "··" stands in when neither yields a
 * letter (mirroring the reference chrome's placeholder).
 */
export function initialsOf(name: string, email: string): string {
  const source = name.trim().length > 0 ? name : (email.split("@")[0] ?? "");
  const initials = source
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return initials.length > 0 ? initials : "··";
}

/** Bottom dock A: which bench the app is pointed at, and where a new
 * one is created. Hidden until the memberships listing is in — a
 * switcher with nothing to switch is noise, and the pages already
 * surface loading/error states for the same query. */
export function BenchDock() {
  const { memberships, selectedTenantId, selectTenant, onBenchCreated } =
    useBench();
  if (memberships.kind !== "ready") return null;
  return (
    <div className="app-bench-dock">
      <BenchSwitcher
        memberships={memberships.data.data}
        activeTenantId={selectedTenantId}
        onSelect={selectTenant}
        onBenchCreated={(bench) => onBenchCreated(bench.id)}
      />
    </div>
  );
}

/** Bottom dock B: who is signed in (initials avatar + email — never an
 * id), with settings and sign-out. */
export function IdentityDock({
  path,
  user,
  onSignOut,
}: {
  readonly path: string;
  readonly user: SessionUser;
  readonly onSignOut: () => void;
}) {
  const navigate = useNavigate();
  const settingsActive = matchesRoute(SETTINGS_PATH, path);
  return (
    <div className="app-identity-dock">
      <div className="app-identity" title={user.email}>
        <span className="app-identity-avatar" aria-hidden>
          {initialsOf(user.name, user.email)}
        </span>
        <span className="app-identity-email">{user.email}</span>
      </div>
      <div className="app-identity-actions">
        <a
          aria-current={settingsActive ? "page" : undefined}
          href={SETTINGS_PATH}
          title="Settings"
          aria-label="Settings"
          className="app-identity-settings"
          onClick={(event) => handleLinkClick(event, SETTINGS_PATH, navigate)}
        >
          <Settings size={17} />
        </a>
        <Button
          variant="ghost"
          size="sm"
          onClick={onSignOut}
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut />
        </Button>
      </div>
    </div>
  );
}
