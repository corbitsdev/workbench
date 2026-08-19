import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDB, runMigrations, dropSchema, schema } from "@intx/db";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { credentialAad } from "@intx/types";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import {
  resolveConfigFromConnectedCredential,
  resolveConfigFromEnv,
  resolveConfigLexicalOnly,
  resolveMemoryConfig,
} from "./memory-config";

const BASE_ENV = { DATABASE_URL: "postgres://localhost:5432/workbench" };

describe("resolveConfigFromEnv", () => {
  test("returns undefined when EMBED_BASE_URL is unset — the next step gets a turn", () => {
    expect(resolveConfigFromEnv(BASE_ENV)).toBeUndefined();
  });

  test("returns undefined when EMBED_BASE_URL is blank", () => {
    expect(
      resolveConfigFromEnv({ ...BASE_ENV, EMBED_BASE_URL: "" }),
    ).toBeUndefined();
  });

  test("builds an embed config when EMBED_BASE_URL and EMBED_MODEL are both set", () => {
    const config = resolveConfigFromEnv({
      ...BASE_ENV,
      EMBED_BASE_URL: "https://api.openai.com/v1",
      EMBED_MODEL: "text-embedding-3-small",
      EMBED_API_KEY: "sk-test",
    });
    expect(config?.memory.embed).toEqual({
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      apiStyle: "openai",
      apiKey: "sk-test",
      timeoutMs: undefined,
    });
  });

  test("throws when EMBED_BASE_URL is set but EMBED_MODEL is missing — a real operator mistake, never silently skipped", () => {
    expect(() =>
      resolveConfigFromEnv({
        ...BASE_ENV,
        EMBED_BASE_URL: "https://api.openai.com/v1",
      }),
    ).toThrow();
  });

  test("throws when DATABASE_URL is missing", () => {
    expect(() =>
      resolveConfigFromEnv({
        EMBED_BASE_URL: "https://api.openai.com/v1",
        EMBED_MODEL: "text-embedding-3-small",
      }),
    ).toThrow(/DATABASE_URL/);
  });

  test("rerank stays unset when its env vars are absent", () => {
    const config = resolveConfigFromEnv({
      ...BASE_ENV,
      EMBED_BASE_URL: "https://api.openai.com/v1",
      EMBED_MODEL: "text-embedding-3-small",
    });
    expect(config?.memory.rerank).toEqual({
      baseUrl: undefined,
      model: undefined,
      apiKey: undefined,
      maxDocChars: undefined,
      timeoutMs: undefined,
    });
  });
});

describe("resolveConfigLexicalOnly", () => {
  test("omits embed entirely — the floor needs nothing beyond DATABASE_URL", () => {
    const config = resolveConfigLexicalOnly(BASE_ENV);
    expect(config.memory.embed).toBeUndefined();
    expect(config.memory.databaseUrl).toBe(BASE_ENV.DATABASE_URL);
  });

  test("throws when DATABASE_URL is missing", () => {
    expect(() => resolveConfigLexicalOnly({})).toThrow(/DATABASE_URL/);
  });
});

// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates above), matching this repo's existing
// convention for tests that talk to a real Postgres (`memory-mount.test.ts`).
//
// Proves precedence step (b) — a connected OpenAI credential — resolves
// through the platform's own ownership-walk-the-ancestor-chain resolver
// (`resolveCredentialRequirement`, never a hand-rolled query), and that
// `resolveMemoryConfig` prefers it over the lexical-only floor when no
// `EMBED_BASE_URL` is set, but never touches it when one is.
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "hub_memory_config_test";
const CIPHER = createEnvKeyCredentialCipher(new Uint8Array(32).fill(7));

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
