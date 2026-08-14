import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { TagEvent, TagThread } from "corbits-tag/slack";
import type { PrincipalResolution } from "corbits-tag/interchange";

import { dispatchWorkbenchSlackEvent, mountWorkbenchSlack } from "./dispatch";
import { createInMemorySlackChannelBindingStore } from "./store";
import type { MountWorkbenchSlackDeps } from "./dispatch";

/** Every method resolves to undefined — enough for Chat's lazy init path.
 * Mirrors `corbits-tag/slack`'s own `noopState` test helper: a structurally
 * valid `StateAdapter` is heavy to fake, and these tests only exercise the
 * seams `@corbits/slack-tag` owns (signature verification is the SDK's, and
 * is exercised here purely at the transport boundary). */
const noopState = () =>
  new Proxy({}, { get: () => async () => undefined }) as never;

function baseDeps(
  overrides: Partial<MountWorkbenchSlackDeps> = {},
): MountWorkbenchSlackDeps {
  return {
    tenantId: "tenant_1",
    slack: { botToken: "xoxb-test", signingSecret: "shhh-real-secret" },
    state: noopState(),
    bindings: createInMemorySlackChannelBindingStore(),
    resolvePrincipal: async () => ({
      ok: true,
      principal: {
        principalId: "prn_1",
        tenantId: "tenant_1",
        userId: "usr_1",
        email: "person@example.com",
      },
    }),
    provisionChannel: async () => ({ channelId: "workflowRun_new" }),
    sendMessage: async () => ({ id: "mail_1" }),
    subscribeToChannel: () => () => undefined,
    // Fast default so a test that never fires a reply doesn't sit on the
    // production 60s default and blow the test runner's own timeout.
    replyWaitMs: 50,
    ...overrides,
  };
}

/**
 * Signature verification (transport boundary): this exercises the REAL
 * `corbits-tag/slack` mount over a real Hono app with a genuine Slack HMAC
 * signature computed against the WRONG secret — nothing here is mocked, so
 * a pass proves `@corbits/slack-tag` inherits real signature verification
 * rather than bypassing it.
 */
describe("mountWorkbenchSlack signature verification", () => {
  test("rejects a request signed with the wrong secret", async () => {
    const app = new Hono();
    const deps = baseDeps();
    const { path } = mountWorkbenchSlack(app, deps);

    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "app_mention",
        channel: "C1",
        user: "U1",
        text: "<@BOT1> hello",
        ts: "1721800000.000100",
      },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const wrongSecretSignature =
      "v0=" +
      createHmac("sha256", "not-the-real-secret")
        .update(`v0:${timestamp}:${body}`)
        .digest("hex");

    const res = await app.request(path, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": wrongSecretSignature,
      },
    });

    expect(res.status).toBe(401);
  });

  test("rejects a request with no signature headers at all", async () => {
    const app = new Hono();
    const { path } = mountWorkbenchSlack(app, baseDeps());
    const res = await app.request(path, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });
});

function fakeAuthor(overrides: Partial<TagEvent["author"]> = {}) {
  return {
    userId: "U1",
    userName: "alice",
    fullName: "Alice Example",
    isBot: false as const,
    email: "alice@example.com",
    emailVerified: true as const,
    isRestricted: false as const,
    ...overrides,
  };
}

function fakeEvent(overrides: Partial<TagEvent> = {}): TagEvent {
  return {
    platform: "slack",
    threadId: "C1:1721800000.000100",
    text: "hello there",
    author: fakeAuthor(),
    isMention: true,
    trigger: "mention",
    ...overrides,
  };
}

function fakeThread(): TagThread & { posts: string[]; subscribed: boolean } {
  const posts: string[] = [];
  return {
    id: "C1:1721800000.000100",
    posts,
    subscribed: false,
    async post(text) {
      posts.push(text);
    },
    async subscribe() {
      this.subscribed = true;
    },
  };
}

describe("dispatchWorkbenchSlackEvent", () => {
  test("a mention auto-provisions the principal, binds the channel, and lands the message in chat", async () => {
    const bindings = createInMemorySlackChannelBindingStore();
    let resolvedAuthor: unknown;
    let provisioned:
      | { tenantId: string; name: string; creatorPrincipalId: string }
      | undefined;
    let sent:
      | {
          tenantId: string;
          channelId: string;
          principalId: string;
          text: string;
        }
      | undefined;

    const deps = baseDeps({
      bindings,
      resolvePrincipal: async (author) => {
        resolvedAuthor = author;
        return {
          ok: true,
          principal: {
            principalId: "prn_1",
            tenantId: "tenant_1",
            userId: "usr_1",
            email: "alice@example.com",
          },
        } satisfies PrincipalResolution;
      },
      provisionChannel: async (input) => {
        provisioned = input;
        return { channelId: "workflowRun_new" };
      },
      sendMessage: async (input) => {
        sent = input;
        return { id: "mail_1" };
      },
      resolveChannelName: async () => "general",
    });

    const thread = fakeThread();
    await dispatchWorkbenchSlackEvent(deps, fakeEvent(), thread);

    expect(resolvedAuthor).toEqual({
      userId: "U1",
      email: "alice@example.com",
      emailVerified: true,
      isRestricted: false,
      isBot: false,
    });
    expect(provisioned).toEqual({
      tenantId: "tenant_1",
      name: "general",
      creatorPrincipalId: "prn_1",
    });
    expect(sent).toEqual({
      tenantId: "tenant_1",
      channelId: "workflowRun_new",
      principalId: "prn_1",
      text: "hello there",
    });

    const binding = await bindings.getBinding("tenant_1", "C1");
    expect(binding?.channelId).toBe("workflowRun_new");
    expect(thread.subscribed).toBe(true);
  });

  test("a second mention in the same Slack channel reuses the existing binding", async () => {
    const bindings = createInMemorySlackChannelBindingStore();
    await bindings.createBinding({
      tenantId: "tenant_1",
      slackChannelId: "C1",
      channelId: "workflowRun_existing",
    });

    let provisionCalls = 0;
    let sentChannelId: string | undefined;
    const deps = baseDeps({
      bindings,
      provisionChannel: async () => {
        provisionCalls += 1;
        return { channelId: "workflowRun_should_not_be_used" };
      },
      sendMessage: async (input) => {
        sentChannelId = input.channelId;
        return { id: "mail_2" };
      },
    });

    await dispatchWorkbenchSlackEvent(deps, fakeEvent(), fakeThread());

    expect(provisionCalls).toBe(0);
    expect(sentChannelId).toBe("workflowRun_existing");
  });

  test("an unresolved author is told why, and no channel is provisioned or messaged", async () => {
    let provisionCalls = 0;
    let sendCalls = 0;
    const deps = baseDeps({
      resolvePrincipal: async () => ({
        ok: false,
        reason: "restricted_author",
        tenantId: undefined,
        email: undefined,
      }),
      provisionChannel: async () => {
        provisionCalls += 1;
        return { channelId: "should_not_happen" };
      },
      sendMessage: async () => {
        sendCalls += 1;
        return { id: "should_not_happen" };
      },
    });

    const thread = fakeThread();
    await dispatchWorkbenchSlackEvent(deps, fakeEvent(), thread);

    expect(provisionCalls).toBe(0);
    expect(sendCalls).toBe(0);
    expect(thread.posts).toHaveLength(1);
    expect(thread.posts[0]).toMatch(/guest and shared-channel/);
  });

  test("relays the agent's reply back to the Slack thread once it lands on the channel stream", async () => {
    let capturedOnEvent:
      ((event: { type: string; data: unknown }) => void) | undefined;
    const deps = baseDeps({
      subscribeToChannel: (_channelId, onEvent) => {
        capturedOnEvent = onEvent;
        return () => undefined;
      },
      sendMessage: async () => {
        // Fire the reply once the message "lands" — mirrors the real chat
        // orchestrator turning a connector.reply sidecar event into a
        // channel event asynchronously after sendMail resolves.
        queueMicrotask(() => {
          capturedOnEvent?.({
            type: "chat.agent",
            data: {
              type: "connector.reply",
              data: { content: "Hi! How can I help?" },
            },
          });
        });
        return { id: "mail_1" };
      },
    });

    const thread = fakeThread();
    await dispatchWorkbenchSlackEvent(deps, fakeEvent(), thread);

    expect(thread.posts).toEqual(["Hi! How can I help?"]);
  });

  test("leaves no reply posted when the wait times out", async () => {
    const deps = baseDeps({ replyWaitMs: 10 });
    const thread = fakeThread();
    await dispatchWorkbenchSlackEvent(deps, fakeEvent(), thread);
    expect(thread.posts).toEqual([]);
  });
});
