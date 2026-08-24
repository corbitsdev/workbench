import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  CODE_REVIEW_TEMPLATE,
  serializeWorkbenchTemplateManifest,
} from "@corbits/workflow-catalog";

import {
  createWorkbenchFromTemplate,
  NEW_WORKBENCH_TITLE,
} from "./instant-agent-create";

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("createWorkbenchFromTemplate (CL-6387)", () => {
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
  // one it created. CL-6981: blank must POST kind=workbench without
  // Myra's definitionId, or a second "+" would find-or-reopen her DM.
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
      if (/\/chat\/workbenches\/chan-\d+\/invite$/.test(path)) {
        return json({
          address: "agent:myra@room",
          definitionId: "def-assistant",
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
    // invented. CL-6981: a room mint, never a Myra chat reopen.
    const body = JSON.parse(String(createCalls[0]?.init?.body));
    expect(body).toEqual({
      kind: "workbench",
      name: NEW_WORKBENCH_TITLE,
    });
    expect(body).not.toHaveProperty("definitionId");

    const inviteBodies = calls
      .filter((call) => /\/chat\/workbenches\/chan-\d+\/invite$/.test(call.path))
      .map((call) => JSON.parse(String(call.init?.body)));
    expect(inviteBodies).toEqual([
      { definitionId: "def-assistant" },
      { definitionId: "def-assistant" },
    ]);
  });

  // CL-6387 follow-up: picking a named template threw its own name away
  // and left the reviewer roster its greeting promises out of the room
  // (every bench looked like every other "New Workbench", and Myra's
  // "Three reviewers read every pull request" greeting described a team
  // that wasn't there — see `createWorkbenchFromTemplate`'s own doc).
  test("picking the code-review template names the bench after it and invites the whole reviewer roster", async () => {
    const navigated: string[] = [];
    let nextReviewerId = 0;
    const calls = stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [assistantDefinitionWire], nextCursor: null });
      }
      if (path.endsWith("/library/templates/code-review")) {
        return json({
          id: "code-review",
          content: serializeWorkbenchTemplateManifest(CODE_REVIEW_TEMPLATE),
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
    expect(createBody).toEqual({
      kind: "workbench",
      name: CODE_REVIEW_TEMPLATE.title,
    });
    expect(createBody).not.toHaveProperty("definitionId");

    const createAgentCalls = calls.filter((call) =>
      call.path.endsWith("/agent-definitions"),
    );
    const reviewerCount = CODE_REVIEW_TEMPLATE.participants.filter(
      (participant) => participant.handle !== "myra",
    ).length;
    expect(createAgentCalls).toHaveLength(reviewerCount);

    const inviteCalls = calls.filter((call) =>
      call.path.endsWith("/chat/workbenches/chan-1/invite"),
    );
    const invitedIds = inviteCalls.map(
      (call) => JSON.parse(String(call.init?.body)).definitionId,
    );
    // Myra first (post-mint invite), then each reviewer from instantiate.
    const createdIds = createAgentCalls.map(
      (_, index) => `def-reviewer-${index + 1}`,
    );
    expect(invitedIds[0]).toBe("def-assistant");
    expect(invitedIds.slice(1).sort()).toEqual(createdIds.sort());
    expect(navigated).toEqual(["/w/chan-1"]);

    // CL-6594: a room this function navigates to must never carry a
    // `workbenches` cache captured before its own reviewer roster
    // finished being invited — that staleness is what left an invited
    // agent with no name, no avatar, and no `@mention` in the room the
    // owner reported it from.
    expect(queryClient.getQueryState(staleQueryKey)?.isInvalidated).toBe(true);
  });
});
