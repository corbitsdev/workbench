import { describe, expect, it } from "bun:test";
import { buildToolGrantRows, TOOL_GRANT_RESOURCE_PREFIX } from "./tool-grants";

const scope = { tenantId: "tnt_1", principalId: "prn_1" };
const now = new Date("2026-06-08T00:00:00.000Z");

describe("buildToolGrantRows", () => {
  it("builds one allow/invoke/system grant per tool, scoped to the principal", () => {
    const rows = buildToolGrantRows(
      ["exa_search", "granola_list_notes"],
      scope,
      now,
    );
    expect(rows).toHaveLength(2);
    const exa = rows.find(
      (r) => r.resource === `${TOOL_GRANT_RESOURCE_PREFIX}exa_search`,
    );
    expect(exa).toBeDefined();
    expect(exa).toMatchObject({
      tenantId: "tnt_1",
      principalId: "prn_1",
      roleId: null,
      action: "invoke",
      effect: "allow",
      origin: "system",
      conditions: null,
      expiresAt: null,
    });
    expect(exa?.id.startsWith("grt_")).toBe(true);
    expect(exa?.createdAt).toEqual(now);
  });

  it("de-duplicates repeated tool names", () => {
    const rows = buildToolGrantRows(["exa_search", "exa_search"], scope, now);
    expect(rows).toHaveLength(1);
  });

  it("keys the grant resource on the LLM-safe name for canonical package tools (CL-2306)", () => {
    const rows = buildToolGrantRows(
      ["@workbench/tools-exa/exa:exa_search"],
      scope,
      now,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource).toBe(`${TOOL_GRANT_RESOURCE_PREFIX}exa__search`);
  });

  it("returns no rows for an empty tool list", () => {
    expect(buildToolGrantRows([], scope, now)).toEqual([]);
  });

  it("stamps every grant 'allow' — approval is enforced at the sidecar runner, not the grant", () => {
    const rows = buildToolGrantRows(
      ["@workbench/tools-attio/attio:attio_update_task", "exa_search"],
      scope,
      now,
    );
    expect(rows.every((r) => r.effect === "allow")).toBe(true);
  });

  it("assigns a distinct id to each grant", () => {
    const rows = buildToolGrantRows(["a", "b", "c"], scope, now);
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(3);
  });

  describe("askToolNames (native-approvals activation)", () => {
    it("stamps 'ask' on grants whose LLM-safe name is in askToolNames, 'allow' otherwise", () => {
      const rows = buildToolGrantRows(
        ["@workbench/tools-attio/attio:attio_update_task", "exa_search"],
        scope,
        now,
        { askToolNames: new Set(["attio__update_task"]) },
      );
      const attio = rows.find(
        (r) => r.resource === `${TOOL_GRANT_RESOURCE_PREFIX}attio__update_task`,
      );
      const exa = rows.find(
        (r) => r.resource === `${TOOL_GRANT_RESOURCE_PREFIX}exa_search`,
      );
      expect(attio?.effect).toBe("ask");
      expect(exa?.effect).toBe("allow");
    });

    it("matches askToolNames against the mapped LLM-safe name, not the bare input name", () => {
      const rows = buildToolGrantRows(
        ["@workbench/tools-slack/slack:slack_post_message"],
        scope,
        now,
        // the ask set carries the LLM-safe name the model actually invokes
        { askToolNames: new Set(["slack__post_message"]) },
      );
      expect(rows[0]?.effect).toBe("ask");
    });

    it("leaves every grant 'allow' when askToolNames is empty or omitted", () => {
      const omitted = buildToolGrantRows(["exa_search"], scope, now);
      const empty = buildToolGrantRows(["exa_search"], scope, now, {
        askToolNames: new Set(),
      });
      expect(omitted[0]?.effect).toBe("allow");
      expect(empty[0]?.effect).toBe("allow");
    });
  });
});
