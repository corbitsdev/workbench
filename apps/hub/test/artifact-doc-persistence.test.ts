// DB-gated: skipped when DATABASE_URL is unreachable, matching this repo's
// existing convention for tests that talk to a real Postgres (see
// apps/hub/src/memory-mount.test.ts). Proves the exact wiring
// `src/index.ts` composes between `@corbits/presence`'s
// `createArtifactDocPersistence` and `@corbits/artifacts`' own
// `getArtifact`/`writeArtifactVersion` seam actually lands a new artifact
// version row — not just that the two packages' unit tests independently
// pass with fakes standing in for each other.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { dbGate } from "../../../scripts/e2e/db-gate";
import * as Y from "yjs";
import { and, eq } from "drizzle-orm";

import { createDB, schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import {
  artifactVersion,
  createArtifact,
  createArtifactDb,
  getArtifact,
  getArtifactVersion,
  runArtifactMigrations,
  writeArtifactVersion,
  type ArtifactDb,
} from "@corbits/artifacts";
import {
  createArtifactDocPersistence,
  createPresenceRoomRegistry,
} from "@corbits/presence";

function dbConfigFromUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = dbGate(databaseUrl, import.meta.path);

describeIfDb(
  "artifact doc persistence: a real snapshot write against Postgres",
  () => {
    let controlDb: DB;
    let artifactDb: ArtifactDb;

    const tenantId = generateId("tenant");
    const principalId = generateId("principal");

    beforeAll(async () => {
      controlDb = createDB(dbConfigFromUrl(databaseUrl as string));
      await controlDb.db.insert(schema.tenant).values({
        id: tenantId,
        name: "Co-editing Test Bench",
        slug: `coediting-${tenantId}`,
        domain: `coediting-${tenantId}.localhost`,
      });
      await controlDb.db.insert(schema.principal).values({
        id: principalId,
        tenantId,
        kind: "user",
        refId: "not-a-real-user",
        status: "active",
      });

      const created = createArtifactDb(databaseUrl as string);
      artifactDb = created.db;
      await runArtifactMigrations(artifactDb);
    });

    afterAll(async () => {
      await controlDb.db
        .delete(schema.principal)
        .where(eq(schema.principal.id, principalId));
      await controlDb.db
        .delete(schema.tenant)
        .where(eq(schema.tenant.id, tenantId));
    });

    test("a debounced snapshot writes a new artifact_version row via writeArtifactVersion", async () => {
      const created = await artifactDb.transaction((tx) =>
        createArtifact(tx, {
          scope: { tenantId, principalId },
          ownerPrincipalId: principalId,
          kind: "document",
          title: "Co-edited doc",
          content: "original content",
          source: {},
        }),
      );

      const registry = createPresenceRoomRegistry();
      const errors: unknown[] = [];
      const persistence = createArtifactDocPersistence({
        registry,
        debounceMs: 10,
        loadArtifactContent: async (tid, artifactId) => {
          const row = await getArtifact(artifactDb, artifactId);
          if (row === null || row.tenantId !== tid) return null;
          return row.content;
        },
        writeArtifactSnapshot: async (tid, artifactId, author, content) => {
          const written = await writeArtifactVersion(artifactDb, {
            scope: { tenantId: tid, principalId: author },
            artifactId,
            content,
          });
          return { version: written.version };
        },
        onSnapshotError: (_key, error) => errors.push(error),
      });

      const key = { tenantId, surface: `artifact:${created.id}` };
      await persistence.seedOnJoin(key);
      expect(registry.docText(key)).toBe("original content");

      // A real co-editor catches up to the seeded state first (mirroring
      // the join route's `docUpdate` response), then edits from there —
      // editing an unrelated, un-synced doc would just concurrently merge
      // instead of replacing, which is correct Yjs behavior but not what
      // this test means to exercise.
      const doc = new Y.Doc();
      Y.applyUpdate(doc, registry.docStateAsUpdate(key));
      const text = doc.getText("content");
      text.delete(0, text.length);
      text.insert(0, "edited by a co-editor");
      registry.applyDocUpdate(key, Y.encodeStateAsUpdate(doc), principalId);

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(errors).toEqual([]);
      const updated = await getArtifact(artifactDb, created.id);
      expect(updated?.version).toBe(2);
      expect(updated?.content).toBe("edited by a co-editor");

      const versionTwo = await getArtifactVersion(artifactDb, created.id, 2);
      expect(versionTwo?.content).toBe("edited by a co-editor");

      const [versionTwoRow] = await artifactDb
        .select({ authorId: artifactVersion.authorId })
        .from(artifactVersion)
        .where(
          and(
            eq(artifactVersion.artifactId, created.id),
            eq(artifactVersion.version, 2),
          ),
        );
      expect(versionTwoRow?.authorId).toBe(principalId);

      persistence.dispose();
    });
  },
);
