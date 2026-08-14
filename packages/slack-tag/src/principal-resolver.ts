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
 * known authors normally; auto-provision a principal on first contact
 * instead of turning humans away. Bots stay excluded, and resolver
 * infrastructure errors still fail. The role(s) named in `roleNames`
 * must already exist in the tenant — `provisionPrincipal` throws on an
 * unknown one, so callers pass roles only once boot has created them.
 */
import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { schema } from "@intx/db";
import {
  createPrincipalResolver,
  provisionPrincipal,
  type PrincipalResolution,
  type PrincipalResolver,
} from "corbits-tag/interchange";
import { getLogger } from "@intx/log";

const log = getLogger(["slack-tag", "principal-resolver"]);

export function createAutoProvisionPrincipalResolver(
  db: DB["db"],
  tenantSlug: string,
  roleNames: readonly string[] = [],
): PrincipalResolver {
  const baseResolver = createPrincipalResolver({ db, tenantSlug });
  return async (author): Promise<PrincipalResolution> => {
    const resolution = await baseResolver(author);
    if (resolution.ok) return resolution;
    if (resolution.reason === "bot_author") return resolution;
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
