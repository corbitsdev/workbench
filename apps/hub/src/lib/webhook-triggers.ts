import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { WebhookTrigger } from "@workbench/shared";
import type { HubDb } from "../db";
import { workflowTrigger, type WorkflowTriggerRow } from "../db/schema";

// Store for the workflow_trigger table (CL-3300): owner-scoped CRUD for the
// /me/webhook-triggers management routes, plus the lookup + secret-compare +
// fire-bookkeeping the public firing route needs. Every management write is
// scoped by owner principal so one member can never address another's row;
// the firing route looks a row up by id alone (it has no session) and relies
// on the per-trigger secret for authorization instead.

const SECRET_BYTES = 32;

export function generateTriggerSecret(): string {
  return randomBytes(SECRET_BYTES).toString("hex");
}

function hashTriggerSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

// Constant-time compare against the stored hash, so a timing side-channel
// cannot leak how many hash bytes matched. A length mismatch (which
// `timingSafeEqual` would throw on) is treated as a non-match.
export function secretMatchesHash(secret: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashTriggerSecret(secret), "hex");
  const expected = Buffer.from(storedHash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function toApiWebhookTrigger(row: WorkflowTriggerRow): WebhookTrigger {
  return {
    id: row.id,
    workflowKind: row.workflowKind,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
  };
}

export async function listOwnerWebhookTriggers(
  db: HubDb,
  tenantId: string,
  ownerPrincipalId: string,
): Promise<WorkflowTriggerRow[]> {
  return db.query.workflowTrigger.findMany({
    where: and(
      eq(workflowTrigger.tenantId, tenantId),
      eq(workflowTrigger.ownerMemberPrincipalId, ownerPrincipalId),
    ),
  });
}

// Creates a trigger and returns both the row and the plaintext secret. The
// caller (the route) must hand the plaintext back exactly once and never
// persist it — only `secretHash` is stored.
export async function createOwnerWebhookTrigger(
  db: HubDb,
  args: { tenantId: string; ownerPrincipalId: string; kind: string },
): Promise<{ row: WorkflowTriggerRow; secret: string }> {
  const secret = generateTriggerSecret();
  const [inserted] = await db
    .insert(workflowTrigger)
    .values({
      tenantId: args.tenantId,
      ownerMemberPrincipalId: args.ownerPrincipalId,
      workflowKind: args.kind,
      secretHash: hashTriggerSecret(secret),
    })
    .returning();
  if (!inserted) {
    throw new Error("workflow_trigger insert returned no row");
  }
  return { row: inserted, secret };
}

// Owner-scoped delete. Returns false when no row matched the (tenant, owner,
// id) triple, so deleting another member's trigger is a no-op 404.
export async function deleteOwnerWebhookTrigger(
  db: HubDb,
  args: { tenantId: string; ownerPrincipalId: string; id: string },
): Promise<boolean> {
  const deleted = await db
    .delete(workflowTrigger)
    .where(
      and(
        eq(workflowTrigger.id, args.id),
        eq(workflowTrigger.tenantId, args.tenantId),
        eq(workflowTrigger.ownerMemberPrincipalId, args.ownerPrincipalId),
      ),
    )
    .returning({ id: workflowTrigger.id });
  return deleted.length > 0;
}

// Unscoped lookup by id for the firing route, which authenticates the
// request by the per-trigger secret rather than a session/owner scope.
export async function findWebhookTriggerById(
  db: HubDb,
  id: string,
): Promise<WorkflowTriggerRow | null> {
  const row = await db.query.workflowTrigger.findFirst({
    where: eq(workflowTrigger.id, id),
  });
  return row ?? null;
}

export async function markWebhookTriggerFired(
  db: HubDb,
  id: string,
): Promise<void> {
  await db
    .update(workflowTrigger)
    .set({ lastFiredAt: new Date() })
    .where(eq(workflowTrigger.id, id));
}
