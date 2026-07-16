import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  assembleMessage,
  assembleSignedContent,
  type MessageHeaders,
} from "@intx/mime";
import type { MessageAttachment } from "@intx/types/runtime";
import type { TurnFinalized } from "@workbench/event-collector";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  resolveMailboxLoadout,
} from "@workbench/myra";

const prepareOnlyLoadout = resolveMailboxLoadout("prepare_only");
import type { MemberPreferences } from "@workbench/shared";
import type { HubDb } from "../db";
import { resetFeatureGrantCache } from "../lib/feature-grants";

const parseDocumentMock = mock(
  async (_db: unknown, _input: Record<string, unknown>) =>
    "Extracted: quarterly numbers.",
);
mock.module("./file-parser", () => ({
  parseDocument: parseDocumentMock,
  FileParseError: class FileParseError extends Error {},
}));

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

const MYRA_TRIAGE_DEF = {
  id: "agt_myra_triage",
  tenantId: "ten-1",
  name: "Myra Triage",
  modelConfig: { defaultModel: "deepseek-v4-flash" },
  credentialRequirements: [
    { providerName: "openai-compatible", source: "tenant", name: "Myra LLM" },
  ],
  capabilities: null,
  contextConfig: null,
  initialState: null,
  modelRequirements: null,
  grantRequirements: null,
  toolPackages: [],
};
const VISION_TRIAGE_DEF = {
  ...MYRA_TRIAGE_DEF,
  id: "agt_myra_triage_vision",
  modelConfig: { defaultModel: "claude-sonnet-5" },
  credentialRequirements: [
    { providerName: "anthropic", source: "tenant", name: "Myra LLM" },
  ],
};
let triageDef: typeof MYRA_TRIAGE_DEF = MYRA_TRIAGE_DEF;
const resolveDefMock = mock(async () => triageDef);
const teardownMock = mock(async () => undefined);
mock.module("./myra-threads", () => ({
  resolveMyraVariantDefinition: resolveDefMock,
  teardownThreadRows: teardownMock,
}));

let variantPref: {
  chat: string | null;
  triage: string | null;
  instructionsGlobal: string | null;
  instructionsChat: string | null;
  instructionsTriage: string | null;
} = {
  chat: null,
  triage: null,
  instructionsGlobal: null,
  instructionsChat: null,
  instructionsTriage: null,
};
const readVariantPrefMock = mock(async () => variantPref);
mock.module("./myra-variant-preferences", () => ({
  readMyraVariantPreference: readVariantPrefMock,
}));

let prefs: MemberPreferences = {};
const readPrefsMock = mock(async () => prefs);
mock.module("../lib/member-preferences", () => ({
  readMemberPreferences: readPrefsMock,
}));

const writeMock = mock(
  async (_db: unknown, _opts: Record<string, unknown>) => ({
    id: "handoff-1",
  }),
);
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

function mailHeaders(overrides?: Partial<MessageHeaders>): MessageHeaders {
  return {
    from: "partner@outside.example",
    to: ["usr_alice@tenant.example"],
    cc: undefined,
    date: new Date("2026-07-10T07:00:00Z"),
    messageId: "<orig-123@outside.example>",
    subject: "Partnership intro",
    inReplyTo: undefined,
    references: undefined,
    mimeVersion: "1.0",
    interchangeType: "conversation.message",
    interchangeCorrelationId: undefined,
    interchangeTenantId: undefined,
    interchangeAgentId: undefined,
    interchangeSessionId: undefined,
    interchangeOfferingId: undefined,
    interchangeSchemaVersion: undefined,
    traceparent: undefined,
    tracestate: undefined,
    extensionHeaders: undefined,
    ...overrides,
  };
}

function buildRawWithAttachments(
  text: string,
  attachments: MessageAttachment[],
): Uint8Array {
  const content = assembleSignedContent({
    kind: "conversation",
    text,
    attachments,
  });
  return assembleMessage(
    mailHeaders(),
    content,
    new TextEncoder().encode("FAKE-SIGNATURE"),
  );
}

const IMAGE_ATTACHMENT: MessageAttachment = {
  name: "screenshot.png",
  contentType: "image/png",
  data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
};

const RAW_WITH_IMAGE = buildRawWithAttachments(
  "Hi Alice, see the attached screenshot.",
  [IMAGE_ATTACHMENT],
);

const ITEM_WITH_IMAGE = { ...ITEM, raw: RAW_WITH_IMAGE };

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
  const sendUserMessage = mock(
    async (_message: Record<string, unknown>) => new Uint8Array(),
  );
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
  now?: () => number,
) {
  return createMailboxTriage({
    db,
    sessionService: session.service,
    grantStore: DUMMY_GRANTS,
    eventCollectors: DUMMY_COLLECTORS,
    cryptoProvider: DUMMY_CRYPTO,
    turnTimeoutMs,
    ...(now ? { now } : {}),
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
  variantPref = {
    chat: null,
    triage: null,
    instructionsGlobal: null,
    instructionsChat: null,
    instructionsTriage: null,
  };
  triageDef = MYRA_TRIAGE_DEF;
  readVariantPrefMock.mockClear();
  launchMock.mockClear();
  teardownMock.mockClear();
  writeMock.mockClear();
  resolveDefMock.mockClear();
  parseDocumentMock.mockClear();
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

  it.each([
    "mailer-daemon",
    "postmaster",
    "no-reply",
    "noreply",
    "do-not-reply",
    "donotreply",
    "bounce",
    "bounces",
    "MAILER-DAEMON",
    "bounces+abc123",
    "No-Reply+campaign42",
  ])("skips bounce/postmaster sender %s", async (localPart) => {
    const { db } = makeDb({ sender: undefined });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue({
      ...ITEM,
      senderAddress: `${localPart}@outside.example`,
    });
    await triage.waitForDrain();

    expect(launchMock).not.toHaveBeenCalled();
  });

  it("does not misclassify a bounce sender when the local part itself contains an @ (splitMailAddress lastIndexOf semantics)", async () => {
    const { db } = makeDb({ sender: undefined });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    // A first `@` inside the local part (e.g. an imported/synced refId) must
    // not be mistaken for the address's domain separator — splitMailAddress
    // anchors on the LAST `@`, so the local part here is "bounce@import",
    // which is NOT in BOUNCE_SENDER_LOCAL_PARTS, and the mail triages.
    triage.enqueue({
      ...ITEM,
      senderAddress: "bounce@import@outside.example",
    });
    await triage.waitForDrain();

    expect(launchMock).toHaveBeenCalled();
  });

  it("skips mail with the triage handoff subject prefix", async () => {
    const { db } = makeDb({ sender: undefined });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue({ ...ITEM, subject: "Myra triaged: Partnership intro" });
    await triage.waitForDrain();

    expect(launchMock).not.toHaveBeenCalled();
  });

  it("skips mail from another member's agent instance in the same tenant", async () => {
    const { db } = makeDb({
      sender: { id: "ins_other-member-myra", principalId: "pri-bob" },
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
    expect(launchOpts.agentId).toBe(MYRA_TRIAGE_DEF.id);
    expect(resolveDefMock).toHaveBeenCalled();

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
    expect(sendArgs.content).toContain("Mailbox message id: row-1");
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
      refs: [{ kind: "mail", ref: "row-1", label: "Open: Partnership intro" }],
    });

    expect(session.endSession).toHaveBeenCalled();
    expect(teardownMock).toHaveBeenCalledTimes(1);
  });

  it("appends the member's global + triage standing instructions after the persona prompt", async () => {
    variantPref = {
      chat: null,
      triage: null,
      instructionsGlobal: "Be terse.",
      instructionsChat: "Chat: use bullet lists.",
      instructionsTriage: "Triage: flag anything from investors.",
    };
    const { db } = makeDb({
      sender: { id: "ins_dep-ext", principalId: "pri-someone-else" },
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM);
    await untilCalled(session.sendUserMessage);

    const launchOpts = launchMock.mock.calls[0]![4] as Record<string, unknown>;
    const systemPrompt = launchOpts.systemPrompt as string;
    expect(systemPrompt).toContain("Be terse.");
    expect(systemPrompt).toContain("Triage: flag anything from investors.");
    // The chat-only override never reaches the triage session prompt.
    expect(systemPrompt).not.toContain("Chat: use bullet lists.");
    expect(systemPrompt.indexOf(prepareOnlyLoadout.systemPrompt)).toBe(0);
  });

  it("keeps the persona prompt verbatim when the member has set no standing instructions", async () => {
    const { db } = makeDb({
      sender: { id: "ins_dep-ext", principalId: "pri-someone-else" },
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM);
    await untilCalled(session.sendUserMessage);

    const launchOpts = launchMock.mock.calls[0]![4] as Record<string, unknown>;
    expect(launchOpts.systemPrompt).toBe(prepareOnlyLoadout.systemPrompt);
  });

  it("binds a member's non-default triage variant while keeping the mailbox loadout", async () => {
    variantPref = {
      chat: null,
      triage: "myra-triage-opus-4-8",
      instructionsGlobal: null,
      instructionsChat: null,
      instructionsTriage: null,
    };
    const { db } = makeDb({
      sender: { id: "ins_dep-ext", principalId: "pri-someone-else" },
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM);
    await untilCalled(session.sendUserMessage);

    // The selected variant's own definition is resolved by seedName…
    const resolvedVariant = resolveDefMock.mock.calls[0]![2] as {
      id: string;
      seedName: string;
    };
    expect(resolvedVariant.id).toBe("myra-triage-opus-4-8");
    expect(resolvedVariant.seedName).toBe("Myra Triage (Opus)");
    // …but the launched loadout stays the mailbox persona's, regardless of model.
    const launchOpts = launchMock.mock.calls[0]![4] as Record<string, unknown>;
    expect(launchOpts.persona).toEqual({
      toolNames: prepareOnlyLoadout.toolNames,
    });
    // The composed triage prompt names the SELECTED variant's model, not the
    // canonical triage default.
    const systemPrompt = launchOpts.systemPrompt as string;
    expect(systemPrompt).toContain(
      "You run on the claude-opus-4-8 model, served through the Corbits platform.",
    );
    expect(systemPrompt).not.toContain("deepseek-v4-flash");
    expect(systemPrompt).toBe(
      resolveMailboxLoadout("prepare_only", true, "claude-opus-4-8")
        .systemPrompt,
    );
  });

  it("diverts an inbound image attachment through the File Parser for a text-only triage agent, instead of riding it inline", async () => {
    const { db } = makeDb({
      sender: { id: "ins_dep-ext", principalId: "pri-someone-else" },
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM_WITH_IMAGE);
    await untilCalled(session.sendUserMessage);

    expect(parseDocumentMock).toHaveBeenCalledTimes(1);
    const parseArgs = parseDocumentMock.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(parseArgs).toMatchObject({
      tenantId: "ten-1",
      filename: "screenshot.png",
      mimeType: "image/png",
    });

    const sendArgs = session.sendUserMessage.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    // No inline image content block reaches the turn — the sent message
    // carries no `attachments` field at all.
    expect(sendArgs.attachments).toBeUndefined();
    // The parser's extracted text surfaces in the message content instead.
    expect(sendArgs.content).toContain("Extracted: quarterly numbers.");

    triage.handleTurnFinalized(
      sendArgs.agentAddress as string,
      completedTurn("done"),
    );
    await triage.waitForDrain();
  });

  it("keeps an inline attachment for a vision-capable triage agent (no over-fixing)", async () => {
    triageDef = VISION_TRIAGE_DEF;
    const { db } = makeDb({
      sender: { id: "ins_dep-ext", principalId: "pri-someone-else" },
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM_WITH_IMAGE);
    await untilCalled(session.sendUserMessage);

    expect(parseDocumentMock).not.toHaveBeenCalled();

    const sendArgs = session.sendUserMessage.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    const attachments = sendArgs.attachments as MessageAttachment[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      name: "screenshot.png",
      contentType: "image/png",
    });

    triage.handleTurnFinalized(
      sendArgs.agentAddress as string,
      completedTurn("done"),
    );
    await triage.waitForDrain();
  });

  it("stores a kind:file artifact only after a successful parse", async () => {
    const { db, txInserts } = makeDb({
      sender: { id: "ins_dep-ext", principalId: "pri-someone-else" },
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM_WITH_IMAGE);
    await untilCalled(session.sendUserMessage);

    // Exactly one file artifact + its version row are persisted, and only
    // because the parse succeeded first.
    const fileArtifacts = txInserts.filter((r) => r.kind === "file");
    expect(fileArtifacts).toHaveLength(1);
    expect(fileArtifacts[0]).toMatchObject({ title: "screenshot.png" });

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

  it("on a parse failure, sends the turn with a note and stores NO orphan artifact", async () => {
    parseDocumentMock.mockImplementationOnce(async () => {
      throw new Error("parser exploded");
    });
    const { db, txInserts } = makeDb({
      sender: { id: "ins_dep-ext", principalId: "pri-someone-else" },
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue(ITEM_WITH_IMAGE);
    await untilCalled(session.sendUserMessage);

    // The failed parse must not leave a committed artifact behind.
    expect(txInserts.filter((r) => r.kind === "file")).toHaveLength(0);

    const sendArgs = session.sendUserMessage.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    // The turn still goes out, carrying a note instead of the image.
    expect(sendArgs.attachments).toBeUndefined();
    expect(sendArgs.content).toContain("could not be parsed");
    expect(sendArgs.content).not.toContain("Extracted: quarterly numbers.");

    triage.handleTurnFinalized(
      sendArgs.agentAddress as string,
      completedTurn("done"),
    );
    await triage.waitForDrain();
  });

  it("drops an oversize attachment without calling the parser or storing an artifact", async () => {
    const oversize: MessageAttachment = {
      name: "huge.png",
      contentType: "image/png",
      data: new Uint8Array(10 * 1024 * 1024 + 1),
    };
    const { db, txInserts } = makeDb({
      sender: { id: "ins_dep-ext", principalId: "pri-someone-else" },
    });
    const session = makeSessionService();
    const triage = makeTriage(db, session);

    triage.enqueue({
      ...ITEM,
      raw: buildRawWithAttachments("See attached.", [oversize]),
    });
    await untilCalled(session.sendUserMessage);

    expect(parseDocumentMock).not.toHaveBeenCalled();
    expect(txInserts.filter((r) => r.kind === "file")).toHaveLength(0);

    const sendArgs = session.sendUserMessage.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(sendArgs.attachments).toBeUndefined();
    expect(sendArgs.content).toContain("too large");

    triage.handleTurnFinalized(
      sendArgs.agentAddress as string,
      completedTurn("done"),
    );
    await triage.waitForDrain();
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

  it("leaves the DB rows in place (does not teardown) when endSession fails, so the boot sweep can retry deprovisioning", async () => {
    const { db } = makeDb({
      sender: { id: "ins_dep-ext", principalId: "pri-someone-else" },
    });
    const session = makeSessionService();
    session.endSession.mockImplementation(async () => {
      throw new Error("sidecar unreachable");
    });
    const triage = makeTriage(db, session, 20);

    triage.enqueue(ITEM);
    await triage.waitForDrain();

    expect(session.endSession).toHaveBeenCalled();
    expect(teardownMock).not.toHaveBeenCalled();
  });

  it("still tears down (nothing to deprovision) when the launch itself fails before a session ever exists", async () => {
    const { db } = makeDb({
      sender: { id: "ins_dep-ext", principalId: "pri-someone-else" },
    });
    const session = makeSessionService();
    launchMock.mockImplementationOnce(async () => {
      throw new Error("launch failed");
    });
    const triage = makeTriage(db, session, 20);

    triage.enqueue(ITEM);
    await triage.waitForDrain();

    expect(session.endSession).not.toHaveBeenCalled();
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
    // Advance the clock well past the spawn-budget window on every tick so
    // this test — which exercises queue capping, not the spawn budget —
    // never trips the (unrelated) per-tenant session ceiling.
    let clock = 0;
    const triage = makeTriage(db, session, 2_000, () => {
      clock += 60 * 60 * 1000 + 1;
      return clock;
    });

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

describe("createMailboxTriage session spawn budget", () => {
  it("spawns while under the per-tenant hourly budget", async () => {
    const { db } = makeDb({ sender: undefined });
    const session = makeSessionService();
    const triage = makeTriage(db, session, 2_000, () => 1_000);

    triage.enqueue({ ...ITEM, rowId: "row-1" });
    await triage.waitForDrain();

    expect(session.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("drops and logs once the per-tenant budget is exhausted, without spawning", async () => {
    const { db } = makeDb({ sender: undefined });
    const session = makeSessionService();
    const triage = createMailboxTriage({
      db,
      sessionService: session.service,
      grantStore: DUMMY_GRANTS,
      eventCollectors: DUMMY_COLLECTORS,
      cryptoProvider: DUMMY_CRYPTO,
      turnTimeoutMs: 5,
      now: () => 1_000,
    });

    for (let i = 0; i < 31; i++) {
      triage.enqueue({ ...ITEM, rowId: `row-${i}` });

      await triage.waitForDrain();
    }

    expect(session.sendUserMessage).toHaveBeenCalledTimes(30);
  });

  it("slides the window: budget frees up as old spawns expire", async () => {
    const { db } = makeDb({ sender: undefined });
    const session = makeSessionService();
    let clock = 1_000;
    const triage = createMailboxTriage({
      db,
      sessionService: session.service,
      grantStore: DUMMY_GRANTS,
      eventCollectors: DUMMY_COLLECTORS,
      cryptoProvider: DUMMY_CRYPTO,
      turnTimeoutMs: 5,
      now: () => clock,
    });

    for (let i = 0; i < 30; i++) {
      triage.enqueue({ ...ITEM, rowId: `row-${i}` });

      await triage.waitForDrain();
    }
    expect(session.sendUserMessage).toHaveBeenCalledTimes(30);

    triage.enqueue({ ...ITEM, rowId: "row-blocked" });
    await triage.waitForDrain();
    expect(session.sendUserMessage).toHaveBeenCalledTimes(30);

    clock += 60 * 60 * 1000 + 1;
    triage.enqueue({ ...ITEM, rowId: "row-after-window" });
    await triage.waitForDrain();
    expect(session.sendUserMessage).toHaveBeenCalledTimes(31);
  });

  it("isolates the budget per tenant: one tenant's cap does not block another's", async () => {
    const { db } = makeDb({ sender: undefined });
    const session = makeSessionService();
    const triage = createMailboxTriage({
      db,
      sessionService: session.service,
      grantStore: DUMMY_GRANTS,
      eventCollectors: DUMMY_COLLECTORS,
      cryptoProvider: DUMMY_CRYPTO,
      turnTimeoutMs: 5,
      now: () => 1_000,
    });

    for (let i = 0; i < 31; i++) {
      triage.enqueue({ ...ITEM, tenantId: "ten-a", rowId: `ten-a-${i}` });

      await triage.waitForDrain();
    }
    expect(session.sendUserMessage).toHaveBeenCalledTimes(30);

    triage.enqueue({ ...ITEM, tenantId: "ten-b", rowId: "ten-b-1" });
    await triage.waitForDrain();
    expect(session.sendUserMessage).toHaveBeenCalledTimes(31);
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
