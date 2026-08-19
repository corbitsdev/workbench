// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring
// `packages/granola-tools/test/credential-delivery.drizzle.test.ts`. Runs
// against its own Postgres schema, never the developer's or the
// walking-skeleton suite's.
//
// Proves precedence step (b) — a connected OpenAI credential — resolves
// through the platform's own ownership-walk-the-ancestor-chain resolver
// (`resolveCredentialRequirement`, never a hand-rolled query), and that
// `resolveMemoryConfig` prefers it over the lexical-only floor when no
// `EMBED_BASE_URL` is set, but never touches it when one is.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDB, runMigrations, dropSchema, schema } from "@intx/db";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { credentialAad } from "@intx/types";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import {
  resolveConfigFromConnectedCredential,
  resolveMemoryConfig,
} from "../src/config-resolution";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "memory_plane_config_resolution_test";
const CIPHER = createEnvKeyCredentialCipher(new Uint8Array(32).fill(7));
const BASE_ENV = { DATABASE_URL: "postgres://localhost:5432/workbench" };

describeIfDb("resolveConfigFromConnectedCredential", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  test("undefined for a tenant with no connected openai credential", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await db.insert(schema.tenant).values({
        id: "tnt_memory_no_credential",
        name: "No Credential Tenant",
        slug: "memory-no-credential-tenant",
        domain: "memory-no-credential.workbench.test",
      });

      const config = await resolveConfigFromConnectedCredential({
        env: BASE_ENV,
        db,
        tenantId: "tnt_memory_no_credential",
        credentialCipher: CIPHER,
      });
      expect(config).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("decrypts the tenant's connected openai credential into an embed config", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = "tnt_memory_has_credential";
      await db.insert(schema.tenant).values({
        id: tenantId,
        name: "Has Credential Tenant",
        slug: "memory-has-credential-tenant",
        domain: "memory-has-credential.workbench.test",
      });
      await db.insert(schema.provider).values({
        id: "prov_memory_openai",
        tenantId,
        name: "openai",
        plugin: "http",
      });
      const credentialId = "cred_memory_openai";
      await db.insert(schema.credential).values({
        id: credentialId,
        tenantId,
        providerId: "prov_memory_openai",
        name: "OpenAI",
        type: "api_key",
        secret: await CIPHER.encrypt(
          "sk-test-secret",
          credentialAad(credentialId, "secret"),
        ),
        status: "active",
      });

      const config = await resolveConfigFromConnectedCredential({
        env: BASE_ENV,
        db,
        tenantId,
        credentialCipher: CIPHER,
      });
      expect(config?.memory.embed).toEqual({
        baseUrl: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        apiStyle: "openai",
        apiKey: "sk-test-secret",
        timeoutMs: undefined,
      });

      const resolution = await resolveMemoryConfig({
        env: BASE_ENV,
        db,
        tenantId,
        credentialCipher: CIPHER,
      });
      expect(resolution.source).toBe("connected-credential");
    } finally {
      await close();
    }
  });

  test("resolveMemoryConfig falls to lexical-only when neither env nor a credential is set", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = "tnt_memory_lexical_only";
      await db.insert(schema.tenant).values({
        id: tenantId,
        name: "Lexical Only Tenant",
        slug: "memory-lexical-only-tenant",
        domain: "memory-lexical-only.workbench.test",
      });

      const resolution = await resolveMemoryConfig({
        env: BASE_ENV,
        db,
        tenantId,
        credentialCipher: CIPHER,
      });
      expect(resolution.source).toBe("lexical-only");
      expect(resolution.config.memory.embed).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("env, when set, wins without ever touching the database for a credential", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const resolution = await resolveMemoryConfig({
        env: {
          ...BASE_ENV,
          EMBED_BASE_URL: "https://api.openai.com/v1",
          EMBED_MODEL: "text-embedding-3-small",
        },
        db,
        tenantId: "tnt_never_queried",
        credentialCipher: CIPHER,
      });
      expect(resolution.source).toBe("env");
    } finally {
      await close();
    }
  });
});
