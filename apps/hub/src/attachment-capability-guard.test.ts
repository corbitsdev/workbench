import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { DB } from "@intx/db";
import {
  createAttachmentCapabilityGuard,
  resolveInstanceAcceptedMimeTypes,
} from "./attachment-capability-guard";

function fakeAgentRow(opts: { model: string | null; plugin: string }) {
  return {
    id: "agt_1",
    modelConfig: opts.model !== null ? { defaultModel: opts.model } : null,
    credentialRequirements: [
      { providerName: opts.plugin, source: "tenant", name: "cred" },
    ],
    capabilities: null,
    contextConfig: null,
    initialState: null,
    modelRequirements: null,
    grantRequirements: null,
    toolPackages: [],
  };
}

function fakeDb(opts: {
  instance?: { agentId: string } | null;
  agent?: unknown;
}): DB["db"] {
  return {
    query: {
      agentInstance: {
        findFirst: async () => opts.instance ?? undefined,
      },
      agent: {
        findFirst: async () => opts.agent ?? undefined,
      },
    },
  } as unknown as DB["db"];
}

const MAIL_PATH = "/api/tenants/t1/agents/instances/inst-1/mail" as const;

describe("resolveInstanceAcceptedMimeTypes", () => {
  it("gives an openai-compatible vision agent images but not pdf", async () => {
    const db = fakeDb({
      instance: { agentId: "agt_1" },
      agent: fakeAgentRow({ model: "kimi-k2.6", plugin: "openai-compatible" }),
    });
    const accepted = await resolveInstanceAcceptedMimeTypes(db, "inst-1");
    expect(accepted).toContain("image/png");
    expect(accepted).not.toContain("application/pdf");
  });

  it("gives an anthropic agent images and pdf", async () => {
    const db = fakeDb({
      instance: { agentId: "agt_1" },
      agent: fakeAgentRow({ model: "claude-opus-4-8", plugin: "anthropic" }),
    });
    const accepted = await resolveInstanceAcceptedMimeTypes(db, "inst-1");
    expect(accepted).toContain("image/png");
    expect(accepted).toContain("application/pdf");
  });

  it("gives a text-only agent an empty set", async () => {
    const db = fakeDb({
      instance: { agentId: "agt_1" },
      agent: fakeAgentRow({
        model: "deepseek-v4-flash",
        plugin: "openai-compatible",
      }),
    });
    expect(await resolveInstanceAcceptedMimeTypes(db, "inst-1")).toEqual([]);
  });

  it("returns null when the instance is missing", async () => {
    const db = fakeDb({ instance: null });
    expect(await resolveInstanceAcceptedMimeTypes(db, "inst-1")).toBeNull();
  });

  it("returns null when the agent has no classifiable model", async () => {
    const db = fakeDb({
      instance: { agentId: "agt_1" },
      agent: fakeAgentRow({ model: null, plugin: "openai-compatible" }),
    });
    expect(await resolveInstanceAcceptedMimeTypes(db, "inst-1")).toBeNull();
  });
});

function guardedApp(db: DB["db"]): Hono {
  const app = new Hono();
  app.use(
    "/api/tenants/:tenantId/agents/instances/:instanceId/mail",
    createAttachmentCapabilityGuard(db),
  );
  app.post("/api/tenants/:tenantId/agents/instances/:instanceId/mail", (c) =>
    c.json({ forwarded: true }),
  );
  app.get("/api/tenants/:tenantId/agents/instances/:instanceId/mail", (c) =>
    c.json({ forwarded: true }),
  );
  return app;
}

function post(app: Hono, body: unknown) {
  return app.request(MAIL_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createAttachmentCapabilityGuard", () => {
  const myraDb = () =>
    fakeDb({
      instance: { agentId: "agt_1" },
      agent: fakeAgentRow({ model: "kimi-k2.6", plugin: "openai-compatible" }),
    });

  it("rejects a document the agent's adapter can't consume", async () => {
    const res = await post(guardedApp(myraDb()), {
      content: "here",
      attachments: [{ mimeType: "application/pdf", data: "AAAA" }],
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("disallowed_for_agent");
  });

  it("forwards an allowed attachment to the downstream handler", async () => {
    const res = await post(guardedApp(myraDb()), {
      content: "here",
      attachments: [{ mimeType: "image/png", data: "AAAA" }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ forwarded: true });
  });

  it("forwards when there are no attachments", async () => {
    const res = await post(guardedApp(myraDb()), { content: "just text" });
    expect(res.status).toBe(200);
  });

  it("forwards (defers) when the agent capability can't be resolved", async () => {
    const res = await post(guardedApp(fakeDb({ instance: null })), {
      content: "here",
      attachments: [{ mimeType: "application/pdf", data: "AAAA" }],
    });
    expect(res.status).toBe(200);
  });

  it("does not guard GET (outbox reads)", async () => {
    const res = await guardedApp(myraDb()).request(MAIL_PATH, {
      method: "GET",
    });
    expect(res.status).toBe(200);
  });
});
