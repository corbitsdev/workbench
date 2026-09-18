import { afterEach, describe, expect, test } from "bun:test";

import { agentDeploySourceAssetName } from "../agent-deploy";
import { MYRA_SOURCE_CONFIG } from "../myra-source";
import {
  chatTitle,
  displayAgentName,
  listWorkbenchParticipants,
  resolveAvatarName,
  type WorkbenchParticipant,
} from "./threads-api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("displayAgentName", () => {
  test("renders Myra's fixed display name for her asset", () => {
    expect(displayAgentName(MYRA_SOURCE_CONFIG.assetName)).toBe(MYRA_SOURCE_CONFIG.displayName);
  });

  test("title-cases a deployed agent's slug with hyphens as spaces", () => {
    expect(displayAgentName(agentDeploySourceAssetName("echo-bot"))).toBe("Echo Bot");
    expect(displayAgentName(agentDeploySourceAssetName("scribe"))).toBe("Scribe");
  });

  test("falls back to the raw name for anything unrecognized", () => {
    expect(displayAgentName("some-other-asset")).toBe("some-other-asset");
  });
});

function meTurn(subject: string, body: string) {
  return {
    id: "Sent:1",
    messageId: "m1",
    parentId: undefined,
    address: "run_alice@example.com",
    author: "me" as const,
    subject,
    body,
    at: "2026-01-01T00:00:00Z",
    attachments: [],
  };
}

describe("chatTitle", () => {
  test("titles a chat by the agent's display name, never mail metadata", () => {
    expect(chatTitle([meTurn("Deploy the thing", "hi")], "Echo Bot")).toBe("Echo Bot");
  });

  test("falls back to the opening turn's subject only when the agent can't be resolved", () => {
    expect(chatTitle([meTurn("Deploy the thing", "hi")], undefined)).toBe("Deploy the thing");
  });

  test("falls back further to the opening turn's body when it has no subject", () => {
    expect(chatTitle([meTurn("", "hello there")], undefined)).toBe("hello there");
  });

  test("falls back to a generic label when there is no opening turn and no agent name", () => {
    expect(chatTitle([], undefined)).toBe("Untitled chat");
  });
});

describe("listWorkbenchParticipants", () => {
  test("a person's address is their refId at the workbench's own domain, never email or bare refId", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      if (path.includes("/principals")) {
        return Promise.resolve(
          json({
            data: [
              {
                id: "prin_1",
                kind: "user",
                refId: "Mk9tHH",
                displayName: "Alice",
                email: "alice@example.com",
                status: "active",
              },
            ],
            nextCursor: null,
          }),
        );
      }
      if (path.includes("/workflows/deployments")) return Promise.resolve(json([]));
      if (path.includes("/assets")) return Promise.resolve(json([]));
      if (path.includes("/runs")) return Promise.resolve(json({ data: [], nextCursor: null }));
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    const participants = await listWorkbenchParticipants("tnt_1", "example.com");
    expect(participants).toContainEqual({
      id: "prin_1",
      kind: "person",
      name: "Alice",
      address: "Mk9tHH@example.com",
    });
  });
});

describe("resolveAvatarName", () => {
  // A person's roster address is `<refId>@<domain>`, mixed case as stored;
  // the mailbox lowercases local parts on the wire, so a header `from`
  // stays mixed case while the envelope `from` comes back lowercase.
  const participants: readonly WorkbenchParticipant[] = [
    { id: "p1", kind: "person", name: "alice", address: "Mk9tHH@example.com" },
    { id: "a1", kind: "agent", name: "Myra", address: "myra@example.com" },
  ];

  test("matches the person's own turn by envelope address, case-insensitively", () => {
    const name = resolveAvatarName(
      { author: "me", authorName: "You", address: "mk9thh@example.com" },
      participants,
    );
    expect(name).toBe("alice");
  });

  test("uses the matching participant's name for another author", () => {
    const name = resolveAvatarName(
      { author: "other", authorName: "myra", address: "myra@example.com" },
      participants,
    );
    expect(name).toBe("Myra");
  });

  test("falls back to authorName when no participant matches", () => {
    const name = resolveAvatarName(
      { author: "other", authorName: "someone", address: "unknown@example.com" },
      participants,
    );
    expect(name).toBe("someone");
  });
});
