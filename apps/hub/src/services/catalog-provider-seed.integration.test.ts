import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { and, eq } from "drizzle-orm";
import { resolveModelSources, schema as intxSchema } from "@intx/db";
import type { GrantRule } from "@intx/types/authz";

// The service pushes resolved sources to live sidecars through this native
// primitive after any catalog mutation. No sidecars exist under PGlite, so mock
// the push at the @intx boundary and record which tenant subtree it targeted —
// the DB writes below stay real.
const pushCalls: string[] = [];
mock.module("@intx/hub-sessions", () => ({
  pushSourceUpdatesSubtree: async (
    _db: unknown,
    _router: unknown,
    tenantId: string,
  ) => {
    pushCalls.push(tenantId);
    return { pushed: 0 };
  },
}));

import { schema } from "../db";
import type { HubDb } from "../db";
import {
  clearCatalogProvidersForCredentials,
  reconcileProviderCatalog,
} from "./catalog-provider-seed";

// Real-Postgres (PGlite) exercise of reconcileProviderCatalog across its true
// seams: it writes real model/model_provider/model_offering rows and the
// assertions read them back through the native resolveModelSources ->
// listVisibleOfferings path that actually gates Myra variant availability. The
// only thing mocked is the sidecar push.

const TENANT = "ten-root";
const CRED_ID = "cred-openrouter";
const BASE_URL = "https://openrouter.ai/api/v1";

const { model, modelProvider, modelOffering, tenant, credential, provider } =
  intxSchema;

let client: PGlite;
let db: HubDb;

const SEEDED_TABLES = [
  "model_offering",
  "model_provider",
  "model",
  "credential",
  "tenant",
];

const sidecarRouter = {} as never;

// resolveModelSources fail-closes the credential secret unless the caller's
// grants authorize `credential:{id}` / `use` (the same wildcard the tenant
// system principal holds in production). Without it the resolved source would
// be withheld as `credential_unauthorized`, so the apiKey assertions below
// exercise the real gate rather than a bypass.
const CREATOR_GRANTS: GrantRule[] = [
  {
    id: "grant-cred-use",
    resource: "credential:*",
    action: "use",
    effect: "allow",
    origin: "creator",
    conditions: null,
    expiresAt: null,
    roleId: null,
    principalId: null,
  },
];

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  // Disable FK triggers so we can seed a credential without a full provider
  // graph; CHECK constraints (e.g. model_provider's credential/wallet XOR) stay
  // enforced, which is what we want to exercise.
  await client.exec(`SET session_replication_role = 'replica';`);
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  pushCalls.length = 0;
  for (const table of SEEDED_TABLES) {
    await client.exec(`DELETE FROM ${table};`);
  }
  const now = new Date();
  await db.insert(tenant).values({
    id: TENANT,
    name: "root",
    slug: "root",
    domain: "root.localhost",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(credential).values({
    id: CRED_ID,
    tenantId: TENANT,
    providerId: "prov-openrouter",
    name: "OpenRouter",
    type: "api_key",
    secret: "sk-openrouter-secret",
    createdAt: now,
    updatedAt: now,
  });
});

describe("reconcileProviderCatalog over real Postgres", () => {
  test("seeds provider + model + offering and makes the model resolvable", async () => {
    const result = await reconcileProviderCatalog({
      db,
      sidecarRouter,
      tenantId: TENANT,
      providerName: "openrouter",
      credentialId: CRED_ID,
      baseURL: BASE_URL,
    });

    expect(result).not.toBeNull();
    expect(result?.providerSeeded).toBe(true);
    expect(result?.modelsCreated).toContain("kimi-k3");
    expect(result?.offeringsCreated).toContain("kimi-k3");

    const providerRow = await db.query.modelProvider.findFirst({
      where: and(
        eq(modelProvider.tenantId, TENANT),
        eq(modelProvider.name, "openrouter"),
      ),
    });
    expect(providerRow?.plugin).toBe("openai-compatible");
    expect(providerRow?.baseURL).toBe(BASE_URL);
    expect(providerRow?.credentialId).toBe(CRED_ID);

    const modelRow = await db.query.model.findFirst({
      where: and(
        eq(model.tenantId, TENANT),
        eq(model.canonicalName, "kimi-k3"),
      ),
    });
    expect(modelRow).toBeDefined();

    const offeringRow = await db.query.modelOffering.findFirst({
      where: and(
        eq(modelOffering.tenantId, TENANT),
        eq(modelOffering.providerId, providerRow!.id),
      ),
    });
    expect(offeringRow?.modelId).toBe(modelRow!.id);
    // 2 is kimi-k3's openrouter priority in CATALOG_OFFERINGS (openrouter is a
    // priority-2 direct source; see packages/catalog/src/offerings.ts).
    expect(offeringRow?.priority).toBe(2);

    const resolution = await resolveModelSources(db, TENANT, [{ model: "kimi-k3" }], CREATOR_GRANTS);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.sources[0]?.model).toBe("kimi-k3");
      expect(resolution.sources[0]?.baseURL).toBe(BASE_URL);
      expect(resolution.sources[0]?.apiKey).toBe("sk-openrouter-secret");
    }

    expect(pushCalls).toContain(TENANT);
  });

  test("is idempotent: a second call creates nothing new and does not throw", async () => {
    await reconcileProviderCatalog({
      db,
      sidecarRouter,
      tenantId: TENANT,
      providerName: "openrouter",
      credentialId: CRED_ID,
      baseURL: BASE_URL,
    });

    pushCalls.length = 0;
    const second = await reconcileProviderCatalog({
      db,
      sidecarRouter,
      tenantId: TENANT,
      providerName: "openrouter",
      credentialId: CRED_ID,
      baseURL: BASE_URL,
    });

    expect(second?.providerSeeded).toBe(false);
    expect(second?.credentialBound).toBe(false);
    expect(second?.modelsCreated).toEqual([]);
    expect(second?.offeringsCreated).toEqual([]);
    expect(second?.offeringsReprioritized).toEqual([]);

    const providers = await db.query.modelProvider.findMany({
      where: eq(modelProvider.tenantId, TENANT),
    });
    const offerings = await db.query.modelOffering.findMany({
      where: eq(modelOffering.tenantId, TENANT),
    });
    expect(providers).toHaveLength(1);
    expect(offerings).toHaveLength(1);
    // No mutation on the idempotent pass means no source re-push.
    expect(pushCalls).toEqual([]);
  });

  test("binds credentialId on a pre-existing provider row bound to the wrong credential", async () => {
    const now = new Date();
    const staleProviderId = "mpv-stale";
    await db.insert(modelProvider).values({
      id: staleProviderId,
      tenantId: TENANT,
      name: "openrouter",
      plugin: "openai-compatible",
      baseURL: "https://stale.example/v1",
      credentialId: "cred-wrong",
      createdAt: now,
      updatedAt: now,
    });

    const result = await reconcileProviderCatalog({
      db,
      sidecarRouter,
      tenantId: TENANT,
      providerName: "openrouter",
      credentialId: CRED_ID,
      baseURL: BASE_URL,
    });

    expect(result?.providerSeeded).toBe(false);
    expect(result?.credentialBound).toBe(true);

    const providerRow = await db.query.modelProvider.findFirst({
      where: eq(modelProvider.id, staleProviderId),
    });
    expect(providerRow?.credentialId).toBe(CRED_ID);
    expect(providerRow?.baseURL).toBe(BASE_URL);

    // With the credential rebound, the model now resolves against a real secret.
    const resolution = await resolveModelSources(db, TENANT, [{ model: "kimi-k3" }], CREATOR_GRANTS);
    expect(resolution.ok).toBe(true);
    expect(pushCalls).toContain(TENANT);
  });

  test("returns null and writes nothing for a tool-only provider", async () => {
    const result = await reconcileProviderCatalog({
      db,
      sidecarRouter,
      tenantId: TENANT,
      providerName: "granola",
      credentialId: CRED_ID,
      baseURL: "https://granola.example",
    });

    expect(result).toBeNull();
    const providers = await db.query.modelProvider.findMany({
      where: eq(modelProvider.tenantId, TENANT),
    });
    const models = await db.query.model.findMany({
      where: eq(model.tenantId, TENANT),
    });
    expect(providers).toHaveLength(0);
    expect(models).toHaveLength(0);
    expect(pushCalls).toEqual([]);
  });

  test("rebinds a wallet-authenticated provider row to the credential (nulls walletId)", async () => {
    const now = new Date();
    await db.insert(modelProvider).values({
      id: "mpv-wallet",
      tenantId: TENANT,
      name: "openrouter",
      plugin: "openai-compatible",
      baseURL: BASE_URL,
      walletId: "wlt-fake",
      createdAt: now,
      updatedAt: now,
    });

    const result = await reconcileProviderCatalog({
      db,
      sidecarRouter,
      tenantId: TENANT,
      providerName: "openrouter",
      credentialId: CRED_ID,
      baseURL: BASE_URL,
    });

    expect(result?.credentialBound).toBe(true);
    const row = await db.query.modelProvider.findFirst({
      where: eq(modelProvider.id, "mpv-wallet"),
    });
    // The model_provider credential/wallet XOR would be violated if walletId
    // were left set alongside the new credentialId.
    expect(row?.credentialId).toBe(CRED_ID);
    expect(row?.walletId).toBeNull();
  });
});

// A second Postgres WITHOUT the replica-role bypass, so FK restrict/cascade are
// live — this is the seam the DELETE-credential fix depends on: the auto-seeded
// model_provider.credentialId is an onDelete:"restrict" FK, so the catalog rows
// must be cleared before the credential can be deleted.
describe("clearCatalogProvidersForCredentials under real FK enforcement", () => {
  let fkClient: PGlite;
  let fkDb: HubDb;
  const T = "ten-fk";
  const PROV = "prv-fk";
  const CRED = "cred-fk";

  beforeAll(async () => {
    fkClient = new PGlite();
    const bootstrap = drizzle(fkClient, { schema });
    const { apply } = await pushSchema(schema, bootstrap as never);
    await apply();
    fkDb = bootstrap as unknown as HubDb;

    const now = new Date();
    await fkDb.insert(tenant).values({
      id: T,
      name: "fk",
      slug: "fk",
      domain: "fk.localhost",
      createdAt: now,
      updatedAt: now,
    });
    await fkDb.insert(provider).values({
      id: PROV,
      tenantId: T,
      name: "openrouter",
      plugin: "openai-compatible",
      createdAt: now,
      updatedAt: now,
    });
    await fkDb.insert(credential).values({
      id: CRED,
      tenantId: T,
      providerId: PROV,
      name: "OpenRouter",
      type: "api_key",
      secret: "sk-openrouter",
      createdAt: now,
      updatedAt: now,
    });
    await reconcileProviderCatalog({
      db: fkDb,
      sidecarRouter,
      tenantId: T,
      providerName: "openrouter",
      credentialId: CRED,
      baseURL: BASE_URL,
    });
  });

  afterAll(async () => {
    await fkClient?.close();
  });

  test("a naive credential delete is FK-blocked by the auto-seeded model_provider", async () => {
    await expect(
      (async () => {
        await fkDb.delete(credential).where(eq(credential.id, CRED));
      })(),
    ).rejects.toThrow();
  });

  test("clearing the catalog providers first lets the delete succeed and cascades offerings", async () => {
    const removed = await clearCatalogProvidersForCredentials(fkDb, T, [CRED]);
    expect(removed).toBe(1);

    const provs = await fkDb.query.modelProvider.findMany({
      where: eq(modelProvider.tenantId, T),
    });
    const offs = await fkDb.query.modelOffering.findMany({
      where: eq(modelOffering.tenantId, T),
    });
    expect(provs).toHaveLength(0);
    expect(offs).toHaveLength(0);

    await fkDb.delete(credential).where(eq(credential.id, CRED));
    const creds = await fkDb.query.credential.findMany({
      where: eq(credential.tenantId, T),
    });
    expect(creds).toHaveLength(0);
  });
});
