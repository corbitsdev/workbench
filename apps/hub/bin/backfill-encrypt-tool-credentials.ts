#!/usr/bin/env bun

/**
 * One-time backfill (CL-3446): encrypts existing plaintext `kind: "tool"`
 * credential secrets in place. No schema change — `credential.secret` stays
 * `text`; a row that already carries a `v1:` envelope is left untouched, so
 * this is safe to re-run (idempotent).
 *
 * Scope: only credentials whose provider is a `kind: "tool"` entry in
 * `CREDENTIAL_PROVIDER_CATALOG` (packages/workbench-shared/src/governance.ts)
 * are touched. `kind: "inference"` rows are never encrypted — Interchange
 * reads `credential.secret` raw at agent-launch time.
 *
 *   bun run apps/hub/bin/backfill-encrypt-tool-credentials.ts [--tenant <slug>] [--dry-run]
 *
 * Requires DATABASE_URL and CREDENTIAL_ENCRYPTION_KEY. Without --tenant,
 * scans every tenant.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { CREDENTIAL_PROVIDER_CATALOG } from "@workbench/shared";
import {
  encryptSecret,
  isEncryptedEnvelope,
} from "../src/lib/credential-crypto";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tenantSlugIdx = args.indexOf("--tenant");
const tenantSlug = tenantSlugIdx >= 0 ? args[tenantSlugIdx + 1] : undefined;

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("[backfill-encrypt-tool-credentials] DATABASE_URL is required");
  process.exit(1);
}

const TOOL_PROVIDER_NAMES = new Set(
  CREDENTIAL_PROVIDER_CATALOG.filter((e) => e.kind === "tool").map(
    (e) => e.providerName,
  ),
);

const sql = postgres(databaseUrl);
const db = drizzle(sql, { schema: intxSchema });

async function main(): Promise<void> {
  let tenantId: string | undefined;
  if (tenantSlug) {
    const tenant = await db.query.tenant.findFirst({
      where: eq(intxSchema.tenant.slug, tenantSlug),
    });
    if (!tenant) {
      console.error(
        `[backfill-encrypt-tool-credentials] Unknown tenant slug: ${tenantSlug}`,
      );
      process.exit(1);
    }
    tenantId = tenant.id;
    console.log(
      `[backfill-encrypt-tool-credentials] Tenant ${tenant.slug} (${tenant.id})`,
    );
  } else {
    console.log("[backfill-encrypt-tool-credentials] Scanning every tenant");
  }

  const providerRows = tenantId
    ? await db.query.provider.findMany({
        where: eq(intxSchema.provider.tenantId, tenantId),
      })
    : await db.query.provider.findMany();
  const toolProviderIds = new Set(
    providerRows
      .filter((p) => TOOL_PROVIDER_NAMES.has(p.name))
      .map((p) => p.id),
  );

  if (toolProviderIds.size === 0) {
    console.log(
      "[backfill-encrypt-tool-credentials] No tool-kind provider rows found — nothing to do",
    );
    await sql.end();
    return;
  }

  const credentialRows = await db.query.credential.findMany();
  const candidates = credentialRows.filter((c) =>
    toolProviderIds.has(c.providerId),
  );

  let encrypted = 0;
  let alreadyEncrypted = 0;
  for (const row of candidates) {
    if (isEncryptedEnvelope(row.secret)) {
      alreadyEncrypted++;
      continue;
    }
    console.log(
      `[backfill-encrypt-tool-credentials] ${dryRun ? "[dry-run] would encrypt" : "Encrypting"} credential ${row.id} (${row.name})`,
    );
    if (!dryRun) {
      await db
        .update(intxSchema.credential)
        .set({ secret: encryptSecret(row.secret) })
        .where(eq(intxSchema.credential.id, row.id));
    }
    encrypted++;
  }

  console.log(
    `[backfill-encrypt-tool-credentials] Done. ${encrypted} encrypted, ${alreadyEncrypted} already encrypted, ${candidates.length} tool-kind rows scanned.`,
  );
  await sql.end();
}

main().catch((err) => {
  console.error("[backfill-encrypt-tool-credentials] Failed:", err);
  process.exit(1);
});
