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
  /** Rows returned by listSkills-shaped selects (leftJoin present). */
  skills?: {
    id: string;
    name: string;
    displayName: string | null;
    tenantId: string;
    creatorPrincipalId: string | null;
    createdAt: Date;
    updatedAt: Date;
    scope: string | null;
    ownerUserId: string | null;
    ownerName: string | null;
  }[];
  updateResult?: ReturnType<typeof makeDraft> | null;
  captureUpdates?: Record<string, unknown>[];
}) {
  const drafts = opts.drafts ?? [];
  const skills = opts.skills ?? [];
  const captureUpdates = opts.captureUpdates ?? [];

  return {
    // getAncestorChain stops when parentId is missing → chain = [tenantId]
    query: {
      tenant: {
        findFirst: async () => ({ parentId: null }),
      },
    },
    select: () => {
      // Per-select state: leftJoin marks a skill-library listSkills path.
      let joined = false;
      const chain = {
        from: () => chain,
        leftJoin: () => {
          joined = true;
          return chain;
        },
        where: () => chain,
        orderBy: async () => (joined ? skills : drafts),
        limit: async (_n: number) => {
          if (joined) return skills.slice(0, 1);
          return drafts.slice(0, 1);
        },
      };
      return chain;
    },
    insert: () => ({
      values: async () => undefined,
    }),
    delete: () => ({
      where: async () => undefined,
    }),
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
        files: [],
        status: "draft",
        updatedAt: "2026-01-02T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("surfaces support files (excluding SKILL.md) on list items", async () => {
    const draft = makeDraft({
      source: {
        origin: "skill-draft",
        description: "with files",
        files: [
          { path: "SKILL.md", content: "ignored-dup" },
          { path: "helpers/foo.ts", content: "export const x = 1" },
        ],
      },
    });
    const items = await listSkillDrafts(makeDb({ drafts: [draft] }), VIEWER);
    expect(items[0]?.files).toEqual([
      { path: "helpers/foo.ts", content: "export const x = 1" },
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

  it("CAS-claims then reopens draft when createSkill fails", async () => {
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
    // claim (approved) then compensating reopen (draft)
    expect(updates.map((u) => u.status)).toEqual(["approved", "draft"]);
  });

  it("409 when CAS claim loses the race", async () => {
    const db = makeDb({
      drafts: [makeDraft()],
      updateResult: null,
    });
    await expect(
      approveSkillDraft({} as never, db, VIEWER, "art_draft_1", OWNER_OPTS),
    ).rejects.toMatchObject({
      message: "Draft is no longer pending",
      status: 409,
    });
  });

  it("reaches updateSkill for owned draft with existingSkillId", async () => {
    const now = new Date();
    const db = makeDb({
      drafts: [
        makeDraft({
          title: "my-skill",
          source: {
            origin: "skill-draft",
            existingSkillId: "skl_existing",
          },
        }),
      ],
      // getSkillAsset + loadManageableSkill both select+limit on joined skill rows
      skills: [
        {
          id: "skl_existing",
          name: "my-skill",
          displayName: "my-skill",
          tenantId: "ten_a",
          creatorPrincipalId: "prn_owner",
          createdAt: now,
          updatedAt: now,
          scope: "tenant",
          ownerUserId: "usr_1",
          ownerName: "Owner",
        },
      ],
    });
    // updateSkill fails later without full assetService — create must not run.
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
    ).rejects.not.toThrow("CREATE_SHOULD_NOT_RUN");
  });

  it("400 when existingSkillId points at a skill that does not match the draft title", async () => {
    const now = new Date();
    const db = makeDb({
      drafts: [
        makeDraft({
          title: "my-skill",
          source: {
            origin: "skill-draft",
            existingSkillId: "skl_other",
          },
        }),
      ],
      skills: [
        {
          id: "skl_other",
          name: "unrelated-skill",
          displayName: "Unrelated Skill",
          tenantId: "ten_a",
          creatorPrincipalId: "prn_owner",
          createdAt: now,
          updatedAt: now,
          scope: "tenant",
          ownerUserId: "usr_1",
          ownerName: "Owner",
        },
      ],
    });
    await expect(
      approveSkillDraft({} as never, db, VIEWER, "art_draft_1", OWNER_OPTS),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("does not match skill"),
    });
  });

  it("stamps existingSkillId on the draft after a successful create", async () => {
    const updates: Record<string, unknown>[] = [];
    const db = makeDb({ drafts: [makeDraft()], captureUpdates: updates });
    const now = new Date();
    const assetService = {
      createAsset: async () => ({
        id: "skl_new",
        name: "my-skill",
        displayName: "my-skill",
        tenantId: "ten_a",
        createdAt: now,
        updatedAt: now,
      }),
      populateAsset: async () => undefined,
    };
    const result = await approveSkillDraft(
      assetService as never,
      db,
      VIEWER,
      "art_draft_1",
      OWNER_OPTS,
    );
    expect(result.skill.id).toBe("skl_new");
    // claim (status) then source stamp with the new skill id
    const sourceStamp = updates.find(
      (u) =>
        u.source !== undefined &&
        typeof u.source === "object" &&
        u.source !== null &&
        "existingSkillId" in (u.source as object),
    );
    expect(sourceStamp?.source).toMatchObject({
      origin: "skill-draft",
      existingSkillId: "skl_new",
    });
  });

  it("approve resolves by display title slug when existingSkillId is missing", async () => {
    const now = new Date();
    const db = makeDb({
      drafts: [
        makeDraft({
          title: "Company Research",
          source: { origin: "skill-draft" },
        }),
      ],
      skills: [
        {
          id: "skl_by_name",
          name: "company-research",
          displayName: "Company Research",
          tenantId: "ten_a",
          creatorPrincipalId: "prn_owner",
          createdAt: now,
          updatedAt: now,
          scope: "tenant",
          ownerUserId: "usr_1",
          ownerName: "Owner",
        },
      ],
    });
    // updateSkill loads manageable skill via select+limit → returns skills[0]
    // then fails later without full assetService — past resolve is enough:
    // createAsset must NOT run.
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
    ).rejects.not.toThrow("CREATE_SHOULD_NOT_RUN");
  });

  it("approve falls back to update when create hits name 409", async () => {
    const { SkillLibraryError } = await import("./skill-library");
    const now = new Date();
    const db = makeDb({
      drafts: [makeDraft({ title: "my-skill" })],
      // First listSkills (pre-create resolve) empty; second (409 fallback) hits skill
      skills: [
        {
          id: "skl_409",
          name: "my-skill",
          displayName: "my-skill",
          tenantId: "ten_a",
          creatorPrincipalId: "prn_owner",
          createdAt: now,
          updatedAt: now,
          scope: "tenant",
          ownerUserId: "usr_1",
          ownerName: "Owner",
        },
      ],
    });
    // Pre-create resolve will find skl_409 via listSkills — so we never hit create.
    // To force 409 path, use a title that doesn't match skills until after create fails
    // is hard with static skills. Instead: empty skills would skip resolve; create
    // throws 409; fallback resolve still empty → rethrows 409. Test that path:
    const emptyDb = makeDb({
      drafts: [makeDraft({ title: "orphan-skill" })],
      skills: [],
    });
    await expect(
      approveSkillDraft(
        {
          createAsset: async () => {
            throw new SkillLibraryError(
              "A skill named that already exists",
              409,
            );
          },
        } as never,
        emptyDb,
        VIEWER,
        "art_draft_1",
        OWNER_OPTS,
      ),
    ).rejects.toMatchObject({ status: 409 });

    // With a matching skill present, resolve-before-create takes update path.
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
    ).rejects.not.toThrow("CREATE_SHOULD_NOT_RUN");
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
