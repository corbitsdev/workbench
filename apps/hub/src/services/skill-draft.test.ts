import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPair } from "@intx/crypto";
import { schema as intxSchema } from "@intx/db";
import {
  createAgentRepoStore,
  createAssetService,
  skillDraftAuthorize,
  skillDraftKindHandler,
} from "@workbench/hub-sessions";
import type { HubDb } from "../db";
import { skillAccess as skillAccessTable } from "../db/schema";

// Integration test over the REAL seams: a real on-disk git-backed
// `AgentRepoStore` (with the `skill-draft` kind registered exactly as
// `apps/hub/src/index.ts` registers it) and a real `AssetService` built on
// top of it. Only the Postgres layer is faked — a small in-memory table
// keyed by the real drizzle column objects (via reference identity, not by
// parsing SQL), so `eq`/`and`/`inArray` conditions from the real
// skill-library code evaluate genuinely against it. This is deliberately
// NOT a hand-canned "return this" mock: the two required tests (the
// concurrency race and the failed-publish retry) depend on the fake
// actually mutating shared state the way Postgres would, or they would
// prove nothing.
const ancestorTenantIds = ["ten_a"];
const realDb = await import("@intx/db");
mock.module("@intx/db", () => ({
  ...realDb,
  getAncestorChain: async () => ancestorTenantIds,
}));

// The fake db below evaluates conditions structurally by tagged shape
// (`{kind: "eq", ...}`), not by parsing real drizzle SQL objects. Mocking
// `eq`/`and`/`inArray` at the drizzle-orm module boundary means the real
// skill-library code's real query calls produce exactly those tags, so the
// fake db's filtering is genuine, not canned. `asc`/`desc` pass through as
// no-ops — the fake ignores ORDER BY and always returns the full row set.
const realDrizzle = await import("drizzle-orm");
mock.module("drizzle-orm", () => ({
  ...realDrizzle,
  eq: (col: unknown, val: unknown) => ({ kind: "eq", col, val }),
  and: (...clauses: unknown[]) => ({ kind: "and", clauses }),
  inArray: (col: unknown, vals: unknown[]) => ({ kind: "inArray", col, vals }),
  asc: (col: unknown) => col,
  desc: (col: unknown) => col,
}));

const {
  approveSkillDraft,
  createSkill,
  discardSkillDraft,
  getOwnedSkillDraftItem,
  listSkillDrafts,
  upsertSkillDraft,
} = await import("./skill-library");

type AssetRow = {
  id: string;
  tenantId: string;
  kind: string;
  name: string;
  displayName: string | null;
  creatorPrincipalId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SkillAccessRow = {
  assetId: string;
  scope: string;
  ownerUserId: string | null;
  ownerPrincipalId: string | null;
  description: string | null;
};

const assetColKey = new Map<unknown, keyof AssetRow>([
  [intxSchema.asset.id, "id"],
  [intxSchema.asset.tenantId, "tenantId"],
  [intxSchema.asset.kind, "kind"],
  [intxSchema.asset.name, "name"],
  [intxSchema.asset.displayName, "displayName"],
  [intxSchema.asset.creatorPrincipalId, "creatorPrincipalId"],
  [intxSchema.asset.createdAt, "createdAt"],
  [intxSchema.asset.updatedAt, "updatedAt"],
]);

const skillAccessColKey = new Map<unknown, keyof SkillAccessRow>([
  [skillAccessTable.assetId, "assetId"],
  [skillAccessTable.scope, "scope"],
  [skillAccessTable.ownerUserId, "ownerUserId"],
  [skillAccessTable.ownerPrincipalId, "ownerPrincipalId"],
  [skillAccessTable.description, "description"],
]);

const userColKey = new Map<unknown, string>([
  [intxSchema.user.name, "userName"],
]);

function keyFor(col: unknown): string {
  const assetKey = assetColKey.get(col);
  if (assetKey !== undefined) return assetKey;
  const accessKey = skillAccessColKey.get(col);
  if (accessKey !== undefined) return accessKey;
  const userKey = userColKey.get(col);
  if (userKey !== undefined) return userKey;
  throw new Error("fake db: unmapped column in test query");
}

type Cond =
  | { kind: "eq"; col: unknown; val: unknown }
  | { kind: "and"; clauses: Cond[] }
  | { kind: "inArray"; col: unknown; vals: unknown[] };

function evalCond(cond: Cond, row: Record<string, unknown>): boolean {
  if (cond.kind === "eq") return row[keyFor(cond.col)] === cond.val;
  if (cond.kind === "and") return cond.clauses.every((c) => evalCond(c, row));
  if (cond.kind === "inArray") {
    const vals = cond.vals;
    return vals.includes(row[keyFor(cond.col)]);
  }
  throw new Error("fake db: unsupported condition");
}

class UniqueViolation extends Error {
  readonly code = "23505";
  constructor(constraint: string) {
    super(`duplicate key value violates unique constraint "${constraint}"`);
  }
}

function makeFakeDb() {
  const assets: AssetRow[] = [];
  const skillAccessRows: SkillAccessRow[] = [];

  function projectRows(
    cols: Record<string, unknown> | undefined,
    base: unknown,
    joins: unknown[],
    cond: Cond | undefined,
  ): Record<string, unknown>[] {
    if (base !== intxSchema.asset) {
      throw new Error("fake db: only queries FROM asset are supported");
    }
    const results: Record<string, unknown>[] = [];
    for (const assetRow of assets) {
      const flat: Record<string, unknown> = { ...assetRow };
      if (joins.includes(skillAccessTable)) {
        const access = skillAccessRows.find((a) => a.assetId === assetRow.id);
        if (access) Object.assign(flat, access);
      }
      if (joins.includes(intxSchema.user)) {
        flat.userName = null;
      }
      if (cond && !evalCond(cond, flat)) continue;
      // `select()` with no argument (as opposed to `select({...})`) selects
      // the whole base row — used by `listSkillDrafts`/`getOwnedSkillDraftItem`.
      if (cols === undefined) {
        results.push(assetRow);
        continue;
      }
      const projected: Record<string, unknown> = {};
      for (const [key, col] of Object.entries(cols)) {
        const value = flat[keyFor(col)];
        projected[key] = value === undefined ? null : value;
      }
      results.push(projected);
    }
    return results;
  }

  function deleteAsset(cond: Cond): AssetRow[] {
    const removed: AssetRow[] = [];
    for (let i = assets.length - 1; i >= 0; i -= 1) {
      const row = assets[i];
      if (row !== undefined && evalCond(cond, row)) {
        removed.push(row);
        assets.splice(i, 1);
      }
    }
    return removed;
  }

  function deleteSkillAccess(cond: Cond): SkillAccessRow[] {
    const removed: SkillAccessRow[] = [];
    for (let i = skillAccessRows.length - 1; i >= 0; i -= 1) {
      const row = skillAccessRows[i];
      if (row !== undefined && evalCond(cond, row)) {
        removed.push(row);
        skillAccessRows.splice(i, 1);
      }
    }
    return removed;
  }

  const db = {
    query: {
      asset: {
        findFirst: (args: { where: Cond }) => {
          const row = assets.find((a) => evalCond(args.where, a));
          return Promise.resolve(row);
        },
      },
    },
    select(cols?: Record<string, unknown>) {
      let base: unknown;
      const joins: unknown[] = [];
      let cond: Cond | undefined;
      const chain = {
        from(table: unknown) {
          base = table;
          return chain;
        },
        leftJoin(table: unknown) {
          joins.push(table);
          return chain;
        },
        where(condition: Cond) {
          cond = condition;
          return chain;
        },
        limit: (n: number) =>
          Promise.resolve(projectRows(cols, base, joins, cond).slice(0, n)),
        orderBy: (..._order: unknown[]) =>
          Promise.resolve(projectRows(cols, base, joins, cond)),
      };
      return chain;
    },
    insert(table: unknown) {
      return {
        values(row: Record<string, unknown>) {
          function insertReturning(): Promise<unknown[]> {
            if (table === intxSchema.asset) {
              const assetRow = row as unknown as AssetRow;
              if (
                assets.some(
                  (a) =>
                    a.tenantId === assetRow.tenantId &&
                    a.kind === assetRow.kind &&
                    a.name === assetRow.name,
                )
              ) {
                return Promise.reject(
                  new UniqueViolation("asset_tenant_kind_name"),
                );
              }
              assets.push(assetRow);
              return Promise.resolve([assetRow]);
            }
            if (table === skillAccessTable) {
              skillAccessRows.push(row as unknown as SkillAccessRow);
              return Promise.resolve([row]);
            }
            throw new Error("fake db: unexpected insert table");
          }
          // Callers use this both ways: `.values(row).returning()` and a
          // bare awaited `.values(row)` (createSkill's skillAccess insert).
          // Return a real Promise so both forms work, with `.returning()`
          // attached as an extra method on it.
          const inserted = insertReturning();
          const withReturning = inserted.then(
            () => undefined,
          ) as Promise<void> & {
            returning: () => Promise<unknown[]>;
          };
          withReturning.returning = () => inserted;
          return withReturning;
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where: (cond: Cond) => {
              if (table !== skillAccessTable) {
                throw new Error("fake db: unexpected update table");
              }
              for (const row of skillAccessRows) {
                if (evalCond(cond, row)) Object.assign(row, values);
              }
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where: (cond: Cond) => {
          let deleted: Promise<AssetRow[]>;
          if (table === intxSchema.asset) {
            deleted = Promise.resolve(deleteAsset(cond));
          } else if (table === skillAccessTable) {
            deleted = Promise.resolve(
              deleteSkillAccess(cond),
            ) as unknown as Promise<AssetRow[]>;
          } else {
            throw new Error("fake db: unexpected delete table");
          }
          // Callers use this two ways: `.where(...).returning()` (the
          // claiming delete) and a bare awaited/`.catch`-chained
          // `.where(...)` (best-effort cleanup on a failure path). Return a
          // real Promise so both forms work, with `.returning()` attached
          // as an extra method on it.
          const withReturning = deleted.then(
            () => undefined,
          ) as Promise<void> & {
            returning: () => Promise<AssetRow[]>;
          };
          withReturning.returning = () => deleted;
          return withReturning;
        },
      };
    },
  } as unknown as HubDb;

  return { db, assets, skillAccessRows };
}

async function makeRepoStore(dataDir: string) {
  const signingKey = await generateKeyPair();
  return createAgentRepoStore({
    dataDir,
    signingKey,
    handlers: {
      "skill-draft": {
        handler: skillDraftKindHandler,
        authorize: skillDraftAuthorize,
      },
    },
  });
}

const TENANT_ID = "ten_a";
const OWNER_PRINCIPAL_ID = "prn_owner";
const OWNER_USER_ID = "usr_owner";
const OWNER_NAME = "Owner Name";
const VIEWER = { tenantId: TENANT_ID, principalId: OWNER_PRINCIPAL_ID };

let dataDir: string;
let fakeDb: ReturnType<typeof makeFakeDb>;
let repoStore: Awaited<ReturnType<typeof makeRepoStore>>;
let assetService: ReturnType<typeof createAssetService>;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-draft-test-"));
  fakeDb = makeFakeDb();
  repoStore = await makeRepoStore(dataDir);
  assetService = createAssetService({
    db: fakeDb.db,
    repoStore: repoStore.repoStore,
    registeredKinds: repoStore.registeredKinds,
  });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function seedSkill(name: string): Promise<string> {
  const skill = await createSkill(assetService, fakeDb.db, VIEWER, {
    name,
    description: "seed skill",
    files: [{ path: "SKILL.md", content: Buffer.from(`# ${name}`) }],
    scope: "tenant",
    ownerUserId: OWNER_USER_ID,
    ownerName: OWNER_NAME,
  });
  return skill.id;
}

async function createDraft(
  title: string,
  existingSkillId: string | null,
): Promise<string> {
  const result = await upsertSkillDraft(
    assetService,
    fakeDb.db,
    repoStore.repoStore,
    {
      tenantId: TENANT_ID,
      ownerPrincipalId: OWNER_PRINCIPAL_ID,
      title,
      body: `# ${title}\ncontent`,
      description: "does a thing",
      files: undefined,
      existingSkillId,
    },
  );
  return result.draftId;
}

describe("upsertSkillDraft / listSkillDrafts / getOwnedSkillDraftItem", () => {
  it("creates a draft, then updates the same draft on re-authoring", async () => {
    const draftId = await createDraft("my-skill", null);
    const listed = await listSkillDrafts(
      fakeDb.db,
      repoStore.repoStore,
      VIEWER,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(draftId);
    expect(listed[0]?.content).toBe("# my-skill\ncontent");

    const secondResult = await upsertSkillDraft(
      assetService,
      fakeDb.db,
      repoStore.repoStore,
      {
        tenantId: TENANT_ID,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
        title: "my-skill",
        body: "# my-skill\nupdated content",
        description: "does a thing, updated",
        files: undefined,
        existingSkillId: undefined,
      },
    );
    expect(secondResult.draftId).toBe(draftId);

    const item = await getOwnedSkillDraftItem(
      fakeDb.db,
      repoStore.repoStore,
      VIEWER,
      draftId,
    );
    expect(item.content).toBe("# my-skill\nupdated content");
    expect(item.description).toBe("does a thing, updated");
  });
});

describe("discardSkillDraft", () => {
  it("deletes the draft asset and its git repo", async () => {
    const draftId = await createDraft("throwaway", null);
    const result = await discardSkillDraft(
      fakeDb.db,
      repoStore.repoStore,
      VIEWER,
      draftId,
    );
    expect(result.draftId).toBe(draftId);
    expect(fakeDb.assets.some((a) => a.id === draftId)).toBe(false);

    await expect(
      getOwnedSkillDraftItem(fakeDb.db, repoStore.repoStore, VIEWER, draftId),
    ).rejects.toThrow(`Skill draft not found: ${draftId}`);
  });

  it("404s when the draft never existed", async () => {
    await expect(
      discardSkillDraft(fakeDb.db, repoStore.repoStore, VIEWER, "nope"),
    ).rejects.toThrow("Skill draft not found: nope");
  });
});

describe("approveSkillDraft", () => {
  it("publishes an update to the linked skill and deletes the draft", async () => {
    const skillId = await seedSkill("my-skill");
    const draftId = await createDraft("my-skill", skillId);

    const result = await approveSkillDraft(
      assetService,
      fakeDb.db,
      repoStore.repoStore,
      VIEWER,
      draftId,
      { scope: "tenant", ownerUserId: OWNER_USER_ID, ownerName: OWNER_NAME },
    );

    expect(result.skill.id).toBe(skillId);
    expect(fakeDb.assets.some((a) => a.id === draftId)).toBe(false);
  });

  // Required by CL-4215: a racing approve and discard on the same draft must
  // resolve to exactly one winner, never both and never neither. The claim
  // is a conditional `DELETE ... RETURNING` on the draft asset row — the
  // fake db's `deleteAsset` mutates the shared `assets` array synchronously,
  // so this genuinely exercises the same single-winner guarantee Postgres'
  // row-level MVCC gives the real claim.
  it("concurrency: exactly one of a racing approve and discard wins", async () => {
    const skillId = await seedSkill("race-skill");
    const draftId = await createDraft("race-skill", skillId);

    const [approveOutcome, discardOutcome] = await Promise.allSettled([
      approveSkillDraft(
        assetService,
        fakeDb.db,
        repoStore.repoStore,
        VIEWER,
        draftId,
        { scope: "tenant", ownerUserId: OWNER_USER_ID, ownerName: OWNER_NAME },
      ),
      discardSkillDraft(fakeDb.db, repoStore.repoStore, VIEWER, draftId),
    ]);

    const outcomes = [approveOutcome, discardOutcome];
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejectedOutcome = rejected[0];
    if (
      rejectedOutcome !== undefined &&
      rejectedOutcome.status === "rejected"
    ) {
      expect(String(rejectedOutcome.reason)).toContain("no longer pending");
    }
    // The draft asset is gone regardless of which side won.
    expect(fakeDb.assets.some((a) => a.id === draftId)).toBe(false);
  });

  // Required by CL-4215: a failed publish must never leave the draft
  // "stuck approved" with no skill — existence is the only state, so a
  // failure must leave the draft existing again (pending), and a retry on
  // the reinstated draft must succeed.
  it("failed publish: draft is reinstated as pending, and retry succeeds", async () => {
    const skillId = await seedSkill("flaky-skill");
    const draftId = await createDraft("flaky-skill", skillId);

    const originalPopulateAsset = assetService.populateAsset.bind(assetService);
    let callCount = 0;
    assetService.populateAsset = (
      params: Parameters<typeof originalPopulateAsset>[0],
    ) => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.reject(new Error("simulated publish failure"));
      }
      return originalPopulateAsset(params);
    };

    await expect(
      approveSkillDraft(
        assetService,
        fakeDb.db,
        repoStore.repoStore,
        VIEWER,
        draftId,
        { scope: "tenant", ownerUserId: OWNER_USER_ID, ownerName: OWNER_NAME },
      ),
    ).rejects.toThrow("simulated publish failure");

    // The original draft id is gone (claimed), but a fresh draft asset for
    // the same name exists and is listable — pending, not stuck.
    const listedAfterFailure = await listSkillDrafts(
      fakeDb.db,
      repoStore.repoStore,
      VIEWER,
    );
    expect(listedAfterFailure).toHaveLength(1);
    const reinstatedRow = listedAfterFailure[0];
    expect(reinstatedRow).toBeDefined();
    const reinstatedId = reinstatedRow?.id as string;
    expect(reinstatedId).not.toBe(draftId);
    expect(reinstatedRow?.content).toBe("# flaky-skill\ncontent");

    const retryResult = await approveSkillDraft(
      assetService,
      fakeDb.db,
      repoStore.repoStore,
      VIEWER,
      reinstatedId,
      { scope: "tenant", ownerUserId: OWNER_USER_ID, ownerName: OWNER_NAME },
    );
    expect(retryResult.skill.id).toBe(skillId);

    const listedAfterRetry = await listSkillDrafts(
      fakeDb.db,
      repoStore.repoStore,
      VIEWER,
    );
    expect(listedAfterRetry).toHaveLength(0);
  });
});
