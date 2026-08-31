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
//   - a `CredentialBinding` naming this package's declared "linear"
//     handle resolves to a seeded tenant-owned credential's decrypted
//     secret;
//   - the same binding fails closed (`unresolved`) when no credential
//     exists for the provider, rather than delivering nothing silently.
import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { dbGate } from "../../../scripts/e2e/db-gate";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const SCHEMA = "linear_tools_credential_delivery_test";
const KEY = new Uint8Array(32).fill(11);
const CIPHER = createEnvKeyCredentialCipher(KEY);

const LINEAR_BINDING: CredentialBinding = {
  package: "@corbits/linear-tools",
  handle: "linear",
  provider: "linear",
  locator: "tenant",
};

describeIfDb("buildCredentialDelivery: the linear handle binding", () => {
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
        id: "tnt_linear_resolves",
        name: "Linear Resolves Tenant",
        slug: "linear-resolves-tenant",
        domain: "linear-resolves.workbench.test",
      });
      await db.insert(schema.provider).values({
        id: "prov_linear",
        tenantId: "tnt_linear_resolves",
        name: "linear",
        plugin: "linear",
        apiBaseUrl: "https://api.linear.app/graphql",
      });
      const credentialId = "cred_linear";
      await db.insert(schema.credential).values({
        id: credentialId,
        tenantId: "tnt_linear_resolves",
        providerId: "prov_linear",
        name: "linear-key",
        type: "api_key",
        secret: await CIPHER.encrypt(
          "linear-plaintext-secret",
          credentialAad(credentialId, "secret"),
        ),
        status: "active",
      });

      const result = await buildCredentialDelivery({
        db,
        tenantId: "tnt_linear_resolves",
        bindings: [LINEAR_BINDING],
        creatorPrincipalId: null,
        invokerPrincipalId: null,
        credentialCipher: CIPHER,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected resolution to succeed");
      expect(result.delivery?.bindings).toEqual([
        {
          handle: "linear",
          credentialId,
          consumer: "tool:@corbits/linear-tools",
        },
      ]);
      expect(result.delivery?.materials).toEqual([
        {
          credentialId,
          providerKey: "linear",
          origin: "https://api.linear.app/graphql",
          secret: "linear-plaintext-secret",
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
        id: "tnt_linear_unresolved",
        name: "Linear Unresolved Tenant",
        slug: "linear-unresolved-tenant",
        domain: "linear-unresolved.workbench.test",
      });
      // No provider, no credential row for this tenant: the binding's
      // provider never resolves.

      const result = await buildCredentialDelivery({
        db,
        tenantId: "tnt_linear_unresolved",
        bindings: [LINEAR_BINDING],
        creatorPrincipalId: null,
        invokerPrincipalId: null,
        credentialCipher: CIPHER,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected resolution to fail closed");
      expect(result.reason).toEqual({
        code: "unresolved",
        binding: {
          provider: "linear",
          package: "@corbits/linear-tools",
          handle: "linear",
        },
        message:
          "No credential resolves the binding for provider linear " +
          "(package @corbits/linear-tools, handle linear)",
      });
    } finally {
      await close();
    }
  });
});
