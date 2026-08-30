import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import type { RequireGrant } from "@intx/hub-api";
import { createPresenceRoutes } from "../src/routes";
import { createPresenceRoomRegistry } from "../src/room-registry";
import { colorForPrincipal } from "../src/color";
import { decodeBase64, encodeBase64 } from "../src/base64";
import { mountAs } from "./test-support";

const SURFACE = "channel:chn_1";

/** A grant checker that always allows — the default fixture for every
 * test that isn't specifically exercising the grant gate itself, the
 * same pattern `@corbits/artifacts-hub`'s own route tests use. */
const allowAll: RequireGrant = () => async (_c, next) => next();

interface PresenceMember {
  principalId: string;
  displayName: string;
  color: string;
}

interface JoinResponseBody {
  self: PresenceMember;
  members: PresenceMember[];
  docUpdate: string;
}

describe("presence routes", () => {
  test("join assigns a server-side color and returns the room's members", async () => {
    const app = mountAs(createPresenceRoutes({ requireGrant: allowAll }), {
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
    const app = mountAs(createPresenceRoutes({ requireGrant: allowAll }), {
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
    const app = mountAs(createPresenceRoutes({ requireGrant: allowAll }), {
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

  test("a heartbeat arriving just past the timeout boundary does not evict its own sender", async () => {
    let clock = 0;
    const registry = createPresenceRoomRegistry();
    const app = mountAs(
      createPresenceRoutes({
        registry,
        requireGrant: allowAll,
        now: () => clock,
      }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );

    await app.request(`/rooms/${SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    // One second past the default 45s heartbeat timeout: normal jitter
    // (a slow network tick, a throttled background tab), not a genuinely
    // stale client — the heartbeat that arrives now is itself proof the
    // sender is alive.
    clock = 46_000;
    const response = await app.request(`/rooms/${SURFACE}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      members: JoinResponseBody["members"];
    };
    expect(body.members.map((m) => m.principalId)).toEqual(["prn_alice"]);
  });

  test("a heartbeat still sweeps a genuinely stale, different principal out of the response", async () => {
    let clock = 0;
    const registry = createPresenceRoomRegistry();
    const alice = mountAs(
      createPresenceRoutes({
        registry,
        requireGrant: allowAll,
        now: () => clock,
      }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );
    const bob = mountAs(
      createPresenceRoutes({
        registry,
        requireGrant: allowAll,
        now: () => clock,
      }),
      {
        tenantId: "tnt_a",
        principalId: "prn_bob",
      },
    );

    await alice.request(`/rooms/${SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await bob.request(`/rooms/${SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    // Bob never heartbeats again; alice's next heartbeat lands well past
    // the timeout for bob, but only 1ms past it for herself.
    clock = 46_000;
    const response = await alice.request(`/rooms/${SURFACE}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      members: JoinResponseBody["members"];
    };
    expect(body.members.map((m) => m.principalId)).toEqual(["prn_alice"]);
  });

  test("an invalid join body is rejected with 400", async () => {
    const app = mountAs(createPresenceRoutes({ requireGrant: allowAll }), {
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
    const alice = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );
    const bob = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_bob",
      },
    );

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
    const app = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );

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
    const tenantA = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );
    const tenantB = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_b",
        principalId: "prn_mallory",
      },
    );

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
    const app = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );

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

const ARTIFACT_SURFACE = "artifact:art_1";

function docUpdateFor(text: string): string {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return encodeBase64(Y.encodeStateAsUpdate(doc));
}

describe("presence routes: doc sync", () => {
  test("join returns the room's current doc state as a base64 Yjs update", async () => {
    const registry = createPresenceRoomRegistry();
    registry.seedDocText(
      { tenantId: "tnt_a", surface: ARTIFACT_SURFACE },
      "existing content",
    );
    const app = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );

    const response = await app.request(`/rooms/${ARTIFACT_SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = (await response.json()) as JoinResponseBody;

    const doc = new Y.Doc();
    Y.applyUpdate(doc, decodeBase64(body.docUpdate));
    expect(doc.getText("content").toString()).toBe("existing content");
  });

  test("two clients converge: concurrent updates from each land in the shared doc", async () => {
    const registry = createPresenceRoomRegistry();
    const alice = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );
    const bob = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_bob",
      },
    );

    await alice.request(`/rooms/${ARTIFACT_SURFACE}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: docUpdateFor("hello ") }),
    });
    const bobDoc = new Y.Doc();
    bobDoc.getText("content").insert(0, "world");
    const bobResponse = await bob.request(`/rooms/${ARTIFACT_SURFACE}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        update: encodeBase64(Y.encodeStateAsUpdate(bobDoc)),
      }),
    });

    expect(bobResponse.status).toBe(202);
    expect(
      registry.docText({ tenantId: "tnt_a", surface: ARTIFACT_SURFACE }),
    ).toContain("world");
  });

  test("a late joiner's join response reflects updates already applied by others", async () => {
    const registry = createPresenceRoomRegistry();
    const alice = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );
    const bob = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_bob",
      },
    );

    await alice.request(`/rooms/${ARTIFACT_SURFACE}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: docUpdateFor("written by alice") }),
    });

    const joinResponse = await bob.request(`/rooms/${ARTIFACT_SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = (await joinResponse.json()) as JoinResponseBody;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decodeBase64(body.docUpdate));
    expect(doc.getText("content").toString()).toBe("written by alice");
  });

  test("an oversize update is rejected with 413, not silently truncated or applied", async () => {
    const registry = createPresenceRoomRegistry();
    const app = mountAs(
      createPresenceRoutes({
        registry,
        maxDocUpdateBytes: 16,
        requireGrant: allowAll,
      }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );

    const response = await app.request(`/rooms/${ARTIFACT_SURFACE}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        update: docUpdateFor("this is way more than 16 bytes of content"),
      }),
    });

    expect(response.status).toBe(413);
    expect(
      registry.docText({ tenantId: "tnt_a", surface: ARTIFACT_SURFACE }),
    ).toBe("");
  });

  test("a malformed (non-Yjs) update is rejected with 400", async () => {
    const registry = createPresenceRoomRegistry();
    const app = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );

    const response = await app.request(`/rooms/${ARTIFACT_SURFACE}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        update: encodeBase64(new Uint8Array([255, 255, 255, 255])),
      }),
    });

    expect(response.status).toBe(400);
  });

  test("invalid base64 in the update body is rejected with 400", async () => {
    const app = mountAs(createPresenceRoutes({ requireGrant: allowAll }), {
      tenantId: "tnt_a",
      principalId: "prn_alice",
    });

    const response = await app.request(`/rooms/${ARTIFACT_SURFACE}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: "not base64!!" }),
    });

    expect(response.status).toBe(400);
  });

  test("tenant isolation: an update posted in tenant A never reaches tenant B's identically-named room", async () => {
    const registry = createPresenceRoomRegistry();
    const tenantA = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );

    await tenantA.request(`/rooms/${ARTIFACT_SURFACE}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: docUpdateFor("tenant a's content") }),
    });

    expect(
      registry.docText({ tenantId: "tnt_b", surface: ARTIFACT_SURFACE }),
    ).toBe("");
    expect(
      registry.docText({ tenantId: "tnt_a", surface: ARTIFACT_SURFACE }),
    ).toBe("tenant a's content");
  });

  test("the SSE stream carries doc.update events for updates applied by others", async () => {
    const registry = createPresenceRoomRegistry();
    const app = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );

    const streamResponse = await app.request(
      `/rooms/${ARTIFACT_SURFACE}/stream`,
      {
        headers: { accept: "text/event-stream" },
      },
    );
    const reader = streamResponse.body?.getReader();

    await app.request(`/rooms/${ARTIFACT_SURFACE}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: docUpdateFor("streamed") }),
    });

    const decoder = new TextDecoder();
    let chunk = "";
    for (let i = 0; i < 5 && !chunk.includes("doc.update"); i += 1) {
      const result = await reader?.read();
      if (result && !result.done) chunk += decoder.decode(result.value);
    }
    expect(chunk).toContain("doc.update");
    await reader?.cancel();
  });

  test("the SSE stream carries a doc.saved event when the registry announces a snapshot", async () => {
    const registry = createPresenceRoomRegistry();
    const app = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      {
        tenantId: "tnt_a",
        principalId: "prn_alice",
      },
    );

    const streamResponse = await app.request(
      `/rooms/${ARTIFACT_SURFACE}/stream`,
      {
        headers: { accept: "text/event-stream" },
      },
    );
    const reader = streamResponse.body?.getReader();

    registry.notifySnapshot(
      { tenantId: "tnt_a", surface: ARTIFACT_SURFACE },
      { version: 7, savedAt: 1_700_000_000_000 },
    );

    const decoder = new TextDecoder();
    let chunk = "";
    for (let i = 0; i < 5 && !chunk.includes("doc.saved"); i += 1) {
      const result = await reader?.read();
      if (result && !result.done) chunk += decoder.decode(result.value);
    }
    expect(chunk).toContain("doc.saved");
    expect(chunk).toContain('"version":7');
    await reader?.cancel();
  });

  test("when requireGrant is supplied, a doc update without the asset:write grant is refused", async () => {
    const registry = createPresenceRoomRegistry();
    const denyAll: RequireGrant = () => async (c) =>
      c.json({ error: { code: "forbidden", message: "no grant" } }, 403);
    const app = mountAs(
      createPresenceRoutes({ registry, requireGrant: denyAll }),
      { tenantId: "tnt_a", principalId: "prn_alice" },
    );

    const response = await app.request(`/rooms/${ARTIFACT_SURFACE}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: docUpdateFor("blocked") }),
    });

    expect(response.status).toBe(403);
    expect(
      registry.docText({ tenantId: "tnt_a", surface: ARTIFACT_SURFACE }),
    ).toBe("");
  });

  test("when requireGrant is supplied, a doc update WITH the asset:write grant succeeds", async () => {
    const registry = createPresenceRoomRegistry();
    const allowAll: RequireGrant = () => async (_c, next) => next();
    const app = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      { tenantId: "tnt_a", principalId: "prn_alice" },
    );

    const response = await app.request(`/rooms/${ARTIFACT_SURFACE}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update: docUpdateFor("allowed") }),
    });

    expect(response.status).toBe(202);
    expect(
      registry.docText({ tenantId: "tnt_a", surface: ARTIFACT_SURFACE }),
    ).toBe("allowed");
  });

  // A presence-only surface (never doc-carrying) has nothing a grant
  // check would protect — join/heartbeat/leave/stream stay exactly as
  // ungated on it as phase 1 left them, even when requireGrant is
  // supplied and would deny everything.
  test("join/heartbeat/leave/stream stay ungated on a presence-only (non-artifact) surface", async () => {
    const registry = createPresenceRoomRegistry();
    const denyAll: RequireGrant = () => async (c) =>
      c.json({ error: { code: "forbidden", message: "no grant" } }, 403);
    const app = mountAs(
      createPresenceRoutes({ registry, requireGrant: denyAll }),
      { tenantId: "tnt_a", principalId: "prn_alice" },
    );

    const joinResponse = await app.request(`/rooms/${SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(joinResponse.status).toBe(200);

    const heartbeatResponse = await app.request(`/rooms/${SURFACE}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(heartbeatResponse.status).toBe(200);

    const streamResponse = await app.request(`/rooms/${SURFACE}/stream`, {
      headers: { accept: "text/event-stream" },
    });
    expect(streamResponse.status).toBe(200);
    await streamResponse.body?.cancel();

    const leaveResponse = await app.request(`/rooms/${SURFACE}/leave`, {
      method: "POST",
    });
    expect(leaveResponse.status).toBe(202);
  });

  // The read-access bypass this test set guards against: join's response
  // and the SSE stream both carry a doc-carrying surface's full content,
  // so a principal Library's own read route would refuse must be refused
  // here too — "waving a cursor isn't a write" never covered "reading
  // the document," and phase 2 made join/stream carry real document text
  // for the first time.
  test("a principal without the asset read grant cannot join a doc-carrying (artifact) surface", async () => {
    const registry = createPresenceRoomRegistry();
    registry.seedDocText(
      { tenantId: "tnt_a", surface: ARTIFACT_SURFACE },
      "secret content",
    );
    const denyAll: RequireGrant = () => async (c) =>
      c.json({ error: { code: "forbidden", message: "no grant" } }, 403);
    const app = mountAs(
      createPresenceRoutes({ registry, requireGrant: denyAll }),
      { tenantId: "tnt_a", principalId: "prn_mallory" },
    );

    const joinResponse = await app.request(`/rooms/${ARTIFACT_SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(joinResponse.status).toBe(403);
    // Never joined the room as a side effect of the denied request.
    expect(
      registry
        .states({ tenantId: "tnt_a", surface: ARTIFACT_SURFACE })
        .map((s) => s.principalId),
    ).toEqual([]);
  });

  test("a principal without the asset read grant cannot open the SSE stream for a doc-carrying (artifact) surface", async () => {
    const registry = createPresenceRoomRegistry();
    const denyAll: RequireGrant = () => async (c) =>
      c.json({ error: { code: "forbidden", message: "no grant" } }, 403);
    const app = mountAs(
      createPresenceRoutes({ registry, requireGrant: denyAll }),
      { tenantId: "tnt_a", principalId: "prn_mallory" },
    );

    const streamResponse = await app.request(
      `/rooms/${ARTIFACT_SURFACE}/stream`,
      {
        headers: { accept: "text/event-stream" },
      },
    );

    expect(streamResponse.status).toBe(403);
  });

  test("a principal WITH the asset read grant can join and stream a doc-carrying (artifact) surface", async () => {
    const registry = createPresenceRoomRegistry();
    registry.seedDocText(
      { tenantId: "tnt_a", surface: ARTIFACT_SURFACE },
      "visible content",
    );
    const app = mountAs(
      createPresenceRoutes({ registry, requireGrant: allowAll }),
      { tenantId: "tnt_a", principalId: "prn_alice" },
    );

    const joinResponse = await app.request(`/rooms/${ARTIFACT_SURFACE}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(joinResponse.status).toBe(200);
    const body = (await joinResponse.json()) as JoinResponseBody;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decodeBase64(body.docUpdate));
    expect(doc.getText("content").toString()).toBe("visible content");

    const streamResponse = await app.request(
      `/rooms/${ARTIFACT_SURFACE}/stream`,
      {
        headers: { accept: "text/event-stream" },
      },
    );
    expect(streamResponse.status).toBe(200);
    await streamResponse.body?.cancel();
  });
});
