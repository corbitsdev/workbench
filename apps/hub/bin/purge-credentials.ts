#!/usr/bin/env bun

/**
 * Bulk-delete credentials and their backing providers from a tenant.
 *
 * Lists all tenant-owned credentials and providers, prints a summary, then
 * deletes them after explicit confirmation. Skips inherited rows (they belong
 * to an ancestor tenant and cannot be deleted here).
 *
 * Usage:
 *   bun run apps/hub/bin/purge-credentials.ts --tenant <slug>
 *   bun run apps/hub/bin/purge-credentials.ts --tenant <slug> --yes
 *
 * Flags:
 *   --yes   skip the interactive confirm (for scripted runs)
 */

import { api, makeLogger, makeFail, resolveTargetTenant, signIn } from "./_lib";

const BASE = process.env["HUB_URL"] ?? "http://localhost:4000";
const EMAIL = process.env["SUPERADMIN_EMAIL"] ?? "alice@example.com";
const PASSWORD = process.env["SUPERADMIN_PASS"] ?? "password123";
const GLOBAL_SLUG = process.env["GLOBAL_TENANT_SLUG"] ?? "abklabs";
const SESSION_TOKEN = process.env["SESSION_TOKEN"];

const log = makeLogger("purge-credentials");
const fail = makeFail("purge-credentials");

type CredentialRow = { id: string; name: string; providerId?: string };
type ProviderRow = { id: string; name: string };

function parseRows<T>(data: unknown): T[] {
  const rows = (data as { data?: unknown }).data;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function parseFlags(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

export async function listCredentials(
  tenantId: string,
  cookies: string[],
): Promise<CredentialRow[]> {
  const res = await api(
    BASE,
    "GET",
    `/api/tenants/${tenantId}/credentials`,
    undefined,
    cookies,
  );
  if (res.status !== 200) fail("list credentials", res.status, res.data);
  return parseRows<CredentialRow>(res.data);
}

export async function listProviders(
  tenantId: string,
  cookies: string[],
): Promise<ProviderRow[]> {
  const res = await api(
    BASE,
    "GET",
    `/api/tenants/${tenantId}/providers?inherited=false`,
    undefined,
    cookies,
  );
  if (res.status !== 200) fail("list providers", res.status, res.data);
  return parseRows<ProviderRow>(res.data);
}

if (import.meta.main) {
  const flags = parseFlags(process.argv.slice(2));

  const cookies = await signIn(BASE, EMAIL, PASSWORD, SESSION_TOKEN, log, fail);

  const target = await resolveTargetTenant({
    base: BASE,
    cookies,
    argv: process.argv.slice(2),
    envVar: "WORKBENCH_SLUG",
    globalSlug: GLOBAL_SLUG,
  });
  log(`Tenant: ${target.name} [${target.slug}] (${target.tenantId})`);

  const credentials = await listCredentials(target.tenantId, cookies);
  const providers = await listProviders(target.tenantId, cookies);

  if (credentials.length === 0 && providers.length === 0) {
    log("No credentials or providers found on this tenant.");
    process.exit(0);
  }

  log(`${credentials.length} credential(s):`);
  for (const c of credentials) {
    log(`  ${c.id}  ${c.name}`);
  }
  log(`${providers.length} provider(s):`);
  for (const p of providers) {
    log(`  ${p.id}  ${p.name}`);
  }

  if (flags["yes"] !== "true") {
    const answer = prompt(
      `Delete ${credentials.length} credential(s) and ${providers.length} provider(s) from "${target.slug}"? Type the tenant slug to confirm:`,
    );
    if (answer !== target.slug) {
      log("Aborted (confirmation did not match).");
      process.exit(1);
    }
  }

  let deleted = 0;
  for (const cred of credentials) {
    const res = await api(
      BASE,
      "DELETE",
      `/api/tenants/${target.tenantId}/credentials/${cred.id}`,
      undefined,
      cookies,
    );
    if (res.status !== 204 && res.status !== 200) {
      log(
        `  FAILED credential ${cred.id} (${cred.name}): ${res.status} ${JSON.stringify(res.data)}`,
      );
      continue;
    }
    deleted++;
    log(`  Deleted credential: ${cred.name}`);
  }

  for (const prov of providers) {
    const res = await api(
      BASE,
      "DELETE",
      `/api/tenants/${target.tenantId}/providers/${prov.id}`,
      undefined,
      cookies,
    );
    if (res.status !== 204 && res.status !== 200) {
      log(
        `  FAILED provider ${prov.id} (${prov.name}): ${res.status} ${JSON.stringify(res.data)}`,
      );
      continue;
    }
    log(`  Deleted provider: ${prov.name}`);
  }

  log(
    `Done. Deleted ${deleted}/${credentials.length} credential(s) and providers.`,
  );
}
