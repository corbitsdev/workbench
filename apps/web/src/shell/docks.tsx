// The rail's bottom docks: the bench switcher and the identity row. Kept as
// small parts rather than one component so the rail's footer slot can
// compose them independently of whatever else the shell adds there later.

import { Button, ThemeToggle } from "@corbits/react-ui";
import {
  BenchSwitcher,
  filterWorkbenchMemberships,
  listChannelTenantIds,
} from "@corbits/bench-ui";
import { useQuery } from "@tanstack/react-query";
import { LogOut, SlidersHorizontal } from "lucide-react";

import { useBench } from "../bench-context";
import { handleLinkClick, useNavigate } from "../navigation";
import { meKeys } from "../query-client";
import { SETTINGS_PATH, matchesRoute } from "../routes";
import type { SessionUser } from "../session";

/**
 * Initials for the identity dock's avatar, derived locally — the app is
 * CSP-strict, so there is never a network fetch for an avatar image.
 * Prefers the account name; an account with no usable name falls back
 * to the email's local part, and "··" stands in when neither yields a
 * letter (mirroring the reference chrome's placeholder).
 */
export function initialsOf(name: string, email = ""): string {
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

/** Bottom dock A: which bench the app is pointed at, and where a new one
 * is created. Hidden until the memberships listing is in — a switcher with
 * nothing to switch is noise, and the pages already surface loading/error
 * states for the same query.
 *
 * `/api/me/principals` returns one row per tenant the account belongs to,
 * workbenches and channel child tenancies alike — Interchange's tenant row
 * has no kind field to tell them apart (see `@corbits/bench-ui`'s
 * `tenancy-kind`). This dock is the one place that asks which of those
 * tenant ids are channels and drops them before the switcher ever renders
 * a row for one. */
export function BenchDock() {
  const { memberships, selectedTenantId, selectTenant, onBenchCreated } =
    useBench();
  const tenantIds =
    memberships.kind === "ready"
      ? memberships.data.data.map((membership) => membership.tenantId)
      : [];
  const channelTenancyKinds = useQuery({
    queryKey: meKeys.channelTenancyKinds(tenantIds),
    queryFn: () => listChannelTenantIds(tenantIds),
    enabled: tenantIds.length > 0,
  });

  if (memberships.kind !== "ready") return null;
  const workbenches = filterWorkbenchMemberships(
    memberships.data.data,
    channelTenancyKinds.data ?? new Set(),
  );
  return (
    <div className="shell-bench-dock">
      <BenchSwitcher
        memberships={workbenches}
        activeTenantId={selectedTenantId}
        onSelect={selectTenant}
        onBenchCreated={(bench) => onBenchCreated(bench.id)}
      />
    </div>
  );
}

/** Rail footer: who is signed in (initials avatar, tooltip-only email —
 * never an id) plus theme, settings and sign-out, stacked to fit the narrow
 * rail rather than the wide row the contextual panel used to have room for. */
export function RailIdentity({
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
    <div className="shell-rail-identity">
      <ThemeToggle />
      <a
        aria-current={settingsActive ? "page" : undefined}
        href={SETTINGS_PATH}
        title="Settings"
        aria-label="Settings"
        className="shell-rail-identity-settings"
        onClick={(event) => handleLinkClick(event, SETTINGS_PATH, navigate)}
      >
        <SlidersHorizontal size={17} />
      </a>
      <span
        className="shell-rail-identity-avatar"
        aria-hidden
        title={user.email}
      >
        {initialsOf(user.name, user.email)}
      </span>
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
  );
}
