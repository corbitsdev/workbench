import { describe, expect, it, mock } from "bun:test";
import { deriveUserMailAddress } from "@workbench/hub-agent";
import type { Task } from "@workbench/shared";
import type { HubDb } from "../db";

mock.module("../config", () => ({
  getConfig: () => ({
    cors: { origins: ["https://app.example"] },
    auth: { baseUrl: "https://auth.example" },
  }),
}));

let preferences: Record<string, unknown> = {};
mock.module("./member-preferences", () => ({
  readMemberPreferences: async () => preferences,
}));

const { deliverTaskMail } = await import("./deliver-task-mail");

const TENANT_ROW = { id: "ten-1", domain: "tenant.example" };
const OWNER_PRINCIPAL = {
  id: "prn-owner",
  tenantId: "ten-1",
  refId: "owner-1",
  kind: "user",
};
const ACTOR_USER_PRINCIPAL = {
  id: "prn-actor",
  tenantId: "ten-1",
  refId: "actor-1",
  kind: "user",
};
const ACTOR_AGENT_PRINCIPAL = {
  id: "prn-agent",
  tenantId: "ten-1",
  refId: "agent-1",
  kind: "agent",
};

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    tenantId: "ten-1",
    ownerPrincipalId: "prn-owner",
    createdByPrincipalId: "prn-actor",
    title: "Follow up with Acme",
    status: "open",
    source: "agent",
    links: [],
    externalRefs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDb(opts: {
  principals: Record<string, unknown>;
  users?: Record<string, { id: string; name: string }>;
  agents?: Record<string, { id: string; name: string }>;
}) {
  const inserted: Record<string, unknown>[] = [];
  const returning = mock(async () => [{ id: "row-1" }]);
  const onConflictDoNothing = mock(() => ({ returning }));
  const values = mock((row: Record<string, unknown>) => {
    inserted.push(row);
    return { onConflictDoNothing };
  });
  const findPrincipalByEmbeddedId = (where: unknown): string | undefined => {
    // Walk the drizzle `eq(principal.id, X)` expression looking for a value
    // that matches a key in opts.principals.
    const seen = new Set<unknown>();
    const walk = (value: unknown): string | undefined => {
      if (typeof value === "string" && opts.principals[value]) return value;
      if (value === null || typeof value !== "object" || seen.has(value))
        return undefined;
      seen.add(value);
      for (const v of Object.values(value)) {
        const found = walk(v);
        if (found) return found;
      }
      return undefined;
    };
    return walk(where);
  };
  const db = {
    insert: mock(() => ({ values })),
    query: {
      tenant: { findFirst: mock(async () => TENANT_ROW) },
      principal: {
        findFirst: mock(async ({ where }: { where: unknown }) => {
          const id = findPrincipalByEmbeddedId(where);
          return id ? opts.principals[id] : undefined;
        }),
      },
      user: {
        findFirst: mock(async ({ where }: { where: unknown }) => {
          const seen = new Set<unknown>();
          const walk = (value: unknown): string | undefined => {
            if (typeof value === "string" && opts.users?.[value]) return value;
            if (value === null || typeof value !== "object" || seen.has(value))
              return undefined;
            seen.add(value);
            for (const v of Object.values(value)) {
              const found = walk(v);
              if (found) return found;
            }
            return undefined;
          };
          const id = walk(where);
          return id ? opts.users?.[id] : undefined;
        }),
      },
      agent: {
        findFirst: mock(async ({ where }: { where: unknown }) => {
          const seen = new Set<unknown>();
          const walk = (value: unknown): string | undefined => {
            if (typeof value === "string" && opts.agents?.[value]) return value;
            if (value === null || typeof value !== "object" || seen.has(value))
              return undefined;
            seen.add(value);
            for (const v of Object.values(value)) {
              const found = walk(v);
              if (found) return found;
            }
            return undefined;
          };
          const id = walk(where);
          return id ? opts.agents?.[id] : undefined;
        }),
      },
    },
  } as unknown as HubDb;
  return { db, inserted };
}

describe("deliverTaskMail", () => {
  it("skips a self-event (actor is the owner)", async () => {
    preferences = {};
    const { db, inserted } = makeDb({
      principals: { "prn-owner": OWNER_PRINCIPAL },
    });
    await deliverTaskMail({
      db,
      tenantId: "ten-1",
      task: baseTask({ createdByPrincipalId: "prn-owner" }),
      event: "created",
      actorPrincipalId: "prn-owner",
    });
    expect(inserted).toHaveLength(0);
  });

  it("writes a mailbox row for an agent-assigned task, addressed to the owner", async () => {
    preferences = {};
    const { db, inserted } = makeDb({
      principals: {
        "prn-owner": OWNER_PRINCIPAL,
        "prn-agent": ACTOR_AGENT_PRINCIPAL,
      },
      agents: { "agent-1": { id: "agent-1", name: "Myra" } },
    });
    await deliverTaskMail({
      db,
      tenantId: "ten-1",
      task: baseTask(),
      event: "assigned",
      actorPrincipalId: "prn-agent",
    });
    expect(inserted).toHaveLength(1);
    const row = inserted[0] as Record<string, unknown>;
    expect(row.principalId).toBe("prn-owner");
    // Pins the ONE canonical principal-mailbox address format: this writer
    // must match deriveUserMailAddress's output, not a locally reconstructed
    // string.
    expect(row.address).toBe(
      deriveUserMailAddress({
        userRefId: "owner-1",
        domain: "tenant.example",
      }),
    );
    expect(row.subject).toBe("Myra assigned you: Follow up with Acme");
    expect(row.messageKey).toBe("task:task-1:assigned");
    const raw = new TextDecoder().decode(row.raw as Uint8Array);
    expect(raw).toContain("/inbox?task=task-1");
  });

  it("carries a task ref, and renders Linear externalRefs as clickable links and refs", async () => {
    preferences = {};
    const { db, inserted } = makeDb({
      principals: {
        "prn-owner": OWNER_PRINCIPAL,
        "prn-agent": ACTOR_AGENT_PRINCIPAL,
      },
      agents: { "agent-1": { id: "agent-1", name: "Myra" } },
    });
    await deliverTaskMail({
      db,
      tenantId: "ten-1",
      task: baseTask({
        externalRefs: [
          {
            adapterId: "linear",
            externalId: "ISSUE-1",
            externalUrl: "https://linear.app/x/ISSUE-1",
            syncState: "synced",
          },
        ],
      }),
      event: "assigned",
      actorPrincipalId: "prn-agent",
    });
    const row = inserted[0] as Record<string, unknown>;
    const raw = new TextDecoder().decode(row.raw as Uint8Array);
    // Clickable Markdown link, not a bare "Synced to: linear" line.
    expect(raw).toContain("[linear · ISSUE-1](https://linear.app/x/ISSUE-1)");
    const header = raw
      .split("\r\n")
      .find((line) => line.startsWith("X-Workbench-Refs:"));
    expect(header).toBeString();
    const refs = JSON.parse(
      (header as string).slice("X-Workbench-Refs:".length),
    );
    expect(refs).toEqual([
      { kind: "task", ref: "task-1", label: "Open task" },
      {
        kind: "linear",
        ref: "https://linear.app/x/ISSUE-1",
        label: "linear · ISSUE-1",
      },
    ]);
  });

  it("uses plain 'New task' subject for a non-agent creation", async () => {
    preferences = {};
    const { db, inserted } = makeDb({
      principals: {
        "prn-owner": OWNER_PRINCIPAL,
        "prn-actor": ACTOR_USER_PRINCIPAL,
      },
      users: { "actor-1": { id: "actor-1", name: "Alice" } },
    });
    await deliverTaskMail({
      db,
      tenantId: "ten-1",
      task: baseTask({ source: "mail" }),
      event: "created",
      actorPrincipalId: "prn-actor",
    });
    expect(inserted).toHaveLength(1);
    const row = inserted[0] as Record<string, unknown>;
    expect(row.subject).toBe("New task: Follow up with Acme");
  });

  it("reuses the same messageKey on a repeat event so a reconciler retry can never spam", async () => {
    preferences = {};
    let insertCount = 0;
    const returning = mock(async () => {
      insertCount += 1;
      // First insert lands; the second collides on the (tenant, principal,
      // messageKey) unique index and onConflictDoNothing yields no row.
      return insertCount === 1 ? [{ id: "row-1" }] : [];
    });
    const onConflictDoNothing = mock(() => ({ returning }));
    const inserted: Record<string, unknown>[] = [];
    const values = mock((row: Record<string, unknown>) => {
      inserted.push(row);
      return { onConflictDoNothing };
    });
    const publish = mock(() => undefined);
    const bus = { publish, subscribe: mock(() => () => undefined) };
    const db = {
      insert: mock(() => ({ values })),
      query: {
        tenant: { findFirst: mock(async () => TENANT_ROW) },
        principal: {
          findFirst: mock(async () => ACTOR_AGENT_PRINCIPAL),
        },
        agent: {
          findFirst: mock(async () => ({ id: "agent-1", name: "Myra" })),
        },
      },
    } as unknown as HubDb;

    const args = {
      db,
      tenantId: "ten-1",
      task: baseTask(),
      event: "waiting" as const,
      actorPrincipalId: "prn-agent",
      mailboxEventBus: bus,
    };
    await deliverTaskMail(args);
    await deliverTaskMail(args);

    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.messageKey).toBe("task:task-1:waiting");
    expect(inserted[1]?.messageKey).toBe("task:task-1:waiting");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not mail when the owner has taskMailEnabled turned off", async () => {
    preferences = { taskMailEnabled: false };
    const { db, inserted } = makeDb({
      principals: {
        "prn-owner": OWNER_PRINCIPAL,
        "prn-agent": ACTOR_AGENT_PRINCIPAL,
      },
      agents: { "agent-1": { id: "agent-1", name: "Myra" } },
    });
    await deliverTaskMail({
      db,
      tenantId: "ten-1",
      task: baseTask(),
      event: "assigned",
      actorPrincipalId: "prn-agent",
    });
    expect(inserted).toHaveLength(0);
  });

  it("addresses a reassignment to the new assignee, not the owner", async () => {
    preferences = {};
    const NEW_ASSIGNEE_PRINCIPAL = {
      id: "prn-assignee",
      tenantId: "ten-1",
      refId: "assignee-1",
      kind: "user",
    };
    const { db, inserted } = makeDb({
      principals: {
        "prn-owner": OWNER_PRINCIPAL,
        "prn-actor": ACTOR_USER_PRINCIPAL,
        "prn-assignee": NEW_ASSIGNEE_PRINCIPAL,
      },
      users: {
        "actor-1": { id: "actor-1", name: "Alice" },
        "assignee-1": { id: "assignee-1", name: "Bob" },
      },
    });
    await deliverTaskMail({
      db,
      tenantId: "ten-1",
      task: baseTask(),
      event: "assigned",
      actorPrincipalId: "prn-actor",
      recipientPrincipalId: "prn-assignee",
    });
    expect(inserted).toHaveLength(1);
    const row = inserted[0] as Record<string, unknown>;
    expect(row.principalId).toBe("prn-assignee");
    expect(row.subject).toBe("Alice assigned you: Follow up with Acme");
    expect(row.messageKey).toBe("task:task-1:assigned:prn-assignee");
  });

  it("skips a reassignment self-event (actor assigns the task to themself)", async () => {
    preferences = {};
    const { db, inserted } = makeDb({
      principals: {
        "prn-owner": OWNER_PRINCIPAL,
        "prn-actor": ACTOR_USER_PRINCIPAL,
      },
    });
    await deliverTaskMail({
      db,
      tenantId: "ten-1",
      task: baseTask(),
      event: "assigned",
      actorPrincipalId: "prn-actor",
      recipientPrincipalId: "prn-actor",
    });
    expect(inserted).toHaveLength(0);
  });

  it("never throws when the db lookup fails", async () => {
    preferences = {};
    const db = {
      query: {
        tenant: { findFirst: mock(() => Promise.reject(new Error("db down"))) },
      },
    } as unknown as HubDb;
    await expect(
      deliverTaskMail({
        db,
        tenantId: "ten-1",
        task: baseTask(),
        event: "created",
        actorPrincipalId: "prn-agent",
      }),
    ).resolves.toBeUndefined();
  });
});
