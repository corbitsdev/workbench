import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { TurnFinalized } from "@workbench/event-collector";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  resolveMailboxLoadout,
} from "@workbench/myra";

const prepareOnlyLoadout = resolveMailboxLoadout("prepare_only");
import type { MemberPreferences } from "@workbench/shared";
import type { HubDb } from "../db";
import { resetFeatureGrantCache } from "../lib/feature-grants";

const configState = { triageEnabled: true };
mock.module("../config", () => ({
  getConfig: () => ({ triageEnabled: configState.triageEnabled }),
}));

const launchMock = mock(
  async (
    _db: unknown,
    _sessionService: unknown,
    _grantStore: unknown,
    _eventCollectors: unknown,
    opts: { instanceId: string; tenantDomain: string },
  ) => ({
    address: `${opts.instanceId}@${opts.tenantDomain}`,
    sessionId: "ses-triage-1",
  }),
);
mock.module("./agent-provisioning", () => ({
  launchAgentSession: launchMock,
}));

const MYRA_DEF = { id: "agt_myra", tenantId: "ten-1", name: "Myra" };
const resolveDefMock = mock(async () => MYRA_DEF);
const teardownMock = mock(async () => undefined);
mock.module("./myra-threads", () => ({
  resolveMyraDefinition: resolveDefMock,
  teardownThreadRows: teardownMock,
}));

let prefs: MemberPreferences = {};
const readPrefsMock = mock(async () => prefs);
mock.module("../lib/member-preferences", () => ({
  readMemberPreferences: readPrefsMock,
}));

const writeMock = mock(async () => ({ id: "handoff-1" }));
mock.module("../lib/mailbox-write", () => ({
  writeMailboxMessage: writeMock,
}));

const { createMailboxTriage } = await import("./mailbox-triage");
const { createPrincipalMailboxPersist } = await import(
  "../lib/principal-mailbox"
);

const RAW = new TextEncoder().encode(
  "From: partner@outside.example\r\n" +
    "To: usr_alice@tenant.example\r\n" +
    "Subject: Partnership intro\r\n" +
    "Message-ID: <orig-123@outside.example>\r\n" +
    "Date: Fri, 10 Jul 2026 07:00:00 +0000\r\n" +
    "\r\n" +
    "Hi Alice, keen to explore a partnership.\r\n",
);

const ITEM = {
  rowId: "row-1",
  tenantId: "ten-1",
  memberPrincipalId: "pri-alice",
  recipientAddress: "usr_alice@tenant.example",
  senderAddress: "ins_dep-ext@tenant.example",
  subject: "Partnership intro",
  fromAddress: "partner@outside.example",
  raw: RAW,
};

type SenderRow = { id: string; principalId: string } | undefined;

function makeDb(opts: {
  sender: SenderRow;
  senderMappedToMember?: boolean;
  featureGranted?: boolean;
}): { db: HubDb; txInserts: Record<string, unknown>[] } {
  const txInserts: Record<string, unknown>[] = [];
  const tx = {
    insert: mock(() => ({
      values: mock(async (row: Record<string, unknown>) => {
        txInserts.push(row);
      }),
    })),
  };
  const db = {
    query: {
      agentInstance: { findFirst: mock(async () => opts.sender) },
      memberAgentInstance: {
        findFirst: mock(async () =>
          opts.senderMappedToMember ? { id: "map-1" } : undefined,
        ),
      },
      tenant: {
        findFirst: mock(async () => ({
          id: "ten-1",
          domain: "tenant.example",
        })),
      },
      role: {
        findMany: mock(async () => [{ id: "rol_member" }]),
      },
      grant: {
        findMany: mock(async () =>
          opts.featureGranted
            ? [
                {
                  id: "grt_1",
                  resource: "feature:triage",
                  action: "enable",
                  effect: "allow",
                  origin: "role",
                  conditions: null,
                  expiresAt: null,
                  roleId: "rol_member",
                  principalId: null,
                },
              ]
            : [],
        ),
      },
    },
    transaction: mock(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
  } as unknown as HubDb;
  return { db, txInserts };
}

function makeSessionService() {
  const sendUserMessage = mock(async () => new Uint8Array());
  const endSession = mock(async () => undefined);
  return {
    service: { sendUserMessage, endSession } as never,
    sendUserMessage,
    endSession,
  };
}

const DUMMY_GRANTS = {} as never;
const DUMMY_COLLECTORS = {} as never;
const DUMMY_CRYPTO = {} as never;

function makeTriage(
  db: HubDb,
  session: ReturnType<typeof makeSessionService>,
  turnTimeoutMs = 2_000,
) {
  return createMailboxTriage({
    db,
    sessionService: session.service,
    grantStore: DUMMY_GRANTS,
    eventCollectors: DUMMY_COLLECTORS,
    cryptoProvider: DUMMY_CRYPTO,
    turnTimeoutMs,
  });
}

async function untilCalled(fn: { mock: { calls: unknown[][] } }) {
  for (let i = 0; i < 200; i++) {
    if (fn.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("mock was never called");
}

function completedTurn(text: string): TurnFinalized {
  return {
    turnId: "turn-1",
    status: "completed",
    text,
    hadReply: true,
    hadError: false,
    errors: [],
    toolCalls: [],
    toolErrors: [],
  } as unknown as TurnFinalized;
}

beforeEach(() => {
  configState.triageEnabled = true;
  resetFeatureGrantCache();
  prefs = {};
  launchMock.mockClear();
  teardownMock.mockClear();
  writeMock.mockClear();
  resolveDefMock.mockClear();
});

describe("createMailboxTriage", () => {
  it("does nothing when the kill switch is off", async () => {
    configState.triageEnabled = false;
    const { db } = makeDb({ sender: { id: "ins_x", principalId: "pri-b" } });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM);
    await triage.waitForDrain();

    expect(launchMock).not.toHaveBeenCalled();
    expect(session.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does nothing when the env kill switch is off and the tenant has no feature grant", async () => {
    configState.triageEnabled = false;
    const { db } = makeDb({
      sender: { id: "ins_x", principalId: "pri-b" },
      featureGranted: false,
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM);
    await triage.waitForDrain();

    expect(launchMock).not.toHaveBeenCalled();
  });

  it("runs triage when the env kill switch is off but the tenant's member role grants the feature", async () => {
    configState.triageEnabled = false;
    const { db } = makeDb({
      sender: { id: "ins_x", principalId: "pri-b" },
      featureGranted: true,
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM);
    await triage.waitForDrain();

    expect(launchMock).toHaveBeenCalled();
  });

  it("skips mail from the member's own workflow deployment", async () => {
    const { db } = makeDb({
      sender: { id: "ins_dep-own", principalId: "pri-alice" },
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM);
    await triage.waitForDrain();

    expect(launchMock).not.toHaveBeenCalled();
  });

  it("skips mail from system rails (hub sender)", async () => {
    const { db } = makeDb({ sender: undefined });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue({ ...ITEM, senderAddress: "hub@tenant.example" });
    await triage.waitForDrain();

    expect(launchMock).not.toHaveBeenCalled();
  });

  it("skips mail from the member's own Myra instances", async () => {
    const { db } = makeDb({
      sender: { id: "ins_myra-thread", principalId: "pri-agent" },
      senderMappedToMember: true,
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM);
    await triage.waitForDrain();

    expect(launchMock).not.toHaveBeenCalled();
  });

  it("triages external mail end to end and writes the handoff", async () => {
    const { db, txInserts } = makeDb({
      sender: { id: "ins_dep-ext", principalId: "pri-someone-else" },
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM);
    await untilCalled(session.sendUserMessage);

    const launchOpts = launchMock.mock.calls[0]![4] as Record<string, unknown>;
    expect(launchOpts.systemPrompt).toBe(prepareOnlyLoadout.systemPrompt);
    expect(launchOpts.persona).toEqual({
      toolNames: prepareOnlyLoadout.toolNames,
    });
    expect(launchOpts.agentId).toBe(MYRA_DEF.id);

    const mapping = txInserts.find(
      (row) => row.templateKey === "myra-triage",
    ) as Record<string, unknown>;
    expect(mapping).toBeDefined();
    expect(mapping.memberPrincipalId).toBe("pri-alice");

    const sendArgs = session.sendUserMessage.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(sendArgs.from).toBe("hub@tenant.example");
    expect(sendArgs.content).toContain("Partnership intro");
    expect(sendArgs.content).toContain("keen to explore a partnership");

    triage.handleTurnFinalized(
      sendArgs.agentAddress as string,
      completedTurn("Classification: actionable. Draft: hi."),
    );
    await triage.waitForDrain();

    expect(writeMock).toHaveBeenCalledTimes(1);
    const writeArgs = writeMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(writeArgs).toMatchObject({
      tenantId: "ten-1",
      principalId: "pri-alice",
      address: "usr_alice@tenant.example",
      fromAddress: "myra@tenant.example",
      subject: "Myra triaged: Partnership intro",
      body: "Classification: actionable. Draft: hi.",
      messageKey: "triage:row-1",
      inReplyTo: "<orig-123@outside.example>",
    });

    expect(session.endSession).toHaveBeenCalled();
    expect(teardownMock).toHaveBeenCalledTimes(1);
  });

  it("mounts the full loadout under execute_with_gates", async () => {
    prefs = { agentAutonomy: "execute_with_gates" };
    const { db } = makeDb({
      sender: { id: "ins_dep-ext", principalId: "pri-someone-else" },
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM);
    await untilCalled(session.sendUserMessage);

    const launchOpts = launchMock.mock.calls[0]![4] as Record<string, unknown>;
    expect(launchOpts.persona).toEqual({
      toolNames: PERSONAL_AGENT_BASE_TOOLS,
    });
    expect(launchOpts.systemPrompt).toContain("approval");

    const sendArgs = session.sendUserMessage.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    triage.handleTurnFinalized(
      sendArgs.agentAddress as string,
      completedTurn("done"),
    );
    await triage.waitForDrain();
  });

  it("tears down without a handoff when the turn never finalizes", async () => {
    const { db } = makeDb({
      sender: { id: "ins_dep-ext", principalId: "pri-someone-else" },
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session, 20);

    triage.enqueue(ITEM);
    await triage.waitForDrain();

    expect(session.sendUserMessage).toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalled();
    expect(teardownMock).toHaveBeenCalledTimes(1);
  });

  it("caps the queue at 50 and drops the oldest item on overflow, never blocking enqueue", async () => {
    const MAX_QUEUE = 50;
    const OVERFLOW = 6;
    let unblockFirst: (() => void) | undefined;
    const blockGate = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    let firstCallStarted = false;
    const findFirst = mock(async () => {
      if (!firstCallStarted) {
        firstCallStarted = true;
        await blockGate;
      }
      return { id: "ins_self", principalId: "pri-alice" };
    });

    const db = {
      query: {
        agentInstance: { findFirst },
        memberAgentInstance: { findFirst: mock(async () => undefined) },
        tenant: {
          findFirst: mock(async () => ({
            id: "ten-1",
            domain: "tenant.example",
          })),
        },
      },
      transaction: mock(async () => undefined),
    } as unknown as HubDb;
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    // The head-of-line item blocks inside isEligible, so it stays "in
    // flight" (already shifted out of the internal queue array) while the
    // pushes below accumulate behind it. enqueue() itself never awaits, so a
    // slow head-of-line item cannot block a caller from enqueuing more.
    triage.enqueue({ ...ITEM, rowId: "row-block" });
    for (let i = 0; i < MAX_QUEUE + OVERFLOW; i++) {
      triage.enqueue({ ...ITEM, rowId: `row-${i}` });
    }

    // Only the blocked head-of-line item has reached the DB so far — proof
    // that enqueuing the rest above did not need it to unblock first.
    expect(findFirst).toHaveBeenCalledTimes(1);

    unblockFirst?.();
    await triage.waitForDrain();

    // 1 head-of-line item + (MAX_QUEUE + OVERFLOW) pushed, capped at
    // MAX_QUEUE queued: the oldest OVERFLOW queued items are dropped, so
    // only 1 + MAX_QUEUE ever reach the DB.
    expect(findFirst).toHaveBeenCalledTimes(1 + MAX_QUEUE);
  });
});

describe("persistMail trigger seam", () => {
  const SENDER = {
    id: "ins_dep-ext",
    tenantId: "ten-1",
    principalId: "pri-someone-else",
    address: "ins_dep-ext@tenant.example",
  };

  function makePersistDb() {
    const returning = mock(async () => [{ id: "row-42" }]);
    const values = mock(() => ({ returning }));
    return {
      query: {
        agentInstance: { findFirst: mock(async () => SENDER) },
        tenant: {
          findFirst: mock(async () => ({
            id: "ten-1",
            domain: "tenant.example",
          })),
        },
        principal: { findFirst: mock(async () => ({ id: "pri-alice" })) },
      },
      insert: mock(() => ({ values })),
    } as unknown as HubDb;
  }

  it("hands each written mailbox row to the triage hook", async () => {
    const events: Record<string, unknown>[] = [];
    const persist = createPrincipalMailboxPersist(
      makePersistDb(),
      mock(async () => []),
      { onUserMailboxRow: (event) => events.push(event) },
    );

    await persist({
      senderAddress: SENDER.address,
      recipients: ["usr_alice@tenant.example"],
      raw: RAW,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      rowId: "row-42",
      tenantId: "ten-1",
      memberPrincipalId: "pri-alice",
      recipientAddress: "usr_alice@tenant.example",
      senderAddress: SENDER.address,
      subject: "Partnership intro",
      fromAddress: "partner@outside.example",
    });
  });

  it("never fails the persist when the hook throws", async () => {
    const persist = createPrincipalMailboxPersist(
      makePersistDb(),
      mock(async () => []),
      {
        onUserMailboxRow: () => {
          throw new Error("triage exploded");
        },
      },
    );

    await expect(
      persist({
        senderAddress: SENDER.address,
        recipients: ["usr_alice@tenant.example"],
        raw: RAW,
      }),
    ).resolves.toEqual([]);
  });
});
