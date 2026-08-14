/**
 * Hub-side artifacts engine mount — the host's own analog of
 * `@corbits/dock`'s `mountArtifacts`.
 *
 * Same Postgres URL as the hub control plane, different schema: the package
 * owns `artifacts.*` (tables, migrations, ledger) and never writes the host
 * search_path. Hard FKs from `artifacts.artifact` into `public.tenant` /
 * `public.principal` require that shared URL — a separate database would
 * break those FKs.
 *
 * URL resolution: explicit `databaseUrl` option (tests/DI) → `DATABASE_URL`.
 * There is exactly one Postgres URL for this hub. When neither is set, the
 * mount is skipped (logged once, never thrown) — same optional contract as
 * the dock mount.
 *
 * This module lands the mount + factory only. Tenant-scoped HTTP
 * list/get/upload routes live in `@corbits/artifacts-hub` and are
 * registered from the hub composition root when the mount succeeds.
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
  /** Explicit database URL. Defaults to `process.env.DATABASE_URL`. */
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
  const databaseUrl = options.databaseUrl ?? process.env["DATABASE_URL"];
  if (!databaseUrl) {
    log.info("No DATABASE_URL — artifacts will not be persisted");
    return undefined;
  }

  const { db } = createArtifactDb(databaseUrl);
  await runArtifactMigrations(db);
  log.info(
    "Artifacts engine mounted — artifacts persist as versioned rows by kind",
  );
  return { db, contentStore: InlineContentStore };
}
