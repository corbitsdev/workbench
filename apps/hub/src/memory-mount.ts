/**
 * Hub-side memory plane mount — host analog of Scout dock's `mountKnowledge`
 * (`packages/agent-dock/src/knowledge.ts`). `@corbits/memory` (git pin) owns
 * the firm-memory plane + HTTP under `/api/tenants/:tenantId/memory/*`.
 *
 * Degrades cleanly when unconfigured: missing `KNOWLEDGE_DATABASE_URL` (or
 * embed env) means "no memory plane", logged once at boot, never thrown —
 * same optional-engine contract as the artifacts mount. When env is present,
 * boot fails loudly if create/load throws so a half-wired deploy is never
 * silent.
 *
 * This module lands the mount + factory only. Capture/ingestion glue is a
 * later ticket; agents that want firm memory ask the returned handle.
 *
 * Boundary casts (`as never`) match Scout: `@corbits/memory` ships against its
 * own Hono/authz type copies, and Hono env + ConditionRegistry are invariant
 * across package roots — cast only at the mount boundary.
 */
import type { Hono } from "hono";
import type { ConditionRegistry, GrantStore } from "@intx/authz";
import { getLogger } from "@intx/log";
import { createMemory, loadMemoryConfig, type Memory } from "@corbits/memory";

const log = getLogger(["hub", "memory-mount"]);

export type MountMemoryOptions = {
  /** Hub Hono app (routes register under tenant memory paths). */
  // Accept AppEnv without coupling this module to hub AppEnv.
  app: Hono;
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
  /**
   * When true (default), skip mount if `KNOWLEDGE_DATABASE_URL` is unset.
   * Tests can force a mount attempt by setting env + `optional: false`.
   */
  optional?: boolean;
};

export type MemoryMountHandle = {
  memory: Memory;
};

/**
 * Returns a memory handle when the plane is configured and mounted; `undefined`
 * when optional and env is absent.
 */
export function mountMemory(
  options: MountMemoryOptions,
): MemoryMountHandle | undefined {
  const optional = options.optional !== false;
  const knowledgeUrl = process.env["KNOWLEDGE_DATABASE_URL"];
  if (!knowledgeUrl) {
    if (optional) {
      log.info(
        "KNOWLEDGE_DATABASE_URL not set — memory plane will not be mounted",
      );
      return undefined;
    }
    throw new Error("KNOWLEDGE_DATABASE_URL is required to mount memory");
  }

  // loadMemoryConfig also requires EMBED_* — fail at boot when env is partial.
  const config = loadMemoryConfig();
  // Cast grant/condition/app at the package boundary — see module doc.
  const memory = createMemory({
    app: options.app as never,
    config,
    grantStore: options.grantStore as never,
    conditionRegistry: options.conditionRegistry as never,
  });

  log.info("Memory plane mounted at /api/tenants/:tenantId/memory/*");
  return { memory };
}
