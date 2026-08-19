/**
 * Hub-side memory plane mount — composition root only. Every product
 * decision (how a tenant's config resolves, how the plane builds lazily,
 * what the status route reports) lives in `@corbits/memory-plane`; this
 * module wires this hub's own `db`, `credentialCipher`, grant store, and
 * condition registry into it and nothing else.
 *
 * Always mounts: the actual `@corbits/memory` engine (DB pool,
 * migrations, embed client) only builds on the first real call, per
 * tenant precedence (env, then a connected OpenAI credential, then
 * unconfigured — see `@corbits/memory-plane`'s `resolveMemoryConfig`), so
 * a credential connected long after boot takes effect with no restart.
 * Every consumer of the returned handle (chat orchestrator, artifact
 * delivery, the workflow-memory store) already only calls `add`/`search`/
 * `list`, so the lazy `Memory` this hands them is a drop-in: it resolves
 * for real on first use and answers a clear 503 until it is configured.
 *
 * Boundary casts (`as never`) match Scout's `mountKnowledge`
 * (`packages/agent-dock/src/knowledge.ts`): `@corbits/memory` ships
 * against its own Hono/authz type copies, and Hono env + ConditionRegistry
 * are invariant across package roots — cast only at this mount boundary.
 */
import type { Hono } from "hono";
import type { ConditionRegistry, GrantStore } from "@intx/authz";
import type { CredentialCipher } from "@intx/types";
import type { DB } from "@intx/db";
import { createRequireGrant } from "@intx/hub-api";
import { registerMemoryRoutes, type Memory } from "@corbits/memory";
import {
  createLazyMemoryPlane,
  createMemoryStatusRoutes,
} from "@corbits/memory-plane";
import { getLogger } from "@intx/log";

const log = getLogger(["hub", "memory-mount"]);

export type MountMemoryOptions<E extends object = object> = {
  /** Hub Hono app (routes register under tenant memory paths). */
  app: Hono<E>;
  db: DB["db"];
  credentialCipher: CredentialCipher;
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
};

export type MemoryMountHandle = {
  /** Resolves its real engine lazily per tenant call. */
  memory: Memory;
};

export function mountMemory<E extends object = object>(
  options: MountMemoryOptions<E>,
): MemoryMountHandle {
  const plane = createLazyMemoryPlane({
    env: process.env,
    db: options.db,
    credentialCipher: options.credentialCipher,
    grantStore: options.grantStore,
    conditionRegistry: options.conditionRegistry,
  });
  const grants = {
    grantStore: options.grantStore,
    conditionRegistry: options.conditionRegistry,
  };
  const requireGrant = createRequireGrant(grants);

  registerMemoryRoutes(options.app as never, {
    memory: plane.memory,
    requireGrant: requireGrant as never,
    grants: grants as never,
  });
  options.app.route(
    "/api/tenants/:tenantId/memory",
    createMemoryStatusRoutes({
      plane,
      requireGrant: requireGrant as never,
    }) as never,
  );

  log.info(
    "Memory plane mount point registered at /api/tenants/:tenantId/memory/* " +
      "(builds lazily on first use)",
  );
  return { memory: plane.memory };
}
