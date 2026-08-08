// Boot and provisioning helpers for the tenant-isolation suite. The
// suite talks to the hub exactly the way a client does — sign-up,
// tenant creation, and every read go through mounted routes — so a
// missing tenant filter shows up here as leaked data, not as a green
// run.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The minimal surface of the hub the suite needs: a fetch-shaped
 * request method. Structural on purpose — the suite stays decoupled
 * from the hub's own types and exercises it purely over HTTP.
 */
export type AppLike = {
  request(path: string, init?: RequestInit): Promise<Response>;
};

export type IsolationHub = {
  app: AppLike;
  /** Closes the database pool and removes the temp directories. */
  shutdown(): Promise<void>;
};

/**
 * The database the suite runs against. The suite never invents a
 * default: pointing it at a database is an explicit act, because it
 * creates real rows there.
 */
export function resolveDatabaseUrl(): string | undefined {
  return process.env["ISOLATION_DATABASE_URL"] ?? process.env["DATABASE_URL"];
}

/**
 * Seam to the repository's shared database bootstrap. The script owns
 * schema creation (platform migrations plus auth tables); this suite
 * only consumes it, so the two never drift. Expects
 * `scripts/db-setup.ts` to export `setupDatabase(databaseUrl)`.
 */
export async function prepareDatabase(databaseUrl: string): Promise<void> {
  const modulePath = new URL("../../scripts/db-setup.ts", import.meta.url).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(modulePath)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      "scripts/db-setup.ts is not importable. The isolation suite relies on it to create the platform schema before booting the hub.",
      { cause },
    );
  }
  const setup = mod["setupDatabase"];
  if (typeof setup !== "function") {
    throw new Error(
      "scripts/db-setup.ts must export setupDatabase(databaseUrl) for the isolation suite to prepare its database.",
    );
  }
  await (setup as (url: string) => Promise<void>)(databaseUrl);
}

/**
 * Boots a real hub against the given database. Imported dynamically so
 * merely loading this suite (for example under a repo-wide `bun test`
 * with no database configured) never requires the hub's dependency
 * tree.
 */
export async function bootIsolationHub(
  databaseUrl: string,
): Promise<IsolationHub> {
  const root = mkdtempSync(path.join(tmpdir(), "isolation-suite-"));
  const staticDir = path.join(root, "static");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "<html>shell</html>");
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir, { recursive: true });

  const hubModule = new URL("../../apps/hub/src/index.ts", import.meta.url)
    .href;
  const { createHub } = (await import(hubModule)) as {
    createHub(config: {
      databaseUrl: string;
      baseUrl: string;
      sessionSecret: string;
      hubDataDir: string;
      hubStaticDir: string;
      signupRateLimit: { windowSeconds: number; max: number };
      socialProviders: Record<string, unknown>;
    }): Promise<{ app: AppLike; close(): Promise<void> }>;
  };

  const hub = await createHub({
    databaseUrl,
    // app.request() builds requests against http://localhost, so the
    // configured origin must match for auth cookies to be issued.
    baseUrl: "http://localhost",
    sessionSecret: "insecure-isolation-suite-secret-0000",
    hubDataDir: dataDir,
    hubStaticDir: staticDir,
    signupRateLimit: { windowSeconds: 60, max: 5 },
    // No OAuth social sign-in is under test here; an empty map is the
    // same "none configured" state `readHubConfig` produces when no
    // provider's credential pair is set in the environment.
    socialProviders: {},
  });

  return {
    app: hub.app,
    shutdown: async () => {
      await hub.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function requireJson(
  response: Response,
  expected: number,
  what: string,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (response.status !== expected) {
    throw new Error(
      `${what}: expected ${expected}, got ${response.status}: ${text}`,
    );
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Signs up a fresh user through the platform's own auth surface and
 * returns the session cookie a browser would hold.
 */
export async function signUpUser(
  app: AppLike,
  email: string,
  name: string,
): Promise<string> {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name, password: "isolation-suite-pass" }),
  });
  if (!response.ok) {
    throw new Error(
      `sign-up for ${email} failed with ${response.status}: ${await response.text()}`,
    );
  }
  const cookies = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .filter((pair): pair is string => Boolean(pair));
  if (cookies.length === 0) {
    throw new Error(`sign-up for ${email} returned no session cookie`);
  }
  return cookies.join("; ");
}

/** One tenant with everything the sweep asserts on. */
export type ProvisionedTenant = {
  cookie: string;
  tenantId: string;
  principalId: string;
  grantId: string;
  credentialId: string;
  /**
   * Strings that must never appear in any response served to the other
   * tenant. Includes the stored secret: it must not surface anywhere,
   * least of all across a tenant boundary.
   */
  markers: string[];
};

/**
 * Creates a tenant through the native creation route, then seeds it
 * with a provider and a credential so its read surfaces have real rows
 * capable of leaking.
 */
export async function provisionTenant(
  app: AppLike,
  cookie: string,
  label: string,
  nonce: string,
): Promise<ProvisionedTenant> {
  const tag = `${label}-${nonce}`;

  const tenantJson = await requireJson(
    await app.request("/api/tenants", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: `Isolation ${tag}`,
        slug: `isolation-${tag}`,
      }),
    }),
    201,
    `create tenant ${tag}`,
  );
  const tenantId = tenantJson["id"] as string;

  const principalsJson = await requireJson(
    await app.request(`/api/tenants/${tenantId}/principals`, {
      headers: { cookie },
    }),
    200,
    `list principals in ${tag}`,
  );
  const principals = listItems(principalsJson);
  const principal = principals[0] as { id: string } | undefined;
  if (principals.length !== 1 || !principal) {
    throw new Error(
      `expected exactly the owner principal in ${tag}, got ${principals.length}`,
    );
  }

  const grantsJson = await requireJson(
    await app.request(`/api/tenants/${tenantId}/grants`, {
      headers: { cookie },
    }),
    200,
    `list grants in ${tag}`,
  );
  const grant = listItems(grantsJson)[0] as { id: string } | undefined;
  if (!grant) throw new Error(`expected system grants in ${tag}, found none`);

  const providerJson = await requireJson(
    await app.request(`/api/tenants/${tenantId}/providers`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: `provider-${tag}`, plugin: "noop" }),
    }),
    201,
    `create provider in ${tag}`,
  );

  const credentialName = `credential-${tag}`;
  const credentialSecret = `leak-canary-secret-${tag}`;
  const credentialJson = await requireJson(
    await app.request(`/api/tenants/${tenantId}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        providerId: providerJson["id"] as string,
        name: credentialName,
        type: "api_key",
        secret: credentialSecret,
      }),
    }),
    201,
    `create credential in ${tag}`,
  );

  return {
    cookie,
    tenantId,
    principalId: principal.id,
    grantId: grant.id,
    credentialId: credentialJson["id"] as string,
    markers: [
      principal.id,
      grant.id,
      credentialJson["id"] as string,
      providerJson["id"] as string,
      credentialName,
      credentialSecret,
    ],
  };
}

/** Accepts both bare-array and cursor-paginated list responses. */
export function listItems(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const data = (json as Record<string, unknown>)["data"];
  if (Array.isArray(data)) return data;
  throw new Error(`expected a list response, got: ${JSON.stringify(json)}`);
}
