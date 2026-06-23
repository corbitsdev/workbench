#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Permanently delete a tenant and all its data.
 *
 * This operation is IRREVERSIBLE. All principals, credentials, providers,
 * agents, instances, sessions, grants, and roles belonging to the tenant
 * cascade-delete from the database. There is no recovery path.
 *
 * Requires a direct DATABASE_URL connection — there is no HTTP endpoint for
 * tenant deletion in Interchange.
 *
 * Usage:
 *   DATABASE_URL=... bun run apps/hub/bin/delete-tenant.ts --tenant <slug>
 *
 * The script will ask for TWO confirmations before proceeding:
 *   1. Type "DELETE" to confirm you understand this is irreversible.
 *   2. Type the exact tenant slug to confirm the correct target.
 */

import postgres from "postgres";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[delete-tenant] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function log(message: string) {
  console.log(`[delete-tenant] ${message}`);
}

function readFlag(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === flag) return argv[i + 1];
    if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

const slug = readFlag(process.argv.slice(2), "--tenant");
if (!slug) {
  console.error("[delete-tenant] --tenant <slug> is required");
  process.exit(1);
}

const databaseUrl = requireEnv("DATABASE_URL");
const sql = postgres(databaseUrl, { max: 1 });

try {
  const [row] = await sql<{ id: string; name: string; slug: string }[]>`
    select id, name, slug from tenant where slug = ${slug} limit 1
  `;

  if (!row) {
    console.error(`[delete-tenant] No tenant found with slug "${slug}"`);
    process.exit(1);
  }

  log(`Target tenant:`);
  log(`  ID:   ${row.id}`);
  log(`  Name: ${row.name}`);
  log(`  Slug: ${row.slug}`);
  log("");
  log(
    "WARNING: This will permanently delete the tenant and ALL associated data:",
  );
  log(
    "  principals, credentials, providers, agents, instances, sessions, grants, roles.",
  );
  log("There is no recovery path.");
  log("");

  const first = prompt('Type "DELETE" to confirm this is irreversible:');
  if (first !== "DELETE") {
    log("Aborted.");
    process.exit(1);
  }

  const second = prompt(
    `Type the tenant slug "${row.slug}" to confirm the target:`,
  );
  if (second !== row.slug) {
    log("Aborted (slug did not match).");
    process.exit(1);
  }

  log(`Deleting tenant ${row.id} (${row.slug})…`);

  const deleted = await sql<{ id: string }[]>`
    delete from tenant where id = ${row.id} returning id
  `;

  if (deleted.length === 0) {
    console.error(
      "[delete-tenant] Delete returned no rows — tenant may have already been deleted.",
    );
    process.exit(1);
  }

  log(`Done. Tenant ${row.slug} (${row.id}) has been permanently deleted.`);
} finally {
  await sql.end();
}
