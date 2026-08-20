// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring
// `packages/webhook-triggers/test/store.drizzle.test.ts`. Runs against
// its own Postgres schema, never the developer's or the walking-skeleton
// suite's.
//
// Proves the launch-time half of CL-6028's credential-binding adoption
// using only the platform's own, already-built functions
// (`buildCredentialDelivery`, `createEnvKeyCredentialCipher`,
// `credentialAad`) — never a hand-rolled resolver:
//
//   - a `CredentialBinding` naming this package's declared "granola"
//     handle resolves to a seeded tenant-owned credential's decrypted
//     secret;
//   - the same binding fails closed (`unresolved`) when no credential
//     exists for the provider, rather than delivering nothing silently.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildCredentialDelivery,
  createDB,
  runMigrations,
  dropSchema,
} from "@intx/db";
import { schema } from "@intx/db";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { credentialAad } from "@intx/types";
import type { CredentialBinding } from "@intx/types";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "granola_tools_credential_delivery_test";
const KEY = new Uint8Array(32).fill(9);
const CIPHER = createEnvKeyCredentialCipher(KEY);

const GRANOLA_BINDING: CredentialBinding = {
  package: "@corbits/granola-tools",
  handle: "granola",
  provider: "granola",
  locator: "tenant",
};

describeIfDb("buildCredentialDelivery: the granola handle binding", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  test("resolves the bound handle to the seeded tenant credential's decrypted secret", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await db.insert(schema.tenant).values({
        id: "tnt_granola_resolves",
        name: "Granola Resolves Tenant",
        slug: "granola-resolves-tenant",
        domain: "granola-resolves.workbench.test",
      });
      await db.insert(schema.provider).values({
        id: "prov_granola",
        tenantId: "tnt_granola_resolves",
        name: "granola",
        plugin: "granola",
        apiBaseUrl: "https://api.granola.ai",
      });
      const credentialId = "cred_granola";
      await db.insert(schema.credential).values({
        id: credentialId,
        tenantId: "tnt_granola_resolves",
        providerId: "prov_granola",
        name: "granola-key",
        type: "api_key",
        secret: await CIPHER.encrypt(
          "granola-plaintext-secret",
          credentialAad(credentialId, "secret"),
        ),
        status: "active",
      });

      const result = await buildCredentialDelivery({
        db,
        tenantId: "tnt_granola_resolves",
        bindings: [GRANOLA_BINDING],
        creatorPrincipalId: null,
        invokerPrincipalId: null,
        credentialCipher: CIPHER,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected resolution to succeed");
      expect(result.delivery?.bindings).toEqual([
        {
          handle: "granola",
          credentialId,
          consumer: "tool:@corbits/granola-tools",
        },
      ]);
      expect(result.delivery?.materials).toEqual([
        {
          credentialId,
          providerKey: "granola",
          origin: "https://api.granola.ai",
          secret: "granola-plaintext-secret",
        },
      ]);
    } finally {
      await close();
    }
  });

  test("fails closed with 'unresolved' when no credential backs the provider", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      await db.insert(schema.tenant).values({
        id: "tnt_granola_unresolved",
        name: "Granola Unresolved Tenant",
        slug: "granola-unresolved-tenant",
        domain: "granola-unresolved.workbench.test",
      });
      // No provider, no credential row for this tenant: the binding's
      // provider never resolves.

      const result = await buildCredentialDelivery({
        db,
        tenantId: "tnt_granola_unresolved",
        bindings: [GRANOLA_BINDING],
        creatorPrincipalId: null,
        invokerPrincipalId: null,
        credentialCipher: CIPHER,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected resolution to fail closed");
      expect(result.reason).toEqual({
        code: "unresolved",
        binding: {
          provider: "granola",
          package: "@corbits/granola-tools",
          handle: "granola",
        },
        message:
          "No credential resolves the binding for provider granola " +
          "(package @corbits/granola-tools, handle granola)",
      });
    } finally {
      await close();
    }
  });
});
