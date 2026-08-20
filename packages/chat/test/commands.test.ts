// The message-path command intercept `routes.ts`'s
// `dispatchWorkbenchCommand` owns: a leading "/" is always dispatched
// (and never posted onto the timeline itself, only its result); a leading
// "@name" is dispatched only when `name` is not an existing agent
// participant's handle, so an ordinary agent mention is untouched.
import { describe, expect, test } from "bun:test";
import { createChatRoutes } from "../src/routes";
import { createCommandRegistry } from "@corbits/commands";
import {
  buildDeps,
  createWorkbench,
  fakePlatform,
  mountAs,
  sendText,
  timelineOf,
  timelineTexts,
} from "./test-support";

describe("workbench command dispatch", () => {
  test("without an injected registry, a leading slash is posted as an ordinary message", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await sendText(app, workbench.id, "/echo hello");
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["command"]).toBeUndefined();
  });

  test("an unknown slash command posts a loud message and never posts the raw text", async () => {
    const registry = createCommandRegistry();
    const deps = buildDeps({ commands: registry });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await sendText(app, workbench.id, "/nope some args");
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      command: { type: string; text: string };
    };
    expect(body.command).toEqual({
      type: "message",
      text: "Unknown command: /nope",
    });

    // Only the result reaches the timeline; the raw "/nope some args"
    // never does.
    expect(timelineTexts(await timelineOf(deps, workbench.id))).toEqual([
      "Unknown command: /nope",
    ]);
  });

  test("a registered slash command runs its handler with the parsed args", async () => {
    const registry = createCommandRegistry();
    let seenArgs: string | undefined;
    registry.registerCommand({
      name: "greet",
      description: "greets",
      handler: (args) => {
        seenArgs = args;
        return { type: "message", text: `hi ${args}` };
      },
    });
    const deps = buildDeps({ commands: registry });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await sendText(app, workbench.id, "/greet world");
    expect(response.status).toBe(201);
    expect(seenArgs).toBe("world");
    expect(timelineTexts(await timelineOf(deps, workbench.id))).toEqual([
      "hi world",
    ]);
  });

  test("an @mention of an existing agent participant keeps its ordinary fan-out, never the command path", async () => {
    const registry = createCommandRegistry();
    registry.registerCommand({
      name: "ins_echo1",
      description: "would shadow the participant's handle",
      handler: () => ({ type: "message", text: "should not run" }),
    });
    const deps = buildDeps({
      commands: registry,
      platform: fakePlatform(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });

    const response = await sendText(app, workbench.id, "@ins_echo1 hi");
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["command"]).toBeUndefined();

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    // The ordinary mention fan-out sent a copy to the participant.
    expect(
      platform.sentMail.some((mail) => mail.workbenchId === "ins_echo1"),
    ).toBe(true);
  });

  test("an @name that resolves to a command (not a participant) dispatches instead of fanning out", async () => {
    const registry = createCommandRegistry();
    registry.registerCommand({
      name: "assistant",
      description: "not yet a participant",
      handler: (args) => ({ type: "message", text: `starting: ${args}` }),
    });
    const deps = buildDeps({ commands: registry });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await sendText(
      app,
      workbench.id,
      "@assistant do the thing",
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      command: { type: string; text: string };
    };
    expect(body.command).toEqual({
      type: "message",
      text: "starting: do the thing",
    });
  });
});
