#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Add or update LLM credentials through standard Interchange API routes.
 *
 * When both ANTHROPIC_API_KEY and OPENAI_COMPATIBLE_API_KEY are set the script
 * upserts both credentials in a single run — Anthropic first, then the
 * openai-compatible credential (e.g. opencode-zen for Myra).
 *
 * Requires the dev user to have owner/admin grants. Run seed:superadmin first.
 */

import { resolveTargetTenant } from "./_lib";

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
const GLOBAL_SLUG = env("GLOBAL_TENANT_SLUG", "abklabs");

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

/** Detect the google-genai credential used by SEO enrichment (tkww-pilot parity). */
export function detectGoogleAi(): {
  providerName: string;
  apiKey: string;
  baseURL: string;
  credentialName: string;
} | null {
  const apiKey =
    process.env["GOOGLE_GEMINI_API_KEY"] ?? process.env["GEMINI_API_KEY"];
  if (!apiKey) return null;

  return {
    providerName: "google-genai",
    apiKey,
    baseURL: "https://generativelanguage.googleapis.com",
    credentialName: process.env["GOOGLE_AI_CREDENTIAL_NAME"] ?? "google-ai",
  };
}

/** Detect the openai-compatible credential config independently of detectProvider(). */
function detectOpenaiCompatible(): {
  providerName: string;
  apiKey: string;
  baseURL: string;
  credentialName: string;
} | null {
  const apiKey =
    process.env["OPENAI_COMPATIBLE_API_KEY"] ?? process.env["LLM_API_KEY"];
  const baseURL =
    process.env["OPENAI_COMPATIBLE_BASE_URL"] ?? process.env["LLM_BASE_URL"];
  const credentialName =
    process.env["OPENAI_COMPATIBLE_CREDENTIAL_NAME"] ?? "opencode-zen";

  if (!apiKey) return null;

  return {
    providerName: "openai-compatible",
    apiKey,
    baseURL: baseURL ?? "https://api.openai.com/v1",
    credentialName,
  };
}

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

async function upsertCredential(
  tenantId: string,
  sessionCookies: CookieJar,
  config: {
    providerName: string;
    apiKey: string;
    baseURL?: string;
    credentialName: string;
  },
): Promise<void> {
  const { providerName, apiKey, baseURL, credentialName } = config;

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
  ).find((p) => p.name === providerName);

  if (!provider) {
    const providerMetadata = baseURL ? { baseURL } : {};
    const createProvider = await api(
      "POST",
      `/api/tenants/${tenantId}/providers`,
      {
        name: providerName,
        plugin: providerName,
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
      ).find((p) => p.name === providerName);
    }
  }

  if (!provider) {
    console.error(`[credential] Could not resolve provider ${providerName}`);
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
  ).find((c) => c.name === credentialName);

  log(`Credential name: "${credentialName}"`);
  log(`  provider: ${providerName}`);
  if (baseURL) log(`  base URL: ${baseURL}`);

  const credentialMetadata = baseURL ? { baseURL } : {};

  if (existingCredential) {
    const patch = await api(
      "PATCH",
      `/api/tenants/${tenantId}/credentials/${existingCredential.id}`,
      { secret: apiKey, metadata: credentialMetadata },
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
        name: credentialName,
        type: "api_key",
        secret: apiKey,
        scopes: ["chat"],
        metadata: credentialMetadata,
      },
      sessionCookies,
    );
    if (createCredential.status !== 201)
      fail("create credential", createCredential.status, createCredential.data);
    log(
      `Credential created (new): ${(createCredential.data as { id?: string }).id ?? credentialName}`,
    );
  }
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

  const target = await resolveTargetTenant({
    base: BASE,
    cookies: sessionCookies,
    argv: process.argv.slice(2),
    envVar: "WORKBENCH_SLUG",
    globalSlug: GLOBAL_SLUG,
  });
  const tenantId = target.tenantId;
  log(`Tenant: ${target.name} [${target.slug}] (${tenantId})`);

  // Primary provider (Anthropic, OpenAI, or openai-compatible depending on env vars).
  const detected = detectProvider();
  const primaryCredentialName =
    process.env["LLM_CREDENTIAL_NAME"] ??
    detected.credentialName ??
    "llm-credential";

  await upsertCredential(tenantId, sessionCookies, {
    ...detected,
    credentialName: primaryCredentialName,
  });

  // If ANTHROPIC_API_KEY drove the primary credential, also upsert the
  // openai-compatible credential (opencode-zen) when its key is present.
  if (detected.providerName === "anthropic") {
    const compat = detectOpenaiCompatible();
    if (compat) {
      log(""); // blank line for readability
      log("Also upserting openai-compatible credential...");
      await upsertCredential(tenantId, sessionCookies, compat);
    }
  }

  const googleAi = detectGoogleAi();
  if (googleAi) {
    log("");
    log("Also upserting google-genai credential for SEO enrichment...");
    await upsertCredential(tenantId, sessionCookies, googleAi);
  }
}
