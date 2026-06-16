#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Add a local LLM credential through standard Interchange API routes.
 *
 * Requires the dev user to have owner/admin grants. Run seed:superadmin first.
 */

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const BASE = env("HUB_URL", "http://localhost:4000");
const EMAIL = env("SUPERADMIN_EMAIL", "alice@example.com");
const PASSWORD = env("SUPERADMIN_PASS", "password123");
// SESSION_TOKEN: pass a better-auth session cookie value grabbed from the browser.
// Use this in production where email/password auth is disabled (OAuth-only).
// In DevTools: Application → Cookies → copy the value of the `better-auth.session_token` cookie.
const SESSION_TOKEN = process.env["SESSION_TOKEN"];
const TENANT_SLUG = env("GLOBAL_TENANT_SLUG", "abklabs");

// Auto-detect provider from well-known env vars if no explicit override is set.
// Priority: LLM_PROVIDER_NAME > ANTHROPIC_API_KEY > OPENAI_API_KEY > openai-compatible default.
// Model is NOT stored here — it belongs in each agent definition's modelConfig.
export function detectProvider(): {
  providerName: string;
  apiKey: string;
  baseURL?: string;
  credentialName?: string;
} {
  const explicit = process.env["LLM_PROVIDER_NAME"];

  if (
    explicit === "anthropic" ||
    (!explicit && process.env["ANTHROPIC_API_KEY"])
  ) {
    // baseURL must be set here too: resolveOneCredential reads the provider
    // row's metadata.baseURL, and ProviderMetadata requires it. Without it, an
    // anthropic provider created by this script (rather than seed-credentials)
    // resolves to provider_misconfigured and inference 404s.
    return {
      providerName: "anthropic",
      apiKey:
        process.env["ANTHROPIC_API_KEY"] ??
        process.env["LLM_API_KEY"] ??
        "sk-dummy",
      baseURL: "https://api.anthropic.com",
      credentialName:
        process.env["ANTHROPIC_CREDENTIAL_NAME"] ?? "anthropic-api",
    };
  }

  if (explicit === "openai" || (!explicit && process.env["OPENAI_API_KEY"])) {
    return {
      providerName: "openai",
      apiKey:
        process.env["OPENAI_API_KEY"] ??
        process.env["LLM_API_KEY"] ??
        "sk-dummy",
    };
  }

  // openai-compatible (explicit or fallback) — keep legacy OPENAI_COMPATIBLE_* var names working.
  // baseURL is required for openai-compatible since the endpoint varies per deployment.
  return {
    providerName: explicit ?? "openai-compatible",
    apiKey:
      process.env["OPENAI_COMPATIBLE_API_KEY"] ??
      process.env["LLM_API_KEY"] ??
      "sk-dummy-key-for-local-dev",
    baseURL:
      process.env["OPENAI_COMPATIBLE_BASE_URL"] ??
      process.env["LLM_BASE_URL"] ??
      "https://api.openai.com/v1",
  };
}

const detected = detectProvider();
const PROVIDER_NAME = detected.providerName;
const CREDENTIAL_NAME =
  process.env["LLM_CREDENTIAL_NAME"] ??
  detected.credentialName ??
  process.env["OPENAI_COMPATIBLE_CREDENTIAL_NAME"] ??
  "llm-credential";
const LLM_API_KEY = detected.apiKey;
const LLM_BASE_URL = detected.baseURL;

type CookieJar = string[];

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

  const nextCookies = [...cookies];
  for (const sc of res.headers.getSetCookie()) {
    const name = sc.split("=")[0];
    const value = sc.split(";")[0];
    if (!name || !value) continue;
    const idx = nextCookies.findIndex((c) => c.startsWith(`${name}=`));
    if (idx >= 0) nextCookies[idx] = value;
    else nextCookies.push(value);
  }

  let data: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("json"))
    data = await res.json();
  return { status: res.status, data, cookies: nextCookies };
}

function log(message: string) {
  console.log(`[credential] ${message}`);
}

function fail(label: string, status: number, data: unknown): never {
  console.error(`[credential] FAIL ${label}: ${status}`);
  console.error(`[credential]   ${JSON.stringify(data)}`);
  process.exit(1);
}

if (import.meta.main) {
  let sessionCookies: CookieJar;
  if (SESSION_TOKEN) {
    log("Using SESSION_TOKEN for authentication");
    // Production (HTTPS) uses the __Secure- prefix; include both so it works in both environments.
    sessionCookies = [
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
    sessionCookies = signIn.cookies;
  }

  const principalsRes = await api(
    "GET",
    "/api/me/principals",
    undefined,
    sessionCookies,
  );
  if (principalsRes.status !== 200)
    fail("/api/me/principals", principalsRes.status, principalsRes.data);

  const principals =
    (
      principalsRes.data as {
        data?: Array<{ tenantId: string; tenantSlug?: string }>;
      }
    ).data ?? [];
  const principal =
    principals.find((p) => p.tenantSlug === TENANT_SLUG) ?? principals[0];
  if (!principal) {
    console.error("[credential] No tenant principal found for signed-in user");
    process.exit(1);
  }
  const tenantId = principal.tenantId;
  log(`Tenant ID: ${tenantId}`);

  const providersRes = await api(
    "GET",
    `/api/tenants/${tenantId}/providers?inherited=true`,
    undefined,
    sessionCookies,
  );
  if (providersRes.status !== 200)
    fail("list providers", providersRes.status, providersRes.data);

  let provider = (
    (providersRes.data as { data?: Array<{ id: string; name: string }> })
      .data ?? []
  ).find((p) => p.name === PROVIDER_NAME);

  if (!provider) {
    const providerMetadata = LLM_BASE_URL ? { baseURL: LLM_BASE_URL } : {};
    const createProvider = await api(
      "POST",
      `/api/tenants/${tenantId}/providers`,
      {
        name: PROVIDER_NAME,
        plugin: PROVIDER_NAME,
        metadata: providerMetadata,
      },
      sessionCookies,
    );

    if (createProvider.status !== 201 && createProvider.status !== 409) {
      fail("create provider", createProvider.status, createProvider.data);
    }

    if (createProvider.status === 201) {
      provider = createProvider.data as { id: string; name: string };
    } else {
      const refreshed = await api(
        "GET",
        `/api/tenants/${tenantId}/providers?inherited=true`,
        undefined,
        sessionCookies,
      );
      provider = (
        (refreshed.data as { data?: Array<{ id: string; name: string }> })
          .data ?? []
      ).find((p) => p.name === PROVIDER_NAME);
    }
  }

  if (!provider) {
    console.error(`[credential] Could not resolve provider ${PROVIDER_NAME}`);
    process.exit(1);
  }
  log(`Provider: ${provider.name} (${provider.id})`);

  const listCredentials = await api(
    "GET",
    `/api/tenants/${tenantId}/credentials`,
    undefined,
    sessionCookies,
  );
  if (listCredentials.status !== 200)
    fail("list credentials", listCredentials.status, listCredentials.data);

  const existingCredential = (
    (listCredentials.data as { data?: Array<{ id: string; name: string }> })
      .data ?? []
  ).find((c) => c.name === CREDENTIAL_NAME);

  log(`Credential name: "${CREDENTIAL_NAME}"`);
  log(`  provider: ${PROVIDER_NAME}`);
  if (LLM_BASE_URL) log(`  base URL: ${LLM_BASE_URL}`);

  const credentialMetadata = LLM_BASE_URL ? { baseURL: LLM_BASE_URL } : {};

  if (existingCredential) {
    const patch = await api(
      "PATCH",
      `/api/tenants/${tenantId}/credentials/${existingCredential.id}`,
      { secret: LLM_API_KEY, metadata: credentialMetadata },
      sessionCookies,
    );
    if (patch.status !== 200)
      fail("patch credential", patch.status, patch.data);
    log(`Credential updated (existing): ${existingCredential.id}`);
  } else {
    const createCredential = await api(
      "POST",
      `/api/tenants/${tenantId}/credentials`,
      {
        providerId: provider.id,
        name: CREDENTIAL_NAME,
        type: "api_key",
        secret: LLM_API_KEY,
        scopes: ["chat"],
        metadata: credentialMetadata,
      },
      sessionCookies,
    );
    if (createCredential.status !== 201)
      fail("create credential", createCredential.status, createCredential.data);
    log(
      `Credential created (new): ${(createCredential.data as { id?: string }).id ?? CREDENTIAL_NAME}`,
    );
  }
}
