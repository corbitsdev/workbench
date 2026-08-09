/**
 * Hub-side artifacts engine mount — the host's own analog of
 * `@corbits/dock`'s `mountArtifacts` (see Scout's
 * `packages/agent-dock/src/artifacts-store.ts`). `@corbits/artifacts`
 * (git pin) persists artifacts + immutable version history in Postgres;
 * its `artifact`/`artifact_version` tables carry hard FKs into the
 * host's own `public.tenant` / `public.principal` tables, so the engine
 * MUST point at the same Postgres cluster as this hub's control plane.
 *
 * Degrades cleanly when unconfigured: `ARTIFACTS_DATABASE_URL` unset
 * (and no explicit `databaseUrl` passed) means "no artifacts
 * persistence", logged once at boot, never thrown — same contract as
 * the dock mount.
 *
 * This module lands the mount + factory only. Tenant-scoped HTTP
 * list/search/read routes are intentionally not registered here yet —
 * Library still reads the asset-shim surface until those routes ship.
 */
import { getLogger } from "@intx/log";
import {
  createArtifactDb,
  runArtifactMigrations,
  type ArtifactDb,
} from "@corbits/artifacts";

const log = getLogger(["hub", "artifacts-mount"]);

export type MountArtifactsOptions = {
  /** Defaults to `process.env.ARTIFACTS_DATABASE_URL`. */
  databaseUrl?: string;
};

/**
 * Handle returned by a successful mount. The `db` is the engine's own
 * drizzle handle (the same shape dock's `mountArtifacts` exposes) so a
 * later routes module can build the persist/find/search/read surface on
 * top of it without re-deriving the connection.
 */
export type ArtifactsMountHandle = {
  db: ArtifactDb;
};

export async function mountArtifacts(
  options: MountArtifactsOptions = {},
): Promise<ArtifactsMountHandle | undefined> {
  const databaseUrl = options.databaseUrl ?? process.env["ARTIFACTS_DATABASE_URL"];
  if (!databaseUrl) {
    log.info(
      "ARTIFACTS_DATABASE_URL not set — artifacts will not be persisted",
    );
    return undefined;
  }

  const { db } = createArtifactDb(databaseUrl);
  await runArtifactMigrations(db);
  log.info("Artifacts engine mounted — artifacts persist as versioned rows by kind");
  return { db };
}
