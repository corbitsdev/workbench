// CL-7108: agent DMs run on the interactive warm-mailbox shape — one
// standing per-agent run provisioned from the conversation's definition
// asset, every inbound mail a header-threaded turn on that run, the turn
// rows a durable per-run INBOX. This test pins the shape at the chat
// layer: the DM settings pin (kind + definitionId, in exactly one place)
// and a two-turn DM conversation's durable trail (turn rows, RFC 5322
// threading, turn-mail correlation, mailbox fan-out).
import { describe, expect, test } from "bun:test";
import type { MailContent } from "../src/codec";
import {
  AGENT_DM_DEFINITION_ID_KEY,
  AGENT_DM_KIND,
  definitionIdOfSettings,
  isAgentDmSettings,
} from "../src/agent-dm-mode";
import type { WorkbenchLauncher } from "../src/platform-port";
import type {
  CreateWorkbenchTenantResult,
  WorkbenchTenancyRow,
} from "../src/workbench-tenancy";
import { findExistingAgentChat, mintAgentDm } from "../src/workbench-service";
import { createInMemoryAgentTurnStore } from "../src/agent-turns";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import { createInMemoryChatStore } from "../src/store";
import { createInMemoryThreadStore } from "../src/threads";
import { createInMemoryTurnClaimStore } from "../src/turn-claims";
import { createTurnCancelRegistry } from "../src/turn-cancellation";
import { createInMemoryTurnMailCorrelationStore } from "../src/turn-mail-correlation";
import { createWorkbenchTurnQueue } from "../src/turn-queue";
import { sendWorkbenchMessage } from "../src/workbench-service";
import type { MailboxWriter } from "../src/mailbox-fanout";

const TENANT_ID = "tnt_1";
const WORKBENCH_ID = "wb_dm_1";
const DOMAIN = "acme.example";
const SENDER = "prn_alice";
const AGENT_ADDRESS = "ins_echo1@acme.example";
const DEFINITION_ID = "def_echo";

function dmSettings() {
  return {
    // Built from the DM pin, never re-typed wire literals: the kind reads
    // as the pin's kind, the definition id sits under the pin's computed
    // key. ("chat/kind" / "chat/participants" keep their product-spelled
    // keys — no pin constant names them, and the product writes them the
    // same way.) The ONE test that names the pin's wire values as
    // literals is "the pin names the exact settings keys on the wire"
    // below; everything else here references the constants.
    "chat/kind": AGENT_DM_KIND,
    [AGENT_DM_DEFINITION_ID_KEY]: DEFINITION_ID,
    "chat/participants": [
      { address: SENDER, handle: SENDER },
      { address: AGENT_ADDRESS, handle: "echo" },
    ],
  };
}

describe("agent DM pin (CL-7108)", () => {
  test("DM settings are a kind:chat conversation with a definition id", () => {
    const settings = dmSettings();
    expect(isAgentDmSettings(settings)).toBe(true);
    expect(definitionIdOfSettings(settings)).toBe(DEFINITION_ID);
  });

  test("the pin names the exact settings keys on the wire", () => {
    expect(AGENT_DM_KIND).toBe("chat");
    expect(AGENT_DM_DEFINITION_ID_KEY).toBe("chat/definitionId");
  });

  test("a group conversation with a definition id is not a DM", () => {
    expect(isAgentDmSettings({ ...dmSettings(), "chat/kind": "group" })).toBe(
      false,
    );
  });

  test("a chat without a definition id is not a DM", () => {
    const { [AGENT_DM_DEFINITION_ID_KEY]: _dropped, ...rest } = dmSettings();
    expect(isAgentDmSettings(rest)).toBe(false);
    expect(definitionIdOfSettings(rest)).toBeUndefined();
  });

  test("a non-string definition id is not a DM", () => {
    expect(
      isAgentDmSettings({ ...dmSettings(), [AGENT_DM_DEFINITION_ID_KEY]: 42 }),
    ).toBe(false);
    expect(
      definitionIdOfSettings({ [AGENT_DM_DEFINITION_ID_KEY]: 42 }),
    ).toBeUndefined();
  });

  test("a missing kind reads as chat, like the workbench view does", () => {
    const { "chat/kind": _dropped, ...rest } = dmSettings();
    expect(isAgentDmSettings(rest)).toBe(true);
  });
});

// A group conversation is never an agent DM — even one that happens to
// carry a definition id must never take the DM find-or-reopen path: the
// pin (kind chat + definition id) is what opens that path, and the group
// kind keeps it closed. Red-proven by flipping the seeded kind to chat
// and watching the find-half fail (the row is found); the mint-fresh
// half is red-proven by inverting its inequality to toBe.
describe("non-DM settings never take the DM path (CL-7108)", () => {
  const GROUP_WORKBENCH_ID = "wb_group_1";

  function stubPlatform(): WorkbenchLauncher {
    return {
      async launchInvite() {
        return { instanceId: "run_echo1", address: AGENT_ADDRESS };
      },
      async ensureAwake() {},
      async listInvitableDefinitions() {
        return [{ id: DEFINITION_ID, name: "echo", description: "Echo" }];
      },
      async resolveDefinitionIdByAddress() {
        return undefined;
      },
      async resolveDefinitionAssetId() {
        return "asset_echo";
      },
      async resolveDefinitionNameSource() {
        return undefined;
      },
      async refreshAgentInstanceFromDefinition() {},
    };
  }

  function stubTenancy() {
    return {
      async createWorkbenchTenant(input: {
        readonly parentTenantId: string;
        readonly workbenchId: string;
        readonly name: string;
        readonly creatorUserId: string;
        readonly cookies: string[];
      }): Promise<CreateWorkbenchTenantResult> {
        return {
          tenantId: `tnt_child_${input.workbenchId}`,
          parentTenantId: input.parentTenantId,
          domain: DOMAIN,
          slug: input.workbenchId,
          ownerPrincipalId: SENDER,
        };
      },
      async compensateWorkbenchTenant() {},
      async getWorkbenchTenancy(): Promise<WorkbenchTenancyRow | undefined> {
        return undefined;
      },
    };
  }

  test("a group chat carrying a definition id is invisible to findExistingAgentChat, and mintAgentDm mints fresh", async () => {
    const store = createInMemoryChatStore();
    const roomMessages = createInMemoryRoomMessageStore();
    const groupSettings = { ...dmSettings(), "chat/kind": "group" };
    await store.createWorkbenchSettings({
      tenantId: TENANT_ID,
      workbenchId: GROUP_WORKBENCH_ID,
      updatedBy: SENDER,
      settings: groupSettings,
    });
    expect(isAgentDmSettings(groupSettings)).toBe(false);

    const deps = {
      store,
      roomMessages,
      publish: () => undefined,
      platform: stubPlatform(),
      tenancy: stubTenancy(),
    };

    // The DM find-or-reopen path never sees the group row...
    expect(
      await findExistingAgentChat(deps, TENANT_ID, DEFINITION_ID),
    ).toBeUndefined();

    // ...so minting for that definition mints a fresh DM beside it.
    const minted = await mintAgentDm(deps, {
      tenantId: TENANT_ID,
      callerWorkbenchId: "wb_myra_dm",
      callerPrincipalId: SENDER,
      creatorUserId: "usr_alice",
      cookies: [],
      definitionId: DEFINITION_ID,
    });
    expect(minted.workbenchId).not.toBe(GROUP_WORKBENCH_ID);
    expect(minted.definitionId).toBe(DEFINITION_ID);
    const mintedRow = await store.getWorkbenchSettings(
      TENANT_ID,
      minted.workbenchId,
    );
    expect(isAgentDmSettings(mintedRow?.settings ?? {})).toBe(true);

    // And the fresh DM — a real DM — is exactly what a later
    // find-or-reopen finds.
    const reopened = await findExistingAgentChat(
      deps,
      TENANT_ID,
      DEFINITION_ID,
    );
    expect(reopened?.workbenchId).toBe(minted.workbenchId);
  });
});

function noopMailbox() {
  const writer: MailboxWriter = {
    async writeBatch(items) {
      return items.map((_item, index) => ({
        messageKey: String(index),
        id: `mbx_${String(index)}`,
      }));
    },
  };
  return {
    writer,
    resolveKnownPrincipalIds: async () => new Set<string>([SENDER]),
    resolveTenantDomain: async () => DOMAIN,
  };
}

async function makeDmDeps(sentMail: MailContent[]) {
  const store = createInMemoryChatStore();
  const roomMessages = createInMemoryRoomMessageStore();
  const threads = createInMemoryThreadStore();
  const claims = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
  const turnQueue = createWorkbenchTurnQueue({
    claims,
    publish: () => undefined,
  });
  const turnCancellation = createTurnCancelRegistry();
  const agentTurns = createInMemoryAgentTurnStore();
  const turnMailCorrelation = createInMemoryTurnMailCorrelationStore();

  await store.createWorkbenchSettings({
    tenantId: TENANT_ID,
    workbenchId: WORKBENCH_ID,
    updatedBy: SENDER,
    settings: dmSettings(),
  });

  const deps = {
    store,
    roomMessages,
    threads,
    publish: () => undefined,
    platform: {
      async sendMail(input: { content: MailContent }) {
        sentMail.push(input.content);
        return { id: "mail_agent_1", createdAt: new Date().toISOString() };
      },
    },
    turnQueue,
    turnCancellation,
    mailbox: noopMailbox(),
    agentTurns,
    turnMailCorrelation,
  };
  return { deps, agentTurns, turnMailCorrelation };
}

async function sendDm(
  deps: Awaited<ReturnType<typeof makeDmDeps>>["deps"],
  text: string,
) {
  const posted = await sendWorkbenchMessage(deps, {
    tenantId: TENANT_ID,
    principalId: SENDER,
    senderAddress: `${SENDER}@${DOMAIN}`,
    workbenchId: WORKBENCH_ID,
    messageParts: [{ kind: "text", text }],
  });
  await posted.fanoutDelivered;
  return posted;
}

describe("agent DM conversation trail (CL-7108)", () => {
  test("two DM turns each open a turn row, dispatch a threaded frame, and correlate", async () => {
    const sentMail: MailContent[] = [];
    const { deps, agentTurns, turnMailCorrelation } =
      await makeDmDeps(sentMail);

    const first = await sendDm(deps, "hello");
    const running = await agentTurns.findRunningTurn({
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
      agentAddress: AGENT_ADDRESS,
    });
    expect(running?.requestMessageIds).toEqual([first.id]);
    // Settle the first turn the way the reply path would, so the second
    // inbound serializes behind it into its own turn instead of piling
    // onto a still-running one.
    await agentTurns.finishTurn({
      tenantId: TENANT_ID,
      turnId: running?.id ?? "",
      status: "completed",
    });

    const second = await sendDm(deps, "again");

    const turns = await agentTurns.listTurns({
      tenantId: TENANT_ID,
      workbenchId: WORKBENCH_ID,
    });
    expect(turns.map((turn) => turn.requestMessageIds)).toEqual([
      [second.id],
      [first.id],
    ]);

    // Every inbound mail is a threaded turn: each dispatched frame carries
    // its own row-derived Message-ID (CL-7450), and each dispatch mail's
    // correlation back to the row it answers is recorded for the reply
    // path (CL-6314) — keyed by the answered row, whose derived
    // Message-ID the sidecar's bracket reports back.
    expect(sentMail).toHaveLength(2);
    expect(sentMail[0]?.messageId).toBe(`<${first.id}@${DOMAIN}>`);
    expect(sentMail[1]?.messageId).toBe(`<${second.id}@${DOMAIN}>`);
    for (const posted of [first, second]) {
      const source = await turnMailCorrelation.findTurnMailSource({
        tenantId: TENANT_ID,
        mailId: posted.id,
      });
      expect(source?.workbenchId).toBe(WORKBENCH_ID);
      expect(source?.sourceMessageId).toBe(posted.id);
    }
  });
});
