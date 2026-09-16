import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  buildNeedsList,
  childTenantStore,
  NeedsListSchema,
  parseNeedsList,
  threadLinkStore,
  type StringStorage,
} from "./needs-list";

function memoryStorage(initial: Record<string, string> = {}): StringStorage {
  const rows = new Map(Object.entries(initial));
  return {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => {
      rows.set(key, value);
    },
  };
}

describe("portable needs-list", () => {
  test("represents the primary tenant, top-level Myra, and workbench children — never DMs", () => {
    const manifest = buildNeedsList({
      account: { id: "usr_1", email: "ada@example.com", name: "Ada" },
      myraDefinitionRefId: "assistant",
      workbenches: [
        {
          localId: "atlas",
          slug: "ada-atlas",
          name: "Atlas",
          principals: [
            {
              kind: "user",
              refId: "usr_2",
              email: "bea@example.com",
              roles: ["member"],
            },
          ],
          initialMessage: { runId: "run_atlas", content: "Kick off Atlas." },
        },
      ],
    });

    expect(manifest).toMatchObject({
      version: 1,
      account: { id: "usr_1" },
      primaryTenant: { kind: "primary", want: "existing" },
      myra: {
        definitionRefId: "assistant",
        scope: "top-level",
        want: "running",
      },
    });
    expect("directMessages" in manifest).toBe(false);
    expect(manifest.workbenches[0]).toMatchObject({
      kind: "workbench",
      parent: "primary",
      principals: [{ kind: "user", refId: "usr_2", status: "active" }],
      initialMessage: { runId: "run_atlas", content: "Kick off Atlas." },
    });
    expect(parseNeedsList(manifest) instanceof type.errors).toBe(false);
    expect(NeedsListSchema).toBeDefined();
  });

  test("rejects an unknown manifest version", () => {
    const manifest = buildNeedsList({
      account: { id: "usr_1", email: "ada@example.com", name: "Ada" },
      myraDefinitionRefId: "assistant",
    });
    expect(
      parseNeedsList({ ...manifest, version: 2 }) instanceof type.errors,
    ).toBe(true);
  });
});

describe("account and hub scoped child-tenant store", () => {
  test("does not leak ids between accounts or hubs and deduplicates local ids", () => {
    const storage = memoryStorage();
    const ada = childTenantStore(storage, "https://one.example", "usr_ada");
    const bea = childTenantStore(storage, "https://one.example", "usr_bea");
    const otherHub = childTenantStore(
      storage,
      "https://two.example",
      "usr_ada",
    );

    ada.record({
      localId: "atlas",
      tenantId: "tnt_old",
      kind: "workbench",
    });
    ada.record({
      localId: "atlas",
      tenantId: "tnt_current",
      kind: "workbench",
      primaryThreadMessageId: "<primary@example>",
      icon: "mountain",
      prefs: { tone: "brief" },
    });

    expect(ada.load()).toEqual([
      {
        localId: "atlas",
        tenantId: "tnt_current",
        kind: "workbench",
        primaryThreadMessageId: "<primary@example>",
        icon: "mountain",
        prefs: { tone: "brief" },
      },
    ]);
    expect(bea.load()).toEqual([]);
    expect(otherHub.load()).toEqual([]);
  });

  test("treats corrupt client state as empty", () => {
    const storage = memoryStorage({
      "workbench.child-tenants:https%3A%2F%2Fone.example:usr_ada": "not json",
    });
    expect(
      childTenantStore(storage, "https://one.example", "usr_ada").load(),
    ).toEqual([]);
  });

  test("keeps valid rows when one row is corrupt, and drops legacy DM rows", () => {
    const storage = memoryStorage({
      "workbench.child-tenants:https%3A%2F%2Fone.example:usr_ada":
        JSON.stringify([
          {
            localId: "atlas",
            tenantId: "tnt_atlas",
            kind: "workbench",
            primaryThreadMessageId: "<primary@example>",
          },
          { localId: "", tenantId: "tnt_bad", kind: "workbench" },
          {
            localId: "dm:run_myra",
            tenantId: "tnt_dm",
            kind: "chat",
            principalRefId: "run_myra",
          },
          null,
        ]),
    });
    expect(
      childTenantStore(storage, "https://one.example", "usr_ada").load(),
    ).toEqual([
      {
        localId: "atlas",
        tenantId: "tnt_atlas",
        kind: "workbench",
        primaryThreadMessageId: "<primary@example>",
      },
    ]);
  });
});

describe("account and hub scoped thread-link store", () => {
  test("holds sub-thread fork links beside created ids, deduped by Message-ID", () => {
    const storage = memoryStorage();
    const ada = threadLinkStore(storage, "https://one.example", "usr_ada");
    const bea = threadLinkStore(storage, "https://one.example", "usr_bea");

    ada.record({
      workbenchLocalId: "atlas",
      messageId: "<sub@example>",
      inReplyTo: "<primary@example>",
      references: ["<primary@example>"],
    });
    ada.record({
      workbenchLocalId: "atlas",
      messageId: "<sub@example>",
      inReplyTo: "<primary@example>",
      references: ["<primary@example>", "<sub@example>"],
    });

    expect(ada.load()).toEqual([
      {
        workbenchLocalId: "atlas",
        messageId: "<sub@example>",
        inReplyTo: "<primary@example>",
        references: ["<primary@example>", "<sub@example>"],
      },
    ]);
    expect(bea.load()).toEqual([]);
  });

  test("treats corrupt client state as empty and skips bad rows", () => {
    const storage = memoryStorage({
      "workbench.thread-links:https%3A%2F%2Fone.example:usr_ada":
        JSON.stringify([
          { workbenchLocalId: "atlas", messageId: "<sub@example>" },
          { workbenchLocalId: "", messageId: "<bad@example>" },
          null,
        ]),
    });
    expect(
      threadLinkStore(storage, "https://one.example", "usr_ada").load(),
    ).toEqual([{ workbenchLocalId: "atlas", messageId: "<sub@example>" }]);
    expect(
      threadLinkStore(
        memoryStorage({
          "workbench.thread-links:https%3A%2F%2Fone.example:usr_ada":
            "not json",
        }),
        "https://one.example",
        "usr_ada",
      ).load(),
    ).toEqual([]);
  });
});
