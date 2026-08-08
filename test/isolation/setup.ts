// Boot and provisioning helpers for the tenant-isolation suite. The
// suite talks to the hub exactly the way a client does — sign-up,
// tenant creation, and every read go through mounted routes — so a
// missing tenant filter shows up here as leaked data, not as a green
// run.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  freePort,
  provisionSidecar,
  startHub,
  startSidecar,
  type HubHandle,
  type SpawnedApp,
} from "../../scripts/e2e/harness.ts";

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
 * The hub's sign-up rate limit as configured for every suite that
 * boots through `bootIsolationHub`. Exported so a suite asserting on
 * the limit itself (`apps/hub/test/rate-limit.test.ts`) never
 * hardcodes a second copy of these numbers that could silently drift
 * from what actually gets booted.
 */
export const ISOLATION_SIGNUP_RATE_LIMIT_MAX = 5;
export const ISOLATION_SIGNUP_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * The database the suite runs against. The suite never invents a
 * default: pointing it at a database is an explicit act, because it
 * creates real rows there. Locally, an unconfigured database skips the
 * suite (a fresh checkout still runs the unit gates); E2E_REQUIRED=1
 * turns that same gap into a hard failure, mirroring
 * scripts/e2e/harness.ts's e2eDatabaseUrl — this suite guards
 * multi-tenant authorization, so it must never vanish from CI silently.
 */
export function resolveDatabaseUrl(): string | undefined {
  const isolationUrl = process.env["ISOLATION_DATABASE_URL"];
  const url =
    isolationUrl !== undefined && isolationUrl !== ""
      ? isolationUrl
      : process.env["DATABASE_URL"];
  if (url !== undefined && url !== "") return url;
  if (process.env["E2E_REQUIRED"] === "1") {
    throw new Error(
      "E2E_REQUIRED=1 but no database is configured for the isolation " +
        "suite; set DATABASE_URL or ISOLATION_DATABASE_URL to a reachable " +
        "Postgres.",
    );
  }
  return undefined;
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
 * Boots the real hub and a real sidecar as spawned processes, exactly
 * as `scripts/e2e/harness.ts` does for the walking skeleton — a
 * chat-channel create launches a real agent instance over the
 * sidecar's WebSocket dial-in, so an in-process hub with no sidecar
 * attached cannot exercise the "chat channel move" block below; it
 * would fail every one of those cases with "no sidecar available"
 * rather than proving isolation. `AppLike.request` wraps `fetch`
 * against the hub's real port, matching how a client actually reaches
 * it.
 */
export async function bootIsolationHub(
  databaseUrl: string,
): Promise<IsolationHub> {
  const root = mkdtempSync(path.join(tmpdir(), "isolation-suite-"));
  const hubDataDir = path.join(root, "hub-data");
  const sidecarDataDir = path.join(root, "sidecar-data");

  // Unique per run: the `sidecar` table's id is a primary key, and a
  // prior run's row is never cleaned up (the isolation suite runs
  // against a shared database, never a scratch one it owns outright).
  const sidecarId = `sidecar-isolation-suite-${crypto.randomUUID()}`;
  const sidecarToken = crypto.randomUUID();
  await provisionSidecar(databaseUrl, sidecarId, sidecarToken);

  const hub: HubHandle = await startHub({
    databaseUrl,
    port: freePort(),
    sessionSecret: "insecure-isolation-suite-secret-0000",
    dataDir: hubDataDir,
    extraEnv: {
      SIGNUP_RATE_LIMIT_MAX: String(ISOLATION_SIGNUP_RATE_LIMIT_MAX),
      SIGNUP_RATE_LIMIT_WINDOW_SECONDS: String(
        ISOLATION_SIGNUP_RATE_LIMIT_WINDOW_SECONDS,
      ),
    },
  });

  const sidecar: SpawnedApp = startSidecar({
    hubPort: Number(new URL(hub.baseUrl).port),
    sidecarId,
    token: sidecarToken,
    dataDir: sidecarDataDir,
  });

  const app: AppLike = {
    request: (requestPath, init) => fetch(`${hub.baseUrl}${requestPath}`, init),
  };

  await waitForSidecarDialIn(app, sidecar);

  return {
    app,
    shutdown: async () => {
      await sidecar.stop();
      await hub.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A channel-launching route has no "not yet connected" contract the
 * way the native workflow-deploy route does (which answers 502 while
 * the sidecar's dial-in is in flight, see `scripts/e2e/harness.ts`) —
 * it fails outright. So this probes readiness itself: sign up a
 * throwaway account, create a throwaway tenant, and retry a channel
 * create until it succeeds or the sidecar visibly died or too much
 * time passed. The probe tenant is left behind, same as every other
 * tenant this suite mints — it is not the database under test's
 * concern to stay clean.
 */
async function waitForSidecarDialIn(
  app: AppLike,
  sidecar: SpawnedApp,
): Promise<void> {
  const cookie = await signUpUser(
    app,
    `sidecar-probe-${crypto.randomUUID()}@isolation.test`,
    "Sidecar Probe",
  );
  const tenantResponse = await app.request("/api/tenants", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name: "Sidecar Probe",
      slug: `sidecar-probe-${crypto.randomUUID().slice(0, 8)}`,
    }),
  });
  if (tenantResponse.status !== 201) {
    throw new Error(
      `sidecar readiness probe: tenant creation failed with ` +
        `${tenantResponse.status}: ${await tenantResponse.text()}`,
    );
  }
  const tenant = (await tenantResponse.json()) as { id: string };

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (sidecar.exited()) {
      throw new Error(
        `sidecar exited before dialing in; output:\n${sidecar.output()}`,
      );
    }
    const channelResponse = await app.request(
      `/api/tenants/${tenant.id}/chat/channels`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ kind: "channel", name: "sidecar-probe" }),
      },
    );
    if (channelResponse.status === 201) return;
    if (Date.now() > deadline) {
      throw new Error(
        `sidecar never dialed in within 30s (channel create kept ` +
          `failing with ${channelResponse.status}): ` +
          `${await channelResponse.text()}\nsidecar output:\n${sidecar.output()}`,
      );
    }
    await Bun.sleep(500);
  }
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
