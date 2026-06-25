import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { createMembersRouter } from "./members";

describe("Members router", () => {
  function wrapWithAuth(
    router: Hono<{ Variables: { userId: string } }>,
    userId = "user-1",
  ): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("userId" as never, userId);
      await next();
    });
    app.route("/", router);
    return app;
  }

  it("returns 400 when tenantId is missing", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: structural mock
    const db: any = {
      query: {
        principal: { findFirst: mock(() => Promise.resolve(undefined)) },
      },
    };
    const app = wrapWithAuth(createMembersRouter(db));
    const res = await app.request("/members");
    expect(res.status).toBe(400);
  });

  it("returns 403 when caller is not a tenant member", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: structural mock
    const db: any = {
      query: {
        principal: {
          findFirst: mock(() => Promise.resolve(undefined)),
        },
      },
    };
    const app = wrapWithAuth(createMembersRouter(db));
    const res = await app.request("/members?tenantId=tn-1");
    expect(res.status).toBe(403);
  });

  it("returns member list with display names for a tenant", async () => {
    const callerPrincipal = { id: "prn-1", refId: "usr-1" };
    const userPrincipals = [
      { id: "prn-1", refId: "usr-1", kind: "user" },
      { id: "prn-2", refId: "usr-2", kind: "user" },
    ];
    const users = [
      { id: "usr-1", name: "Alice" },
      { id: "usr-2", name: "Bob" },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: structural mock
    const db: any = {
      query: {
        principal: {
          findFirst: mock(() => Promise.resolve(callerPrincipal)),
          findMany: mock(() => Promise.resolve(userPrincipals)),
        },
        user: {
          findMany: mock(() => Promise.resolve(users)),
        },
      },
    };
    const app = wrapWithAuth(createMembersRouter(db));
    const res = await app.request("/members?tenantId=tn-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: { id: string; name: string }[];
    };
    expect(body.members).toHaveLength(2);
    const alice = body.members.find((m) => m.id === "prn-1");
    const bob = body.members.find((m) => m.id === "prn-2");
    expect(alice?.name).toBe("Alice");
    expect(bob?.name).toBe("Bob");
  });

  it("omits user principals with no matching user row", async () => {
    const callerPrincipal = { id: "prn-1", refId: "usr-1" };
    const userPrincipals = [
      { id: "prn-1", refId: "usr-1", kind: "user" },
      { id: "prn-ABCDEFGH", refId: "system", kind: "user" },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: structural mock
    const db: any = {
      query: {
        principal: {
          findFirst: mock(() => Promise.resolve(callerPrincipal)),
          findMany: mock(() => Promise.resolve(userPrincipals)),
        },
        user: {
          findMany: mock(() =>
            Promise.resolve([{ id: "usr-1", name: "Alice" }]),
          ),
        },
      },
    };
    const app = wrapWithAuth(createMembersRouter(db));
    const res = await app.request("/members?tenantId=tn-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: { id: string; name: string }[];
    };
    expect(body.members).toHaveLength(1);
    expect(body.members[0]?.id).toBe("prn-1");
    expect(body.members.find((m) => m.id === "prn-ABCDEFGH")).toBeUndefined();
  });
});
