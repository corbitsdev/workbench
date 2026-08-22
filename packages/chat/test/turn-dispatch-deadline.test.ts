// CL-6644's structural close: three rounds of per-hop timeouts (#312
// wake, #314 bypasses, #316 reclaim mail) each fixed one stalling hop
// and a fourth kept appearing — a fourth hang variant (a direct send to
// an already-live run) needed neither #312's wake bound nor #316's
// reclaim-retry bound, and still hung silently. The fix is one
// turn-level deadline: `dispatchTurnBatch` wraps each recipient's
// `dispatchTurn` call in a single wall-clock budget, so no agent turn
// may hang past it regardless of which internal hop stalls. Per-hop
// bounds stay as diagnostics; this is the backstop.
import { describe, expect, test } from "bun:test";

import { createChatRoutes } from "../src/routes";
import {
  buildDeps,
  createWorkbench,
  fakePlatform,
  mountAs,
  settleFanout,
  timelineOf,
} from "./test-support";

describe("dispatchTurnBatch's turn-level deadline (CL-6644)", () => {
  test("a dispatchTurn that never settles still posts an undelivered notice within the injected budget", async () => {
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "echo" }],
    });
    // Models a stall anywhere inside `dispatchTurn`'s own call chain that
    // never throws and never resolves -- the exact shape #316 fixed for
    // the mail-delivery hop specifically, and CL-6644's last comment
    // says stop bounding hops one at a time and put one deadline around
    // the whole turn instead.
    platform.sendMail = () => new Promise<never>(() => {});

    const deps = buildDeps({ platform, turnDispatchTimeoutMs: 20 });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    const started = Date.now();
    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "hello" }] }),
    });
    await settleFanout();
    const elapsedMs = Date.now() - started;

    // The whole HTTP round trip -- including the notice post -- settles
    // well inside a budget generous enough to also cover CI jitter,
    // proving the stall didn't wedge the batch.
    expect(elapsedMs).toBeLessThan(2000);

    const timeline = await timelineOf(deps, workbench.id);
    const notice = timeline.find(
      (message) =>
        message.sender.address === "ins_invited1@acme.example" &&
        message.parts.some(
          (part) => part.kind === "text" && part.turnFailed === true,
        ),
    );
    const noticePart = notice?.parts.find((part) => part.kind === "text");
    expect(noticePart).toMatchObject({ kind: "text", turnFailed: true });
    const text = noticePart?.kind === "text" ? noticePart.text : "";
    expect(text).toMatch(/\(ref [^)]+\)$/);
  });

  test("a timed-out turn releases the workbench's claim instead of wedging it for the TTL", async () => {
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "echo" }],
    });
    platform.sendMail = () => new Promise<never>(() => {});

    const deps = buildDeps({
      platform,
      turnDispatchTimeoutMs: 20,
      turnTimeoutMs: 60_000, // the claim TTL backstop -- must never be needed
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "first" }] }),
    });
    await settleFanout();

    // A second message right after the first's deadline fired must
    // dispatch immediately rather than queue behind a claim the TTL
    // (60s) hasn't released yet -- proving the deadline's rejection
    // released the claim itself, not just posted a notice.
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ kind: "text", text: "second" }] }),
      },
    );
    await settleFanout();
    expect(response.status).toBe(201);

    const timeline = await timelineOf(deps, workbench.id);
    const notices = timeline.filter(
      (message) =>
        message.sender.address === "ins_invited1@acme.example" &&
        message.parts.some(
          (part) => part.kind === "text" && part.turnFailed === true,
        ),
    );
    // Both messages hit the same never-settling `sendMail`, so both
    // should have failed loud on their own -- neither queued silently
    // behind a wedged claim.
    expect(notices).toHaveLength(2);
  });

  test("a slow but eventually-settling dispatch is not killed by the deadline", async () => {
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "echo" }],
    });
    const realSendMail = platform.sendMail.bind(platform);
    platform.sendMail = async (input) => {
      await Bun.sleep(30);
      return realSendMail(input);
    };

    // `dispatchTurn`'s own promise only ever covers "mail handed to the
    // agent's mailbox" (see `./turn-queue.ts`'s note) -- the agent's
    // real, possibly long, streaming reply is produced and posted
    // entirely off this call stack by the orchestrator, so a deadline
    // around `dispatchTurn` can never cut off a reply in progress. This
    // proves the mail-handoff hop itself, once it settles inside the
    // budget, is never mistaken for a stall.
    const deps = buildDeps({ platform, turnDispatchTimeoutMs: 500 });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ kind: "text", text: "hello" }] }),
      },
    );
    await settleFanout();
    expect(response.status).toBe(201);

    const timeline = await timelineOf(deps, workbench.id);
    const notice = timeline.find(
      (message) =>
        message.sender.address === "ins_invited1@acme.example" &&
        message.parts.some(
          (part) => part.kind === "text" && part.turnFailed === true,
        ),
    );
    expect(notice).toBeUndefined();
    expect((platform as ReturnType<typeof fakePlatform>).sentMail).toHaveLength(
      1,
    );
  });

  test("the timeout message names the turn's run address and its elapsed budget", async () => {
    const { turnDispatchTimeoutMessage } =
      await import("../src/workbench-service");
    expect(turnDispatchTimeoutMessage("ins_echo1@acme.example", 30_000)).toBe(
      'turn for "ins_echo1@acme.example" did not settle within 30000ms',
    );
  });
});
