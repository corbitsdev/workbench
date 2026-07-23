import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import {
  GRANOLA_CALL_ARTIFACT_KINDS,
  granolaCallSourceRef,
} from "@workbench/shared";

import { schema } from "../db";
import type { HubDb } from "../db";
import {
  granolaCallArtifactsProcessed,
  granolaCallSourceRefs,
} from "./granola-call-artifacts";

// Real-Postgres-shaped exercise of the CL-4213 dedupe primitive: pushes the
// real drizzle schema into PGlite so the partial unique index
// (artifact_tenant_source_ref_uniq) is genuinely enforced, not mocked.
const TENANT = "tn-granola";
const NOTE_ID = "note-abc123";

let client: PGlite;
let db: HubDb;

async function seedArtifact(args: {
  tenantId?: string;
  sourceRef: string;
}): Promise<void> {
  await client.query(
    `insert into artifact (id, tenant_id, kind, title, content, source_ref, created_at, updated_at)
     values (gen_random_uuid(), $1, 'granola-call-summary', 't', 'c', $2, now(), now())`,
    [args.tenantId ?? TENANT, args.sourceRef],
  );
}

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.exec(`DELETE FROM "artifact";`);
});

describe("granolaCallSourceRefs", () => {
  test("derives one sourceRef per artifact kind, keyed by the stable note id", () => {
    const refs = granolaCallSourceRefs(NOTE_ID);
    expect(refs).toEqual([
      granolaCallSourceRef(NOTE_ID, GRANOLA_CALL_ARTIFACT_KINDS.painPoints),
      granolaCallSourceRef(NOTE_ID, GRANOLA_CALL_ARTIFACT_KINDS.summary),
      granolaCallSourceRef(NOTE_ID, GRANOLA_CALL_ARTIFACT_KINDS.brief),
    ]);
    // Three distinct refs for one note — a note renamed later never changes
    // these, only the note id would.
    expect(new Set(refs).size).toBe(3);
  });
});

describe("granolaCallArtifactsProcessed", () => {
  test("false when no artifacts exist for the note", async () => {
    expect(await granolaCallArtifactsProcessed(db, TENANT, NOTE_ID)).toBe(
      false,
    );
  });

  test("false on a partial write — one or two of three artifacts present is still 'not processed', so a re-run fills the gap", async () => {
    await seedArtifact({
      sourceRef: granolaCallSourceRef(
        NOTE_ID,
        GRANOLA_CALL_ARTIFACT_KINDS.painPoints,
      ),
    });
    expect(await granolaCallArtifactsProcessed(db, TENANT, NOTE_ID)).toBe(
      false,
    );

    await seedArtifact({
      sourceRef: granolaCallSourceRef(
        NOTE_ID,
        GRANOLA_CALL_ARTIFACT_KINDS.summary,
      ),
    });
    expect(await granolaCallArtifactsProcessed(db, TENANT, NOTE_ID)).toBe(
      false,
    );
  });

  test("true only once all three artifacts exist", async () => {
    for (const kind of Object.values(GRANOLA_CALL_ARTIFACT_KINDS)) {
      await seedArtifact({
        sourceRef: granolaCallSourceRef(NOTE_ID, kind),
      });
    }
    expect(await granolaCallArtifactsProcessed(db, TENANT, NOTE_ID)).toBe(true);
  });

  test("scoped by tenant — another tenant's fully-processed call never marks this tenant's call processed", async () => {
    for (const kind of Object.values(GRANOLA_CALL_ARTIFACT_KINDS)) {
      await seedArtifact({
        tenantId: "tn-other",
        sourceRef: granolaCallSourceRef(NOTE_ID, kind),
      });
    }
    expect(await granolaCallArtifactsProcessed(db, TENANT, NOTE_ID)).toBe(
      false,
    );
  });

  test("the partial unique index rejects a concurrent duplicate insert for the same (tenant, sourceRef) — the correctness backstop behind the pre-flight check", async () => {
    const sourceRef = granolaCallSourceRef(
      NOTE_ID,
      GRANOLA_CALL_ARTIFACT_KINDS.brief,
    );
    await seedArtifact({ sourceRef });
    await expect(seedArtifact({ sourceRef })).rejects.toThrow();
  });
});
