import { describe, expect, it } from "bun:test";
import JSZip from "jszip";
import {
  buildSkillBundle,
  buildSkillTree,
  canManageSkill,
  excludeRepoInitCommit,
  filesFromZip,
  isSkillVisible,
  SkillLibraryError,
  toAssetName,
  toVersionEntries,
} from "./skill-library";

describe("canManageSkill", () => {
  it("lets the recorded owner manage, by stable user id", () => {
    expect(
      canManageSkill(
        { ownerUserId: "usr-me", creatorPrincipalId: "prn-other" },
        { userId: "usr-me", principalId: "prn-mine" },
      ),
    ).toBe(true);
  });

  it("blocks a non-owner even when their per-tenant principal differs from the creator", () => {
    expect(
      canManageSkill(
        { ownerUserId: "usr-owner", creatorPrincipalId: "prn-owner" },
        { userId: "usr-me", principalId: "prn-mine" },
      ),
    ).toBe(false);
  });

  it("owner check ignores principal id (shared skill managed from another tenant)", () => {
    // Same user, different per-tenant principal than the creator — still owns it.
    expect(
      canManageSkill(
        { ownerUserId: "usr-me", creatorPrincipalId: "prn-in-creating-tenant" },
        { userId: "usr-me", principalId: "prn-in-viewing-tenant" },
      ),
    ).toBe(true);
  });

  it("falls back to creator principal for legacy rows with no access entry", () => {
    expect(
      canManageSkill(
        { ownerUserId: null, creatorPrincipalId: "prn-mine" },
        { userId: "usr-me", principalId: "prn-mine" },
      ),
    ).toBe(true);
    expect(
      canManageSkill(
        { ownerUserId: null, creatorPrincipalId: "prn-other" },
        { userId: "usr-me", principalId: "prn-mine" },
      ),
    ).toBe(false);
  });

  it("denies a legacy row whose creator principal is null", () => {
    expect(
      canManageSkill(
        { ownerUserId: null, creatorPrincipalId: null },
        { userId: "usr-me", principalId: "prn-mine" },
      ),
    ).toBe(false);
  });
});

describe("excludeRepoInitCommit", () => {
  const content = (oid: string, message: string) => ({
    oid,
    commit: { message, author: { name: "Mae", timestamp: 1700000000 } },
  });

  it("drops the trailing repo-init genesis commit", () => {
    const commits = [
      content("ccc", "Update"),
      content("bbb", "Add my-skill"),
      content("aaa", "Initialize repository"),
    ];
    expect(excludeRepoInitCommit(commits).map((c) => c.oid)).toEqual([
      "ccc",
      "bbb",
    ]);
  });

  it("numbers the first content commit v1 (no spurious extra version)", () => {
    const commits = [
      content("bbb", "Add my-skill"),
      content("aaa", "Initialize repository"),
    ];
    const entries = toVersionEntries(excludeRepoInitCommit(commits));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ version: 1, message: "Add my-skill" });
  });

  it("leaves a normal history untouched", () => {
    const commits = [content("bbb", "Update"), content("aaa", "Add my-skill")];
    expect(excludeRepoInitCommit(commits).map((c) => c.oid)).toEqual([
      "bbb",
      "aaa",
    ]);
  });
});

describe("toVersionEntries", () => {
  const commits = [
    {
      oid: "cccccccdef",
      commit: {
        message: "Update guide\n",
        author: { name: "Mae", timestamp: 1700000200 },
      },
    },
    {
      oid: "bbbbbbbdef",
      commit: {
        message: "Edit\n",
        author: { name: "Mae", timestamp: 1700000100 },
      },
    },
    {
      oid: "aaaaaaadef",
      commit: {
        message: "Add skill\n",
        author: { name: "Mae", timestamp: 1700000000 },
      },
    },
  ];

  it("numbers oldest commit v1 and newest highest", () => {
    const entries = toVersionEntries(commits);
    expect(entries.map((e) => e.version)).toEqual([3, 2, 1]);
    expect(entries[2]?.message).toBe("Add skill");
  });

  it("exposes a 7-character short sha and ISO timestamp", () => {
    const [latest] = toVersionEntries(commits);
    expect(latest?.shortSha).toBe("ccccccc");
    expect(latest?.sha).toBe("cccccccdef");
    expect(latest?.createdAt).toBe(new Date(1700000200 * 1000).toISOString());
  });

  it("returns an empty list for no commits", () => {
    expect(toVersionEntries([])).toEqual([]);
  });
});

describe("isSkillVisible", () => {
  const viewer = {
    ancestorTenantIds: ["workbench-1", "org-1", "root-1"],
    userId: "usr-me",
  };

  it("hides skills whose tenant is outside the viewer ancestor chain", () => {
    expect(
      isSkillVisible(
        {
          assetTenantId: "other-workbench",
          scope: "tenant",
          ownerUserId: "usr-them",
        },
        viewer,
      ),
    ).toBe(false);
  });

  it("shows tenant-scoped skills shared at any ancestor level", () => {
    expect(
      isSkillVisible(
        { assetTenantId: "org-1", scope: "tenant", ownerUserId: "usr-them" },
        viewer,
      ),
    ).toBe(true);
  });

  it("treats a missing access row as tenant-wide (legacy behaviour)", () => {
    expect(
      isSkillVisible(
        { assetTenantId: "org-1", scope: null, ownerUserId: null },
        viewer,
      ),
    ).toBe(true);
  });

  it("shows a private skill only to its owner", () => {
    expect(
      isSkillVisible(
        {
          assetTenantId: "workbench-1",
          scope: "private",
          ownerUserId: "usr-me",
        },
        viewer,
      ),
    ).toBe(true);
    expect(
      isSkillVisible(
        {
          assetTenantId: "workbench-1",
          scope: "private",
          ownerUserId: "usr-them",
        },
        viewer,
      ),
    ).toBe(false);
  });

  it("hides a private skill from the owner when its tenant is out of chain", () => {
    expect(
      isSkillVisible(
        { assetTenantId: "unrelated", scope: "private", ownerUserId: "usr-me" },
        viewer,
      ),
    ).toBe(false);
  });
});

function file(path: string, content: string, mimeType = "text/markdown") {
  return { path, content: Buffer.from(content), mimeType };
}

describe("toAssetName", () => {
  it("lowercases and kebab-cases a display name", () => {
    expect(toAssetName("My ASAP Skill")).toBe("my-asap-skill");
  });

  it("collapses runs of non-alphanumeric characters to a single hyphen", () => {
    expect(toAssetName("Skill: (v2) -- final!")).toBe("skill-v2-final");
  });

  it("strips leading and trailing hyphens", () => {
    expect(toAssetName("---skill---")).toBe("skill");
  });

  it('falls back to "skill" for a blank or symbol-only name', () => {
    expect(toAssetName("")).toBe("skill");
    expect(toAssetName("!!!")).toBe("skill");
  });

  it("truncates to 64 characters", () => {
    expect(toAssetName("a".repeat(100))).toHaveLength(64);
  });
});

describe("buildSkillTree", () => {
  it("places files under <assetName>/ and strips the bundle prefix", () => {
    const bundle = buildSkillBundle([
      file("asap/SKILL.md", "# ASAP"),
      file("asap/guide.md", "guide"),
    ]);
    const contents = new Map(bundle.files.map((f) => [f.path, f.content]));
    const tree = buildSkillTree(
      "asap",
      "An ASAP skill",
      bundle.manifest,
      contents,
    );

    expect(Object.keys(tree).sort()).toEqual([
      "asap/SKILL.md",
      "asap/guide.md",
    ]);
  });

  it("injects YAML frontmatter into SKILL.md, preserving existing body", () => {
    const bundle = buildSkillBundle([file("SKILL.md", "# Body text")]);
    const contents = new Map(bundle.files.map((f) => [f.path, f.content]));
    const tree = buildSkillTree(
      "my-skill",
      "My description",
      bundle.manifest,
      contents,
    );

    const skillMd = new TextDecoder().decode(tree["my-skill/SKILL.md"]);
    expect(skillMd).toContain("name: my-skill");
    expect(skillMd).toContain('description: "My description"');
    expect(skillMd).toContain("# Body text");
  });

  it("replaces existing frontmatter without duplicating it", () => {
    const bundle = buildSkillBundle([
      file("SKILL.md", '---\nname: old\ndescription: "old"\n---\n# Body'),
    ]);
    const contents = new Map(bundle.files.map((f) => [f.path, f.content]));
    const tree = buildSkillTree(
      "new-skill",
      "New desc",
      bundle.manifest,
      contents,
    );

    const skillMd = new TextDecoder().decode(tree["new-skill/SKILL.md"]);
    expect(skillMd.match(/---/g)?.length).toBe(2);
    expect(skillMd).toContain("name: new-skill");
  });

  it("does not produce a ghost SKILL.md copy when entrypoint is nested", () => {
    const bundle = buildSkillBundle([
      file("docs/SKILL.md", "# Nested"),
      file("docs/ref.md", "ref"),
    ]);
    const contents = new Map(bundle.files.map((f) => [f.path, f.content]));
    const tree = buildSkillTree(
      "nested-skill",
      null,
      bundle.manifest,
      contents,
    );
    // canonical entrypoint must exist
    expect("nested-skill/SKILL.md" in tree).toBe(true);
    // original nested path must not remain as a ghost copy
    expect("nested-skill/docs/SKILL.md" in tree).toBe(false);
    // sibling files get the bundle prefix stripped too (docs/ is the common prefix)
    expect("nested-skill/ref.md" in tree).toBe(true);
  });

  it("throws if a manifest file has no content in the map", () => {
    const bundle = buildSkillBundle([file("SKILL.md", "# ASAP")]);
    expect(() =>
      buildSkillTree("asap", null, bundle.manifest, new Map()),
    ).toThrow("Missing content for bundle file");
  });
});

describe("buildSkillBundle", () => {
  it("normalizes a pasted text skill into an immutable one-file manifest", () => {
    const bundle = buildSkillBundle([file("SKILL.md", "# ASAP")]);

    expect(bundle.manifest.entrypointPath).toBe("SKILL.md");
    expect(bundle.manifest.files[0]).toMatchObject({
      path: "SKILL.md",
      promptReadable: true,
      executableLike: false,
    });
    expect(bundle.manifest.checksum).toBeString();
  });

  it("preserves folder paths and marks non-text/code-like files as inert metadata", () => {
    const bundle = buildSkillBundle([
      file("asap/SKILL.md", "# ASAP"),
      file("asap/examples/example.md", "Example"),
      file("asap/assets/logo.png", "not really png", "image/png"),
      file(
        "asap/scripts/build.ts",
        'console.log("stored only")',
        "text/typescript",
      ),
    ]);

    expect(bundle.manifest.entrypointPath).toBe("asap/SKILL.md");
    expect(bundle.manifest.files.map((entry) => entry.path)).toEqual([
      "asap/assets/logo.png",
      "asap/examples/example.md",
      "asap/scripts/build.ts",
      "asap/SKILL.md",
    ]);
    expect(
      bundle.manifest.files.find((entry) => entry.path.endsWith("logo.png")),
    ).toMatchObject({
      promptReadable: false,
      executableLike: false,
    });
    expect(
      bundle.manifest.files.find((entry) => entry.path.endsWith("build.ts")),
    ).toMatchObject({
      promptReadable: true,
      executableLike: true,
    });
  });

  it("extracts zip bundles into normalized bundle files", async () => {
    const zip = new JSZip();
    zip.file("asap/SKILL.md", "# ASAP");
    zip.file("asap/assets/logo.png", "png", { binary: true });
    const content = Buffer.from(
      await zip.generateAsync({ type: "uint8array" }),
    );

    const files = await filesFromZip(content);
    const bundle = buildSkillBundle(files);

    expect(bundle.manifest.entrypointPath).toBe("asap/SKILL.md");
    expect(bundle.manifest.files.map((entry) => entry.path)).toContain(
      "asap/assets/logo.png",
    );
  });

  it("rejects oversized zip bundles during extraction", async () => {
    const zip = new JSZip();
    zip.file("SKILL.md", "# ASAP");
    zip.file("large.txt", "x".repeat(21 * 1024 * 1024));
    const content = Buffer.from(
      await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
    );

    await expect(filesFromZip(content)).rejects.toThrow("Skill bundle exceeds");
  }, 20000);

  it("rejects invalid zip archives with a client-safe error", async () => {
    await expect(filesFromZip(Buffer.from("not a zip"))).rejects.toThrow(
      "Invalid zip archive",
    );
  });

  it("rejects path traversal and missing markdown entrypoints", () => {
    expect(() => buildSkillBundle([file("../SKILL.md", "# nope")])).toThrow(
      SkillLibraryError,
    );
    expect(() =>
      buildSkillBundle([file("asset.png", "binary", "image/png")]),
    ).toThrow(
      "Skill bundle must include SKILL.md or at least one markdown file",
    );
  });
});
