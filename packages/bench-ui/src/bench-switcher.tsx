// The app-chrome bench switcher: a thin adapter from this surface's
// membership shape to `@corbits/react-ui`'s `TenantSelector`. Every label it
// shows is the server-resolved bench name — never a tenant id.

import { TenantSelector } from "@corbits/react-ui";

import { membershipDisplay } from "./membership";
import { BENCH_STRINGS } from "./strings";
import type { BenchMembership } from "./api";

export function BenchSwitcher({
  memberships,
  activeTenantId,
  onSelect,
}: {
  readonly memberships: readonly BenchMembership[];
  readonly activeTenantId: string | null;
  readonly onSelect: (tenantId: string) => void;
}) {
  const tenants = memberships.map((membership) => {
    const display = membershipDisplay(membership);
    return { id: display.tenantId, name: display.name };
  });
  return (
    <TenantSelector
      tenants={tenants}
      activeId={activeTenantId}
      onSelect={onSelect}
      label={BENCH_STRINGS.switcherLabel}
    />
  );
}
