import { describe, expect, test } from "bun:test";
import { createPresenceRoutes } from "../src/routes";
import { createPresenceRoomRegistry } from "../src/room-registry";
import { colorForPrincipal } from "../src/color";
import { mountAs } from "./test-support";

const SURFACE = "channel:chn_1";

interface PresenceMember {
  principalId: string;
  displayName: string;
  color: string;
}

interface JoinResponseBody {
  self: PresenceMember;
  members: PresenceMember[];
}

describe("presence routes", () => {
  test("join assigns a server-side color and returns the room's members", async () => {
    const app = mountAs(createPresenceRoutes(), {
      tenantId: "tnt_a",
      principalId: "prn_alice",
      displayName: "Alice",
    });

    const response = await app.request(`/rooms/${SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as JoinResponseBody;
    expect(body.self).toMatchObject({
      principalId: "prn_alice",
      displayName: "Alice",
      color: colorForPrincipal("prn_alice"),
    });
    expect(body.members).toHaveLength(1);
  });

  test("a client cannot supply its own color or principalId in the join body", async () => {
    const app = mountAs(createPresenceRoutes(), {
      tenantId: "tnt_a",
      principalId: "prn_alice",
    });

    const response = await app.request(`/rooms/${SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        color: "hsl(0 0% 0%)",
        principalId: "prn_mallory",
      }),
    });

    const body = (await response.json()) as JoinResponseBody;
    expect(body.self.principalId).toBe("prn_alice");
    expect(body.self.color).toBe(colorForPrincipal("prn_alice"));
  });

  test("heartbeat rejects a principal that never joined", async () => {
    const app = mountAs(createPresenceRoutes(), {
      tenantId: "tnt_a",
      principalId: "prn_ghost",
    });

    const response = await app.request(`/rooms/${SURFACE}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
  });

  test("an invalid join body is rejected with 400", async () => {
    const app = mountAs(createPresenceRoutes(), {
      tenantId: "tnt_a",
      principalId: "prn_alice",
    });

    const response = await app.request(`/rooms/${SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursor: { x: "not a number" } }),
    });

    expect(response.status).toBe(400);
  });

  test("two clients join the same room through the routes and each sees the other", async () => {
    const registry = createPresenceRoomRegistry();
    const alice = mountAs(createPresenceRoutes({ registry }), {
      tenantId: "tnt_a",
      principalId: "prn_alice",
    });
    const bob = mountAs(createPresenceRoutes({ registry }), {
      tenantId: "tnt_a",
      principalId: "prn_bob",
    });

    await alice.request(`/rooms/${SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const bobJoin = await bob.request(`/rooms/${SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const bobBody = (await bobJoin.json()) as JoinResponseBody;

    expect(bobBody.members.map((m) => m.principalId).sort()).toEqual([
      "prn_alice",
      "prn_bob",
    ]);
  });

  test("leave drops the caller from the room", async () => {
    const registry = createPresenceRoomRegistry();
    const app = mountAs(createPresenceRoutes({ registry }), {
      tenantId: "tnt_a",
      principalId: "prn_alice",
    });

    await app.request(`/rooms/${SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const leaveResponse = await app.request(`/rooms/${SURFACE}/leave`, {
      method: "POST",
    });

    expect(leaveResponse.status).toBe(202);
    expect(registry.states({ tenantId: "tnt_a", surface: SURFACE })).toEqual(
      [],
    );
  });

  test("tenant isolation: a client in tenant A cannot see or join tenant B's room", async () => {
    const registry = createPresenceRoomRegistry();
    const tenantA = mountAs(createPresenceRoutes({ registry }), {
      tenantId: "tnt_a",
      principalId: "prn_alice",
    });
    const tenantB = mountAs(createPresenceRoutes({ registry }), {
      tenantId: "tnt_b",
      principalId: "prn_mallory",
    });

    await tenantA.request(`/rooms/${SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const joinB = await tenantB.request(`/rooms/${SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const bodyB = (await joinB.json()) as JoinResponseBody;

    // Same `surface` string, different tenant: tenant B's room starts
    // empty and only ever contains tenant B's own principal, even though
    // tenant A already joined the identically-named surface.
    expect(bodyB.members.map((m) => m.principalId)).toEqual(["prn_mallory"]);
    expect(
      registry
        .states({ tenantId: "tnt_a", surface: SURFACE })
        .map((s) => s.principalId),
    ).toEqual(["prn_alice"]);
  });

  test("the SSE stream opens and carries the join event for a subscriber already listening", async () => {
    const registry = createPresenceRoomRegistry();
    const app = mountAs(createPresenceRoutes({ registry }), {
      tenantId: "tnt_a",
      principalId: "prn_alice",
    });

    const streamResponse = await app.request(`/rooms/${SURFACE}/stream`, {
      headers: { accept: "text/event-stream" },
    });
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type")).toContain(
      "text/event-stream",
    );

    const reader = streamResponse.body?.getReader();
    expect(reader).toBeDefined();

    await app.request(`/rooms/${SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const decoder = new TextDecoder();
    let chunk = "";
    const chunkResult = await reader?.read();
    if (chunkResult && !chunkResult.done) {
      chunk += decoder.decode(chunkResult.value);
    }
    expect(chunk).toContain("presence.state");
    await reader?.cancel();
  });
});
