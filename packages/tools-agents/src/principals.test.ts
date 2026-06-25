import { describe, expect, it, mock } from "bun:test";
import type { DB } from "@intx/db";
import {
  createPrincipalsTools,
  LIST_PRINCIPALS_DEFINITION,
  resolvePrincipalKind,
  resolvePrincipalStatusFilter,
} from "./principals";
import { AGENTS_HUB_TOOLS } from "./index";

function makeContext(rows: unknown[]) {
  let limitArg = -1;

  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: (n: number) => {
      limitArg = n;
      return Promise.resolve(rows);
    },
  };

  const db = {
    select: mock(() => chain),
  } as unknown as DB["db"];

  return {
    context: { db, tenantId: "tnt_local" },
    getLimit: () => limitArg,
  };
}

function handler(context: { db: DB["db"]; tenantId: string }) {
  const tool = createPrincipalsTools(context)[0];
  if (!tool?.handler) throw new Error("expected a handler");
  return (args: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve(
      (tool.handler as (a: Record<string, unknown>) => Promise<unknown>)(args),
    );
}

describe("LIST_PRINCIPALS_DEFINITION", () => {
  it("takes no required arguments and is registered under list_principals", () => {
    expect(LIST_PRINCIPALS_DEFINITION.inputSchema.required).toEqual([]);
    expect(AGENTS_HUB_TOOLS.list_principals.definition).toBe(
      LIST_PRINCIPALS_DEFINITION,
    );
  });
});

describe("resolvePrincipalKind", () => {
  it("returns undefined (no filter) when no kind is given", () => {
    expect(resolvePrincipalKind(undefined)).toBeUndefined();
  });

  it("returns the kind when valid", () => {
    expect(resolvePrincipalKind("user")).toBe("user");
    expect(resolvePrincipalKind("agent")).toBe("agent");
  });

  it("throws for an unknown kind", () => {
    expect(() => resolvePrincipalKind("robot")).toThrow(/kind must be one of/);
  });
});

describe("resolvePrincipalStatusFilter", () => {
  it("defaults to active when no status is given", () => {
    expect(resolvePrincipalStatusFilter(undefined)).toBe("active");
  });

  it("returns undefined (no filter) for the all escape hatch", () => {
    expect(resolvePrincipalStatusFilter("all")).toBeUndefined();
  });

  it("returns a valid granular status", () => {
    expect(resolvePrincipalStatusFilter("suspended")).toBe("suspended");
  });

  it("throws including all for an unknown status", () => {
    expect(() => resolvePrincipalStatusFilter("banana")).toThrow(
      /status must be one of:.*all/,
    );
  });
});

describe("list_principals handler", () => {
  it("returns the principal rows from the query and defaults the limit", async () => {
    const rows = [
      {
        principalId: "prn_1",
        kind: "user",
        refId: "usr_1",
        status: "active",
        tenantId: "tnt_local",
      },
      {
        principalId: "prn_2",
        kind: "agent",
        refId: "agt_1",
        status: "active",
        tenantId: "tnt_local",
      },
    ];
    const { context, getLimit } = makeContext(rows);

    const result = JSON.parse((await handler(context)({})) as string);

    expect(result).toEqual({ principals: rows });
    expect(getLimit()).toBe(50);
  });

  it("accepts kind and status filters", async () => {
    const { context } = makeContext([]);
    expect(
      JSON.parse(
        (await handler(context)({ kind: "agent", status: "all" })) as string,
      ),
    ).toEqual({ principals: [] });
  });

  it("rejects an unknown kind", async () => {
    const { context } = makeContext([]);
    await expect(handler(context)({ kind: "robot" })).rejects.toThrow(
      /kind must be one of/,
    );
  });
});
