/**
 * Auto-provisioning principal resolver for workbench's Slack mount.
 *
 * Lifted from the `createAutoProvisionPrincipalResolver` pattern in
 * scout's `packages/agent-dock/src/tag-mount.ts` (CL-4973) — the
 * composition, not the product: `roleNames` is caller-supplied here
 * rather than a hardcoded Scout role, and every read/write below rides
 * `corbits-tag/interchange`'s own `createPrincipalResolver`/
 * `provisionPrincipal`, which are already product-agnostic — this
 * function only owns the auto-provision-on-first-contact POLICY on top
 * of them.
 *
 * Channel trust: being in the Slack channel IS the authorization. The
 * Slack app is only installed into channels the bench owner chooses, so
 * anyone who can reach the bot was let in by a workspace admin. Resolve
 * known authors normally; auto-provision a principal only for a true
 * first contact — the base resolver found no readable email (`no_email`,
 * covered by the synthetic-address fallback below) or no account at all
 * (`no_account`). Every other non-ok reason is declined rather than
 * auto-provisioned: `bot_author` and `restricted_author` (Slack guest /
 * shared-channel accounts) are not eligible identities at all;
 * `not_a_member` and `principal_inactive` mean a principal record already
 * exists and something about it was deliberately withheld or deactivated,
 * which a Slack mention must not silently override; `tenant_not_found`
 * and `lookup_failed` are infrastructure/config problems, not something
 * provisioning can fix. The role(s) named in `roleNames` must already
 * exist in the tenant — `provisionPrincipal` throws on an unknown one, so
 * callers pass roles only once boot has created them.
 */
import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { schema } from "@intx/db";
import {
  createPrincipalResolver,
  provisionPrincipal,
  type PrincipalResolution,
  type PrincipalResolver,
  type UnresolvedReason,
} from "corbits-tag/interchange";
import { getLogger } from "@intx/log";

const log = getLogger(["slack-tag", "principal-resolver"]);

const AUTO_PROVISIONABLE_REASONS: ReadonlySet<UnresolvedReason> = new Set([
  "no_email",
  "no_account",
]);

export function createAutoProvisionPrincipalResolver(
  db: DB["db"],
  tenantSlug: string,
  roleNames: readonly string[] = [],
): PrincipalResolver {
  const baseResolver = createPrincipalResolver({ db, tenantSlug });
  return async (author): Promise<PrincipalResolution> => {
    const resolution = await baseResolver(author);
    if (resolution.ok) return resolution;
    if (!AUTO_PROVISIONABLE_REASONS.has(resolution.reason)) return resolution;
    if (author === null) return resolution;

    const tenant = await db.query.tenant.findFirst({
      where: eq(schema.tenant.slug, tenantSlug),
    });
    if (tenant === undefined) return resolution;

    // No readable email (restricted profile or missing users:read.email
    // scope) must not lock a channel member out: fall back to a stable
    // synthetic address derived from the Slack user id.
    const email =
      author.email !== undefined && author.email.trim() !== ""
        ? author.email
        : `slack-${author.userId.toLowerCase()}@${tenantSlug}.localhost`;
    const name = author.userId;

    try {
      const principal = await provisionPrincipal(db, {
        tenantId: tenant.id,
        email,
        name,
        roles: roleNames,
      });
      log.info("Provisioned principal for {email} on first contact", { email });
      return { ok: true, principal };
    } catch (cause) {
      log.error("Auto-provision failed for {email}: {error}", {
        email,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return resolution;
    }
  };
}
