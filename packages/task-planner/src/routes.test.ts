// Mirrors packages/tasks/src/routes.test.ts's mounting style: a plain
// stubbed `dispatch` port, no database, no folded-run machinery.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { TenantEnv } from "@intx/hub-api";

import {
  PlannerInferenceUnavailableError,
  PlannerMyraUnavailableError,
} from "./planner-run";
import { FoldedRunTimedOutError } from "@corbits/folded-runs";
import { PlannerReferenceOutOfInventoryError } from "./task-spec";
import { SkillRegistryError } from "@corbits/skills";
import {
  AgentDefinitionDraftReferenceOutOfInventoryError,
  MyraAgentDefinitionDraftingUnavailableError,
  type AgentDefinitionDraft,
} from "./agent-definition-drafting";
import {
  createPlannerRoutes,
  type CreatePlannerRoutesDeps,
  type DispatchWithPlannerResult,
} from "./routes";

const TENANT = { id: "tnt_1" };

function principal(id: string) {
  return { id };
}

function mountAs(app: Hono<TenantEnv>, principalId: string): Hono<TenantEnv> {
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT as never);
    c.set("principal", principal(principalId) as never);
    await next();
  };
  const mounted = new Hono<TenantEnv>();
  mounted.use("*", asPrincipal);
  mounted.route("/", app);
  return mounted;
}

const RESULT: DispatchWithPlannerResult = {
  task: {
    id: "task_1",
    tenantId: "tnt_1",
    principalId: "prn_alice",
    definitionId: "wfd_agent",
    agentName: "Agent",
    prompt: "Summarize the doc",
    modelPreference: null,
    status: "running",
    runId: "run_1",
    runIds: ["run_1"],
    stepCount: 1,
    resultMailId: null,
    plannerRunId: "wfr_planner_1",
    workbenchId: null,
    createdAt: new Date(),
    completedAt: null,
  },
  plannerRunId: "wfr_planner_1",
  inventory: {
    agents: [],
    toolPackages: [],
    skills: [],
    memoryAvailable: false,
    models: [],
  },
};

function buildDeps(
  overrides: Partial<CreatePlannerRoutesDeps> = {},
): CreatePlannerRoutesDeps {
  return {
    requireGrant: () => async (_c, next) => {
      await next();
    },
    dispatch: async () => RESULT,
    ...overrides,
  };
}

describe("POST /", () => {
  test("dispatches a plan and returns 201 with the task and plannerRunId", async () => {
    const app = mountAs(createPlannerRoutes(buildDeps()), "prn_alice");

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "Summarize the doc" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      task: { id: string };
      plannerRunId: string;
    };
    expect(body.task.id).toBe("task_1");
    expect(body.plannerRunId).toBe("wfr_planner_1");
  });

  test("a malformed body is rejected with the structured error envelope", async () => {
    const app = mountAs(createPlannerRoutes(buildDeps()), "prn_alice");

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("a denied grant is rejected before any plan is dispatched", async () => {
    let dispatched = false;
    const deps = buildDeps({
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
      dispatch: async () => {
        dispatched = true;
        throw new Error("should never be called");
      },
    });
    const app = mountAs(createPlannerRoutes(deps), "prn_alice");

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "Summarize the doc" }),
    });

    expect(response.status).toBe(403);
    expect(dispatched).toBe(false);
  });

  test.each([
    [
      "PlannerMyraUnavailableError",
      () => new PlannerMyraUnavailableError("tnt_1", "no deployed Myra"),
    ],
    ["FoldedRunTimedOutError", () => new FoldedRunTimedOutError(60_000)],
    [
      "PlannerReferenceOutOfInventoryError",
      () => new PlannerReferenceOutOfInventoryError("use", "wfd_unknown"),
    ],
    [
      "SkillRegistryError",
      () => new SkillRegistryError("not_found", 'No skill named "unknown"'),
    ],
  ])("%s maps to a plain-language 422", async (_name, makeError) => {
    const deps = buildDeps({
      dispatch: async () => {
        throw makeError();
      },
    });
    const app = mountAs(createPlannerRoutes(deps), "prn_alice");

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "Summarize the doc" }),
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("planning_failed");
    expect(body.error.message).not.toContain("wfd_unknown");
  });

  test("PlannerInferenceUnavailableError maps to a 503 inference_unavailable, not planning_failed", async () => {
    const deps = buildDeps({
      dispatch: async () => {
        throw new PlannerInferenceUnavailableError("tnt_1");
      },
    });
    const app = mountAs(createPlannerRoutes(deps), "prn_alice");

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "Summarize the doc" }),
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("inference_unavailable");
    expect(body.error.message).toBe(
      "The model couldn't be reached — try again in a moment",
    );
  });

  test("a second concurrent request from the same principal is rejected while the first is in flight, and a later request succeeds once it settles", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let dispatchCalls = 0;
    const deps = buildDeps({
      dispatch: async () => {
        dispatchCalls += 1;
        if (dispatchCalls === 1) {
          await firstGate;
        }
        return RESULT;
      },
    });
    const app = mountAs(createPlannerRoutes(deps), "prn_alice");

    const firstRequest = app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "Summarize the doc" }),
    });
    // Let the first request's handler actually start (and register itself
    // as in-flight) before firing the second.
    await Promise.resolve();

    const secondResponse = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "Summarize something else" }),
    });
    expect(secondResponse.status).toBe(409);
    const secondBody = (await secondResponse.json()) as {
      error: { code: string };
    };
    expect(secondBody.error.code).toBe("dispatch_in_progress");

    releaseFirst?.();
    const firstResponse = await firstRequest;
    expect(firstResponse.status).toBe(201);

    const thirdResponse = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "Summarize a third doc" }),
    });
    expect(thirdResponse.status).toBe(201);
    expect(dispatchCalls).toBe(2);
  });

  test("an unexpected error is rethrown, not swallowed into a 422", async () => {
    const deps = buildDeps({
      dispatch: async () => {
        throw new Error("platform fault");
      },
    });
    const app = mountAs(createPlannerRoutes(deps), "prn_alice");

    // Hono's own dispatch turns an uncaught throw into a generic 500 —
    // the point under test is that it is NOT this route's 422
    // "planning_failed" envelope, i.e. the route never mistakes a
    // platform fault for a planning failure.
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "Summarize the doc" }),
    });
    expect(response.status).toBe(500);
  });
});

const DRAFT: AgentDefinitionDraft = {
  systemPrompt: "You review incidents.",
  toolPackagePins: [],
  skills: [],
};

describe("POST /agent-definitions/draft", () => {
  test("answers 503 when the host hasn't wired draftAgentDefinition", async () => {
    const app = mountAs(createPlannerRoutes(buildDeps()), "prn_alice");

    const response = await app.request("/agent-definitions/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bot", purpose: "Help with incidents" }),
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unavailable");
  });

  test("drafts an agent definition and returns 201 with the draft", async () => {
    const deps = buildDeps({ draftAgentDefinition: async () => DRAFT });
    const app = mountAs(createPlannerRoutes(deps), "prn_alice");

    const response = await app.request("/agent-definitions/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bot", purpose: "Help with incidents" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { draft: AgentDefinitionDraft };
    expect(body.draft).toEqual(DRAFT);
  });

  test("a malformed body is rejected with the structured error envelope", async () => {
    const deps = buildDeps({ draftAgentDefinition: async () => DRAFT });
    const app = mountAs(createPlannerRoutes(deps), "prn_alice");

    const response = await app.request("/agent-definitions/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("a name-only body (no purpose) is accepted — the happy path is name-only", async () => {
    let received: { readonly purpose?: string } | undefined;
    const deps = buildDeps({
      draftAgentDefinition: async (input) => {
        received = input;
        return DRAFT;
      },
    });
    const app = mountAs(createPlannerRoutes(deps), "prn_alice");

    const response = await app.request("/agent-definitions/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bot" }),
    });

    expect(response.status).toBe(201);
    expect(received?.purpose).toBeUndefined();
  });

  test.each([
    [
      "MyraAgentDefinitionDraftingUnavailableError",
      () =>
        new MyraAgentDefinitionDraftingUnavailableError(
          "tnt_1",
          "no deployed Myra",
        ),
    ],
    ["FoldedRunTimedOutError", () => new FoldedRunTimedOutError(60_000)],
    [
      "AgentDefinitionDraftReferenceOutOfInventoryError",
      () =>
        new AgentDefinitionDraftReferenceOutOfInventoryError(
          "modelPreference",
          "made-up/model",
        ),
    ],
  ])("%s maps to a plain-language 422", async (_name, makeError) => {
    const deps = buildDeps({
      draftAgentDefinition: async () => {
        throw makeError();
      },
    });
    const app = mountAs(createPlannerRoutes(deps), "prn_alice");

    const response = await app.request("/agent-definitions/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bot", purpose: "Help with incidents" }),
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("drafting_failed");
    expect(body.error.message).not.toContain("made-up/model");
  });

  test("a second concurrent draft request from the same principal is rejected while the first is in flight", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let draftCalls = 0;
    const deps = buildDeps({
      draftAgentDefinition: async () => {
        draftCalls += 1;
        if (draftCalls === 1) {
          await firstGate;
        }
        return DRAFT;
      },
    });
    const app = mountAs(createPlannerRoutes(deps), "prn_alice");

    const firstRequest = app.request("/agent-definitions/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bot", purpose: "Help with incidents" }),
    });
    await Promise.resolve();

    const secondResponse = await app.request("/agent-definitions/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bot", purpose: "Help with incidents" }),
    });
    expect(secondResponse.status).toBe(409);
    const secondBody = (await secondResponse.json()) as {
      error: { code: string };
    };
    expect(secondBody.error.code).toBe("dispatch_in_progress");

    releaseFirst?.();
    const firstResponse = await firstRequest;
    expect(firstResponse.status).toBe(201);
    expect(draftCalls).toBe(1);
  });
});
