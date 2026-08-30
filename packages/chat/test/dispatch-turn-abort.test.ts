// CL-7201 (Critique finding): `dispatchTurn` must never call `sendMail`
// for a turn whose signal was ALREADY aborted before the call — as
// opposed to CL-7230's disclosed ceiling (a signal that aborts WHILE
// `sendMail` is already in flight, which genuinely cannot be stopped).
// An already-aborted signal at entry means the caller knew, before ever
// asking this to do anything, that the turn was cancelled; dispatching
// a brand-new mail send at that point orphans a reply nothing will ever
// attach to a running row again.
import { describe, expect, test } from "bun:test";

import { createInMemoryAgentTurnStore } from "../src/agent-turns";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import { TurnCancelledError } from "../src/turn-cancellation";
import { dispatchTurn } from "../src/workbench-service";
import { fakePlatform, TENANT } from "./test-support";

describe("dispatchTurn with an already-aborted signal (CL-7201)", () => {
  test("never calls sendMail, and settles the row cancelled", async () => {
    const platform = fakePlatform();
    const agentTurns = createInMemoryAgentTurnStore();
    const roomMessages = createInMemoryRoomMessageStore();
    const controller = new AbortController();
    controller.abort(new TurnCancelledError());

    await dispatchTurn(
      { platform, agentTurns, roomMessages, publish: () => undefined },
      {
        tenantId: TENANT.id,
        workbenchId: "wb_1",
        principalId: "prn_1",
        agentAddress: "ins_echo1@acme.example",
        parts: [{ kind: "text", text: "hello" }],
        requestMessageIds: ["msg_1"],
      },
      controller.signal,
    );

    expect(platform.sentMail).toHaveLength(0);

    const turns = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId: "wb_1",
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe("cancelled");

    const messages = await roomMessages.listMessages({
      tenantId: TENANT.id,
      workbenchId: "wb_1",
    });
    const notice = messages.items.find((message) =>
      message.parts.some(
        (part) => part.kind === "text" && part.turnCancelled === true,
      ),
    );
    expect(notice).toBeDefined();
  });
});
