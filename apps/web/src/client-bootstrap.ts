// Uses only stock routes — no workbench server proxies, tables, or mounts.

import { findOwnedTenants, type StockHub } from "./needs-converge";

export type ClientBootstrapAccount = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
};

/** Derives a stable, readable slug for the primary tenant this account is
 * about to mint — never random, so a retry after a dropped response
 * targets the same slug rather than minting a second root. */
function primaryTenantSlug(account: ClientBootstrapAccount): string {
  const base = account.email
    .split("@")[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base !== undefined && base.length > 0 ? base : `home-${account.id}`;
}

/** Never hub boot, never a CLI. Never mints a second root: an account that
 * already owns one is left alone. */
export async function ensurePrimaryTenant(
  account: ClientBootstrapAccount,
  hub: StockHub,
): Promise<void> {
  const owned = await findOwnedTenants(hub);
  if (owned.some((tenant) => tenant.parentId === null)) return;
  await hub.createTenant({
    name: `${account.name}'s Workbench`,
    slug: primaryTenantSlug(account),
  });
}
