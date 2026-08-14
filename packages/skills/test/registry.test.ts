import { beforeEach, describe, expect, test } from "bun:test";

import {
  createSkillRegistry,
  DRAFT_ASSET_NAME_PREFIX,
  SkillRegistryError,
  type SkillRegistry,
} from "../src/registry";
import { createFakeSkillAccess, createFakeSkillAssets } from "./fakes";
import type { FakeSkillAssets } from "./fakes";
import type { SkillAccessStore } from "../src/access";

const AUTHOR = { tenantId: "tenant_1", principalId: "principal_author" };
const TEAMMATE = { tenantId: "tenant_1", principalId: "principal_teammate" };
const OUTSIDER = { tenantId: "tenant_2", principalId: "principal_author" };

const DRAFT_INPUT = {
  name: "triage",
  description: "Sorts inbound issues into bug, question, or feature.",
  body: "Read the report. Pick exactly one label. Explain the pick.",
};

let assets: FakeSkillAssets;
let access: SkillAccessStore;
let registry: SkillRegistry;

beforeEach(() => {
  assets = createFakeSkillAssets();
  access = createFakeSkillAccess();
  registry = createSkillRegistry({ assets, access });
});

async function publish(scope: "private" | "tenant") {
  await registry.createDraft(AUTHOR, DRAFT_INPUT);
  return registry.publishDraft(AUTHOR, DRAFT_INPUT.name, scope);
}

describe("drafts", () => {
  test("a draft's existence is the pending state — it never appears in the registry", async () => {
    await registry.createDraft(AUTHOR, DRAFT_INPUT);
    expect(await registry.list(AUTHOR)).toHaveLength(0);
    expect(registry.load(AUTHOR, "triage")).rejects.toThrow(SkillRegistryError);
    const drafts = await registry.listDrafts(AUTHOR);
    expect(drafts.map((d) => d.name)).toEqual(["triage"]);
  });

  test("the draft lives on a prefixed skill asset, not an invented asset kind", async () => {
    await registry.createDraft(AUTHOR, DRAFT_INPUT);
    const names = [...assets.assets.values()].map((row) => row.name);
    expect(names).toEqual([`${DRAFT_ASSET_NAME_PREFIX}triage`]);
  });

  test("another principal never sees someone else's pending draft", async () => {
    await registry.createDraft(AUTHOR, DRAFT_INPUT);
    expect(await registry.listDrafts(TEAMMATE)).toHaveLength(0);
  });

  test("a second draft of the same name is a conflict, not a silent overwrite", async () => {
    await registry.createDraft(AUTHOR, DRAFT_INPUT);
    expect(registry.createDraft(AUTHOR, DRAFT_INPUT)).rejects.toThrow(
      /already pending/,
    );
  });

  test("a name inside the reserved draft prefix is refused", async () => {
    expect(
      registry.createDraft(AUTHOR, { ...DRAFT_INPUT, name: "draft-triage" }),
    ).rejects.toThrow(/reserved/);
  });

  test("an invalid skill body is refused before any asset is created", async () => {
    expect(
      registry.createDraft(AUTHOR, { ...DRAFT_INPUT, body: "   " }),
    ).rejects.toThrow(SkillRegistryError);
    expect(assets.assets.size).toBe(0);
  });

  test("discarding a draft removes the pending asset", async () => {
    await registry.createDraft(AUTHOR, DRAFT_INPUT);
    await registry.discardDraft(AUTHOR, "triage");
    expect(assets.assets.size).toBe(0);
  });
});

describe("publish", () => {
  test("converts the draft into a real skill and drops the draft asset", async () => {
    const skill = await publish("tenant");
    expect(skill.name).toBe("triage");
    const names = [...assets.assets.values()].map((row) => row.name);
    expect(names).toEqual(["triage"]);
    expect(await registry.listDrafts(AUTHOR)).toHaveLength(0);
  });

  test("the published skill keeps the drafted description and body", async () => {
    await publish("tenant");
    const loaded = await registry.load(AUTHOR, "triage");
    expect(loaded.description).toBe(DRAFT_INPUT.description);
    expect(loaded.body).toBe(DRAFT_INPUT.body);
  });

  test("publishing without a draft is a not-found, never an empty skill", async () => {
    expect(registry.publishDraft(AUTHOR, "triage", "tenant")).rejects.toThrow(
      /no pending draft/,
    );
  });

  test("another principal cannot publish someone else's draft", async () => {
    await registry.createDraft(AUTHOR, DRAFT_INPUT);
    expect(registry.publishDraft(TEAMMATE, "triage", "tenant")).rejects.toThrow(
      /no pending draft/,
    );
  });

  test("retrying publish after the canonical asset exists but the draft is still pending resumes, without erroring or duplicating", async () => {
    await registry.createDraft(AUTHOR, DRAFT_INPUT);
    const draftRow = await assets.findByName(
      AUTHOR.tenantId,
      `${DRAFT_ASSET_NAME_PREFIX}${DRAFT_INPUT.name}`,
    );
    if (draftRow === null) throw new Error("draft row missing");
    const draftContents = await assets.readSkillMd({
      assetId: draftRow.id,
      skillName: DRAFT_INPUT.name,
    });
    if (draftContents === null) throw new Error("draft SKILL.md missing");

    // Simulate a publish that created the canonical asset and its access
    // row, then crashed or timed out before removing the draft.
    const published = await assets.create({
      tenantId: AUTHOR.tenantId,
      name: DRAFT_INPUT.name,
      displayName: DRAFT_INPUT.name,
      creatorPrincipalId: AUTHOR.principalId,
    });
    await assets.writeSkillMd({
      assetId: published.id,
      skillName: DRAFT_INPUT.name,
      contents: draftContents,
      message: `Publish ${DRAFT_INPUT.name}`,
    });
    await access.upsert({
      assetId: published.id,
      tenantId: AUTHOR.tenantId,
      skillName: DRAFT_INPUT.name,
      creatorPrincipalId: AUTHOR.principalId,
      scope: "tenant",
    });

    const resumed = await registry.publishDraft(AUTHOR, "triage", "tenant");
    expect(resumed.assetId).toBe(published.id);
    expect(await registry.listDrafts(AUTHOR)).toHaveLength(0);
    const names = [...assets.assets.values()].map((row) => row.name);
    expect(names).toEqual(["triage"]);
  });
});

describe("access scoping", () => {
  test("a private skill is listed for its author only", async () => {
    await publish("private");
    expect((await registry.list(AUTHOR)).map((s) => s.name)).toEqual([
      "triage",
    ]);
    expect(await registry.list(TEAMMATE)).toHaveLength(0);
  });

  test("a tenant skill is listed for every principal in the tenant", async () => {
    await publish("tenant");
    expect((await registry.list(TEAMMATE)).map((s) => s.name)).toEqual([
      "triage",
    ]);
  });

  test("no skill is ever visible from another tenant", async () => {
    await publish("tenant");
    expect(await registry.list(OUTSIDER)).toHaveLength(0);
    expect(registry.load(OUTSIDER, "triage")).rejects.toThrow(
      SkillRegistryError,
    );
  });

  test("search never reaches past the caller's own visibility", async () => {
    await publish("private");
    expect(await registry.search(TEAMMATE, "triage")).toHaveLength(0);
    expect(
      (await registry.search(AUTHOR, "triage")).map((s) => s.name),
    ).toEqual(["triage"]);
  });

  test("search matches on the description as well as the name", async () => {
    await publish("tenant");
    expect(await registry.search(AUTHOR, "inbound issues")).toHaveLength(1);
    expect(await registry.search(AUTHOR, "unrelated")).toHaveLength(0);
  });

  test("setScope shares a private skill with the tenant", async () => {
    await publish("private");
    await registry.setScope(AUTHOR, "triage", "tenant");
    expect(await registry.list(TEAMMATE)).toHaveLength(1);
  });

  test("setScope unshares a tenant skill back to its author", async () => {
    await publish("tenant");
    await registry.setScope(AUTHOR, "triage", "private");
    expect(await registry.list(TEAMMATE)).toHaveLength(0);
  });

  test("a teammate who can read a shared skill still cannot rescope it", async () => {
    await publish("tenant");
    expect(registry.setScope(TEAMMATE, "triage", "private")).rejects.toThrow(
      /only the author/,
    );
  });
});

describe("versions", () => {
  test("history comes from the asset's commits, newest first", async () => {
    await publish("tenant");
    const versions = await registry.versions(AUTHOR, "triage");
    expect(versions).toHaveLength(1);
    expect(versions[0]?.current).toBe(true);
    expect(versions[0]?.message).toBe("Publish triage");
  });

  test("restore re-commits an older version and marks it current", async () => {
    await publish("tenant");
    const first = (await registry.versions(AUTHOR, "triage"))[0];
    expect(first).toBeDefined();
    await registry.setScope(AUTHOR, "triage", "tenant");

    // Author a second version by restoring, then confirm the rewind is
    // itself a new commit rather than a rewrite of the history.
    const restored = await registry.restore(
      AUTHOR,
      "triage",
      first?.commitSha ?? "",
    );
    expect(restored.body).toBe(DRAFT_INPUT.body);
    const versions = await registry.versions(AUTHOR, "triage");
    expect(versions).toHaveLength(2);
    expect(versions[0]?.current).toBe(true);
    expect(versions[1]?.commitSha).toBe(first?.commitSha);
  });

  test("restoring a commit that carries no SKILL.md is a not-found", async () => {
    await publish("tenant");
    expect(registry.restore(AUTHOR, "triage", "commit9999")).rejects.toThrow(
      /no SKILL.md at commit/,
    );
  });

  test("a teammate cannot restore a shared skill they did not author", async () => {
    await publish("tenant");
    const first = (await registry.versions(TEAMMATE, "triage"))[0];
    expect(
      registry.restore(TEAMMATE, "triage", first?.commitSha ?? ""),
    ).rejects.toThrow(/only the author/);
  });
});
