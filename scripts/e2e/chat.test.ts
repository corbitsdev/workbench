// The permanent booted-stack chat e2e: two principals in one tenant,
// messages fanning in to a single converged timeline through the
// mounted `@corbits/chat` HTTP surface, settings and read-state live,
// and mention fan-out landing a copy in a second run's own mailbox.
// Deterministic — no credentials, no real inference, no API keys.
//
// The path proven: database setup (chat migrations apply) → hub boot
// → sidecar boot → two sign-ups in one tenant (an invited principal
// activated by the owner) → an inference catalog chain seeded with a
// placeholder key → a workbench launched (the anchor instance boots
// in-process, the go/no-go test) → both users posting messages and
// reading back the converged, decoded timeline with sender identity →
// a second message proving the anchor keeps accepting mail with no
// relaunch → a settings patch that both updates the record and
// appends an audit event to the timeline → independent per-user
// read-state cursors → a second workbench's address mentioned in the
// first, fanning a copy into the mentioned run's own mailbox → the
// workbench kind filter.
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

import { formatRunAddress } from "@intx/types";
import {
  createHubAPI,
  seedCatalog,
  type ApiCall,
} from "../../packages/hub-client/src/index.ts";
import type { Part } from "../../packages/chat/src/index.ts";
import {
  buildEchoWorkflow,
  serializeEchoWorkflow,
} from "../../workflows/echo/src/index.ts";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  provisionSidecar,
  pushWorkflowJson,
  startHub,
  startSidecar,
  type ApiResult,
  type HubHandle,
  type SpawnedApp,
} from "./harness.ts";

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "chat e2e: DATABASE_URL is not set; suite skipped. Set DATABASE_URL " +
      "(see .env.example) to run it; CI sets E2E_REQUIRED=1 so this skip " +
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
  let sidecar: SpawnedApp;
  let api: ApiCall;
  let user1: SignedUpUser;
  let user2: SignedUpUser;
  let tenantId: string;
  let domain: string;
  let workbenchId: string;
  let chatId: string;

  beforeAll(async () => {
    const url = databaseUrl;
    if (url === undefined) throw new Error("unreachable: suite is skipped");

    // The chat package's own migrations apply right after the
    // platform's, per scripts/db-setup.ts.
    await resetSchema(url);
    const report = await setupDatabase(url);
    expect(report.action).toBe("migrated");
    expect(report.migrations).toBeGreaterThan(0);

    const sidecarId = "chat-e2e-sidecar";
    const sidecarToken = crypto.randomUUID();
    await provisionSidecar(url, sidecarId, sidecarToken);

    hub = await startHub({
      databaseUrl: url,
      port: freePort(),
      sessionSecret: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("hex"),
      dataDir: await tempDir("e2e-chat-hub-data-"),
    });
    track(hub);

    sidecar = startSidecar({
      hubPort: new URL(hub.baseUrl).port
        ? Number(new URL(hub.baseUrl).port)
        : 80,
      sidecarId,
      token: sidecarToken,
      dataDir: await tempDir("e2e-chat-sidecar-data-"),
    });
    track(sidecar);

    api = createHubAPI(hub.baseUrl);

    // Two independent browser-shaped accounts, each carrying its own
    // session cookie for the rest of the suite.
    user1 = await signUp(api, "Chat Tester One");
    user2 = await signUp(api, "Chat Tester Two");

    // user1 becomes the owner and, via the platform's own wildcard
    // owner grant, needs no grants planted by this suite for anything
    // that follows.
    const slug = `chate2e${crypto.randomUUID().slice(0, 8)}`;
    const created = await api(
      "POST",
      "/api/tenants",
      { name: "Chat E2E", slug },
      user1.cookies,
    );
    expectStatus("create tenant", created, 201);
    tenantId = stringField(created.data, "id", "create tenant");
    domain = stringField(created.data, "domain", "create tenant");

    // user2 joins the tenant: invited by email, then activated by the
    // owner — an invited principal is refused by tenant middleware
    // (403) until its status is "active". Being a non-owner
    // principal, user2 carries no grants of its own by default (only
    // the tenant creator gets the platform's wildcard owner grant),
    // so this also plants the read/write grants chat's routes gate
    // on, exactly as `packages/hub-client/src/seed.ts`'s
    // `plantGrant` does for a tenant's own owner.
    const invited = await api(
      "POST",
      `/api/tenants/${tenantId}/members/invite`,
      { email: user2.email },
      user1.cookies,
    );
    expectStatus("invite user2", invited, 201);
    const principal2Id = stringField(invited.data, "id", "invite user2");
    expect(stringField(invited.data, "status", "invite user2")).toBe("invited");

    const activated = await api(
      "PATCH",
      `/api/tenants/${tenantId}/principals/${principal2Id}`,
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
        `/api/tenants/${tenantId}/grants`,
        { principalId, resource, action, effect: "allow", origin: "creator" },
        user1.cookies,
      );
      expectStatus(`grant ${resource}/${action} to ${principalId}`, res, 201);
    }
    await plantGrant(principal2Id, "workflow-run:*", "read");
    await plantGrant(principal2Id, "workflow-run:*", "write");

    // A workbench host's folded launch pins a real inference source
    // chain against the tenant catalog before it will launch at all,
    // even though it never performs inference — the placeholder key
    // is never used to call a model.
    await seedCatalog({
      api,
      cookies: user1.cookies,
      tenantId,
      placeholderCredential: true,
      log: () => undefined,
    });

    // Seed the echo workflow as a deployed, invitable definition: the
    // same asset-publish → git-token → smart-HTTP push → native deploy
    // path `scripts/e2e/walking-skeleton.test.ts` proves end to end.
    // The native deploy call's own inference source is a placeholder
    // (that deployment's own execution is never exercised here); the
    // invite launch this suite proves instead resolves its source
    // against the tenant catalog seeded just above, matching the
    // provider/model this workflow declares.
    const echoAssetCreated = await api(
      "POST",
      `/api/tenants/${tenantId}/assets`,
      { kind: "workflow", name: "echo" },
      user1.cookies,
    );
    expectStatus("create echo workflow asset", echoAssetCreated, 201);
    const echoAssetId = stringField(
      echoAssetCreated.data,
      "id",
      "create echo workflow asset",
    );

    const echoGitToken = await api(
      "POST",
      `/api/tenants/${tenantId}/git-tokens`,
      {
        name: "chat-e2e-echo-push",
        resource: "asset:*",
        refPattern: "**",
        actions: ["can_read", "can_push"],
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
      user1.cookies,
    );
    expectStatus("mint echo git token", echoGitToken, 201);

    await pushWorkflowJson({
      baseUrl: hub.baseUrl,
      tenantId,
      assetName: "echo",
      tokenSecret: stringField(echoGitToken.data, "secret", "mint git token"),
      workflowJson: serializeEchoWorkflow(
        buildEchoWorkflow({
          triggerAddress: `echo@${domain}`,
          inferencePreferences: [
            { provider: "anthropic", model: "claude-sonnet-5" },
          ],
          turnTimeoutMs: 60_000,
        }),
      ),
    });

    // Retries while the hub still answers 502 (the sidecar's dial-in
    // may not have completed yet), matching `createWorkbench`'s own
    // retry loop below.
    const echoDeployDeadline = Date.now() + 60_000;
    let echoDeployed: ApiResult;
    for (;;) {
      if (sidecar.exited()) {
        throw new Error(
          `sidecar exited before echo deploy; output:\n${sidecar.output()}`,
        );
      }
      echoDeployed = await api(
        "POST",
        `/api/tenants/${tenantId}/workflows/deployments`,
        {
          assetId: echoAssetId,
          sources: [
            {
              id: "src-echo-e2e",
              provider: "anthropic",
              baseURL: "https://inference.invalid",
              apiKey: "e2e-placeholder",
              model: "claude-sonnet-5",
            },
          ],
          defaultSource: "src-echo-e2e",
        },
        user1.cookies,
      );
      if (echoDeployed.status !== 502) break;
      if (Date.now() > echoDeployDeadline) {
        throw new Error(
          `echo workflow never became deployable (hub kept answering 502): ` +
            `${JSON.stringify(echoDeployed.data)}\nsidecar output:\n${sidecar.output()}`,
        );
      }
      await Bun.sleep(1000);
    }
    expectStatus("deploy echo workflow", echoDeployed, 201);
  }, 120_000);

  // Launching a workbench is the go/no-go signal for the whole suite: it
  // launches the anchor instance in-process, which needs the
  // sidecar's dial-in to have completed. `packages/chat/src/routes.ts`
  // has no 502-style retry translation of its own (unlike the native
  // workflow deploy route), so a launch attempted before the sidecar
  // connects fails with an uncaught 500 — retried here directly until
  // the sidecar is ready, exactly as the walking skeleton retries a
  // 502 for the native deploy route.
  async function createWorkbench(
    body: Record<string, unknown>,
  ): Promise<ApiResult> {
    const deadline = Date.now() + 60_000;
    let res: ApiResult;
    for (;;) {
      if (sidecar.exited()) {
        throw new Error(
          `sidecar exited before workbench creation; output:\n${sidecar.output()}`,
        );
      }
      res = await api(
        "POST",
        `/api/tenants/${tenantId}/chat/workbenches`,
        body,
        user1.cookies,
      );
      if (res.status !== 500) break;
      if (Date.now() > deadline) {
        throw new Error(
          `workbench never became launchable (hub kept answering 500): ` +
            `${JSON.stringify(res.data)}\nsidecar output:\n${sidecar.output()}`,
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
  ): Promise<string> {
    const res = await api(
      "POST",
      `/api/tenants/${tenantId}/chat/workbenches/${workbench}/messages`,
      { parts: textPart(text) },
      cookies,
    );
    expectStatus(`post message "${text}"`, res, 201);
    return stringField(res.data, "id", `post message "${text}"`);
  }

  async function listMessages(
    cookies: string[],
    workbench: string,
  ): Promise<ListedMessage[]> {
    const res = await api(
      "GET",
      `/api/tenants/${tenantId}/chat/workbenches/${workbench}/messages`,
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

  /** Flattens a workbench's timeline to its text-part bodies. */
  function textsOf(items: readonly ListedMessage[]): string[] {
    return items.flatMap((item) =>
      item.parts
        .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
        .map((p) => p.text),
    );
  }

  /**
   * A fan-out copy lands on the recipient run's timeline only after the
   * mail round-trips through the sidecar, so poll (bounded) until a
   * text matching `predicate` appears, then re-list once after a short
   * settle so a redelivered duplicate would still be visible to an
   * exactly-once assertion.
   */
  async function pollForDeliveredTexts(
    cookies: string[],
    workbench: string,
    predicate: (text: string) => boolean,
  ): Promise<string[]> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const texts = textsOf(await listMessages(cookies, workbench));
      if (texts.some(predicate)) break;
      if (Date.now() > deadline) return texts;
      await Bun.sleep(1000);
    }
    await Bun.sleep(3_000);
    return textsOf(await listMessages(cookies, workbench));
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
  // never call `listMail`, so ordering it first keeps this test's
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

  test("mention fan-out lands a copy in the mentioned run's own mailbox", async () => {
    const secondWorkbench = await createWorkbench({
      kind: "workbench",
      name: "mentioned",
    });
    expectStatus("create second workbench", secondWorkbench, 201);
    const secondWorkbenchId = stringField(
      secondWorkbench.data,
      "id",
      "create second workbench",
    );
    const secondWorkbenchAddress = formatRunAddress(secondWorkbenchId, domain);

    const patched = await api(
      "PATCH",
      `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/settings`,
      { "chat/participants": [secondWorkbenchAddress] },
      user1.cookies,
    );
    expectStatus("add mentionable participant", patched, 200);

    const mentionText = `hey @${secondWorkbenchId} take a look ${crypto.randomUUID()}`;
    await postMessage(user1.cookies, workbenchId, mentionText);

    const mentionedTexts = await pollForDeliveredTexts(
      user1.cookies,
      secondWorkbenchId,
      (text) => text.endsWith(mentionText),
    );
    // The delivered copy carries the workbench-context block merged ahead
    // of the message in one text part, so the mention text is a suffix
    // of the delivered body rather than the whole body.
    expect(mentionedTexts.some((text) => text.endsWith(mentionText))).toBe(
      true,
    );
  }, 90_000);

  test("inviting the echo agent launches its own run, joins the workbench, and receives @mentions", async () => {
    const invitableRes = await api(
      "GET",
      `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/invitable`,
      undefined,
      user1.cookies,
    );
    expectStatus("list invitable definitions", invitableRes, 200);
    const invitable = arrayField(
      invitableRes.data,
      "items",
      "list invitable definitions",
    ) as { id: string; name: string }[];
    const echoDefinition = invitable.find((item) => item.name === "echo");
    if (echoDefinition === undefined) {
      throw new Error(
        `no invitable definition named "echo": ${JSON.stringify(invitable)}`,
      );
    }

    const invited = await api(
      "POST",
      `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/invite`,
      { definitionId: echoDefinition.id },
      user1.cookies,
    );
    expectStatus("invite echo agent", invited, 201);
    const invitedAddress = stringField(
      invited.data,
      "address",
      "invite echo agent",
    );
    expect(stringField(invited.data, "definitionId", "invite echo agent")).toBe(
      echoDefinition.id,
    );
    const invitedLocalPart = invitedAddress.split("@")[0];
    if (invitedLocalPart === undefined || invitedLocalPart === "") {
      throw new Error(`malformed invited agent address: ${invitedAddress}`);
    }

    // The invited agent's own run's address joined this workbench's
    // participants — as a record carrying a friendly mention handle
    // derived from the invited definition's name ("echo"), never the
    // unusable raw local part — and the join event landed on this
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
    expect(invitedParticipant.handle).toBe("echo");

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
    // irrelevant to this assertion.
    const mentionText = `hey @${invitedParticipant.handle} welcome ${crypto.randomUUID()}`;
    await postMessage(user1.cookies, workbenchId, mentionText);

    const invitedTexts = await pollForDeliveredTexts(
      user1.cookies,
      invitedLocalPart,
      (text) => text.endsWith(mentionText),
    );
    // Exactly once, not merely "at least once": before CL-6043's
    // self-anchor fix, an invited agent's own run wrote
    // `anchorRunId: null` (see `packages/folded-runs/src/launch.ts`),
    // which `receiveWorkflowRunPack`
    // (`vendor/intx/hub-sessions/src/hub-session-lookups.ts`)
    // permanently rejects — the hub then redelivers the same mail
    // pack on every retry, so a still-broken anchor would show up
    // here as a duplicate, not a missing message.
    const deliveredMentions = invitedTexts.filter((text) =>
      text.endsWith(mentionText),
    );
    expect(deliveredMentions).toHaveLength(1);
  }, 90_000);

  async function echoDefinitionId(): Promise<string> {
    const invitableRes = await api(
      "GET",
      `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/invitable`,
      undefined,
      user1.cookies,
    );
    expectStatus("list invitable definitions", invitableRes, 200);
    const invitable = arrayField(
      invitableRes.data,
      "items",
      "list invitable definitions",
    ) as { id: string; name: string }[];
    const echoDefinition = invitable.find((item) => item.name === "echo");
    if (echoDefinition === undefined) {
      throw new Error(
        `no invitable definition named "echo": ${JSON.stringify(invitable)}`,
      );
    }
    return echoDefinition.id;
  }

  test("a chat auto-invites the echo agent and delivers un-mentioned messages to it", async () => {
    const chatCreated = await createWorkbench({
      kind: "chat",
      definitionId: await echoDefinitionId(),
    });
    expectStatus("create chat", chatCreated, 201);
    expect(stringField(chatCreated.data, "kind", "create chat")).toBe("chat");
    expect(stringField(chatCreated.data, "title", "create chat")).toBe("echo");
    chatId = stringField(chatCreated.data, "id", "create chat");

    const chatParticipants = arrayField(
      chatCreated.data,
      "participants",
      "create chat",
    ) as { address: string; handle: string }[];
    const chatAgent = chatParticipants.find((p) => p.handle === "echo");
    if (chatAgent === undefined) {
      throw new Error(
        `chat has no "echo" agent participant: ${JSON.stringify(chatParticipants)}`,
      );
    }
    const chatAgentLocalPart = chatAgent.address.split("@")[0];
    if (chatAgentLocalPart === undefined || chatAgentLocalPart === "") {
      throw new Error(`malformed chat agent address: ${chatAgent.address}`);
    }

    // Inviting into a chat now grows its participants like any other
    // workbench (the single-concept collapse: a workbench IS an agent
    // conversation) — only participant removal still refuses a chat.
    const secondInvite = await api(
      "POST",
      `/api/tenants/${tenantId}/chat/workbenches/${chatId}/invite`,
      { definitionId: await echoDefinitionId() },
      user1.cookies,
    );
    expectStatus("invite into a chat launches a second run", secondInvite, 201);

    // No @mention is needed: a chat delivers every message to its one
    // agent unconditionally. The agent's own inference source is a
    // placeholder key in CI, so its reply attempt is expected to error
    // and is never asserted here — only that the fan-out mail reached
    // it.
    const unmentionedText = `no mention needed ${crypto.randomUUID()}`;
    await postMessage(user1.cookies, chatId, unmentionedText);

    const agentTexts = await pollForDeliveredTexts(
      user1.cookies,
      chatAgentLocalPart,
      (text) => text === unmentionedText,
    );
    // Exactly once — see the same note on the invited-agent mention
    // assertion above: a redelivered duplicate here would mean this
    // chat agent's own folded run is still failing the live-anchor
    // check on its workflow-run mail pack.
    expect(agentTexts.filter((text) => text === unmentionedText)).toHaveLength(
      1,
    );
  }, 90_000);

  // Runs after the echo chat above so its own create call — same
  // tenant, same agent — proves the deliberate reuse path (CL-6089):
  // "+ New Workbench" always creates, so reuse is opt-in via
  // `reuseExisting: true` (the land-hop `ensureMyraWorkbench` uses),
  // which reopens the existing chat with 200 and the same id back,
  // never a fresh 201.
  test("kind filter excludes and includes by kind, and re-creating an existing agent chat reuses it", async () => {
    const reopened = await createWorkbench({
      kind: "chat",
      definitionId: await echoDefinitionId(),
      reuseExisting: true,
    });
    expectStatus("re-create existing agent chat", reopened, 200);
    expect(
      stringField(reopened.data, "id", "re-create existing agent chat"),
    ).toBe(chatId);

    const workbenchKindListed = await api(
      "GET",
      `/api/tenants/${tenantId}/chat/workbenches?kind=workbench`,
      undefined,
      user1.cookies,
    );
    expectStatus("list kind=workbench", workbenchKindListed, 200);
    const workbenchKindIds = arrayField(
      workbenchKindListed.data,
      "items",
      "list kind=workbench",
    ).map((item) => (item as { id: string }).id);
    expect(workbenchKindIds).not.toContain(chatId);
    expect(workbenchKindIds).toContain(workbenchId);

    const chatKindListed = await api(
      "GET",
      `/api/tenants/${tenantId}/chat/workbenches?kind=chat`,
      undefined,
      user1.cookies,
    );
    expectStatus("list kind=chat", chatKindListed, 200);
    const chatKindIds = arrayField(
      chatKindListed.data,
      "items",
      "list kind=chat",
    ).map((item) => (item as { id: string }).id);
    // Exactly one row for the echo agent chat — not two — is the whole
    // point of CL-6070: the sidebar never shows a duplicate for an agent
    // already talked to.
    expect(chatKindIds.filter((id) => id === chatId)).toHaveLength(1);
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
  // (`vendor/intx/mime/src/mime.ts`): its leaf-depth branch returns
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
  });

  // Every chat/folded run above (the workbench anchor, the mentioned
  // second workbench, the invited echo agent, the auto-invited chat
  // agent) writes its own `workflow-run` mail pack over the course of
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
  // for the echo workflow's plain native deployment too (which has
  // always self-anchored), so it is orthogonal to CL-6043 and made a
  // hub-log assertion flake (confirmed empirically: 4 such transient
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
  test("no chat/folded run's workflow-run pack was ever permanently rejected", () => {
    const sidecarOutput = sidecar.output();
    expect(sidecarOutput).not.toContain("enqueueInbox failed");
    expect(sidecarOutput).not.toContain("withholding ack");
    expect(sidecarOutput).not.toContain("rejecting inbound mail");
  });
});
