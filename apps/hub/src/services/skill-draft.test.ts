import { beforeEach, describe, expect, it, mock } from "bun:test";

const resolveOwnerMemberPrincipalId = mock(
  async (): Promise<string | null> => "prn_owner",
);
mock.module("../lib/artifact-tools", () => ({
  resolveOwnerMemberPrincipalId,
}));

const {
  approveSkillDraft,
  canActOnSkillDraft,
  discardSkillDraft,
  listSkillDrafts,
} = await import("./skill-library");

const VIEWER = {
  tenantId: "ten_a",
  principalId: "prn_owner",
  userId: "usr_1",
};

function makeDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: "art_draft_1",
    tenantId: "ten_a",
    principalId: "prn_myra",
    ownerPrincipalId: "prn_owner",
    kind: "skill-draft",
    title: "my-skill",
    content: "---\nname: my-skill\n---\n# Hello",
    source: { origin: "skill-draft", description: "does a thing" },
    status: "draft" as "draft" | "approved" | "rejected",
    version: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Minimal db mock for skill-draft service paths.
 * select chain: .select().from().where().limit(1) OR .orderBy(...)
 * update chain: .update().set().where().returning()
 */
function makeDb(opts: {
  drafts?: ReturnType<typeof makeDraft>[];
  updateResult?: ReturnType<typeof makeDraft> | null;
  captureUpdates?: Record<string, unknown>[];
}) {
  const drafts = opts.drafts ?? [];
  const captureUpdates = opts.captureUpdates ?? [];

  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: async () => drafts,
    limit: async (_n: number) => drafts.slice(0, 1),
  };

  return {
    select: () => selectChain,
    update: () => ({
      set: (values: Record<string, unknown>) => {
        captureUpdates.push(values);
        return {
          where: () => ({
            returning: async () => {
              if (opts.updateResult === null) return [];
              return [
                opts.updateResult ?? {
                  ...drafts[0],
                  ...values,
                  updatedAt: new Date(),
                },
              ];
            },
          }),
        };
      },
    }),
  } as never;
}

beforeEach(() => {
  resolveOwnerMemberPrincipalId.mockClear();
  resolveOwnerMemberPrincipalId.mockImplementation(async () => "prn_owner");
});

describe("canActOnSkillDraft", () => {
  it("allows the stamped owner principal", async () => {
    const allowed = await canActOnSkillDraft(
      {} as never,
      makeDraft({ ownerPrincipalId: "prn_owner" }),
      VIEWER,
    );
    expect(allowed).toBe(true);
  });

  it("denies a different principal when owner is stamped", async () => {
    const allowed = await canActOnSkillDraft(
      {} as never,
      makeDraft({ ownerPrincipalId: "prn_other" }),
      VIEWER,
    );
    expect(allowed).toBe(false);
    expect(resolveOwnerMemberPrincipalId).not.toHaveBeenCalled();
  });

  it("legacy unstamped: allows direct principal match", async () => {
    const allowed = await canActOnSkillDraft(
      {} as never,
      makeDraft({
        ownerPrincipalId: null,
        principalId: "prn_owner",
      }),
      VIEWER,
    );
    expect(allowed).toBe(true);
  });

  it("legacy unstamped: resolves agent owner and allows match", async () => {
    resolveOwnerMemberPrincipalId.mockImplementation(async () => "prn_owner");
    const allowed = await canActOnSkillDraft(
      {} as never,
      makeDraft({
        ownerPrincipalId: null,
        principalId: "prn_myra",
      }),
      VIEWER,
    );
    expect(allowed).toBe(true);
    expect(resolveOwnerMemberPrincipalId).toHaveBeenCalled();
  });

  it("legacy unstamped: denies when resolved owner differs", async () => {
    resolveOwnerMemberPrincipalId.mockImplementation(async () => "prn_other");
    const allowed = await canActOnSkillDraft(
      {} as never,
      makeDraft({
        ownerPrincipalId: null,
        principalId: "prn_myra",
      }),
      VIEWER,
    );
    expect(allowed).toBe(false);
  });
});

describe("listSkillDrafts", () => {
  it("returns only draft rows for the caller as SkillDraftItems", async () => {
    const draft = makeDraft();
    const db = makeDb({ drafts: [draft] });
    const items = await listSkillDrafts(db, VIEWER);
    expect(items).toEqual([
      {
        id: "art_draft_1",
        title: "my-skill",
        content: draft.content,
        description: "does a thing",
        existingSkillId: null,
        status: "draft",
        updatedAt: "2026-01-02T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });
});

describe("discardSkillDraft", () => {
  it("rejects when draft is not owned (404)", async () => {
    const db = makeDb({
      drafts: [makeDraft({ ownerPrincipalId: "prn_other" })],
    });
    await expect(
      discardSkillDraft(db, VIEWER, "art_draft_1"),
    ).rejects.toMatchObject({
      message: "Draft not found",
      status: 404,
    });
  });

  it("rejects when already discarded (400)", async () => {
    const db = makeDb({
      drafts: [makeDraft({ status: "rejected" })],
    });
    await expect(
      discardSkillDraft(db, VIEWER, "art_draft_1"),
    ).rejects.toMatchObject({
      message: "Draft is not in draft status",
      status: 400,
    });
  });

  it("sets status rejected for owned draft", async () => {
    const updates: Record<string, unknown>[] = [];
    const draft = makeDraft();
    const db = makeDb({
      drafts: [draft],
      updateResult: { ...draft, status: "rejected" },
      captureUpdates: updates,
    });
    const result = await discardSkillDraft(db, VIEWER, "art_draft_1");
    expect(result.status).toBe("rejected");
    expect(updates[0]?.status).toBe("rejected");
  });
});

describe("approveSkillDraft", () => {
  const OWNER_OPTS = {
    scope: "tenant" as const,
    ownerUserId: "usr_1",
    ownerName: "Ada",
  };

  it("404 when draft is in another tenant", async () => {
    // load filters by tenantId in where; empty select = not found
    const db = makeDb({ drafts: [] });
    await expect(
      approveSkillDraft({} as never, db, VIEWER, "art_draft_1", OWNER_OPTS),
    ).rejects.toMatchObject({ message: "Draft not found", status: 404 });
  });

  it("404 when draft is owned by another principal", async () => {
    const db = makeDb({
      drafts: [makeDraft({ ownerPrincipalId: "prn_other" })],
    });
    await expect(
      approveSkillDraft({} as never, db, VIEWER, "art_draft_1", OWNER_OPTS),
    ).rejects.toMatchObject({ message: "Draft not found", status: 404 });
  });

  it("400 when draft is already approved", async () => {
    const db = makeDb({
      drafts: [makeDraft({ status: "approved" })],
    });
    await expect(
      approveSkillDraft({} as never, db, VIEWER, "art_draft_1", OWNER_OPTS),
    ).rejects.toMatchObject({
      message: "Draft is not in draft status",
      status: 400,
    });
  });

  it("400 when owner identity is missing", async () => {
    const db = makeDb({ drafts: [makeDraft()] });
    await expect(
      approveSkillDraft({} as never, db, VIEWER, "art_draft_1", {
        scope: "tenant",
        ownerUserId: "  ",
        ownerName: "Ada",
      }),
    ).rejects.toMatchObject({
      message: "Owner identity is required to approve a draft",
      status: 400,
    });
  });

  it("400 when source.files is malformed", async () => {
    const db = makeDb({
      drafts: [
        makeDraft({
          source: { origin: "skill-draft", files: "not-an-array" },
        }),
      ],
    });
    await expect(
      approveSkillDraft({} as never, db, VIEWER, "art_draft_1", OWNER_OPTS),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("reaches createSkill for owned draft (create path)", async () => {
    const updates: Record<string, unknown>[] = [];
    const db = makeDb({ drafts: [makeDraft()], captureUpdates: updates });
    const assetService = {
      createAsset: async () => {
        throw new Error("CREATE_SKILL_REACHED");
      },
    };
    await expect(
      approveSkillDraft(
        assetService as never,
        db,
        VIEWER,
        "art_draft_1",
        OWNER_OPTS,
      ),
    ).rejects.toThrow("CREATE_SKILL_REACHED");
    // status must not flip if create failed
    expect(updates).toHaveLength(0);
  });

  it("reaches updateSkill for owned draft with existingSkillId", async () => {
    const db = makeDb({
      drafts: [
        makeDraft({
          source: {
            origin: "skill-draft",
            existingSkillId: "skl_existing",
          },
        }),
      ],
    });
    // updateSkill fails looking up the skill via db — past auth is enough.
    await expect(
      approveSkillDraft(
        {
          createAsset: async () => {
            throw new Error("CREATE_SHOULD_NOT_RUN");
          },
        } as never,
        db,
        VIEWER,
        "art_draft_1",
        OWNER_OPTS,
      ),
    ).rejects.toThrow();
  });

  it("skips duplicate SKILL.md entries in source.files", async () => {
    const db = makeDb({
      drafts: [
        makeDraft({
          source: {
            origin: "skill-draft",
            files: [
              { path: "SKILL.md", content: "should-be-skipped" },
              { path: "helper.ts", content: "export {}" },
            ],
          },
        }),
      ],
    });
    // If SKILL.md weren't skipped, buildSkillBundle would throw on duplicate path.
    const assetService = {
      createAsset: async () => {
        throw new Error("CREATE_SKILL_REACHED");
      },
    };
    await expect(
      approveSkillDraft(
        assetService as never,
        db,
        VIEWER,
        "art_draft_1",
        OWNER_OPTS,
      ),
    ).rejects.toThrow("CREATE_SKILL_REACHED");
  });
});
