import { afterEach, describe, expect, test } from "bun:test";

import { agentDeploySourceAssetName } from "../agent-deploy";
import { MYRA_SOURCE_CONFIG } from "../myra-source";
import {
  displayAgentName,
  listRoomParticipants,
  resolveAvatarName,
  type RoomParticipant,
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

describe("listRoomParticipants", () => {
  test("a person's address is their refId at the room's own domain, never email or bare refId", async () => {
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

    const participants = await listRoomParticipants("tnt_1", "room.example");
    expect(participants).toContainEqual({
      id: "prin_1",
      kind: "person",
      name: "Alice",
      address: "Mk9tHH@room.example",
    });
  });
});

describe("resolveAvatarName", () => {
  // A person's roster address is `<refId>@<domain>`, mixed case as stored;
  // the mailbox lowercases local parts on the wire, so a header `from`
  // stays mixed case while the envelope `from` comes back lowercase.
  const participants: readonly RoomParticipant[] = [
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
