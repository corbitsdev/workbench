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
    "chat/kind": "chat",
    "chat/definitionId": DEFINITION_ID,
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
    expect(
      isAgentDmSettings({ ...dmSettings(), "chat/kind": "group" }),
    ).toBe(false);
  });

  test("a chat without a definition id is not a DM", () => {
    const { "chat/definitionId": _dropped, ...rest } = dmSettings();
    expect(isAgentDmSettings(rest)).toBe(false);
    expect(definitionIdOfSettings(rest)).toBeUndefined();
  });

  test("a non-string definition id is not a DM", () => {
    expect(
      isAgentDmSettings({ ...dmSettings(), "chat/definitionId": 42 }),
    ).toBe(false);
    expect(definitionIdOfSettings({ "chat/definitionId": 42 })).toBeUndefined();
  });

  test("a missing kind reads as chat, like the workbench view does", () => {
    const { "chat/kind": _dropped, ...rest } = dmSettings();
    expect(isAgentDmSettings(rest)).toBe(true);
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
    // its own row-derived Message-ID (CL-7450), and each turn's
    // correlation back to its row is recorded for the reply path.
    expect(sentMail).toHaveLength(2);
    expect(sentMail[0]?.messageId).toBe(`<${first.id}@${DOMAIN}>`);
    expect(sentMail[1]?.messageId).toBe(`<${second.id}@${DOMAIN}>`);
    for (const posted of [first, second]) {
      const source = await turnMailCorrelation.findTurnMailSource({
        tenantId: TENANT_ID,
        mailMessageId: `<${posted.id}@${DOMAIN}>`,
      });
      expect(source?.tenantId).toBe(TENANT_ID);
    }
  });
});
