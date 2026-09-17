import { describe, expect, test } from "bun:test";

import { buildNeedsList, childTenantStore } from "./needs-list";
import {
  convergeNeedsList,
  createFetchStockHub,
  forkSubThread,
  StockHubCapabilityError,
  type HubSnapshot,
  type MailMessage,
  type StockHub,
} from "./needs-converge";

const HUB_SCOPE = "https://hub.example";
const ACCOUNT_ID = "usr_1";

const primary = {
  id: "tnt_primary",
  name: "Ada",
  slug: "ada",
  parentId: null,
};

const ownerMembership = {
  principalId: "prn_user",
  tenantId: "tnt_primary",
  tenantName: "Ada",
  tenantSlug: "ada",
  kind: "user",
  status: "active",
  roles: [{ id: "role_owner", name: "owner" }],
};

const ownerPrincipal = {
  id: "prn_user",
  tenantId: "tnt_primary",
  kind: "user",
  refId: "usr_1",
  displayName: "Ada",
  email: "ada@example.com",
  status: "active",
  roles: [{ id: "role_owner", name: "owner" }],
};

const myraPrincipal = {
  id: "prn_myra",
  tenantId: "tnt_primary",
  kind: "workflow",
  refId: "assistant",
  displayName: "Myra",
  status: "active",
  roles: [],
};

function snapshotWithMyra(): HubSnapshot {
  return {
    primaryTenant: primary,
    primaryPrincipals: [ownerPrincipal, myraPrincipal],
    childTenants: [],
    childPrincipals: {},
  };
}

function snapshotWithChild(childId: string): HubSnapshot {
  return {
    primaryTenant: primary,
    primaryPrincipals: [ownerPrincipal, myraPrincipal],
    childTenants: [
      {
        id: childId,
        name: "Atlas",
        slug: "ada-atlas",
        parentId: "tnt_primary",
      },
    ],
    childPrincipals: {},
  };
}

function memoryStorage() {
  const rows = new Map<string, string>();
  return {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
  };
}

function mailMessage(
  messageId: string,
  from: string,
  to: string[],
  extra?: Partial<MailMessage>,
): MailMessage {
  return { messageId, from, to, ...extra };
}

describe("group workbench creation sequence", () => {
  test("creates the child tenant, sends its primary thread, then reports it", async () => {
    const storage = memoryStorage();
    const calls: string[] = [];
    const hub: StockHub = {
      listMyPrincipals: () => Promise.resolve([ownerMembership]),
      getTenant: (id) => Promise.resolve({ ...primary, id }),
      listPrincipals: () => Promise.resolve([ownerPrincipal, myraPrincipal]),
      createTenant: (input) => {
        calls.push(`createTenant:${input.parentId}`);
        expect(input).toMatchObject({
          name: "Atlas",
          slug: "ada-atlas",
          parentId: "tnt_primary",
        });
        return Promise.resolve({
          id: "tnt_atlas",
          name: input.name,
          slug: input.slug,
          parentId: input.parentId ?? null,
        });
      },
      inviteMember: (tenantId, input) => {
        calls.push(`inviteMember:${tenantId}:${input.email}`);
        return Promise.resolve();
      },
      deployWorkflow: () => Promise.reject(new Error("unexpected deploy")),
      sendRunMail: (input) => {
        calls.push(`sendRunMail:${input.tenantId}`);
        expect(input).toMatchObject({
          tenantId: "tnt_atlas",
          runId: "run_atlas",
          to: ["bea@example.com"],
          subject: "Atlas",
          body: "Kick off Atlas.",
        });
        return Promise.resolve({ messageId: "<primary@example>" });
      },
      listRunMail: (input) => {
        calls.push(`listRunMail:${input.tenantId}`);
        return Promise.resolve([
          mailMessage("<primary@example>", "ada@example.com", [
            "bea@example.com",
          ]),
        ]);
      },
      searchAgentMailbox: () =>
        Promise.reject(new Error("unexpected mailbox search")),
      readMailThread: () => Promise.reject(new Error("unexpected thread read")),
    };

    const manifest = buildNeedsList({
      account: { id: ACCOUNT_ID, email: "ada@example.com", name: "Ada" },
      myraDefinitionRefId: "assistant",
      workbenches: [
        {
          localId: "atlas",
          slug: "ada-atlas",
          name: "Atlas",
          principals: [
            {
              kind: "user",
              refId: "usr_2",
              email: "bea@example.com",
              roles: ["member"],
            },
          ],
          initialMessage: { runId: "run_atlas", content: "Kick off Atlas." },
        },
      ],
    });

    const report = await convergeNeedsList(
      manifest,
      hub,
      childTenantStore(storage, HUB_SCOPE, ACCOUNT_ID),
      snapshotWithMyra(),
    );

    // Stock POST /api/tenants { parentId }, then the primary-thread first
    // message, then the stock mailbox read that splits primary + sub-threads.
    expect(calls).toEqual([
      "createTenant:tnt_primary",
      "inviteMember:tnt_atlas:bea@example.com",
      "sendRunMail:tnt_atlas",
      "listRunMail:tnt_atlas",
    ]);
    expect(report).toEqual({
      primaryTenantId: "tnt_primary",
      createdTenantIds: ["tnt_atlas"],
      directMessages: [],
      primaryThreads: [
        {
          tenantId: "tnt_atlas",
          rootMessageId: "<primary@example>",
          subThreads: [],
        },
      ],
    });
    expect(childTenantStore(storage, HUB_SCOPE, ACCOUNT_ID).load()).toEqual([
      {
        localId: "atlas",
        tenantId: "tnt_atlas",
        kind: "workbench",
        primaryThreadMessageId: "<primary@example>",
      },
    ]);
  });

  test("skips the primary-thread send when its Message-ID is already recorded", async () => {
    const storage = memoryStorage();
    const store = childTenantStore(storage, HUB_SCOPE, ACCOUNT_ID);
    store.record({
      localId: "atlas",
      tenantId: "tnt_atlas",
      kind: "workbench",
      primaryThreadMessageId: "<primary@example>",
    });
    const sends: string[] = [];
    const hub: StockHub = {
      listMyPrincipals: () => Promise.resolve([ownerMembership]),
      getTenant: (id) => Promise.resolve({ ...primary, id }),
      listPrincipals: () => Promise.resolve([ownerPrincipal, myraPrincipal]),
      createTenant: () => Promise.reject(new Error("unexpected create")),
      inviteMember: () => Promise.reject(new Error("unexpected invite")),
      deployWorkflow: () => Promise.reject(new Error("unexpected deploy")),
      sendRunMail: (input) => {
        sends.push(input.subject);
        return Promise.resolve({ messageId: "<resent@example>" });
      },
      listRunMail: () =>
        Promise.resolve([
          mailMessage("<primary@example>", "ada@example.com", [
            "bea@example.com",
          ]),
          mailMessage("<reply@example>", "bea@example.com", [
            "ada@example.com",
          ]),
        ]),
      searchAgentMailbox: () =>
        Promise.reject(new Error("unexpected mailbox search")),
      readMailThread: () => Promise.reject(new Error("unexpected thread read")),
    };

    const manifest = buildNeedsList({
      account: { id: ACCOUNT_ID, email: "ada@example.com", name: "Ada" },
      myraDefinitionRefId: "assistant",
      workbenches: [
        {
          localId: "atlas",
          slug: "ada-atlas",
          name: "Atlas",
          principals: [
            {
              kind: "user",
              refId: "usr_2",
              email: "bea@example.com",
              roles: ["member"],
            },
          ],
          initialMessage: { runId: "run_atlas", content: "Kick off Atlas." },
        },
      ],
    });

    const report = await convergeNeedsList(
      manifest,
      hub,
      store,
      snapshotWithChild("tnt_atlas"),
    );

    // No resend: the recorded native Message-ID is the idempotency proof.
    // The reply carries no In-Reply-To, so it groups as a sub-thread.
    expect(sends).toEqual([]);
    expect(report.createdTenantIds).toEqual([]);
    expect(report.primaryThreads).toEqual([
      {
        tenantId: "tnt_atlas",
        rootMessageId: "<primary@example>",
        subThreads: [
          {
            key: "message:<reply@example>",
            rootMessageId: "<reply@example>",
            messageIds: ["<reply@example>"],
          },
        ],
      },
    ]);
  });

  test("recreates the child tenant when the stored id no longer resolves", async () => {
    const storage = memoryStorage();
    const store = childTenantStore(storage, HUB_SCOPE, ACCOUNT_ID);
    store.record({
      localId: "atlas",
      tenantId: "tnt_stale",
      kind: "workbench",
    });
    const hub: StockHub = {
      listMyPrincipals: () => Promise.resolve([ownerMembership]),
      getTenant: (id) => Promise.resolve({ ...primary, id }),
      listPrincipals: () => Promise.resolve([ownerPrincipal, myraPrincipal]),
      createTenant: (input) =>
        Promise.resolve({
          id: "tnt_atlas",
          name: input.name,
          slug: input.slug,
          parentId: input.parentId ?? null,
        }),
      inviteMember: () => Promise.resolve(),
      deployWorkflow: () => Promise.reject(new Error("unexpected deploy")),
      sendRunMail: () => Promise.resolve({ messageId: "<primary@example>" }),
      listRunMail: () => Promise.resolve([]),
      searchAgentMailbox: () =>
        Promise.reject(new Error("unexpected mailbox search")),
      readMailThread: () => Promise.reject(new Error("unexpected thread read")),
    };

    const manifest = buildNeedsList({
      account: { id: ACCOUNT_ID, email: "ada@example.com", name: "Ada" },
      myraDefinitionRefId: "assistant",
      workbenches: [{ localId: "atlas", slug: "ada-atlas", name: "Atlas" }],
    });

    const report = await convergeNeedsList(
      manifest,
      hub,
      store,
      snapshotWithMyra(),
    );

    // No initialMessage supplied, so no primary-thread send — and no mail
    // to read means no primary thread entry either.
    expect(report.createdTenantIds).toEqual(["tnt_atlas"]);
    expect(report.primaryThreads).toEqual([]);
    expect(store.load()).toEqual([
      { localId: "atlas", tenantId: "tnt_atlas", kind: "workbench" },
    ]);
  });
});

describe("writes after gap checks", () => {
  function gapHub(calls: string[]): StockHub {
    return {
      listMyPrincipals: () => Promise.resolve([ownerMembership]),
      getTenant: (id) => Promise.resolve({ ...primary, id }),
      listPrincipals: () => Promise.resolve([ownerPrincipal, myraPrincipal]),
      createTenant: () => {
        calls.push("createTenant");
        return Promise.reject(new Error("must not write past a gap"));
      },
      inviteMember: () => {
        calls.push("inviteMember");
        return Promise.resolve();
      },
      deployWorkflow: () => {
        calls.push("deployWorkflow");
        return Promise.resolve();
      },
      sendRunMail: () => {
        calls.push("sendRunMail");
        return Promise.resolve({ messageId: "<late@example>" });
      },
      listRunMail: () => Promise.resolve([]),
      searchAgentMailbox: () =>
        Promise.reject(new Error("unexpected mailbox search")),
      readMailThread: () => Promise.reject(new Error("unexpected thread read")),
    };
  }

  test("requires exact deployment inputs before writing anything", async () => {
    const calls: string[] = [];
    const manifest = buildNeedsList({
      account: { id: ACCOUNT_ID, email: "ada@example.com", name: "Ada" },
      myraDefinitionRefId: "assistant",
      workbenches: [{ localId: "atlas", slug: "ada-atlas", name: "Atlas" }],
    });
    const snapshot: HubSnapshot = {
      primaryTenant: primary,
      primaryPrincipals: [ownerPrincipal],
      childTenants: [],
      childPrincipals: {},
    };

    const failure = await convergeNeedsList(
      manifest,
      gapHub(calls),
      childTenantStore(memoryStorage(), HUB_SCOPE, ACCOUNT_ID),
      snapshot,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StockHubCapabilityError);
    expect((failure as StockHubCapabilityError).capability).toBe(
      "deploy-workflow-inputs",
    );
    expect(calls).toEqual([]);
  });

  test("deploys Myra from caller-supplied inputs before workbench writes", async () => {
    const calls: string[] = [];
    const deployed: { tenantId: string; input: unknown }[] = [];
    const hub = gapHub(calls);
    hub.deployWorkflow = (tenantId, input) => {
      calls.push("deployWorkflow");
      deployed.push({ tenantId, input });
      return Promise.resolve();
    };
    hub.createTenant = (input) => {
      calls.push("createTenant");
      return Promise.resolve({
        id: "tnt_atlas",
        name: input.name,
        slug: input.slug,
        parentId: input.parentId ?? null,
      });
    };

    const manifest = buildNeedsList({
      account: { id: ACCOUNT_ID, email: "ada@example.com", name: "Ada" },
      myraDefinitionRefId: "assistant",
      myraDeploy: {
        source: { kind: "registry", registry: "npm" },
        entry: "dist/myra.js",
        sourceOfferingIds: ["off_1"],
        defaultSourceOfferingId: "off_1",
      },
      workbenches: [{ localId: "atlas", slug: "ada-atlas", name: "Atlas" }],
    });
    const snapshot: HubSnapshot = {
      primaryTenant: primary,
      primaryPrincipals: [ownerPrincipal],
      childTenants: [],
      childPrincipals: {},
    };

    const report = await convergeNeedsList(
      manifest,
      hub,
      childTenantStore(memoryStorage(), HUB_SCOPE, ACCOUNT_ID),
      snapshot,
    );

    expect(calls).toEqual(["deployWorkflow", "createTenant"]);
    expect(deployed).toEqual([
      {
        tenantId: "tnt_primary",
        input: {
          source: { kind: "registry", registry: "npm" },
          entry: "dist/myra.js",
          sourceOfferingIds: ["off_1"],
          defaultSourceOfferingId: "off_1",
        },
      },
    ]);
    expect(report.primaryTenantId).toBe("tnt_primary");
  });

  test("stops before writes on workflow and role gaps", async () => {
    const calls: string[] = [];
    const manifest = buildNeedsList({
      account: { id: ACCOUNT_ID, email: "ada@example.com", name: "Ada" },
      myraDefinitionRefId: "assistant",
      workbenches: [
        {
          localId: "bot",
          slug: "ada-bot",
          name: "Bot",
          principals: [
            { kind: "workflow", refId: "run_bot", roles: ["member"] },
          ],
        },
        {
          localId: "bossy",
          slug: "ada-bossy",
          name: "Bossy",
          principals: [
            {
              kind: "user",
              refId: "usr_2",
              email: "bea@example.com",
              roles: ["admin"],
            },
          ],
        },
      ],
    });

    const failure = await convergeNeedsList(
      manifest,
      gapHub(calls),
      childTenantStore(memoryStorage(), HUB_SCOPE, ACCOUNT_ID),
      snapshotWithMyra(),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StockHubCapabilityError);
    expect((failure as StockHubCapabilityError).capability).toBe(
      "project-workflow-principal",
    );
    expect(calls).toEqual([]);
  });
});

describe("thread-native DM derivation", () => {
  test("DMs are participant-filtered threads, never tenants", async () => {
    const storage = memoryStorage();
    const created: string[] = [];
    const hub: StockHub = {
      listMyPrincipals: () => Promise.resolve([ownerMembership]),
      getTenant: (id) => Promise.resolve({ ...primary, id }),
      listPrincipals: () => Promise.resolve([ownerPrincipal, myraPrincipal]),
      createTenant: (input) => {
        created.push(input.name);
        return Promise.resolve({
          id: `tnt_${input.slug}`,
          name: input.name,
          slug: input.slug,
          parentId: input.parentId ?? null,
        });
      },
      inviteMember: () => Promise.resolve(),
      deployWorkflow: () => Promise.reject(new Error("unexpected deploy")),
      sendRunMail: () => Promise.reject(new Error("unexpected send")),
      listRunMail: () => Promise.resolve([]),
      searchAgentMailbox: () =>
        Promise.reject(new Error("unexpected mailbox search")),
      readMailThread: () => Promise.reject(new Error("unexpected thread read")),
    };

    const manifest = buildNeedsList({
      account: { id: ACCOUNT_ID, email: "ada@example.com", name: "Ada" },
      myraDefinitionRefId: "assistant",
    });

    const report = await convergeNeedsList(
      manifest,
      hub,
      childTenantStore(storage, HUB_SCOPE, ACCOUNT_ID),
      snapshotWithMyra(),
      [
        mailMessage("<one@example>", "myra@example.com", ["ada@example.com"], {
          subject: "Myra daily",
        }),
        mailMessage("<two@example>", "ada@example.com", ["myra@example.com"], {
          subject: "Myra daily",
        }),
        mailMessage("<group@example>", "myra@example.com", [
          "ada@example.com",
          "bea@example.com",
        ]),
      ],
    );

    // One DM for the user↔Myra thread; the group thread is not a DM; and
    // no tenant was created for any of them.
    expect(report.directMessages).toHaveLength(1);
    expect(report.directMessages[0]).toMatchObject({
      agentAddress: "myra@example.com",
    });
    expect(created).toEqual([]);
  });
});

describe("sub-thread forking", () => {
  test("forks with native ancestry and replays the recorded Message-ID", async () => {
    const storage = memoryStorage();
    const sent: { headers: unknown; subject: string }[] = [];
    const hub: StockHub = {
      listMyPrincipals: () => Promise.resolve([ownerMembership]),
      getTenant: (id) => Promise.resolve({ ...primary, id }),
      listPrincipals: () => Promise.resolve([ownerPrincipal, myraPrincipal]),
      createTenant: () => Promise.reject(new Error("unexpected create")),
      inviteMember: () => Promise.reject(new Error("unexpected invite")),
      deployWorkflow: () => Promise.reject(new Error("unexpected deploy")),
      sendRunMail: (input) => {
        sent.push({ headers: input.headers, subject: input.subject });
        return Promise.resolve({ messageId: "<sub@example>" });
      },
      listRunMail: () => Promise.resolve([]),
      searchAgentMailbox: () =>
        Promise.reject(new Error("unexpected mailbox search")),
      readMailThread: () => Promise.reject(new Error("unexpected thread read")),
    };

    const parent = {
      workbenchLocalId: "atlas",
      tenantId: "tnt_atlas",
      messageId: "<primary@example>",
      references: [] as readonly string[],
    };
    const first = await forkSubThread(
      storage,
      hub,
      HUB_SCOPE,
      ACCOUNT_ID,
      parent,
      {
        to: ["bea@example.com"],
        subject: "Atlas delivery",
        body: "First delivery update.",
      },
    );
    const replay = await forkSubThread(
      storage,
      hub,
      HUB_SCOPE,
      ACCOUNT_ID,
      parent,
      {
        to: ["bea@example.com"],
        subject: "Atlas delivery",
        body: "First delivery update.",
      },
    );

    expect(first).toBe("<sub@example>");
    // Same parent + subject replays the recorded id instead of resending.
    expect(replay).toBe("<sub@example>");
    expect(sent).toEqual([
      {
        headers: {
          inReplyTo: "<primary@example>",
          references: ["<primary@example>"],
        },
        subject: "Atlas delivery",
      },
    ]);
  });

  test("resends when the same parent + subject carries an edited body", async () => {
    const storage = memoryStorage();
    const sent: { subject: string; body: string }[] = [];
    let next = 0;
    const hub: StockHub = {
      listMyPrincipals: () => Promise.resolve([ownerMembership]),
      getTenant: (id) => Promise.resolve({ ...primary, id }),
      listPrincipals: () => Promise.resolve([ownerPrincipal, myraPrincipal]),
      createTenant: () => Promise.reject(new Error("unexpected create")),
      inviteMember: () => Promise.reject(new Error("unexpected invite")),
      deployWorkflow: () => Promise.reject(new Error("unexpected deploy")),
      sendRunMail: (input) => {
        next += 1;
        sent.push({ subject: input.subject, body: input.body });
        return Promise.resolve({ messageId: `<sub${next}@example>` });
      },
      listRunMail: () => Promise.resolve([]),
      searchAgentMailbox: () =>
        Promise.reject(new Error("unexpected mailbox search")),
      readMailThread: () => Promise.reject(new Error("unexpected thread read")),
    };

    const parent = {
      workbenchLocalId: "atlas",
      tenantId: "tnt_atlas",
      messageId: "<primary@example>",
      references: [] as readonly string[],
    };
    const first = await forkSubThread(
      storage,
      hub,
      HUB_SCOPE,
      ACCOUNT_ID,
      parent,
      {
        to: ["bea@example.com"],
        subject: "Atlas delivery",
        body: "First delivery update.",
      },
    );
    const edited = await forkSubThread(
      storage,
      hub,
      HUB_SCOPE,
      ACCOUNT_ID,
      parent,
      {
        to: ["bea@example.com"],
        subject: "Atlas delivery",
        body: "Edited delivery update.",
      },
    );

    // An edited body is a new send, never a replay of the recorded id.
    expect(first).toBe("<sub1@example>");
    expect(edited).toBe("<sub2@example>");
    expect(sent).toEqual([
      { subject: "Atlas delivery", body: "First delivery update." },
      { subject: "Atlas delivery", body: "Edited delivery update." },
    ]);
  });

  test("resends when the same parent + subject targets new recipients", async () => {
    const storage = memoryStorage();
    const sent: { to: readonly string[] }[] = [];
    let next = 0;
    const hub: StockHub = {
      listMyPrincipals: () => Promise.resolve([ownerMembership]),
      getTenant: (id) => Promise.resolve({ ...primary, id }),
      listPrincipals: () => Promise.resolve([ownerPrincipal, myraPrincipal]),
      createTenant: () => Promise.reject(new Error("unexpected create")),
      inviteMember: () => Promise.reject(new Error("unexpected invite")),
      deployWorkflow: () => Promise.reject(new Error("unexpected deploy")),
      sendRunMail: (input) => {
        next += 1;
        sent.push({ to: input.to });
        return Promise.resolve({ messageId: `<sub${next}@example>` });
      },
      listRunMail: () => Promise.resolve([]),
      searchAgentMailbox: () =>
        Promise.reject(new Error("unexpected mailbox search")),
      readMailThread: () => Promise.reject(new Error("unexpected thread read")),
    };

    const parent = {
      workbenchLocalId: "atlas",
      tenantId: "tnt_atlas",
      messageId: "<primary@example>",
      references: [] as readonly string[],
    };
    const first = await forkSubThread(
      storage,
      hub,
      HUB_SCOPE,
      ACCOUNT_ID,
      parent,
      {
        to: ["bea@example.com"],
        subject: "Atlas delivery",
        body: "First delivery update.",
      },
    );
    const retargeted = await forkSubThread(
      storage,
      hub,
      HUB_SCOPE,
      ACCOUNT_ID,
      parent,
      {
        to: ["bea@example.com", "cal@example.com"],
        subject: "Atlas delivery",
        body: "First delivery update.",
      },
    );

    expect(first).toBe("<sub1@example>");
    expect(retargeted).toBe("<sub2@example>");
    expect(sent).toEqual([
      { to: ["bea@example.com"] },
      { to: ["bea@example.com", "cal@example.com"] },
    ]);
  });
});

describe("stock-only fetch hub", () => {
  function stubFetch(
    seen: { method: string; url: string; body: unknown }[],
    routes: Record<string, unknown>,
  ) {
    return (async (url: unknown, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      const path = String(url).split("?")[0] ?? String(url);
      const body =
        init?.body === undefined ? undefined : JSON.parse(init.body as string);
      seen.push({ method, url: String(url), body });
      const key = `${method} ${path}`;
      const payload = key in routes ? routes[key] : routes[path];
      if (payload === undefined) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
  }

  test("mailbox search and thread reads stay typed upstream gaps", async () => {
    const hub = createFetchStockHub(stubFetch([], {}));

    const search = await hub
      .searchAgentMailbox({ address: "myra@example.com" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(search).toBeInstanceOf(StockHubCapabilityError);
    expect((search as StockHubCapabilityError).capability).toBe(
      "agent-mailbox-reads",
    );

    const thread = await hub.readMailThread({ messageId: "<a@example>" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thread).toBeInstanceOf(StockHubCapabilityError);
    expect((thread as StockHubCapabilityError).capability).toBe(
      "thread-fork-context",
    );
  });

  test("every request stays on stock routes with no custom idempotency keys", async () => {
    const seen: { method: string; url: string; body: unknown }[] = [];
    const hub = createFetchStockHub(
      stubFetch(seen, {
        "/api/tenants": {
          id: "tnt_atlas",
          name: "Atlas",
          slug: "ada-atlas",
          parentId: "tnt_primary",
        },
        "POST /api/tenants/tnt_atlas/mailbox/messages": {
          messageId: "<primary@example>",
        },
        "/api/tenants/tnt_atlas/mailbox/messages": {
          data: [
            {
              messageId: "<primary@example>",
              from: "ada@example.com",
              to: ["bea@example.com"],
            },
          ],
          nextCursor: null,
        },
      }),
    );

    const created = await hub.createTenant({
      name: "Atlas",
      slug: "ada-atlas",
      parentId: "tnt_primary",
    });
    expect(created.id).toBeDefined();
    const sent = await hub.sendRunMail({
      tenantId: "tnt_atlas",
      to: ["bea@example.com"],
      subject: "Atlas",
      body: "Kick off Atlas.",
    });
    expect(sent.messageId).toBeDefined();
    const mail = await hub.listRunMail({ tenantId: "tnt_atlas" });
    expect(mail).toHaveLength(1);

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      // Stock surface only: tenant bootstrap, invites, deploys, mailbox.
      // Never a product path, never a DM tenancy path.
      expect(request.url.startsWith("/api/")).toBe(true);
      expect(request.url).not.toContain("/workbenches");
      expect(request.url).not.toContain("dm:");
    }
    const send = seen.find((request) => request.method === "POST");
    expect(send).toBeDefined();
    expect(JSON.stringify(send?.body)).not.toContain("idempotency");
    expect(JSON.stringify(send?.body)).not.toContain("dm:");
  });

  test("inviteMember resolves the role name to the tenant's own role id before inviting", async () => {
    const seen: { method: string; url: string; body: unknown }[] = [];
    const hub = createFetchStockHub(
      stubFetch(seen, {
        "/api/tenants/tnt_atlas/roles": {
          data: [{ id: "role_member", name: "member" }],
          nextCursor: null,
        },
        "POST /api/tenants/tnt_atlas/members/invite": {},
      }),
    );

    await hub.inviteMember("tnt_atlas", {
      email: "bea@example.com",
      role: "member",
    });

    const invite = seen.find((request) =>
      request.url.startsWith("/api/tenants/tnt_atlas/members/invite"),
    );
    expect(invite?.body).toEqual({
      email: "bea@example.com",
      roleId: "role_member",
    });
  });
});
