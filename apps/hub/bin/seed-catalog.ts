#!/usr/bin/env bun
/**
 * Idempotently seeds the Interchange model catalog (providers, models,
 * offerings) for a tenant by driving the native hub-api catalog routes.
 *
 * The catalog is derived from the agent definitions themselves (FULL_CATALOG
 * in @workbench/catalog): every model an agent declares, the provider that
 * authenticates its inference credential, and the offering linking them. Run on
 * the GLOBAL tenant so descendant workbenches inherit the offerings via the
 * catalog ancestor walk.
 *
 * NOTE: the Owner → Catalog key-set path also auto-seeds a single provider's
 * slice at credential-set time (`reconcileProviderCatalog`), and — unlike this
 * script's create-or-skip provider step — it *does* rebind an existing
 * `model_provider`'s credential. Keep the two reconcile semantics deliberately
 * distinct; do not "fix" this script to rebind and reintroduce a second path.
 *
 * Each provider's baseURL is read from its already-seeded credential's
 * metadata, so run AFTER seed-credentials. Providers/models are create-or-skip;
 * offerings are create-or-reconcile — an existing offering's priority is PATCHed
 * in place so a re-seed reorders the source head/tail without a destructive
 * delete. A changed provider baseURL/credential binding is still NOT reconciled
 * (it lives on the provider row) — delete + re-seed to change that. Fails loudly
 * and stops on the first unexpected status; a mid-run failure leaves a partial
 * catalog — re-run to complete.
 */

import { FULL_CATALOG } from "@workbench/catalog";
import { resolveTargetTenant } from "./_lib";

function env(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

const BASE = env("HUB_URL", "http://localhost:4000") as string;
const EMAIL = env("SUPERADMIN_EMAIL", "alice@example.com") as string;
const PASSWORD = env("SUPERADMIN_PASS", "password123") as string;
const GLOBAL_SLUG = env("GLOBAL_TENANT_SLUG", "abklabs") as string;
const SESSION_TOKEN = process.env["SESSION_TOKEN"];

export type CookieJar = string[];

export type CredentialRow = {
  id: string;
  name: string;
  metadata?: Record<string, unknown> | null;
};

type NamedRow = { id: string; name: string };

// Merge `Set-Cookie` response headers into an existing jar: replace a cookie by
// name if present, append otherwise. Pure so the find-or-append logic is tested.
export function mergeCookies(
  cookies: CookieJar,
  setCookies: readonly string[],
): CookieJar {
  const next = [...cookies];
  for (const sc of setCookies) {
    const name = sc.split("=")[0];
    const value = sc.split(";")[0];
    if (!name || !value) continue;
    const idx = next.findIndex((c) => c.startsWith(`${name}=`));
    if (idx >= 0) next[idx] = value;
    else next.push(value);
  }
  return next;
}

// Unwrap a `{ data: T[] }` list envelope, tolerating a null/missing/empty body.
export function listData<T>(data: unknown): T[] {
  if (data === null || typeof data !== "object") return [];
  return ((data as { data?: T[] }).data ?? []) as T[];
}

/**
 * Resolve a credential by name and pull the baseURL its provider runs on. The
 * catalog provider row carries baseURL as a first-class column, so we read it
 * from the credential metadata once at seed time. Throws (fail-loud) when the
 * credential is absent or carries no usable baseURL — the catalog cannot be
 * seeded without it.
 */
export function resolveCredentialBinding(
  credentials: readonly CredentialRow[],
  credentialName: string,
): { id: string; baseURL: string } {
  const cred = credentials.find((c) => c.name === credentialName);
  if (!cred) {
    throw new Error(
      `credential "${credentialName}" not found — run seed-credentials first`,
    );
  }
  const baseURL = (cred.metadata as { baseURL?: unknown } | null)?.baseURL;
  if (typeof baseURL !== "string" || baseURL.length === 0) {
    throw new Error(`credential "${credentialName}" has no metadata.baseURL`);
  }
  return { id: cred.id, baseURL };
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  cookies: CookieJar = [],
): Promise<{ status: number; data: unknown; cookies: CookieJar }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cookies.length > 0) headers["Cookie"] = cookies.join("; ");

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });

  const nextCookies = mergeCookies(cookies, res.headers.getSetCookie());

  let data: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("json"))
    data = await res.json();
  return { status: res.status, data, cookies: nextCookies };
}

function log(message: string) {
  console.log(`[seed-catalog] ${message}`);
}

function fail(label: string, status: number, data: unknown): never {
  console.error(`[seed-catalog] FAIL ${label}: ${status}`);
  console.error(`[seed-catalog]   ${JSON.stringify(data)}`);
  process.exit(1);
}

export async function seedCatalog(
  tenantId: string,
  cookies: CookieJar,
): Promise<void> {
  const credsRes = await api(
    "GET",
    `/api/tenants/${tenantId}/credentials`,
    undefined,
    cookies,
  );
  if (credsRes.status !== 200)
    fail("list credentials", credsRes.status, credsRes.data);
  const credentials = listData<CredentialRow>(credsRes.data);

  // Providers — create or skip, building name → id.
  const providerIdByName = new Map<string, string>();
  const provRes = await api(
    "GET",
    `/api/tenants/${tenantId}/catalog/providers`,
    undefined,
    cookies,
  );
  if (provRes.status !== 200)
    fail("list catalog providers", provRes.status, provRes.data);
  for (const existing of listData<NamedRow>(provRes.data)) {
    providerIdByName.set(existing.name, existing.id);
  }
  // Providers whose credential is not present in this tenant are skipped (and
  // their offerings below) rather than failing the whole seed — a tenant need
  // only carry credentials for the providers it actually uses.
  const skippedProviders = new Set<string>();
  for (const provider of FULL_CATALOG.providers) {
    if (providerIdByName.has(provider.name)) {
      log(`Provider exists: ${provider.name}`);
      continue;
    }
    if (!credentials.some((c) => c.name === provider.credentialName)) {
      skippedProviders.add(provider.name);
      log(
        `Skipping provider ${provider.name} — no '${provider.credentialName}' credential here`,
      );
      continue;
    }
    const cred = resolveCredentialBinding(credentials, provider.credentialName);
    const res = await api(
      "POST",
      `/api/tenants/${tenantId}/catalog/providers`,
      {
        name: provider.name,
        plugin: provider.plugin,
        baseURL: cred.baseURL,
        credentialId: cred.id,
      },
      cookies,
    );
    if (res.status !== 201)
      fail(`create provider (${provider.name})`, res.status, res.data);
    providerIdByName.set(provider.name, (res.data as { id: string }).id);
    log(`Created provider: ${provider.name} (${provider.plugin})`);
  }

  // Models — create or skip, building canonicalName → id.
  const modelIdByName = new Map<string, string>();
  const modelRes = await api(
    "GET",
    `/api/tenants/${tenantId}/catalog/models`,
    undefined,
    cookies,
  );
  if (modelRes.status !== 200)
    fail("list catalog models", modelRes.status, modelRes.data);
  for (const existing of listData<{ id: string; canonicalName: string }>(
    modelRes.data,
  )) {
    modelIdByName.set(existing.canonicalName, existing.id);
  }
  for (const model of FULL_CATALOG.models) {
    if (modelIdByName.has(model.canonicalName)) {
      log(`Model exists: ${model.canonicalName}`);
      continue;
    }
    const res = await api(
      "POST",
      `/api/tenants/${tenantId}/catalog/models`,
      { canonicalName: model.canonicalName },
      cookies,
    );
    if (res.status !== 201)
      fail(`create model (${model.canonicalName})`, res.status, res.data);
    modelIdByName.set(model.canonicalName, (res.data as { id: string }).id);
    log(`Created model: ${model.canonicalName}`);
  }

  // Offerings — create new, or reconcile the priority of an existing one. The
  // priority is what makes a source the head vs the failover tail, so a re-seed
  // over an already-seeded tenant (whose rows predate the priority scheme, all
  // at 0) MUST update it in place — otherwise the intended ordering silently
  // never takes effect. Keyed by (modelId, providerId).
  const offRes = await api(
    "GET",
    `/api/tenants/${tenantId}/catalog/offerings`,
    undefined,
    cookies,
  );
  if (offRes.status !== 200)
    fail("list catalog offerings", offRes.status, offRes.data);
  const existingOfferings = new Map(
    listData<{
      id: string;
      modelId: string;
      providerId: string;
      priority: number;
    }>(offRes.data).map((o) => [`${o.modelId} ${o.providerId}`, o]),
  );
  for (const offering of FULL_CATALOG.offerings) {
    if (skippedProviders.has(offering.provider)) {
      log(
        `Skipping offering ${offering.model} via ${offering.provider} — provider not seeded`,
      );
      continue;
    }
    const modelId = modelIdByName.get(offering.model);
    const providerId = providerIdByName.get(offering.provider);
    if (!modelId || !providerId) {
      fail(
        `resolve offering ${offering.model}/${offering.provider}`,
        500,
        "model or provider id missing after seed",
      );
    }
    const priority = offering.priority ?? 0;
    const existing = existingOfferings.get(`${modelId} ${providerId}`);
    if (existing) {
      if (existing.priority === priority) {
        log(`Offering exists: ${offering.model} via ${offering.provider}`);
        continue;
      }
      const res = await api(
        "PATCH",
        `/api/tenants/${tenantId}/catalog/offerings/${existing.id}`,
        { priority },
        cookies,
      );
      if (res.status !== 200)
        fail(
          `reprioritize offering (${offering.model}/${offering.provider})`,
          res.status,
          res.data,
        );
      log(
        `Reprioritized offering: ${offering.model} via ${offering.provider} → ${priority}`,
      );
      continue;
    }
    const res = await api(
      "POST",
      `/api/tenants/${tenantId}/catalog/offerings`,
      { modelId, providerId, priority },
      cookies,
    );
    if (res.status !== 201)
      fail(
        `create offering (${offering.model}/${offering.provider})`,
        res.status,
        res.data,
      );
    log(`Created offering: ${offering.model} via ${offering.provider}`);
  }
}

if (import.meta.main) {
  let cookies: CookieJar;
  if (SESSION_TOKEN) {
    log("Using SESSION_TOKEN for authentication");
    cookies = [
      `better-auth.session_token=${SESSION_TOKEN}`,
      `__Secure-better-auth.session_token=${SESSION_TOKEN}`,
    ];
  } else {
    const signIn = await api("POST", "/api/auth/sign-in/email", {
      email: EMAIL,
      password: PASSWORD,
    });
    if (signIn.cookies.length === 0)
      fail("sign in", signIn.status, signIn.data);
    cookies = signIn.cookies;
    log(`Signed in as ${EMAIL}`);
  }

  const target = await resolveTargetTenant({
    base: BASE,
    cookies,
    argv: process.argv.slice(2),
    envVar: "WORKBENCH_SLUG",
    globalSlug: GLOBAL_SLUG,
  });
  log(`Tenant: ${target.name} [${target.slug}] (${target.tenantId})`);

  try {
    await seedCatalog(target.tenantId, cookies);
  } catch (err) {
    fail("seed catalog", 500, err instanceof Error ? err.message : String(err));
  }
  log("Catalog seeded.");
}
