// Route-level tests for the workflow-run-authenticated participant-
// invite surface: authentication, the "run's address isn't a
// participant of any channel" 404, and the happy-path invite
// (delegating to `launchAndJoinAgent`, so the join event and settings
// update land exactly as `POST /channels/:id/invite` produces them).
// Reuses `./test-support.ts`'s `TENANT`/`fakePlatform` and
// `createInMemoryChatStore`, matching `channel-service.test.ts`'s style.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createInMemoryChatStore } from "../src/store";
import {
  createWorkflowParticipantRoutes,
  type CreateWorkflowParticipantRoutesDeps,
  type WorkflowParticipantRunScope,
  type WorkflowRunAuthenticator,
} from "../src/workflow-participant-routes";
import { fakePlatform, TENANT } from "./test-support";

const RUN_ID = "run_1";
const SIDECAR_TOKEN = "sidecar-token";
const RUN_ADDRESS = `${RUN_ID}@acme.example`;

const authenticateAsRun: WorkflowRunAuthenticator = {
  resolve: (token, address) =>
    Promise.resolve(
      token === SIDECAR_TOKEN && address === RUN_ADDRESS
        ? ({
            tenantId: TENANT.id,
            principalId: "prn_1",
            runId: RUN_ID,
          } satisfies WorkflowParticipantRunScope)
        : null,
    ),
};

function buildApp(
  overrides: Partial<CreateWorkflowParticipantRoutesDeps> = {},
): Hono {
  const store = overrides.store ?? createInMemoryChatStore();
  return createWorkflowParticipantRoutes({
    store,
    platform: overrides.platform ?? fakePlatform(),
    publish: overrides.publish ?? (() => undefined),
    authenticator: overrides.authenticator ?? authenticateAsRun,
  }) as unknown as Hono;
}

const AUTH_HEADERS = {
  authorization: `Bearer ${SIDECAR_TOKEN}`,
  "x-workflow-run-address": RUN_ADDRESS,
};

test("POST /participants/invite is a 401 without a recognized run credential", async () => {
  const app = buildApp();
  const response = await app.request("/participants/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ definitionId: "wfd_echo" }),
  });
  expect(response.status).toBe(401);
});

test("a run whose address is not a participant of any channel is a 404", async () => {
  const app = buildApp();
  const response = await app.request("/participants/invite", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({ definitionId: "wfd_echo" }),
  });
  expect(response.status).toBe(404);
});

test("an invalid body is a 400", async () => {
  const app = buildApp();
  const response = await app.request("/participants/invite", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(400);
});

test("invites the named definition into the caller's own channel, resolved from its own participant address", async () => {
  const store = createInMemoryChatStore();
  await store.createChannelSettings({
    tenantId: TENANT.id,
    channelId: "chan_1",
    settings: {
      "chat/kind": "channel",
      "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
    },
    updatedBy: "prn_1",
  });
  const platform = fakePlatform({
    invitable: [{ id: "wfd_echo", name: "Echo" }],
  });

  const app = buildApp({ store, platform });
  const response = await app.request("/participants/invite", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({ definitionId: "wfd_echo" }),
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    address: string;
    definitionId: string;
    handle: string;
  };
  expect(body.address).toBe("ins_invited1@acme.example");
  expect(body.definitionId).toBe("wfd_echo");
  expect(body.handle).toBe("echo");
  expect(platform.launchInviteCalls).toEqual([
    {
      tenantId: TENANT.id,
      creatorPrincipalId: "prn_1",
      definitionId: "wfd_echo",
    },
  ]);

  const updated = await store.getChannelSettings(TENANT.id, "chan_1");
  expect(updated?.settings["chat/participants"]).toEqual([
    { address: RUN_ADDRESS, handle: "myra" },
    { address: "ins_invited1@acme.example", handle: "echo" },
  ]);
});

describe("POST /participants/messages", () => {
  test("is a 401 without a recognized run credential", async () => {
    const app = buildApp();
    const response = await app.request("/participants/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "hi" }] }),
    });
    expect(response.status).toBe(401);
  });

  test("a run whose address is not a participant of any channel is a 404", async () => {
    const app = buildApp();
    const response = await app.request("/participants/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ parts: [{ kind: "text", text: "hi" }] }),
    });
    expect(response.status).toBe(404);
  });

  test("an invalid body is a 400", async () => {
    const store = createInMemoryChatStore();
    await store.createChannelSettings({
      tenantId: TENANT.id,
      channelId: "chan_1",
      settings: {
        "chat/kind": "channel",
        "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
      },
      updatedBy: "prn_1",
    });
    const app = buildApp({ store });
    const response = await app.request("/participants/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ parts: "not an array" }),
    });
    expect(response.status).toBe(400);
  });

  test("posts a question block into the caller's own channel as the run's own message", async () => {
    const store = createInMemoryChatStore();
    await store.createChannelSettings({
      tenantId: TENANT.id,
      channelId: "chan_1",
      settings: {
        "chat/kind": "channel",
        "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
      },
      updatedBy: "prn_1",
    });
    const platform = fakePlatform();

    const app = buildApp({ store, platform });
    const questionBlock = {
      kind: "block",
      block: {
        type: "question",
        data: {
          questionId: "q_1",
          question: "Which environment?",
          options: ["Staging", "Production"],
        },
      },
    };
    const response = await app.request("/participants/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ parts: [questionBlock] }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; createdAt: string };
    expect(typeof body.id).toBe("string");
    expect(platform.sentMail.length).toBeGreaterThanOrEqual(1);
    expect(platform.sentMail[0]?.principalId).toBe("prn_1");
    expect(platform.sentMail[0]?.channelId).toBe("chan_1");
  });
});
