import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  CODE_REVIEW_TEMPLATE,
  serializeWorkbenchDefinition,
} from "@workbench/templates";

import {
  createWorkbenchFromTemplate,
  NEW_WORKBENCH_TITLE,
} from "./instant-agent-create";

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("createWorkbenchFromTemplate", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  type RecordedCall = { readonly path: string; readonly init?: RequestInit };

  function stubFetch(respond: (path: string) => Response): RecordedCall[] {
    const calls: RecordedCall[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === "string" ? input : new URL(String(input)).pathname;
      calls.push(init === undefined ? { path } : { path, init });
      return Promise.resolve(respond(path));
    }) as typeof fetch;
    return calls;
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const assistantDefinitionWire = {
    id: "def-assistant",
    tenantId: "tnt_1",
    name: "assistant",
    currentVersion: "1",
    status: "deployed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    skills: [] as readonly string[],
  };

  // The picker's "Create workbench" is clickable more than once per
  // session (a second visit, a second row) — each click must mint its
  // own, genuinely distinct workbench, never reopen or alias the last
  // one it created.
  test("picking the same row twice in a row mints two distinct workbenches, not one reused", async () => {
    let nextId = 0;
    const navigated: string[] = [];
    const calls = stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [assistantDefinitionWire], nextCursor: null });
      }
      if (path.endsWith("/chat/workbenches")) {
        nextId += 1;
        return json({
          id: `chan-${nextId}`,
          title: NEW_WORKBENCH_TITLE,
          kind: "workbench",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await createWorkbenchFromTemplate(
      "tnt_1",
      "blank",
      (to) => navigated.push(to),
      newQueryClient(),
    );
    await createWorkbenchFromTemplate(
      "tnt_1",
      "blank",
      (to) => navigated.push(to),
      newQueryClient(),
    );

    const createCalls = calls.filter((call) =>
      call.path.endsWith("/chat/workbenches"),
    );
    expect(createCalls).toHaveLength(2);
    expect(navigated).toEqual(["/w/chan-1", "/w/chan-2"]);
    expect(navigated[0]).not.toBe(navigated[1]);

    // Blank ("Just start talking") has no template to name the bench
    // after, so it keeps the generic title rather than something
    // invented.
    const body = JSON.parse(String(createCalls[0]?.init?.body));
    expect(body.name).toBe(NEW_WORKBENCH_TITLE);
  });

  // CL-6982: the + / picker create path mints a `kind: "workbench"`
  // channel, never a Myra DM clone (`kind: "chat"` + `definitionId`).
  test("blank create POSTs kind=workbench with no definitionId and invites nobody (CL-6982)", async () => {
    const calls = stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [assistantDefinitionWire], nextCursor: null });
      }
      if (path.endsWith("/chat/workbenches")) {
        return json({
          id: "chan-1",
          title: NEW_WORKBENCH_TITLE,
          kind: "workbench",
          pinned: true,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await createWorkbenchFromTemplate(
      "tnt_1",
      "blank",
      () => undefined,
      newQueryClient(),
    );

    const createCall = calls.find((call) =>
      call.path.endsWith("/chat/workbenches"),
    );
    const body = JSON.parse(String(createCall?.init?.body)) as {
      readonly kind?: string;
      readonly definitionId?: string;
      readonly reuseExisting?: boolean;
      readonly name?: string;
    };
    expect(body.kind).toBe("workbench");
    expect(body.definitionId).toBeUndefined();
    expect(body.reuseExisting).toBeUndefined();
    expect(body.name).toBe(NEW_WORKBENCH_TITLE);
    expect(calls.some((call) => call.path.includes("/invite"))).toBe(false);
  });

  test("picking the code-review definition names the bench after it and invites exactly its three reviewers", async () => {
    const navigated: string[] = [];
    let nextReviewerId = 0;
    const calls = stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [assistantDefinitionWire], nextCursor: null });
      }
      if (path.endsWith("/library/templates/code-review")) {
        return json({
          id: "code-review",
          content: serializeWorkbenchDefinition(CODE_REVIEW_TEMPLATE),
        });
      }
      if (path.endsWith("/chat/workbenches")) {
        return json({
          id: "chan-1",
          title: "Code review",
          kind: "workbench",
          pinned: false,
          participants: [],
        });
      }
      if (path.endsWith("/template-blocks/code-review/deploy")) {
        return json({ id: "def-code-review-block", created: true });
      }
      if (path.endsWith("/agent-definitions")) {
        nextReviewerId += 1;
        return json({
          ...assistantDefinitionWire,
          id: `def-reviewer-${nextReviewerId}`,
        });
      }
      if (path.endsWith("/chat/workbenches/chan-1/onboarding")) {
        return json({ id: "msg-onboarding" }, 201);
      }
      if (path.endsWith("/chat/workbenches/chan-1/invite")) {
        return json({ address: "agent:invited", definitionId: "def-reviewer" });
      }
      if (path.endsWith("/chat/workbenches/chan-1/settings")) {
        return json({
          id: "chan-1",
          title: "Code review",
          kind: "workbench",
          pinned: false,
          participants: [],
          settings: {},
          contextWindow: { value: 0, source: "inherit" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const queryClient = newQueryClient();
    // Seed the cache the way a person browsing before creating this
    // workbench would have: a `workbenches` list fetched before any of
    // the reviewer roster below was invited.
    const staleQueryKey = ["tenant", "tnt_1", "workbenches", "chat"] as const;
    queryClient.setQueryData(staleQueryKey, { items: [] });

    await createWorkbenchFromTemplate(
      "tnt_1",
      "code-review",
      (to) => navigated.push(to),
      queryClient,
    );

    const createCall = calls.find((call) =>
      call.path.endsWith("/chat/workbenches"),
    );
    const createBody = JSON.parse(String(createCall?.init?.body));
    expect(createBody.name).toBe(CODE_REVIEW_TEMPLATE.title);

    const createAgentCalls = calls.filter((call) =>
      call.path.endsWith("/agent-definitions"),
    );
    expect(createAgentCalls).toHaveLength(CODE_REVIEW_TEMPLATE.agents.length);

    const inviteCalls = calls.filter((call) =>
      call.path.endsWith("/chat/workbenches/chan-1/invite"),
    );
    const invitedIds = inviteCalls.map(
      (call) => JSON.parse(String(call.init?.body)).definitionId,
    );
    const createdIds = createAgentCalls.map(
      (_, index) => `def-reviewer-${index + 1}`,
    );
    expect(invitedIds.sort()).toEqual([...createdIds].sort());
    expect(invitedIds).not.toContain("def-assistant");

    const settingsBody = JSON.parse(
      String(
        calls.find((call) =>
          call.path.endsWith("/chat/workbenches/chan-1/settings"),
        )?.init?.body,
      ),
    );
    expect(settingsBody).toEqual({
      "template/id": "code-review",
      "template/pendingConnections": ["github"],
    });

    const onboardingCall = calls.find((call) =>
      call.path.endsWith("/chat/workbenches/chan-1/onboarding"),
    );
    expect(JSON.parse(String(onboardingCall?.init?.body))).toEqual({
      kind: "connect-github",
      requiredForTemplate: "Code review",
      promise: CODE_REVIEW_TEMPLATE.promise,
      steps: CODE_REVIEW_TEMPLATE.onboardingSteps.map(({ title, why }) => ({
        title,
        why,
      })),
    });

    const createBodyParsed = JSON.parse(String(createCall?.init?.body));
    expect(createBodyParsed.kind).toBe("workbench");
    expect(createBodyParsed.definitionId).toBeUndefined();
    expect(navigated).toEqual(["/w/chan-1"]);

    // CL-6594: a room this function navigates to must never carry a
    // `workbenches` cache captured before its own reviewer roster
    // finished being invited — that staleness is what left an invited
    // agent with no name, no avatar, and no `@mention` in the room the
    // owner reported it from.
    expect(queryClient.getQueryState(staleQueryKey)?.isInvalidated).toBe(true);
  });

  // CL-6656: the prompt-box path mints a blank "New Workbench" and used to
  // leave that placeholder in the sidebar forever. With a known first
  // message, create renames via the same `chat/name` settings PATCH the
  // sidebar rename uses.
  test("blank create with a first message renames off New Workbench via chat/name", async () => {
    const navigated: string[] = [];
    const calls = stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [assistantDefinitionWire], nextCursor: null });
      }
      if (path.endsWith("/chat/workbenches")) {
        return json({
          id: "chan-adhoc",
          title: NEW_WORKBENCH_TITLE,
          kind: "workbench",
          pinned: false,
          participants: [],
        });
      }
      if (path.endsWith("/chat/workbenches/chan-adhoc/messages")) {
        return json({
          id: "msg-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          sender: { name: "Sawyer", address: "principal-1" },
          parts: [{ kind: "text", text: "Plan the Q3 launch" }],
        });
      }
      if (path.endsWith("/chat/workbenches/chan-adhoc/settings")) {
        return json({
          id: "chan-adhoc",
          title: "Plan the Q3 launch",
          kind: "workbench",
          pinned: false,
          participants: [],
          settings: { "chat/name": "Plan the Q3 launch" },
          contextWindow: { value: 0, source: "inherit" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await createWorkbenchFromTemplate(
      "tnt_1",
      "blank",
      (to) => navigated.push(to),
      newQueryClient(),
      "Plan the Q3 launch",
    );

    const settingsCall = calls.find((call) =>
      call.path.endsWith("/chat/workbenches/chan-adhoc/settings"),
    );
    expect(settingsCall).toBeDefined();
    expect(JSON.parse(String(settingsCall?.init?.body))).toEqual({
      "chat/name": "Plan the Q3 launch",
    });
    expect(navigated).toEqual(["/w/chan-adhoc"]);
  });

  test("prefab create with a first message does not overwrite the template title", async () => {
    const calls = stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [assistantDefinitionWire], nextCursor: null });
      }
      if (path.endsWith("/library/templates/code-review")) {
        return json({
          id: "code-review",
          content: serializeWorkbenchDefinition(CODE_REVIEW_TEMPLATE),
        });
      }
      if (path.endsWith("/chat/workbenches")) {
        return json({
          id: "chan-1",
          title: "Code review",
          kind: "workbench",
          pinned: false,
          participants: [],
        });
      }
      if (path.endsWith("/template-blocks/code-review/deploy")) {
        return json({ id: "def-code-review-block", created: true });
      }
      if (path.endsWith("/agent-definitions")) {
        return json({ ...assistantDefinitionWire, id: "def-reviewer-1" });
      }
      if (path.endsWith("/chat/workbenches/chan-1/onboarding")) {
        return json({ id: "msg-onboarding" }, 201);
      }
      if (path.endsWith("/chat/workbenches/chan-1/invite")) {
        return json({
          address: "agent:invited",
          definitionId: "def-reviewer-1",
        });
      }
      if (path.endsWith("/chat/workbenches/chan-1/settings")) {
        return json({
          id: "chan-1",
          title: "Code review",
          kind: "workbench",
          pinned: false,
          participants: [],
          settings: {},
          contextWindow: { value: 0, source: "inherit" },
        });
      }
      if (path.endsWith("/chat/workbenches/chan-1/messages")) {
        return json({
          id: "msg-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          sender: { name: "Sawyer", address: "principal-1" },
          parts: [{ kind: "text", text: "Review the auth PR" }],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await createWorkbenchFromTemplate(
      "tnt_1",
      "code-review",
      () => {},
      newQueryClient(),
      "Review the auth PR",
    );

    const settingsBodies = calls
      .filter((call) => call.path.endsWith("/chat/workbenches/chan-1/settings"))
      .map((call) => JSON.parse(String(call.init?.body)));
    expect(
      settingsBodies.some(
        (body) =>
          typeof body === "object" &&
          body !== null &&
          "chat/name" in body &&
          body["chat/name"] === "Review the auth PR",
      ),
    ).toBe(false);
  });

  // GitHub already connected is not a different create path: the in-room
  // card reads live connected state and flips itself to repo pick, so the
  // create flow posts the same walkthrough card and never picks repos or
  // starts reviewing on the person's behalf.
  test("with GitHub already connected, create posts the same walkthrough and never starts reviewing itself", async () => {
    const calls = stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [assistantDefinitionWire], nextCursor: null });
      }
      if (path.endsWith("/library/templates/code-review")) {
        return json({
          id: "code-review",
          content: serializeWorkbenchDefinition(CODE_REVIEW_TEMPLATE),
        });
      }
      if (path.endsWith("/chat/workbenches")) {
        return json({
          id: "chan-1",
          title: "Code review",
          kind: "workbench",
          pinned: false,
          participants: [],
        });
      }
      if (path.endsWith("/template-blocks/code-review/deploy")) {
        return json({ id: "def-code-review-block", created: true });
      }
      if (path.endsWith("/agent-definitions")) {
        return json({ ...assistantDefinitionWire, id: "def-reviewer-1" });
      }
      if (path.endsWith("/chat/workbenches/chan-1/onboarding")) {
        return json({ id: "msg-onboarding" }, 201);
      }
      if (path.endsWith("/chat/workbenches/chan-1/invite")) {
        return json({ address: "agent:invited", definitionId: "def-reviewer" });
      }
      if (path.endsWith("/chat/workbenches/chan-1/settings")) {
        return json({
          id: "chan-1",
          title: "Code review",
          kind: "workbench",
          pinned: false,
          participants: [],
          settings: {},
          contextWindow: { value: 0, source: "inherit" },
        });
      }
      if (path.includes("/credentials/resolve/")) {
        return json({
          id: "cred_github",
          tenantId: "tnt_1",
          name: "GitHub",
          status: "active",
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await createWorkbenchFromTemplate(
      "tnt_1",
      "code-review",
      () => undefined,
      newQueryClient(),
    );

    const onboardingCall = calls.find((call) =>
      call.path.endsWith("/chat/workbenches/chan-1/onboarding"),
    );
    expect(JSON.parse(String(onboardingCall?.init?.body))).toEqual({
      kind: "connect-github",
      requiredForTemplate: "Code review",
      promise: CODE_REVIEW_TEMPLATE.promise,
      steps: CODE_REVIEW_TEMPLATE.onboardingSteps.map(({ title, why }) => ({
        title,
        why,
      })),
    });
    expect(calls.some((call) => call.path.includes("/github/state"))).toBe(
      false,
    );
    expect(
      calls.some((call) => call.path.includes("/github/start-reviewing")),
    ).toBe(false);
  });
});
