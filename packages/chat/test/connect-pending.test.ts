// Tests for the connect-settling half of the in-room connect flow
// (CL-6393): a connection completing in the browser settles every room
// that was waiting on it — the pending entry clears, `chat.settings`
// fires so the card flips, and a message lands in the room so the
// workbench's agent picks the task back up.
import { expect, test } from "bun:test";

import { createInMemoryChatStore } from "../src/store";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import { createInMemoryTurnClaimStore } from "../src/turn-claims";
import { createWorkbenchTurnQueue } from "../src/turn-queue";
import { settleConnectedService } from "../src/connect-pending";
import { fakePlatform, TENANT } from "./test-support";

const HUMAN_ADDRESS = "prn_owner@acme.example";
const AGENT_ADDRESS = "ins_myra@acme.example";

async function seedWorkbench(
  store: ReturnType<typeof createInMemoryChatStore>,
  workbenchId: string,
  pending: readonly string[] | undefined,
) {
  await store.createWorkbenchSettings({
    tenantId: TENANT.id,
    workbenchId,
    settings: {
      "chat/kind": "workbench",
      "chat/participants": [
        { address: HUMAN_ADDRESS, handle: "owner" },
        { address: AGENT_ADDRESS, handle: "myra" },
      ],
      ...(pending !== undefined ? { "connections/pending": pending } : {}),
    },
    updatedBy: "prn_owner",
  });
}

async function seedTemplateWorkbench(
  store: ReturnType<typeof createInMemoryChatStore>,
  workbenchId: string,
  templatePending: readonly string[],
) {
  await store.createWorkbenchSettings({
    tenantId: TENANT.id,
    workbenchId,
    settings: {
      "chat/kind": "workbench",
      "chat/participants": [
        { address: HUMAN_ADDRESS, handle: "owner" },
        { address: AGENT_ADDRESS, handle: "myra" },
      ],
      "template/id": "code-review",
      "template/pendingConnections": templatePending,
    },
    updatedBy: "prn_owner",
  });
}

function buildDeps() {
  const store = createInMemoryChatStore();
  const roomMessages = createInMemoryRoomMessageStore();
  const published: { workbenchId: string; event: { type?: string } }[] = [];
  const publish = (workbenchId: string, event: unknown) => {
    published.push({ workbenchId, event: event as { type?: string } });
  };
  const deps = {
    store,
    platform: fakePlatform(),
    roomMessages,
    publish,
    turnQueue: createWorkbenchTurnQueue({
      claims: createInMemoryTurnClaimStore({ ttlMs: 60_000 }),
      publish,
    }),
    senderAddressFor: () => HUMAN_ADDRESS,
  };
  return { store, roomMessages, published, deps };
}

test("settles every room waiting on the connector: clears pending, publishes chat.settings, posts the resume message", async () => {
  const { store, roomMessages, published, deps } = buildDeps();
  await seedWorkbench(store, "chan_waiting", ["gmail", "exa"]);
  await seedWorkbench(store, "chan_other", undefined);

  await settleConnectedService(deps, {
    tenantId: TENANT.id,
    principalId: "prn_owner",
    connectorId: "gmail",
    displayName: "Gmail",
  });

  const settled = await store.getWorkbenchSettings(TENANT.id, "chan_waiting");
  expect(settled?.settings["connections/pending"]).toEqual(["exa"]);
  expect(
    published.some(
      (entry) =>
        entry.workbenchId === "chan_waiting" &&
        entry.event.type === "chat.settings",
    ),
  ).toBe(true);

  const listed = await roomMessages.listMessages({
    tenantId: TENANT.id,
    workbenchId: "chan_waiting",
  });
  expect(listed.items).toHaveLength(1);
  const text = JSON.stringify(listed.items[0]?.parts);
  expect(text).toContain("Gmail");

  const untouched = await store.getWorkbenchSettings(TENANT.id, "chan_other");
  expect(untouched?.settings["connections/pending"]).toBeUndefined();
  const otherMessages = await roomMessages.listMessages({
    tenantId: TENANT.id,
    workbenchId: "chan_other",
  });
  expect(otherMessages.items).toHaveLength(0);
});

test("matches a pending mcp-prefixed entry when the preset connects under its bare slug", async () => {
  const { store, deps } = buildDeps();
  await seedWorkbench(store, "chan_waiting", ["mcp:notion"]);

  await settleConnectedService(deps, {
    tenantId: TENANT.id,
    principalId: "prn_owner",
    connectorId: "notion",
    displayName: "Notion",
  });

  const settled = await store.getWorkbenchSettings(TENANT.id, "chan_waiting");
  expect(settled?.settings["connections/pending"]).toEqual([]);
});

test("settles a room whose GitHub card is pending under the code-review template's own key — a credential created out of band (not through that card's own submit) still reaches it", async () => {
  const { store, roomMessages, published, deps } = buildDeps();
  await seedTemplateWorkbench(store, "chan_template", ["github"]);

  await settleConnectedService(deps, {
    tenantId: TENANT.id,
    principalId: "prn_owner",
    connectorId: "github",
    displayName: "GitHub",
  });

  const settled = await store.getWorkbenchSettings(TENANT.id, "chan_template");
  expect(settled?.settings["template/pendingConnections"]).toEqual([]);
  expect(settled?.settings["template/id"]).toBe("code-review");
  expect(
    published.some(
      (entry) =>
        entry.workbenchId === "chan_template" &&
        entry.event.type === "chat.settings",
    ),
  ).toBe(true);

  const listed = await roomMessages.listMessages({
    tenantId: TENANT.id,
    workbenchId: "chan_template",
  });
  expect(listed.items).toHaveLength(1);
  expect(JSON.stringify(listed.items[0]?.parts)).toContain("GitHub");
});

test("a connector no room is waiting on settles nothing", async () => {
  const { store, roomMessages, published, deps } = buildDeps();
  await seedWorkbench(store, "chan_1", ["exa"]);

  await settleConnectedService(deps, {
    tenantId: TENANT.id,
    principalId: "prn_owner",
    connectorId: "gmail",
    displayName: "Gmail",
  });

  const untouched = await store.getWorkbenchSettings(TENANT.id, "chan_1");
  expect(untouched?.settings["connections/pending"]).toEqual(["exa"]);
  expect(published).toHaveLength(0);
  const listed = await roomMessages.listMessages({
    tenantId: TENANT.id,
    workbenchId: "chan_1",
  });
  expect(listed.items).toHaveLength(0);
});
