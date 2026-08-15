// Routes-level tests for the Myra-backed drafting seam (CL-5917): the
// wiring this package owns — the port is called, a successful reply
// produces the exact draft shape the review UI consumes, and a failed
// call surfaces the same honest, plain-language "drafting_failed"
// envelope `@corbits/task-planner`'s own planning-failure convention
// uses, never a fabricated draft or a silent empty one.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import { FoldedRunTimedOutError } from "@corbits/folded-runs";

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
  prompt: "Summarize the channel every morning",
  deliveryChannelId: "ch_1",
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
    expect(body).toEqual({
      error: {
        code: "drafting_failed",
        message:
          "Myra couldn't draft a routine from that. Try rephrasing, or build it from the catalog instead.",
      },
    });
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
