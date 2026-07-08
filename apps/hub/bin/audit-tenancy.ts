#!/usr/bin/env bun

/**
 * Tenancy cutover inventory (Interchange HTTP + optional DATABASE_URL).
 *
 *   bun run audit-tenancy:staging
 *   bun run audit-tenancy:production
 *
 * Env: HUB_URL, SUPERADMIN_* or SESSION_TOKEN, GLOBAL_TENANT_SLUG,
 * optional TARGET_ROOT_SLUG (default: GLOBAL_TENANT_SLUG), DATABASE_URL.
 */

import postgres from "postgres";
import {
  api,
  env,
  makeFail,
  makeLogger,
  recommendTenancyCutover,
  signIn,
  type CookieJar,
  type TenancyAuditTenant,
} from "./_lib";
import { extractItems } from "./admin/menu";

const log = makeLogger("audit-tenancy");
const fail = makeFail("audit-tenancy");

const BASE =
  env("HUB_URL") ?? env("BETTER_AUTH_BASE_URL", "http://localhost:4000");
const EMAIL = env("SUPERADMIN_EMAIL", "alice@example.com");
const PASSWORD = env("SUPERADMIN_PASS", "password123");
const SESSION_TOKEN = process.env["SESSION_TOKEN"];
const CONFIGURED_GLOBAL_SLUG = env("GLOBAL_TENANT_SLUG", "abklabs");
const TARGET_ROOT_SLUG =
  process.env["TARGET_ROOT_SLUG"] ?? CONFIGURED_GLOBAL_SLUG;

async function listAllPages(
  base: string,
  path: string,
  cookies: CookieJar,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor: string | undefined;
  for (;;) {
    const sep = path.includes("?") ? "&" : "?";
    const url = cursor
      ? `${path}${sep}cursor=${encodeURIComponent(cursor)}`
      : path;
    const res = await api(base, "GET", url, undefined, cookies);
    if (res.status !== 200) break;
    const { items, nextCursor } = extractItems(res.data);
    out.push(...items);
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return out;
}

async function fetchTenant(
  base: string,
  tenantId: string,
  cookies: CookieJar,
): Promise<TenancyAuditTenant | null> {
  const res = await api(
    base,
    "GET",
    `/api/tenants/${tenantId}`,
    undefined,
    cookies,
  );
  if (res.status !== 200 || typeof res.data !== "object" || !res.data) {
    return null;
  }
  const row = res.data as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.slug !== "string") return null;
  return {
    id: row.id,
    slug: row.slug,
    name: typeof row.name === "string" ? row.name : row.slug,
    parentId:
      row.parentId === null || typeof row.parentId === "string"
        ? (row.parentId as string | null)
        : null,
  };
}

async function loadTenantsFromDb(
  databaseUrl: string,
): Promise<TenancyAuditTenant[]> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<
      { id: string; slug: string; name: string; parent_id: string | null }[]
    >`select id, slug, name, parent_id from tenant order by slug`;
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      parentId: r.parent_id,
    }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

type DbTenantRow = {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  parentSlug: string | null;
  principals: number;
  creds: number;
  providers: number;
  agents: number;
  workbenchWorkflows: number;
  artifacts: number;
};

async function loadDbInventory(databaseUrl: string): Promise<DbTenantRow[]> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<
      {
        id: string;
        slug: string;
        name: string;
        parent_id: string | null;
        parent_slug: string | null;
        principals: string;
        creds: string;
        providers: string;
        agents: string;
        wb_wf: string;
        artifacts: string;
      }[]
    >`
      select t.id, t.slug, t.name, t.parent_id,
        (select slug from tenant p where p.id = t.parent_id) as parent_slug,
        (select count(*)::text from principal pr where pr.tenant_id = t.id) as principals,
        (select count(*)::text from credential c where c.tenant_id = t.id and c.principal_id is null) as creds,
        (select count(*)::text from model_provider mp where mp.tenant_id = t.id) as providers,
        (select count(*)::text from agent a where a.tenant_id = t.id) as agents,
        (select count(*)::text from workbench_workflows w where w.tenant_id = t.id) as wb_wf,
        (select count(*)::text from artifact ar where ar.tenant_id = t.id) as artifacts
      from tenant t
      order by (t.parent_id is null) desc, t.slug
    `;
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      parentId: r.parent_id,
      parentSlug: r.parent_slug,
      principals: Number(r.principals),
      creds: Number(r.creds),
      providers: Number(r.providers),
      agents: Number(r.agents),
      workbenchWorkflows: Number(r.wb_wf),
      artifacts: Number(r.artifacts),
    }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const databaseUrl = process.env["DATABASE_URL"];
const dbOnly =
  process.env["AUDIT_TENANCY_DB_ONLY"] === "1" ||
  process.env["AUDIT_TENANCY_DB_ONLY"] === "true";

if (dbOnly) {
  if (!databaseUrl) fail("db-only", 0, "DATABASE_URL is required");
  log("DB-only mode (no hub HTTP)");
  log(`Hub (env): ${BASE}`);
  log(`GLOBAL_TENANT_SLUG (env): ${CONFIGURED_GLOBAL_SLUG}`);
  log(`TARGET_ROOT_SLUG: ${TARGET_ROOT_SLUG}`);
  const sqlMeta = postgres(databaseUrl, { max: 1 });
  try {
    const [meta] = await sqlMeta<
      { db: string; tenant_count: string }[]
    >`select current_database()::text as db, (select count(*)::text from tenant) as tenant_count`;
    log(
      `Postgres: database=${meta?.db ?? "?"} tenants=${meta?.tenant_count ?? "?"}`,
    );
  } finally {
    await sqlMeta.end({ timeout: 5 });
  }
  const rows = await loadDbInventory(databaseUrl);
  const tenants: TenancyAuditTenant[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    parentId: r.parentId,
  }));
  const weights = new Map<string, number>();
  for (const r of rows) {
    weights.set(
      r.id,
      r.creds + r.providers + r.agents + r.workbenchWorkflows + r.artifacts,
    );
    log(
      `${r.slug} id=${r.id} parent=${r.parentSlug ?? "null"}${r.parentId === null ? " [ROOT]" : ""} db=${JSON.stringify(
        {
          principals: r.principals,
          creds: r.creds,
          providers: r.providers,
          agents: r.agents,
          workbenchWorkflows: r.workbenchWorkflows,
          artifacts: r.artifacts,
        },
      )}`,
    );
  }
  const rec = recommendTenancyCutover(
    tenants,
    CONFIGURED_GLOBAL_SLUG,
    TARGET_ROOT_SLUG,
    (id) => weights.get(id) ?? 0,
  );
  log(`Strategy: ${rec.strategy}`);
  for (const w of rec.warnings) log(`WARN: ${w}`);
  for (const s of rec.steps) log(`STEP: ${s}`);
  process.exit(0);
}

const cookies = await signIn(BASE, EMAIL, PASSWORD, SESSION_TOKEN, log, fail);

const principalsRes = await api(
  BASE,
  "GET",
  "/api/me/principals",
  undefined,
  cookies,
);
if (principalsRes.status !== 200) {
  if (databaseUrl) {
    log(
      `Hub auth failed (${principalsRes.status}) — falling back to DB-only inventory`,
    );
    process.env["AUDIT_TENANCY_DB_ONLY"] = "1";
    const rows = await loadDbInventory(databaseUrl);
    const tenants: TenancyAuditTenant[] = rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      parentId: r.parentId,
    }));
    const weights = new Map<string, number>();
    for (const r of rows) {
      weights.set(
        r.id,
        r.creds + r.providers + r.agents + r.workbenchWorkflows + r.artifacts,
      );
      log(
        `${r.slug} id=${r.id} parent=${r.parentSlug ?? "null"}${r.parentId === null ? " [ROOT]" : ""} db=${JSON.stringify(
          {
            principals: r.principals,
            creds: r.creds,
            providers: r.providers,
            agents: r.agents,
            workbenchWorkflows: r.workbenchWorkflows,
            artifacts: r.artifacts,
          },
        )}`,
      );
    }
    const rec = recommendTenancyCutover(
      tenants,
      CONFIGURED_GLOBAL_SLUG,
      TARGET_ROOT_SLUG,
      (id) => weights.get(id) ?? 0,
    );
    log(`Strategy: ${rec.strategy}`);
    for (const w of rec.warnings) log(`WARN: ${w}`);
    for (const s of rec.steps) log(`STEP: ${s}`);
    process.exit(0);
  }
  fail("principals", principalsRes.status, principalsRes.data);
}

const tenantMap = new Map<string, TenancyAuditTenant>();

if (databaseUrl) {
  log("Loading tenant table from DATABASE_URL");
  for (const t of await loadTenantsFromDb(databaseUrl)) tenantMap.set(t.id, t);
} else {
  log("DATABASE_URL unset — tree may be incomplete (principal tenants only)");
}

const { items } = extractItems(principalsRes.data);
for (const item of items) {
  if (!item || typeof item !== "object") continue;
  const row = item as Record<string, unknown>;
  if (typeof row.tenantId !== "string" || typeof row.tenantSlug !== "string") {
    continue;
  }
  if (!tenantMap.has(row.tenantId)) {
    tenantMap.set(row.tenantId, {
      id: row.tenantId,
      slug: row.tenantSlug,
      name:
        typeof row.tenantName === "string" ? row.tenantName : row.tenantSlug,
      parentId: null,
    });
  }
}

const tenants = [...tenantMap.values()].sort((a, b) =>
  a.slug.localeCompare(b.slug),
);

const weights = new Map<string, number>();

log(`Hub: ${BASE}`);
log(`GLOBAL_TENANT_SLUG (env): ${CONFIGURED_GLOBAL_SLUG}`);
log(`TARGET_ROOT_SLUG: ${TARGET_ROOT_SLUG}`);

for (const t of tenants) {
  const detail = await fetchTenant(BASE, t.id, cookies);
  if (detail) {
    t.parentId = detail.parentId;
    t.name = detail.name;
    t.slug = detail.slug;
  }
  const counts: Record<string, number> = {};
  let dbExtra = "";
  if (detail) {
    const tid = t.id;
    counts.principals = (
      await listAllPages(BASE, `/api/tenants/${tid}/principals`, cookies)
    ).length;
    counts.credentialsOwned = (
      await listAllPages(
        BASE,
        `/api/tenants/${tid}/credentials?inherited=false`,
        cookies,
      )
    ).length;
    counts.catalogProvidersOwned = (
      await listAllPages(
        BASE,
        `/api/tenants/${tid}/catalog/providers?inherited=false`,
        cookies,
      )
    ).length;
    counts.agentDefinitions = (
      await listAllPages(
        BASE,
        `/api/tenants/${tid}/agents/definitions`,
        cookies,
      )
    ).length;
    counts.workflowDeployments = (
      await listAllPages(
        BASE,
        `/api/tenants/${tid}/workflows/instances`,
        cookies,
      )
    ).length;
    weights.set(
      tid,
      counts.credentialsOwned +
        counts.catalogProvidersOwned +
        counts.agentDefinitions +
        counts.workflowDeployments,
    );
  }
  if (databaseUrl) {
    const db = await dbWorkbenchCounts(databaseUrl, t.id);
    weights.set(
      t.id,
      (weights.get(t.id) ?? 0) + db.workbenchWorkflows + db.artifacts,
    );
    dbExtra = ` db=${JSON.stringify(db)}`;
  }
  log(
    `${t.slug} id=${t.id} parent=${t.parentId ?? "null"}${t.parentId === null ? " [ROOT]" : ""} api=${detail !== null} counts=${JSON.stringify(counts)}${dbExtra}`,
  );
}

const rec = recommendTenancyCutover(
  tenants,
  CONFIGURED_GLOBAL_SLUG,
  TARGET_ROOT_SLUG,
  (id) => weights.get(id) ?? 0,
);
log(`Strategy: ${rec.strategy}`);
for (const w of rec.warnings) log(`WARN: ${w}`);
for (const s of rec.steps) log(`STEP: ${s}`);
