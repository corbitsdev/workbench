// The message-path command intercept `routes.ts`'s
// `dispatchWorkbenchCommand` owns: a leading "/" is always dispatched
// (and never posted onto the timeline itself, only its result); a leading
// "@name" is dispatched only when `name` is not an existing agent
// participant's handle, so an ordinary agent mention is untouched.
import { describe, expect, test } from "bun:test";
import { createChatRoutes } from "../src/routes";
import {
  createCommandRegistry,
  createWorkflowCommandPlugin,
} from "@corbits/commands";
import { createInMemoryAgentTurnStore } from "../src/agent-turns";
import { startWorkflowCommand } from "../src/workbench-service";
import {
  buildDeps,
  createWorkbench,
  fakePlatform,
  mountAs,
  sendText,
  timelineOf,
  timelineTexts,
  TENANT,
} from "./test-support";

/**
 * The full workflow-command wiring the hub composes: the registrar's
 * commands are the tenant's invitable definitions, dispatching through
 * `startWorkflowCommand` against the same store/platform the routes use.
 */
function buildWorkflowCommandDeps(
  platform: ReturnType<typeof fakePlatform>,
): ReturnType<typeof buildDeps> & {
  agentTurns: ReturnType<typeof createInMemoryAgentTurnStore>;
} {
  const registry = createCommandRegistry();
  const agentTurns = createInMemoryAgentTurnStore();
  const deps = buildDeps({ commands: registry, platform, agentTurns });
  registry.registerCommandPlugin(
    createWorkflowCommandPlugin({
      listInvitableDefinitions: (tenantId) =>
        platform.listInvitableDefinitions(tenantId),
      startWorkflow: (input) =>
        startWorkflowCommand(
          {
            store: deps.store,
            platform,
            roomMessages: deps.roomMessages,
            publish: () => undefined,
          },
          input,
        ),
    }),
  );
  return Object.assign(deps, { agentTurns });
}

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

  // CL-6451: the participant's mention handle derives from the
  // definition's display name ("Myra"), while the workflow command is
  // named after the definition's wire name ("assistant") — so the
  // known-handle guard alone cannot see that `@assistant` names an agent
  // already in the room, and the command path used to mint a SECOND run
  // for the same participant.
  test("an @name naming an already-resident definition routes to the existing run, never a second one", async () => {
    const platform = fakePlatform({
      invitable: [
        { id: "wfd_assistant", name: "assistant", description: "Myra" },
      ],
      resolveDefinitionIdByAddress: async (address) =>
        address === "ins_invited1@acme.example" ? "wfd_assistant" : undefined,
    });
    const deps = buildWorkflowCommandDeps(platform);
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const invite = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_assistant" }),
    });
    expect(invite.status).toBe(201);
    expect(platform.launchInviteCalls).toHaveLength(1);

    const response = await sendText(
      app,
      workbench.id,
      "@assistant set up a sales workbench",
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    // Not a command dispatch: the message posts as an ordinary message.
    expect(body["command"]).toBeUndefined();
    // One participant, one run: no second launch.
    expect(platform.launchInviteCalls).toHaveLength(1);

    // The message reached the EXISTING participant's run...
    const delivered = platform.sentMail.filter(
      (mail) => mail.workbenchId === "ins_invited1",
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.content.content).toContain("set up a sales workbench");
    // ...through the ordinary turn pipeline: one turn row, on the same
    // occurrence sequence every later turn of this participant rides.
    const turns = await deps.agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId: workbench.id,
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      agentAddress: "ins_invited1@acme.example",
      childRunId: "turn__0",
      status: "running",
    });
    // The user's words stay on the timeline, never swallowed by the
    // command intercept.
    expect(timelineTexts(await timelineOf(deps, workbench.id))).toEqual([
      "@assistant set up a sales workbench",
    ]);

    // CL-6453: the next mention rides the SAME run's occurrence
    // sequence — turn__0 then turn__1 on one section run — so the
    // first exchange lives in the same stepId-keyed history every later
    // turn restores.
    await sendText(app, workbench.id, "@assistant continue");
    const afterSecond = await deps.agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId: workbench.id,
    });
    expect(
      afterSecond
        .map((turn) => ({
          agentAddress: turn.agentAddress,
          childRunId: turn.childRunId,
        }))
        .sort((a, b) => a.childRunId.localeCompare(b.childRunId)),
    ).toEqual([
      {
        agentAddress: "ins_invited1@acme.example",
        childRunId: "turn__0",
      },
      {
        agentAddress: "ins_invited1@acme.example",
        childRunId: "turn__1",
      },
    ]);
    expect(platform.launchInviteCalls).toHaveLength(1);
  });

  test("an @name for a definition NOT in the room still starts it as a command", async () => {
    const platform = fakePlatform({
      invitable: [
        { id: "wfd_assistant", name: "assistant", description: "Myra" },
      ],
    });
    const deps = buildWorkflowCommandDeps(platform);
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await sendText(app, workbench.id, "@assistant hello");
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      command: { type: string; handle: string };
    };
    expect(body.command.type).toBe("workflow-started");
    expect(platform.launchInviteCalls).toHaveLength(1);
  });
});
