/**
 * Hub-side artifacts engine mount — the host's own analog of
 * `@corbits/dock`'s `mountArtifacts`. `@corbits/artifacts` (git pin)
 * persists artifacts + immutable version history in Postgres; its
 * `artifact`/`artifact_version` tables carry hard FKs into the host's own
 * `public.tenant` / `public.principal` tables, so the engine MUST point at
 * the same Postgres cluster as this hub's control plane.
 *
 * Degrades cleanly when unconfigured: `ARTIFACTS_DATABASE_URL` unset
 * (and no explicit `databaseUrl` passed) means "no artifacts
 * persistence", logged once at boot, never thrown — same contract as
 * the dock mount.
 *
 * This module lands the mount + factory only. Tenant-scoped HTTP
 * list/get/upload routes live in `artifact-routes.ts` and are registered
 * from the hub composition root when the mount succeeds.
 */
import { getLogger } from "@intx/log";
import {
  createArtifactDb,
  InlineContentStore,
  runArtifactMigrations,
  type ArtifactDb,
  type ContentStore,
} from "@corbits/artifacts";

const log = getLogger(["hub", "artifacts-mount"]);

export type MountArtifactsOptions = {
  /** Defaults to `process.env.ARTIFACTS_DATABASE_URL`. */
  databaseUrl?: string;
};

/**
 * Handle returned by a successful mount. The `db` is the engine's own
 * drizzle handle; `contentStore` is the byte sink used by upload routes.
 */
export type ArtifactsMountHandle = {
  db: ArtifactDb;
  contentStore: ContentStore;
};

export async function mountArtifacts(
  options: MountArtifactsOptions = {},
): Promise<ArtifactsMountHandle | undefined> {
  const databaseUrl =
    options.databaseUrl ?? process.env["ARTIFACTS_DATABASE_URL"];
  if (!databaseUrl) {
    log.info(
      "ARTIFACTS_DATABASE_URL not set — artifacts will not be persisted",
    );
    return undefined;
  }

  const { db } = createArtifactDb(databaseUrl);
  await runArtifactMigrations(db);
  log.info(
    "Artifacts engine mounted — artifacts persist as versioned rows by kind",
  );
  return { db, contentStore: InlineContentStore };

}
