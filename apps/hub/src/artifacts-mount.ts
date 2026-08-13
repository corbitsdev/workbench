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
 * URL resolution order: explicit `databaseUrl` option →
 * `ARTIFACTS_DATABASE_URL` → `DATABASE_URL`. Prefer the control-plane URL
 * (default). `ARTIFACTS_DATABASE_URL` is only an override when you must pin
 * the same cluster under a different env name — not a second database.
 * When none of the three is set, the mount is skipped (logged once, never
 * thrown) — same optional contract as the dock mount.
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
  /**
   * Explicit database URL. When omitted, falls back to
   * `ARTIFACTS_DATABASE_URL`, then `DATABASE_URL`.
   */
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
    options.databaseUrl ??
    process.env["ARTIFACTS_DATABASE_URL"] ??
    process.env["DATABASE_URL"];
  if (!databaseUrl) {
    log.info(
      "No ARTIFACTS_DATABASE_URL or DATABASE_URL — artifacts will not be persisted",
    );
    return undefined;
  }

  const source =
    options.databaseUrl !== undefined
      ? "options.databaseUrl"
      : process.env["ARTIFACTS_DATABASE_URL"] !== undefined
        ? "ARTIFACTS_DATABASE_URL"
        : "DATABASE_URL";

  const { db } = createArtifactDb(databaseUrl);
  await runArtifactMigrations(db);
  log.info(
    `Artifacts engine mounted (${source}) — artifacts persist as versioned rows by kind`,
  );
  return { db, contentStore: InlineContentStore };
}
