import { beforeEach, describe, expect, test } from "bun:test";

import {
  createSkillRegistry,
  SkillRegistryError,
  type SkillRegistry,
} from "../src/registry";
import { createFakeSkillAccess, createFakeSkillAssets } from "./fakes";
import type { FakeSkillAssets } from "./fakes";
import type { SkillAccessStore } from "../src/access";

const AUTHOR = { tenantId: "tenant_1", principalId: "principal_author" };
const TEAMMATE = { tenantId: "tenant_1", principalId: "principal_teammate" };
const OUTSIDER = { tenantId: "tenant_2", principalId: "principal_author" };

const CREATE_INPUT = {
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
  return registry.create(AUTHOR, { ...CREATE_INPUT, scope });
}

describe("create", () => {
  test("creates a real skill immediately, with no pending state in between", async () => {
    const skill = await publish("tenant");
    expect(skill.name).toBe("triage");
    const names = [...assets.assets.values()].map((row) => row.name);
    expect(names).toEqual(["triage"]);
    expect((await registry.list(AUTHOR)).map((s) => s.name)).toEqual([
      "triage",
    ]);
  });

  test("the created skill keeps the authored description and body", async () => {
    await publish("tenant");
    const loaded = await registry.load(AUTHOR, "triage");
    expect(loaded.description).toBe(CREATE_INPUT.description);
    expect(loaded.body).toBe(CREATE_INPUT.body);
  });

  test("a second skill of the same name is a conflict, not a silent overwrite", async () => {
    await publish("private");
    expect(
      registry.create(AUTHOR, { ...CREATE_INPUT, scope: "private" }),
    ).rejects.toThrow(/already exists/);
  });

  test("an invalid skill body is refused before any asset is created", async () => {
    expect(
      registry.create(AUTHOR, {
        ...CREATE_INPUT,
        body: "   ",
        scope: "private",
      }),
    ).rejects.toThrow(SkillRegistryError);
    expect(assets.assets.size).toBe(0);
  });

  test("invalid SKILL.md frontmatter (a name the schema rejects) is refused before any asset is created", async () => {
    expect(
      registry.create(AUTHOR, {
        ...CREATE_INPUT,
        name: "Not A Valid Name",
        scope: "private",
      }),
    ).rejects.toThrow(SkillRegistryError);
    expect(assets.assets.size).toBe(0);
  });

  test("a name that fails the kebab-case pattern gets a plain-language message, never the raw regex", async () => {
    await expect(
      registry.create(AUTHOR, {
        ...CREATE_INPUT,
        name: "Not A Valid Name",
        scope: "private",
      }),
    ).rejects.toThrow("Name must be lowercase letters, digits, and hyphens.");
  });

  test("a description with an HTML tag gets a plain-language message, never the raw regex", async () => {
    await expect(
      registry.create(AUTHOR, {
        ...CREATE_INPUT,
        description: "<script>bad</script>",
        scope: "private",
      }),
    ).rejects.toThrow("Description can't contain HTML tags.");
  });

  test("retrying create after a failure between the asset write and the access-row write completes it, rather than 409ing forever", async () => {
    // Simulates the exact crash window `create` cannot make transactional:
    // the asset and its SKILL.md commit succeed, but the access-row write
    // — the last step — fails once (a db timeout, say).
    let failNext = true;
    const flakyAccess: SkillAccessStore = {
      ...access,
      async upsert(row) {
        if (failNext) {
          failNext = false;
          throw new Error("simulated write failure (e.g. db timeout)");
        }
        return access.upsert(row);
      },
    };
    const flakyRegistry = createSkillRegistry({ assets, access: flakyAccess });

    await expect(
      flakyRegistry.create(AUTHOR, { ...CREATE_INPUT, scope: "private" }),
    ).rejects.toThrow(/simulated write failure/);

    // The asset was created and left behind, but is invisible: no access
    // row backs it yet.
    expect(assets.assets.size).toBe(1);
    expect(await flakyRegistry.list(AUTHOR)).toHaveLength(0);

    // Retrying the exact same create — the natural recovery a user or
    // client would attempt — finishes the interrupted write instead of
    // 409ing on a name this same caller can never use again.
    const completed = await flakyRegistry.create(AUTHOR, {
      ...CREATE_INPUT,
      scope: "private",
    });
    expect(completed.name).toBe("triage");
    expect(assets.assets.size).toBe(1);
    expect((await flakyRegistry.list(AUTHOR)).map((s) => s.name)).toEqual([
      "triage",
    ]);

    // A third attempt now hits a fully-formed skill and is a genuine
    // conflict.
    await expect(
      flakyRegistry.create(AUTHOR, { ...CREATE_INPUT, scope: "private" }),
    ).rejects.toThrow(/already exists/);
  });

  test("a caller can never complete another principal's half-written create", async () => {
    let failNext = true;
    const flakyAccess: SkillAccessStore = {
      ...access,
      async upsert(row) {
        if (failNext) {
          failNext = false;
          throw new Error("simulated write failure");
        }
        return access.upsert(row);
      },
    };
    const flakyRegistry = createSkillRegistry({ assets, access: flakyAccess });
    await expect(
      flakyRegistry.create(AUTHOR, { ...CREATE_INPUT, scope: "private" }),
    ).rejects.toThrow(/simulated write failure/);

    // A different principal retrying the same name hits a conflict, not
    // a takeover of the first caller's orphaned asset.
    await expect(
      registry.create(TEAMMATE, { ...CREATE_INPUT, scope: "private" }),
    ).rejects.toThrow(/already exists/);
    expect(await registry.list(TEAMMATE)).toHaveLength(0);
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
    expect(versions[0]?.message).toBe("Create triage");
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
    expect(restored.body).toBe(CREATE_INPUT.body);
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
