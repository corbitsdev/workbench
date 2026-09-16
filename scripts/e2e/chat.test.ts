// The permanent booted-stack chat e2e: two principals per tenant,
// messages fanning in to a single converged timeline through the
// mounted `@corbits/chat` HTTP surface, settings and read-state live,
// and mention fan-out driving a second run off its own mailbox.
// Deterministic — no credentials, no real inference, no API keys.
//
// The path proven: database setup (chat migrations apply) → hub boot
// → sidecar boot → two sign-ups, an owner and an invited-then-activated
// member → an inference catalog chain seeded with a placeholder key →
// the stock assistant default workflow seeded the same way
// `greeting-delivery` proves invitable → a workbench created (data only
// since CL-6330 — no host run, the go/no-go test) → both users posting
// messages and reading back the converged, decoded timeline with sender
// identity → a second message proving the room keeps accepting mail →
// a settings patch that both updates the record and appends an audit
// event to the timeline → independent per-user read-state cursors →
// mentioning an already-resident agent participant twice, fanning each
// mention into its existing run and never minting a sibling (CL-6451) →
// the workbench kind filter.
//
// Stock Interchange cutover: one workbench per conversation tenant —
// `POST .../chat/workbenches` stamps `workbenchId = tenant.id`
// (`packages/chat/src/routes.ts`), so a second creation inside the same
// tenant conflicts on the settings row (500). Every test that mints its
// own workbench therefore builds its own tenant through the
// suite-scoped `setupTenant` fixture below (owner + invited member +
// grants + catalog), and the assistant deploy it needs rides the stock
// `seedTenant` default-workflow path — never the deleted
// `agent-definitions/by-name` surface, and never a second agent chat
// for one definition (the `chat/definitionId` 1:1 in
// `packages/chat/src/agent-dm-mode.ts`).
//
// Structured as one shared-boot stack (`beforeAll`) with a separate
// `test` per capability, rather than one long test: a real defect
// blocking one capability (see the "settings" test) then still lets
// every independent capability report its own true result, instead of
// one thrown error masking everything declared after it.
//
// This is permanent smoke coverage, not a demo script: each run resets
// its own sibling `<database>_e2e` database, failures name the
// capability that broke, and teardown stops every spawned process.

import { beforeAll, describe, expect, test } from "bun:test";

import { seedCatalog } from "../../packages/connections/src/seed-catalog.ts";
import { createGitWorkflowPusher } from "../../packages/connections/src/workflow-push.ts";
import {
  createHubAPI,
  type ApiCall,
} from "../../packages/hub-api-client/src/index.ts";
import type { Part } from "../../packages/chat/src/index.ts";
import {
  DEFAULT_WORKFLOWS,
  seedTenant,
} from "../../packages/onboarding/src/tenant-seed.ts";
import { modelSourceFor } from "../../packages/onboarding/src/complete-credential.ts";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  startHub,
  type ApiResult,
  type HubHandle,
} from "./harness.ts";

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "chat e2e: DATABASE_URL is not set; suite skipped. Set DATABASE_URL " +
      "(see .env.example) to run it; start Postgres with `docker compose -f docker-compose.test.yml up -d` so this skip " +
      "can never pass silently there.",
  );
}

function stringField(data: unknown, field: string, what: string): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(
    `${what}: missing string field "${field}": ${JSON.stringify(data)}`,
  );
}

function objectField(
  data: unknown,
  field: string,
  what: string,
): Record<string, unknown> {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "object" && value !== null) {
      return value as Record<string, unknown>;
    }
  }
  throw new Error(
    `${what}: missing object field "${field}": ${JSON.stringify(data)}`,
  );
}

function arrayField(data: unknown, field: string, what: string): unknown[] {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (Array.isArray(value)) return value;
  }
  throw new Error(
    `${what}: missing array field "${field}": ${JSON.stringify(data)}`,
  );
}

const { tempDir, track } = createCleanupHarness();

type SignedUpUser = { userId: string; email: string; cookies: string[] };

async function signUp(api: ApiCall, name: string): Promise<SignedUpUser> {
  const email = `chat-e2e-${crypto.randomUUID()}@example.invalid`;
  const password = `pw-${crypto.randomUUID()}`;
  const res = await api("POST", "/api/auth/sign-up/email", {
    name,
    email,
    password,
  });
  if (res.status !== 200) {
    throw new Error(
      `sign-up for ${name} failed: expected 200, got ${res.status}: ${JSON.stringify(res.data)}`,
    );
  }
  if (res.cookies.length === 0) {
    throw new Error(`sign-up for ${name} returned no session cookie`);
  }
  const userId = stringField(
    objectField(res.data, "user", `sign-up response for ${name}`),
    "id",
    `sign-up user field for ${name}`,
  );
  return { userId, email, cookies: res.cookies };
}

type ListedMessage = {
  id: string;
  sender: { name: string | null; address: string };
  parts: Part[];
};

const textPart = (text: string): Part[] => [{ kind: "text", text }];

describe.skipIf(databaseUrl === undefined)("chat e2e", () => {
  let hub: HubHandle;
  let api: ApiCall;
  let user1: SignedUpUser;
  let user2: SignedUpUser;
  let tenantId: string;
  let domain: string;
  let workbenchId: string;
  let pushWorkflow: ReturnType<typeof createGitWorkflowPusher>;
  let assistantId: string;

  type TenantFixture = {
    tenantId: string;
    domain: string;
    ownerPrincipalId: string;
    user2PrincipalId: string;
  };

  // Suite-scoped tenancy fixture: one conversation tenant carrying both
  // users — user1 as owner, user2 invited by email and activated by the
  // owner, carrying the read/write grants chat's routes gate on (the
  // same pair `packages/onboarding/src/tenant-seed.ts`'s `plantGrant`
  // plants for a bench's own principal), over a placeholder-credential
  // catalog chain. Stock Interchange cutover: `POST .../chat/workbenches`
  // stamps `workbenchId = tenant.id`, so a tenant hosts exactly one
  // workbench — every test that mints its own workbench builds its own
  // fixture rather than sharing the `beforeAll` tenant.
  async function setupTenant(): Promise<TenantFixture> {
    const slug = `chate2e${crypto.randomUUID().slice(0, 8)}`;
    const created = await api(
      "POST",
      "/api/tenants",
      { name: "Chat E2E", slug },
      user1.cookies,
    );
    expectStatus("create tenant", created, 201);
    const fixtureTenantId = stringField(created.data, "id", "create tenant");
    const fixtureDomain = stringField(created.data, "domain", "create tenant");

    // user2 joins the tenant: invited by email, then activated by the
    // owner — an invited principal is refused by tenant middleware
    // (403) until its status is "active". Being a non-owner
    // principal, user2 carries no grants of its own by default (only
    // the tenant creator gets the platform's wildcard owner grant).
    const invited = await api(
      "POST",
      `/api/tenants/${fixtureTenantId}/members/invite`,
      { email: user2.email },
      user1.cookies,
    );
    expectStatus("invite user2", invited, 201);
    const principal2Id = stringField(invited.data, "id", "invite user2");
    expect(stringField(invited.data, "status", "invite user2")).toBe("invited");

    const activated = await api(
      "PATCH",
      `/api/tenants/${fixtureTenantId}/principals/${principal2Id}`,
      { status: "active" },
      user1.cookies,
    );
    expectStatus("activate user2", activated, 200);
    expect(stringField(activated.data, "status", "activate user2")).toBe(
      "active",
    );

    async function plantGrant(
      principalId: string,
      resource: string,
      action: string,
    ): Promise<void> {
      const res = await api(
        "POST",
        `/api/tenants/${fixtureTenantId}/grants`,
        { principalId, resource, action, effect: "allow", origin: "creator" },
        user1.cookies,
      );
      expectStatus(`grant ${resource}/${action} to ${principalId}`, res, 201);
    }
    await plantGrant(principal2Id, "workflow-run:*", "read");
    await plantGrant(principal2Id, "workflow-run:*", "write");
    // The room routes gate on `room:<id>` since CL-6346, not on the
    // run pair above — same two grants `seed.ts` plants for a bench's
    // own principal.
    await plantGrant(principal2Id, "room:*", "read");
    await plantGrant(principal2Id, "room:*", "write");

    // A workbench host's folded launch pins a real inference source
    // chain against the tenant catalog before it will launch at all,
    // even though it never performs inference — the placeholder key
    // is never used to call a model.
    await seedCatalog({
      api,
      cookies: user1.cookies,
      tenantId: fixtureTenantId,
      placeholderCredential: true,
      log: () => undefined,
    });

    // The creator's owner principal, for `seedTenant`'s seed grants:
    // resolved through the stock tenant principals listing rather than
    // assumed, matching on the signup's user id. The stock route is
    // cursor-paginated (`{ data, nextCursor }` — see
    // `vendor/intx/hub-api/src/routes/principals.ts`), not an `items`
    // envelope.
    const principalsListed = await api(
      "GET",
      `/api/tenants/${fixtureTenantId}/principals?kind=user`,
      undefined,
      user1.cookies,
    );
    expectStatus("list tenant principals", principalsListed, 200);
    const owner = arrayField(
      principalsListed.data,
      "data",
      "list tenant principals",
    ).find((row) => (row as { refId?: unknown }).refId === user1.userId) as
      { id: string } | undefined;
    if (owner === undefined) {
      throw new Error(
        `no owner principal for user1 in tenant ${fixtureTenantId}: ` +
          JSON.stringify(principalsListed.data),
      );
    }
    return {
      tenantId: fixtureTenantId,
      domain: fixtureDomain,
      ownerPrincipalId: owner.id,
      user2PrincipalId: principal2Id,
    };
  }

  // The stock `invitable-definitions` listing is the only definition
  // source this suite uses: the deleted `agent-definitions/by-name`
  // surface resolved the old echo workflow directly by name, and the
  // invite dialog's own listing filters non-conversational definitions.
  // Polls until the seeded "assistant" appears (the deploy converges
  // behind the seed call).
  async function assistantDefinitionId(forTenant: string): Promise<string> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const res = await api(
        "GET",
        `/api/tenants/${forTenant}/chat/invitable-definitions`,
        undefined,
        user1.cookies,
      );
      if (res.status === 200) {
        const items = arrayField(
          res.data,
          "items",
          "list invitable definitions",
        ) as { id: string; name: string }[];
        const assistant = items.find((item) => item.name === "assistant");
        if (assistant !== undefined) return assistant.id;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `"assistant" never appeared as invitable: ${JSON.stringify(res.data)}`,
        );
      }
      await Bun.sleep(1000);
    }
  }

  // Seeds the stock assistant default workflow onto a fixture tenant —
  // the same `seedTenant` path `greeting-delivery` proves leaves
  // "assistant" invitable — and returns its listed definition id. The
  // deploy needs the sidecar's dial-in to have completed (its call
  // throws until it has), and every step is ensure-then-create, so the
  // whole call retries safely; deployments are never confirmed here
  // (no inference turns — the placeholder key is never dialed).
  async function deployAssistant(fixture: TenantFixture): Promise<string> {
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (hub.exited()) {
        throw new Error(
          `hub exited before assistant deploy; output:\n${hub.output()}`,
        );
      }
      try {
        await seedTenant({
          api,
          cookies: user1.cookies,
          hubUrl: hub.baseUrl,
          tenant: {
            tenantId: fixture.tenantId,
            principalId: fixture.ownerPrincipalId,
            domain: fixture.domain,
          },
          model: await modelSourceFor(
            api,
            user1.cookies,
            fixture.tenantId,
            "anthropic",
          ),
          pushWorkflow,
          log: () => undefined,
          workflows: DEFAULT_WORKFLOWS,
          confirmDeployments: false,
        });
        break;
      } catch (cause) {
        if (Date.now() > deadline) throw cause;
        await Bun.sleep(1000);
      }
    }
    return assistantDefinitionId(fixture.tenantId);
  }

  beforeAll(async () => {
    const url = databaseUrl;
    if (url === undefined) throw new Error("unreachable: suite is skipped");

    // The chat package's own migrations apply right after the
    // platform's, per scripts/db-setup.ts.
    await resetSchema(url);
    const report = await setupDatabase(url);
    expect(report.action).toBe("migrated");
    expect(report.migrations).toBeGreaterThan(0);

    hub = await startHub({
      databaseUrl: url,
      port: freePort(),
      sessionSecret: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("hex"),
      dataDir: await tempDir("e2e-chat-hub-data-"),
    });
    track(hub);

    api = createHubAPI(hub.baseUrl);

    // Two independent browser-shaped accounts, each carrying its own
    // session cookie for the rest of the suite.
    user1 = await signUp(api, "Chat Tester One");
    user2 = await signUp(api, "Chat Tester Two");

    pushWorkflow = createGitWorkflowPusher();
    // The shared tenant carries the room the timeline/read-state/
    // settings tests share, plus the stock assistant the invite test
    // resolves through the `invitable-definitions` listing.
    const shared = await setupTenant();
    tenantId = shared.tenantId;
    domain = shared.domain;
    assistantId = await deployAssistant(shared);
  }, 180_000);

  // Launching a workbench is the go/no-go signal for the whole suite: it
  // launches the anchor instance in-process, which needs its
  // process-provisioner-spawned sidecar's dial-in to have completed.
  // `packages/chat/src/routes.ts` has no 502-style retry translation of
  // its own (unlike the native workflow deploy route), so a launch
  // attempted before the sidecar connects fails with an uncaught 500 —
  // retried here directly until the sidecar is ready, exactly as the
  // walking skeleton retries a 502 for the native deploy route.
  async function createWorkbench(
    body: Record<string, unknown>,
    forTenant: string = tenantId,
  ): Promise<ApiResult> {
    const deadline = Date.now() + 60_000;
    let res: ApiResult;
    for (;;) {
      if (hub.exited()) {
        throw new Error(
          `hub exited before workbench creation; output:\n${hub.output()}`,
        );
      }
      res = await api(
        "POST",
        `/api/tenants/${forTenant}/chat/workbenches`,
        body,
        user1.cookies,
      );
      if (res.status !== 500) break;
      if (Date.now() > deadline) {
        throw new Error(
          `workbench never became launchable (hub kept answering 500): ` +
            `${JSON.stringify(res.data)}\nhub output:\n${hub.output()}`,
        );
      }
      await Bun.sleep(1000);
    }
    return res;
  }

  async function postMessage(
    cookies: string[],
    workbench: string,
    text: string,
    forTenant: string = tenantId,
  ): Promise<string> {
    const res = await api(
      "POST",
      `/api/tenants/${forTenant}/chat/workbenches/${workbench}/messages`,
      { parts: textPart(text) },
      cookies,
    );
    expectStatus(`post message "${text}"`, res, 201);
    return stringField(res.data, "id", `post message "${text}"`);
  }

  async function listMessages(
    cookies: string[],
    workbench: string,
    forTenant: string = tenantId,
  ): Promise<ListedMessage[]> {
    const res = await api(
      "GET",
      `/api/tenants/${forTenant}/chat/workbenches/${workbench}/messages`,
      undefined,
      cookies,
    );
    expectStatus("list messages", res, 200);
    return arrayField(
      res.data,
      "items",
      "list messages",
    ) as unknown as ListedMessage[];
  }

  type RunEvent = { seq: number; type: string };

  /**
   * A recipient run's own event log. Since CL-6327 a room's timeline is
   * `chat.workbench_messages` — workbench data written by whoever posted
   * — so a fan-out copy delivered to an agent's mailbox never becomes a
   * row under the recipient's id, and `GET .../messages` on the
   * recipient can no longer witness the delivery. The run's committed
   * event log is what does: mail that reaches a run drives it, and
   * `RunStarted`/`StepStarted` commit before any inference is attempted,
   * so the placeholder key CI runs with cannot suppress them.
   */
  async function runEvents(
    cookies: string[],
    runId: string,
    forTenant: string = tenantId,
  ): Promise<RunEvent[]> {
    const res = await api(
      "GET",
      `/api/tenants/${forTenant}/workflows/runs/${runId}/events`,
      undefined,
      cookies,
    );
    expectStatus(`list run events for ${runId}`, res, 200);
    return arrayField(
      res.data,
      "events",
      `run events for ${runId}`,
    ) as unknown as RunEvent[];
  }

  function highestSeq(events: readonly RunEvent[]): number {
    return events.reduce((highest, event) => Math.max(highest, event.seq), -1);
  }

  /**
   * Polls (bounded) until the run commits an event newer than
   * `sinceSeq`. A recipient run is already alive before the message
   * under test is posted — its anchor launched at workbench-creation
   * time — so "the run has events" proves nothing; only events past the
   * pre-post watermark do.
   */
  async function waitForRunProgress(
    cookies: string[],
    runId: string,
    sinceSeq: number,
    forTenant: string = tenantId,
  ): Promise<RunEvent[]> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const fresh = (await runEvents(cookies, runId, forTenant)).filter(
        (event) => event.seq > sinceSeq,
      );
      if (fresh.length > 0) return fresh;
      if (Date.now() > deadline) return fresh;
      await Bun.sleep(1000);
    }
  }

  test("workbench creation launches the anchor", async () => {
    const res = await createWorkbench({ kind: "workbench", name: "demo" });
    expectStatus("create workbench", res, 201);
    expect(stringField(res.data, "kind", "create workbench")).toBe("workbench");
    workbenchId = stringField(res.data, "id", "create workbench");
  }, 90_000);

  const firstFromUser1 = `hello from user1 ${crypto.randomUUID()}`;
  const firstFromUser2 = `hello from user2 ${crypto.randomUUID()}`;

  test("both users post; the timeline converges with sender identity", async () => {
    await postMessage(user1.cookies, workbenchId, firstFromUser1);
    await postMessage(user2.cookies, workbenchId, firstFromUser2);

    const items = await listMessages(user1.cookies, workbenchId);
    const texts = items.map((item) => ({
      text: (
        item.parts.find((p) => p.kind === "text") as
          { kind: "text"; text: string } | undefined
      )?.text,
      senderAddress: item.sender.address,
    }));

    const foundUser1 = texts.find((t) => t.text === firstFromUser1);
    const foundUser2 = texts.find((t) => t.text === firstFromUser2);
    if (foundUser1 === undefined || foundUser2 === undefined) {
      throw new Error(
        `converged timeline missing a message: ${JSON.stringify(items)}`,
      );
    }
    // Each message carries a sender identity distinct per author — the
    // address is the platform's own per-principal mail identity (not
    // the better-auth user id), so this asserts the two authors are
    // told apart rather than pinning the exact address shape.
    expect(foundUser1.senderAddress).toContain("@");
    expect(foundUser2.senderAddress).toContain("@");
    expect(foundUser1.senderAddress).not.toBe(foundUser2.senderAddress);
    expect(foundUser1.senderAddress.endsWith(`@${domain}`)).toBe(true);
    expect(foundUser2.senderAddress.endsWith(`@${domain}`)).toBe(true);
  });

  test("a second message from user2 proves the anchor keeps accepting mail", async () => {
    const secondFromUser2 = `second message from user2 ${crypto.randomUUID()}`;
    await Bun.sleep(50);
    await postMessage(user2.cookies, workbenchId, secondFromUser2);
    const items = await listMessages(user1.cookies, workbenchId);
    const texts = items.flatMap((item) =>
      item.parts
        .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
        .map((p) => p.text),
    );
    expect(texts).toContain(secondFromUser2);
    expect(texts).toContain(firstFromUser1);
    expect(texts).toContain(firstFromUser2);
  });

  // Read-state is proven ahead of the settings test below: the
  // settings PATCH appends a non-text event part to this workbench's
  // timeline, and `GET .../messages` on a workbench carrying one
  // currently 500s (see that test's note) — read-state's own routes
  // read from the room table, so ordering it first keeps this test's
  // result honest regardless of that failure.
  test("read-state cursors are independent per user", async () => {
    const seenId = await postMessage(
      user1.cookies,
      workbenchId,
      `read-state marker ${crypto.randomUUID()}`,
    );
    const putUser1 = await api(
      "PUT",
      `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/read-state`,
      { lastSeenCreatedAt: new Date().toISOString(), lastSeenId: seenId },
      user1.cookies,
    );
    expectStatus("put user1 read-state", putUser1, 200);

    const gotUser1 = await api(
      "GET",
      `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/read-state`,
      undefined,
      user1.cookies,
    );
    expectStatus("get user1 read-state", gotUser1, 200);
    expect(stringField(gotUser1.data, "lastSeenId", "user1 read-state")).toBe(
      seenId,
    );

    const gotUser2 = await api(
      "GET",
      `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/read-state`,
      undefined,
      user2.cookies,
    );
    expectStatus("get user2 read-state", gotUser2, 200);
    expect((gotUser2.data as { lastSeenId: string | null }).lastSeenId).toBe(
      null,
    );
  });

  // Stock Interchange cutover: one workbench per conversation tenant,
  // and the shared tenant's room already occupies it — so this test
  // builds its own fixture tenant (with its own assistant deploy) and
  // threads that tenant through every call below.
  // CL-6330 deleted the workbench-anchor machinery: a bare `kind:
  // "workbench"` room mints only a child tenant and settings rows — no
  // host workflow, no run, nothing `/workflows/runs/:runId/events` can
  // ever resolve. Only an invited agent (`kind: "chat"` or `POST
  // .../invite`) is backed by a real `workflow_run`. This test used to
  // mention a second bare workbench and poll its (nonexistent) run,
  // which is exactly the 404 CL-6436 tracks. It now proves the CL-6451
  // contract this test was actually meant to guard: mentioning a
  // participant already resident in the room drives that participant's
  // existing run — twice, never minting a sibling.
  // A dedicated `kind: "workbench"` room, never `kind: "chat"`: an agent
  // chat this test minted for itself used to sit in the tenant forever
  // as a second, older conversation, and the old `findExistingAgentChat`
  // tenant-wide dedup would then have found *this* leftover instead of
  // the one the reuse test created and expected back (CL-6481 — this
  // collision, introduced when this test was rewritten around a real
  // resident agent, was the reuse test's actual failure). The stock
  // Interchange cutover deleted that dedup surface entirely — one chat
  // per definition 1:1 (`packages/chat/src/agent-dm-mode.ts`) — so a
  // plain workbench now doubles as proof the room never enters a
  // `kind: "chat"` listing at all.
  test("mention fan-out drives the mentioned run", async () => {
    const mention = await setupTenant();
    const mentionAssistantId = await deployAssistant(mention);
    const mentionRoom = await createWorkbench(
      {
        kind: "workbench",
        name: "mention fan-out room",
      },
      mention.tenantId,
    );
    expectStatus("create mention fan-out room", mentionRoom, 201);
    const mentionRoomId = stringField(
      mentionRoom.data,
      "id",
      "create mention fan-out room",
    );

    const invited = await api(
      "POST",
      `/api/tenants/${mention.tenantId}/chat/workbenches/${mentionRoomId}/invite`,
      { definitionId: mentionAssistantId },
      user1.cookies,
    );
    expectStatus("invite assistant into mention fan-out room", invited, 201);
    const assistantAddress = stringField(
      invited.data,
      "address",
      "invite assistant into mention fan-out room",
    );
    const assistantLocalPart = assistantAddress.split("@")[0];
    if (assistantLocalPart === undefined || assistantLocalPart === "") {
      throw new Error(`malformed assistant address: ${assistantAddress}`);
    }

    const beforeFirst = highestSeq(
      await runEvents(user1.cookies, assistantLocalPart, mention.tenantId),
    );
    await postMessage(
      user1.cookies,
      mentionRoomId,
      `hey @myra take a look ${crypto.randomUUID()}`,
      mention.tenantId,
    );
    const afterFirst = await waitForRunProgress(
      user1.cookies,
      assistantLocalPart,
      beforeFirst,
      mention.tenantId,
    );
    expect(afterFirst.length).toBeGreaterThan(0);

    // The resident-reuse claim (CL-6451): a second mention of the same
    // already-resident participant drives the SAME run id further —
    // never mints a sibling — so this polls that same
    // `assistantLocalPart` run again rather than any newly-discovered
    // address, and confirms the room still lists exactly the one agent
    // participant.
    const beforeSecond = highestSeq(
      await runEvents(user1.cookies, assistantLocalPart, mention.tenantId),
    );
    await postMessage(
      user1.cookies,
      mentionRoomId,
      `hey @myra one more thing ${crypto.randomUUID()}`,
      mention.tenantId,
    );
    const afterSecond = await waitForRunProgress(
      user1.cookies,
      assistantLocalPart,
      beforeSecond,
      mention.tenantId,
    );
    expect(afterSecond.length).toBeGreaterThan(0);

    const settingsAfterSecondMention = await api(
      "GET",
      `/api/tenants/${mention.tenantId}/chat/workbenches/${mentionRoomId}/settings`,
      undefined,
      user1.cookies,
    );
    expectStatus(
      "get settings after second mention",
      settingsAfterSecondMention,
      200,
    );
    const participantsAfterSecondMention = arrayField(
      settingsAfterSecondMention.data,
      "participants",
      "get settings after second mention",
    ) as { address: string; handle: string }[];
    expect(participantsAfterSecondMention).toHaveLength(1);
    expect(participantsAfterSecondMention[0]?.address).toBe(assistantAddress);
  }, 90_000);

  test("inviting the assistant launches its own run, joins the workbench, and receives @mentions", async () => {
    // The stock assistant deploy the shared fixture seeded in
    // `beforeAll` is invitable (conversational, carried in the invite
    // dialog's own listing) — this test invites it by the definition id
    // that deploy resolved, proving the same path `greeting-delivery`
    // covers end to end from a second suite.
    const invited = await api(
      "POST",
      `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/invite`,
      { definitionId: assistantId },
      user1.cookies,
    );
    expectStatus("invite assistant", invited, 201);
    const invitedAddress = stringField(
      invited.data,
      "address",
      "invite assistant",
    );
    expect(stringField(invited.data, "definitionId", "invite assistant")).toBe(
      assistantId,
    );
    const invitedLocalPart = invitedAddress.split("@")[0];
    if (invitedLocalPart === undefined || invitedLocalPart === "") {
      throw new Error(`malformed invited agent address: ${invitedAddress}`);
    }

    // The invited agent's own run's address joined this workbench's
    // participants — as a record carrying a friendly mention handle
    // derived from the invited definition's display name ("Myra"), never
    // the unusable raw local part — and the join event landed on this
    // workbench's own timeline.
    const settingsAfterInvite = await api(
      "GET",
      `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/settings`,
      undefined,
      user1.cookies,
    );
    expectStatus("get settings after invite", settingsAfterInvite, 200);
    const participantsAfterInvite = arrayField(
      settingsAfterInvite.data,
      "participants",
      "get settings after invite",
    ) as { address: string; handle: string }[];
    const invitedParticipant = participantsAfterInvite.find(
      (participant) => participant.address === invitedAddress,
    );
    if (invitedParticipant === undefined) {
      throw new Error(
        `invited participant record missing: ${JSON.stringify(participantsAfterInvite)}`,
      );
    }
    expect(invitedParticipant.handle).toBe("myra");

    // The join event itself lands on this workbench's timeline as an
    // `EventPart` (see `POST /workbenches/:id/invite` in
    // packages/chat/src/routes.ts), the same way a settings-changed
    // event does — but this suite cannot read it back via
    // `GET .../messages` any more than the "settings update" test
    // below can: an `EventPart` rides as a lone `application/json` MIME
    // attachment, and reading any attachment back hits the same
    // pre-existing `@intx/mime` `walkParts` defect that test documents
    // (vendor/intx is out of this suite's file scope to fix). Once this
    // workbench's timeline carries that attachment, `GET .../messages`
    // 500s for it for the rest of the suite's run, which is exactly why
    // this test never calls `listMessages` on `workbenchId` again below —
    // only on the invited agent's own, still-clean workbench.

    // @mentioning the invited agent's friendly handle fans a copy into
    // its own run's mailbox — the same fan-out pattern the earlier
    // "mention fan-out" test proves for a workbench-to-workbench mention,
    // now proving it reaches an invited agent's run by its handle
    // rather than its raw instance-id local part. The invited agent's
    // reply is never asserted: its inference source is a placeholder
    // key in CI, so its own reply attempt errors, which is expected and
    // irrelevant to this assertion — the mail arriving and driving the
    // run is the whole claim.
    const before = highestSeq(await runEvents(user1.cookies, invitedLocalPart));
    const mentionText = `hey @${invitedParticipant.handle} welcome ${crypto.randomUUID()}`;
    await postMessage(user1.cookies, workbenchId, mentionText);

    const fresh = await waitForRunProgress(
      user1.cookies,
      invitedLocalPart,
      before,
    );
    expect(fresh.length).toBeGreaterThan(0);
  }, 90_000);

  // Stock Interchange cutover: a tenant hosts exactly one workbench
  // and the shared tenant's room already occupies it, so this chat
  // lives on its own fixture tenant (with its own assistant deploy).
  // The old test's second half — inviting the same definition into the
  // chat again to launch a second run — is gone with the
  // `chat/definitionId` 1:1: a second agent chat for one definition is
  // now a 409, and the kind-filter test below proves the reuse side of
  // that dedup instead.
  test("a chat auto-invites the assistant and delivers un-mentioned messages to it", async () => {
    const direct = await setupTenant();
    const directAssistantId = await deployAssistant(direct);
    const chatCreated = await createWorkbench(
      {
        kind: "chat",
        definitionId: directAssistantId,
      },
      direct.tenantId,
    );
    expectStatus("create chat", chatCreated, 201);
    expect(stringField(chatCreated.data, "kind", "create chat")).toBe("chat");
    expect(stringField(chatCreated.data, "title", "create chat")).toBe("Myra");
    const chatId = stringField(chatCreated.data, "id", "create chat");
    const chatParticipants = arrayField(
      chatCreated.data,
      "participants",
      "create chat",
    ) as { address: string; handle: string }[];
    const chatAgent = chatParticipants.find((p) => p.handle === "myra");
    if (chatAgent === undefined) {
      throw new Error(
        `chat has no "myra" agent participant: ${JSON.stringify(chatParticipants)}`,
      );
    }
    const chatAgentLocalPart = chatAgent.address.split("@")[0];
    if (chatAgentLocalPart === undefined || chatAgentLocalPart === "") {
      throw new Error(`malformed chat agent address: ${chatAgent.address}`);
    }

    // No @mention is needed: a chat delivers every message to its one
    // agent unconditionally. The agent's own inference source is a
    // placeholder key in CI, so its reply attempt is expected to error
    // and is never asserted here — only that the fan-out mail reached
    // it.
    const before = highestSeq(
      await runEvents(user1.cookies, chatAgentLocalPart, direct.tenantId),
    );
    const unmentionedText = `no mention needed ${crypto.randomUUID()}`;
    await postMessage(user1.cookies, chatId, unmentionedText, direct.tenantId);

    const fresh = await waitForRunProgress(
      user1.cookies,
      chatAgentLocalPart,
      before,
      direct.tenantId,
    );
    expect(fresh.length).toBeGreaterThan(0);
  }, 90_000);

  // Stock Interchange cutover: `workbenchId = tenant.id`, so one
  // tenant hosts exactly one workbench — the old test's room-plus-chat
  // pair on the shared tenant is now a PK-duplicate 500 on the second
  // create, and `reuseExisting` is gone from `CreateWorkbenchBody`
  // (arktype silently ignores the unknown key). The kind filter is
  // proven over the tenant's single row instead, on its own fixture
  // tenant so the shared tenant's room is untouched.
  test("kind filter includes the tenant's workbench under its own kind and excludes it under the other", async () => {
    const fixture = await setupTenant();
    const room = await createWorkbench(
      {
        kind: "workbench",
        name: "kind filter room",
      },
      fixture.tenantId,
    );
    expectStatus("create kind filter room", room, 201);
    const roomId = stringField(room.data, "id", "create kind filter room");

    const workbenchKindListed = await api(
      "GET",
      `/api/tenants/${fixture.tenantId}/chat/workbenches?kind=workbench`,
      undefined,
      user1.cookies,
    );
    expectStatus("list kind=workbench", workbenchKindListed, 200);
    const workbenchKindIds = arrayField(
      workbenchKindListed.data,
      "items",
      "list kind=workbench",
    ).map((item) => (item as { id: string }).id);
    expect(workbenchKindIds).toContain(roomId);

    const chatKindListed = await api(
      "GET",
      `/api/tenants/${fixture.tenantId}/chat/workbenches?kind=chat`,
      undefined,
      user1.cookies,
    );
    expectStatus("list kind=chat", chatKindListed, 200);
    const chatKindIds = arrayField(
      chatKindListed.data,
      "items",
      "list kind=chat",
    ).map((item) => (item as { id: string }).id);
    // The tenant's one row is a room, so the chat listing is empty —
    // the filter never leaks a workbench into the other kind's view.
    expect(chatKindIds).not.toContain(roomId);
  }, 90_000);

  // Stock Interchange cutover: the old test's second half — inviting
  // the same definition into its chat again to launch a second run —
  // is gone with the chat 1:1 (`launchAndJoinAgent` throws
  // `KindIsChatError`, mapped to 409, for any non-mint join into a
  // chat). A seeded tenant carries exactly one invitable definition
  // (CL-7074), so the enforcement is proven the other way the stock
  // surface allows: a person-DM chat already bound to its one
  // counterpart refuses an agent invite with a 409, never a sibling
  // participant.
  test("a chat stays one-counterpart: inviting an agent into a person-DM chat is a 409", async () => {
    const fixture = await setupTenant();
    const fixtureAssistantId = await deployAssistant(fixture);
    const dm = await createWorkbench(
      {
        kind: "chat",
        principalId: fixture.user2PrincipalId,
      },
      fixture.tenantId,
    );
    expectStatus("create person-DM chat", dm, 201);
    const dmId = stringField(dm.data, "id", "create person-DM chat");

    const refused = await api(
      "POST",
      `/api/tenants/${fixture.tenantId}/chat/workbenches/${dmId}/invite`,
      { definitionId: fixtureAssistantId },
      user1.cookies,
    );
    expectStatus("invite an agent into a person-DM chat", refused, 409);
  }, 90_000);

  // Settings is exercised last: `PATCH .../settings` folds the patch
  // through `applyControlPayload` and posts each resulting event part
  // onto the anchor's own timeline as its audit trail
  // (`packages/chat/src/routes.ts`). That event part is not a
  // `TextPart`, so `encodeParts` (`packages/chat/src/codec.ts`) rides
  // it as a lone `application/json` MIME attachment rather than bare
  // `content`. Reading it back — `GET .../messages` →
  // `decodeMail` → `fetchBlob` → `extractPartByPath` — hits a real,
  // pre-existing defect in the vendored `@intx/mime`'s `walkParts`
  // (`@intx/mime/src/mime.ts`): its leaf-depth branch returns
  // the attachment's raw MIME slice (headers *and* body) instead of
  // the header-stripped body every intermediate depth already
  // produces, so `JSON.parse` fails on the leading `Content-Type: ...`
  // header text. This reproduces for any multi-part message, not just
  // this event — it is out of this suite's file scope (`vendor/intx`
  // is vendored and read-only) to fix; this test documents the defect
  // precisely rather than working around it, and settings sends last
  // so no other test depends on listing this workbench afterward.
  test("settings update reflects on GET and events the timeline", async () => {
    const newParticipant = `placeholder-participant-${crypto.randomUUID()}`;
    const patched = await api(
      "PATCH",
      `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/settings`,
      { "chat/participants": [newParticipant] },
      user1.cookies,
    );
    expectStatus("patch settings", patched, 200);

    const fetched = await api(
      "GET",
      `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/settings`,
      undefined,
      user1.cookies,
    );
    expectStatus("get settings", fetched, 200);
    const participants = arrayField(
      fetched.data,
      "participants",
      "get settings",
    ) as { address: string; handle: string }[];
    expect(participants.some((p) => p.address === newParticipant)).toBe(true);

    const items = await listMessages(user1.cookies, workbenchId);
    const events = items.flatMap((item) =>
      item.parts.filter((p) => p.kind === "event"),
    );
    const membershipEvent = events.find(
      (e) => (e as { event: string }).event === "workbench.membership-changed",
    );
    if (membershipEvent === undefined) {
      throw new Error(
        `no workbench.membership-changed event on the timeline: ${JSON.stringify(items)}`,
      );
    }
  }, 30_000);

  // Every chat/folded run above (the workbench anchor, the mentioned
  // second workbench, the invited Myra assistant, the auto-invited
  // chat agent) writes its own `workflow-run` mail pack over the course of
  // this suite. Before CL-6043's self-anchor fix, every one of those
  // packs was permanently rejected — `receiveWorkflowRunPack`
  // (vendor/intx/hub-sessions/src/hub-session-lookups.ts) requires the
  // live run at the source address to satisfy `anchorRunId === id`,
  // and a folded run was written with `anchorRunId: null` (see
  // `packages/folded-runs/src/launch.ts`).
  //
  // Asserting on the hub's own log was tried first, as the most direct
  // proof, but the hub side is not a clean signal: a brand-new run —
  // folded or a plain top-level deployment alike — can lose a benign,
  // pre-existing race where its very first pack push reaches the hub
  // before that run's own DB row has committed, logging the identical
  // "no live deployment anchor" warning; the hub's redelivery retries
  // it and it self-heals within a second or two. That race reproduces
  // for a plain native deployment too (which has always
  // self-anchored), so it is orthogonal to CL-6043 and made a hub-log
  // assertion flake (confirmed empirically: 4 such transient
  // warnings even with the fix applied and every test green).
  //
  // The sidecar side is the clean signal instead: a permanently
  // rejected pack surfaces there as
  // `enqueueInbox failed, withholding ack` (the hub never acks, so it
  // keeps redelivering) and, once the run later goes idle and wakes,
  // `rejecting inbound mail ...: workflow run ... is terminal` (see
  // `vendor/intx/workflow-host/src/supervisor/supervisor.ts`) — never
  // logged for a transient, self-healing DB-commit race. Verified by
  // temporarily reverting the self-anchor fix locally: the sidecar log
  // then carries ten `enqueueInbox failed, withholding ack` lines, one
  // per rejected pack, for this same suite; with the fix applied, zero.
  // Every process-provisioner-spawned sidecar inherits the hub
  // process's own stdio (`process-runner.ts`'s `stdout: "inherit"`), so
  // `hub.output()` already carries every sidecar's log lines.
  test("no chat/folded run's workflow-run pack was ever permanently rejected", () => {
    const hubOutput = hub.output();
    expect(hubOutput).not.toContain("enqueueInbox failed");
    expect(hubOutput).not.toContain("withholding ack");
    expect(hubOutput).not.toContain("rejecting inbound mail");
  });
});
