// Routes-level tests for the Myra-backed drafting seam (CL-5917): the
// wiring this package owns — the port is called, a successful reply
// produces the exact draft shape the review UI consumes, and a failed
// call surfaces the same honest, plain-language "drafting_failed"
// envelope other drafting/planning-failure surfaces in this codebase
// use, never a fabricated draft or a silent empty one.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import { FoldedRunTimedOutError } from "@corbits/folded-run-one-shot";

import {
  createRoutineRoutes,
  type CreateRoutineRoutesDeps,
  type RoutineLauncher,
} from "../src/routes";
import { createInMemoryRoutineStore } from "../src/store";
import {
  createInMemoryDraftStore,
  type RoutineDraftingPort,
} from "../src/drafts";
import { RoutineDraftReplyUnparseableError } from "../src/myra-drafting";

const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function principal(id: string) {
  return {
    id,
    tenantId: TENANT.id,
    kind: "user" as const,
    refId: id,
    status: "active" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fakeLauncher(): RoutineLauncher {
  return {
    async launchRoutineRun() {
      return { runId: "run_1" };
    },
  };
}

function mountAs(
  routes: Hono<TenantEnv>,
  principalId: string,
): Hono<TenantEnv> {
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", principal(principalId));
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

function buildDeps(
  drafting: RoutineDraftingPort | undefined,
  overrides: Partial<CreateRoutineRoutesDeps> = {},
): CreateRoutineRoutesDeps {
  return {
    store: createInMemoryRoutineStore(),
    launcher: fakeLauncher(),
    drafts: createInMemoryDraftStore(),
    drafting,
    requireGrant: () => async (_c, next) => {
      await next();
    },
    ...overrides,
  };
}

async function createDraft(
  app: Hono<TenantEnv>,
  body: Record<string, unknown>,
) {
  const response = await app.request("/routine-drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

const DRAFT_BODY = {
  prompt: "Summarize the workbench every morning",
  deliveryWorkbenchId: "ch_1",
  scope: "bench",
};

describe("POST /routine-drafts with a Myra-backed drafting port", () => {
  test("a valid mocked reply produces the exact draft shape the review UI consumes", async () => {
    const drafting: RoutineDraftingPort = {
      async propose() {
        return {
          steps: [
            { title: "Collect yesterday's messages" },
            { title: "Write a summary" },
          ],
          name: "Daily digest",
          trigger: { kind: "daily", hour: 9, minute: 0 },
          definitionId: "wfd_digest",
          autonomy: { triggerInput: { topic: "general" } },
        };
      },
    };
    const app = mountAs(createRoutineRoutes(buildDeps(drafting)), "prn_1");
    const { response, body } = await createDraft(app, DRAFT_BODY);

    expect(response.status).toBe(201);
    expect(body.status).toBe("reviewed");
    expect(body.proposedSteps).toEqual([
      { title: "Collect yesterday's messages" },
      { title: "Write a summary" },
    ]);
    expect(body.proposedTrigger).toEqual({ kind: "daily", hour: 9, minute: 0 });
    expect(body.proposedName).toBe("Daily digest");
    expect(body.definitionId).toBe("wfd_digest");
    expect(body.autonomy).toEqual({ triggerInput: { topic: "general" } });
  });

  test("a drafting-port failure surfaces the honest drafting_failed envelope, never a fabricated draft", async () => {
    const drafting: RoutineDraftingPort = {
      async propose() {
        throw new FoldedRunTimedOutError(60_000);
      },
    };
    const app = mountAs(createRoutineRoutes(buildDeps(drafting)), "prn_1");
    const { response, body } = await createDraft(app, DRAFT_BODY);

    expect(response.status).toBe(422);
    const error = body.error as {
      code: string;
      userMessage: string;
      refId: string;
    };
    expect(error.code).toBe("drafting_failed");
    expect(error.userMessage).toBe(
      "Myra couldn't draft a routine from that. Try rephrasing, or build it from the catalog instead.",
    );
    expect(typeof error.refId).toBe("string");
    expect(error.refId.length).toBeGreaterThan(0);
  });

  test("an unparseable Myra reply also surfaces the honest drafting_failed envelope", async () => {
    const drafting: RoutineDraftingPort = {
      async propose() {
        throw new RoutineDraftReplyUnparseableError(
          "not valid JSON",
          "not json",
        );
      },
    };
    const app = mountAs(createRoutineRoutes(buildDeps(drafting)), "prn_1");
    const { response, body } = await createDraft(app, DRAFT_BODY);

    expect(response.status).toBe(422);
    expect((body.error as { code: string }).code).toBe("drafting_failed");
  });

  test("an unrelated platform error is not swallowed as a drafting failure", async () => {
    const drafting: RoutineDraftingPort = {
      async propose() {
        throw new Error("database connection lost");
      },
    };
    const app = mountAs(createRoutineRoutes(buildDeps(drafting)), "prn_1");
    const response = await app.request("/routine-drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(DRAFT_BODY),
    });
    // Hono's default error handling on an uncaught throw: a 500, never
    // the honest 422 envelope and never a fabricated 201.
    expect(response.status).toBe(500);
  });
});

describe("in-flight drafting guard", () => {
  test("a second concurrent draft request from the same principal gets 409 while Myra is still working", async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const drafting: RoutineDraftingPort = {
      async propose() {
        await gate;
        return { steps: [{ title: "step one" }], trigger: null };
      },
    };
    const app = mountAs(createRoutineRoutes(buildDeps(drafting)), "prn_1");

    const first = createDraft(app, DRAFT_BODY);
    // Give the first request a tick to register itself as in-flight
    // before the second one races it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await createDraft(app, DRAFT_BODY);

    expect(second.response.status).toBe(409);
    const error = second.body.error as {
      code: string;
      userMessage: string;
      refId: string;
    };
    expect(error.code).toBe("dispatch_in_progress");
    expect(error.userMessage).toBe(
      "Myra is already working on your last request.",
    );
    expect(typeof error.refId).toBe("string");
    expect(error.refId.length).toBeGreaterThan(0);

    releaseFirst();
    const firstResult = await first;
    expect(firstResult.response.status).toBe(201);
  });

  test("a different principal is never blocked by another principal's in-flight draft", async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const drafting: RoutineDraftingPort = {
      async propose({ principalId }) {
        // Only Alice's call blocks on the gate — Bob's own request must
        // never wait on a lock it doesn't hold.
        if (principalId === "prn_alice") await gate;
        return { steps: [{ title: "step one" }], trigger: null };
      },
    };
    const routes = createRoutineRoutes(buildDeps(drafting));
    const appAsAlice = mountAs(routes, "prn_alice");
    const appAsBob = mountAs(routes, "prn_bob");

    const first = createDraft(appAsAlice, DRAFT_BODY);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await createDraft(appAsBob, DRAFT_BODY);

    expect(second.response.status).toBe(201);
    releaseFirst();
    await first;
  });

  test("the guard is released after a drafting failure, so a retry is never permanently blocked", async () => {
    const drafting: RoutineDraftingPort = {
      async propose() {
        throw new FoldedRunTimedOutError(60_000);
      },
    };
    const app = mountAs(createRoutineRoutes(buildDeps(drafting)), "prn_1");

    const first = await createDraft(app, DRAFT_BODY);
    expect(first.response.status).toBe(422);

    const second = await createDraft(app, DRAFT_BODY);
    expect(second.response.status).toBe(422);
  });
});

describe("POST /routine-drafts/:id/approve webhook defense in depth", () => {
  test("a drafted webhook trigger is checked against webhookTriggerInTenant, and rejected when it does not resolve — never a corrupt routine", async () => {
    let webhookCheckCalls = 0;
    const drafting: RoutineDraftingPort = {
      async propose() {
        return {
          steps: [{ title: "step one" }],
          definitionId: "def_1",
          trigger: { kind: "webhook", webhookTriggerId: "not-a-real-trigger" },
        };
      },
    };
    const store = createInMemoryRoutineStore();
    const app = mountAs(
      createRoutineRoutes(
        buildDeps(drafting, {
          store,
          webhookTriggerInTenant: async () => {
            webhookCheckCalls += 1;
            return false;
          },
        }),
      ),
      "prn_1",
    );

    const { response: createRes, body: createBody } = await createDraft(
      app,
      DRAFT_BODY,
    );
    expect(createRes.status).toBe(201);
    const draftId = createBody.id as string;

    const approveRes = await app.request(`/routine-drafts/${draftId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(webhookCheckCalls).toBe(1);
    expect(approveRes.status).toBe(404);
    expect(await store.listRoutines(TENANT.id)).toEqual([]);
  });

  test("a drafted webhook trigger that does resolve in this tenant approves normally", async () => {
    const drafting: RoutineDraftingPort = {
      async propose() {
        return {
          steps: [{ title: "step one" }],
          definitionId: "def_1",
          trigger: { kind: "webhook", webhookTriggerId: "wht_real" },
        };
      },
    };
    const app = mountAs(
      createRoutineRoutes(
        buildDeps(drafting, { webhookTriggerInTenant: async () => true }),
      ),
      "prn_1",
    );

    const { body: createBody } = await createDraft(app, DRAFT_BODY);
    const draftId = createBody.id as string;

    const approveRes = await app.request(`/routine-drafts/${draftId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(approveRes.status).toBe(201);
  });
});

describe("POST /routine-drafts/:id/approve definitionId recovery", () => {
  test("a draft with no definitionId is approvable once the request body supplies one — no dead end", async () => {
    const drafting: RoutineDraftingPort = {
      async propose() {
        return { steps: [{ title: "step one" }], trigger: null };
      },
    };
    const app = mountAs(createRoutineRoutes(buildDeps(drafting)), "prn_1");

    const { body: createBody } = await createDraft(app, DRAFT_BODY);
    const draftId = createBody.id as string;
    expect(createBody.definitionId).toBeNull();

    const withoutPick = await app.request(
      `/routine-drafts/${draftId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(withoutPick.status).toBe(400);

    const withPick = await app.request(`/routine-drafts/${draftId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "def_picked" }),
    });
    expect(withPick.status).toBe(201);
    const approved = (await withPick.json()) as {
      routine: { definitionId: string };
    };
    expect(approved.routine.definitionId).toBe("def_picked");
  });
});

describe("routine-drafts when no draft store is configured", () => {
  function mountWithoutDrafts(): Hono<TenantEnv> {
    return mountAs(
      createRoutineRoutes(buildDeps(undefined, { drafts: undefined })),
      "prn_alice",
    );
  }

  test("POST /routine-drafts answers 503, never a 404 conflated with a missing draft", async () => {
    const app = mountWithoutDrafts();
    const response = await app.request("/routine-drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(DRAFT_BODY),
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unavailable");
  });

  test("GET /routine-drafts still lists an honest empty page", async () => {
    const app = mountWithoutDrafts();
    const response = await app.request("/routine-drafts");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  test("GET /routine-drafts/:id and approve/discard answer 503", async () => {
    const app = mountWithoutDrafts();
    expect((await app.request("/routine-drafts/rd_1")).status).toBe(503);
    expect(
      (
        await app.request("/routine-drafts/rd_1/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(503);
    expect(
      (await app.request("/routine-drafts/rd_1/discard", { method: "POST" }))
        .status,
    ).toBe(503);
  });
});
