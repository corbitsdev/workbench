// The composition-root seam CL-6013 fixes: a host that shares one
// `ChannelSubscriberRegistry` between `createChatRoutes` and its own
// workflow-command dispatch (as `apps/hub` does) gets a command-started
// workflow's join event on an already-open SSE stream, with no poll
// required — mirroring what `POST .../invite` already delivered before
// this fix existed only for the ordinary invite path.
import { describe, expect, test } from "bun:test";
import { createChatRoutes } from "../src/routes";
import { createChannelSubscriberRegistry } from "../src/channel-events";
import { startWorkflowCommand } from "../src/channel-service";
import {
  createCommandRegistry,
  createWorkflowCommandPlugin,
} from "@corbits/commands";
import type { ChatChannelEvent } from "../src/platform-port";
import {
  buildDeps,
  createChannel,
  fakePlatform,
  mountAs,
  sendText,
} from "./test-support";

describe("channel subscriber registry shared between chat routes and command dispatch", () => {
  test("a workflow started via a slash command publishes onto a subscriber already listening on that channel", async () => {
    const channelSubscribers = createChannelSubscriberRegistry();
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "echo" }],
    });

    const commands = createCommandRegistry();
    commands.registerCommandPlugin(
      createWorkflowCommandPlugin({
        listInvitableDefinitions: (tenantId) =>
          platform.listInvitableDefinitions(tenantId),
        startWorkflow: (input) =>
          startWorkflowCommand(
            {
              store: deps.store,
              platform,
              publish: channelSubscribers.publish,
            },
            input,
          ),
      }),
    );

    const deps = buildDeps({
      platform,
      commands,
      channelSubscribers,
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: channel } = await createChannel(app, { kind: "channel" });

    const received: ChatChannelEvent[] = [];
    channelSubscribers.subscribe(channel.id, (event) => received.push(event));

    const response = await sendText(app, channel.id, "/echo hello there");
    expect(response.status).toBe(201);

    // No poll: the event must already be in `received` from the
    // synchronous fan-out `registry.publish` performs during the
    // request above, not from re-fetching channel state afterward.
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "chat.settings" });
  });

  test("without an injected registry, createChatRoutes still works with its own default", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { response } = await createChannel(app, { kind: "channel" });
    expect(response.status).toBe(201);
  });
});
