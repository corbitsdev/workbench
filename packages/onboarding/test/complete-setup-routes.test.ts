// `POST /complete-setup` reports where a bench stands; it never
// deploys. CL-6457 moved every workflow deploy off the request path,
// and CL-7586 deleted the pending-seed drain entirely: there is no
// parked row, no deferred deploy step, no nudge target. What is left
// here is a status reporter over hub reads, and it has to answer three
// cases correctly: every default workflow live (`ready` — answered
// from the read alone), a credential with pins still missing
// (`provisioning` — the client's needs-list convergence drives the
// deploy, so this call just answers the status for the waiting surface
// to poll on), and
// nothing to converge with (`unseeded`, a 200 and not an error,
// telling the caller to fall back to the ordinary credential step).
//
// The converging itself — the desired-state reconcile's idempotency,
// its retries, its half-provisioned recovery — is covered where it
// now lives, in `./desired-state.test.ts`.
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { DEFAULT_WORKFLOWS, inferenceCredentialName } from "@corbits/seeding";
import { createOnboardingRoutes } from "../src/routes";

const TENANT_ID = "ten_1";
const PRINCIPAL_ID = "prn_1";
const TENANT_SLUG = "user-1-user1";
const TENANT_DOMAIN = "user-1-user1.bench.local";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function asUser(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("user", { id: "user_1", email: "user_1@example.com" } as never);
    await next();
  };
}

function mountAuthenticated(routes: Hono<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", asUser());
  app.route("/api/onboarding", routes);
  return app;
}

function principalsRoute(hub: Hono) {
  hub.get("/api/me/principals", (c) =>
    c.json({
      data: [
        {
          principalId: PRINCIPAL_ID,
          tenantId: TENANT_ID,
          tenantName: "user_1's workbench",
          tenantSlug: TENANT_SLUG,
          kind: "user",
          status: "active",
          roles: [],
        },
      ],
      nextCursor: null,
    }),
  );
  hub.get(`/api/tenants/${TENANT_ID}`, (c) =>
    c.json({
      id: TENANT_ID,
      name: "user_1's workbench",
      slug: TENANT_SLUG,
      domain: TENANT_DOMAIN,
      parentId: null,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    }),
  );
}

/** The one row `/complete-setup`'s credential check looks for: an
 * active credential under the name the setup catalog persists
 * inference keys as. */
function activeCredentialRow() {
  return {
    id: "cre_1",
    tenantId: TENANT_ID,
    providerId: "prv_1",
    name: inferenceCredentialName("anthropic"),
    type: "api_key",
    status: "active",
    metadata: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function credentialsRoute(
  hub: Hono,
  args: { inferenceCredential?: boolean } = {},
) {
  hub.get(`/api/tenants/${TENANT_ID}/credentials`, (c) =>
    c.json({
      data: args.inferenceCredential === true ? [activeCredentialRow()] : [],
      nextCursor: null,
    }),
  );
}

describe("POST /complete-setup", () => {
  test("requires authentication", async () => {
    const app = new Hono<AppEnv>();
    app.route(
      "/api/onboarding",
      createOnboardingRoutes({
        hubUrl: "https://bench.example.com",
        pushWorkflow: async () => ({
          outcome: "pushed" as const,
          commitSha: "a".repeat(40),
        }),
        log: () => undefined,
      }),
    );

    const response = await app.request("/api/onboarding/complete-setup", {
      method: "POST",
    });

    expect(response.status).toBe(401);
  });

  test("no personal bench yet reports 409, not a fabricated seed", async () => {
    const hub = new Hono();
    hub.get("/api/me/principals", (c) =>
      c.json({ data: [], nextCursor: null }),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("no_personal_bench");
    } finally {
      server.stop(true);
    }
  });

  // CL-7506: a seeded admin's only membership is the root bench, whose
  // slug is the org's own — never the computed personal-bench slug. The
  // fallback must resolve that principal here too, answering from the
  // read instead of 409ing.
  test("a root-bench-only admin (slug mismatch) resolves through the fallback and reports unseeded, not 409", async () => {
    const hub = new Hono();
    hub.get("/api/me/principals", (c) =>
      c.json({
        data: [
          {
            principalId: "prn_root",
            tenantId: "ten_root",
            tenantName: "acme",
            tenantSlug: "acme",
            kind: "user",
            status: "active",
            roles: [],
          },
        ],
        nextCursor: null,
      }),
    );
    hub.get("/api/tenants/ten_root", (c) =>
      c.json({
        id: "ten_root",
        name: "acme",
        slug: "acme",
        domain: "acme.bench.local",
        parentId: null,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      }),
    );
    hub.get("/api/tenants/ten_root/assets", (c) => c.json([]));
    hub.get("/api/tenants/ten_root/workflows/deployments", (c) => c.json([]));
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("unseeded");
    } finally {
      server.stop(true);
    }
  });

  test("an already fully seeded bench reports ready without needing a pending row", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) =>
      c.json(
        DEFAULT_WORKFLOWS.map((workflow, index) => ({
          id: `ast_${index}`,
          tenantId: TENANT_ID,
          kind: "workflow",
          name: workflow.assetName,
          displayName: workflow.displayName,
          creatorPrincipalId: PRINCIPAL_ID,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          origin: { tenantId: TENANT_ID, direct: true },
        })),
      ),
    );
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json(
        DEFAULT_WORKFLOWS.map((_workflow, index) => ({
          definitionAssetId: `ast_${index}`,
          status: "deployed",
        })),
      ),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
        }),
      );

      // An already-seeded bench answers from the read alone — there is
      // nothing to converge, and the route starts no work of its own.
      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        kind: string;
        tenantSlug: string;
        deployed: string[];
        pending: string[];
      };
      expect(body.kind).toBe("ready");
      expect(body.tenantSlug).toBe(TENANT_SLUG);
      expect(body.deployed.sort()).toEqual(
        DEFAULT_WORKFLOWS.map((w) => w.assetName).sort(),
      );
      expect(body.pending).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("nothing live and no credential reports unseeded, not an error", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("unseeded");
    } finally {
      server.stop(true);
    }
  });

  test("a credential with nothing live reports provisioning, answered from the read alone", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    credentialsRoute(hub, { inferenceCredential: true });
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
        }),
      );

      const startedAt = Date.now();
      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });
      const elapsedMs = Date.now() - startedAt;

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        kind: string;
        tenantId: string;
        tenantSlug: string;
        setupAgentReady: boolean;
        deployed: string[];
        pending: string[];
        steps: { name: string; status: string }[];
      };
      expect(body).toEqual({
        kind: "provisioning",
        tenantId: TENANT_ID,
        tenantSlug: TENANT_SLUG,
        setupAgentReady: false,
        deployed: [],
        pending: DEFAULT_WORKFLOWS.map((w) => w.assetName),
        steps: expect.any(Array),
      });
      // The point of CL-6457, kept by CL-7586 and CL-8085: a credential
      // waiting on pins is not a licence to do the converge on the
      // request path. The client's needs-list convergence owns the
      // deploy from here — this route answers from the status read
      // alone, so it stays fast.
      expect(elapsedMs).toBeLessThan(1_000);
    } finally {
      server.stop(true);
    }
  });

  test("two overlapping calls both report provisioning and start no work", async () => {
    // Two "finish setup" requests racing (a double effect fire, a
    // retried fetch) used to be this route's sharpest edge, because
    // both would deploy. Post-CL-6457 the route deploys nothing at all,
    // so the only thing left to hold is that overlapping callers get
    // the same honest status and still start no work of their own. The
    // client's needs-list convergence owns the deploy from here (the
    // converge itself is covered where it lives, in
    // `./desired-state-reconcile.test.ts`).
    const hub = new Hono();
    credentialsRoute(hub, { inferenceCredential: true });
    // Deterministic overlap, not a race against real wall-clock
    // scheduling: `findPersonalTenant` is the first hub call each
    // `/complete-setup` request makes, so gating it on "both requests
    // have arrived" guarantees the two calls are genuinely in flight
    // together every run, rather than hoping `Promise.all` happens to
    // interleave that way under whatever load the machine is under.
    let arrivals = 0;
    let releaseArrivals: () => void = () => undefined;
    const bothArrived = new Promise<void>((resolve) => {
      releaseArrivals = resolve;
    });
    hub.get("/api/me/principals", async (c) => {
      arrivals += 1;
      if (arrivals >= 2) releaseArrivals();
      else await bothArrived;
      return c.json({
        data: [
          {
            principalId: PRINCIPAL_ID,
            tenantId: TENANT_ID,
            tenantName: "user_1's workbench",
            tenantSlug: TENANT_SLUG,
            kind: "user",
            status: "active",
            roles: [],
          },
        ],
        nextCursor: null,
      });
    });
    hub.get(`/api/tenants/${TENANT_ID}`, (c) =>
      c.json({
        id: TENANT_ID,
        name: "user_1's workbench",
        slug: TENANT_SLUG,
        domain: TENANT_DOMAIN,
        parentId: null,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      }),
    );
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
        }),
      );

      const [first, second] = await Promise.all([
        app.request("/api/onboarding/complete-setup", {
          method: "POST",
        }),
        app.request("/api/onboarding/complete-setup", {
          method: "POST",
        }),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = (await first.json()) as { kind: string };
      const secondBody = (await second.json()) as { kind: string };
      expect(firstBody.kind).toBe("provisioning");
      expect(secondBody.kind).toBe("provisioning");
    } finally {
      server.stop(true);
    }
  });

  // CL-6264, re-homed by CL-6457 and kept by CL-7586: a bench that got
  // partway through its workflows must read as still provisioning. The
  // convergence itself — deploying only what is missing on a later
  // pass — is covered by "a non-sidecar failure reports failed, and a
  // re-run can converge" in ./desired-state-reconcile.test.ts; the
  // deploy from here is the client's needs-list convergence (CL-8085),
  // not a server-side kick.
  //
  // CL-7074 narrowed DEFAULT_WORKFLOWS to just the setup agent, so
  // "partway through" no longer means "one of several live, the rest
  // pending" — it means the one default workflow's asset exists but
  // has not gone live yet (the sidecar push landed, the deploy
  // confirmation has not).
  test("a bench whose agent is not yet live reports provisioning for the client to converge", async () => {
    const liveWorkflow = DEFAULT_WORKFLOWS[0];
    if (liveWorkflow === undefined) {
      throw new Error("DEFAULT_WORKFLOWS is empty");
    }
    const hub = new Hono();
    principalsRoute(hub);
    credentialsRoute(hub, { inferenceCredential: true });
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) =>
      c.json(
        DEFAULT_WORKFLOWS.map((workflow, index) => ({
          id: `ast_${index}`,
          tenantId: TENANT_ID,
          kind: "workflow",
          name: workflow.assetName,
          displayName: workflow.displayName,
          creatorPrincipalId: PRINCIPAL_ID,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          origin: { tenantId: TENANT_ID, direct: true },
        })),
      ),
    );
    // The asset exists, but no deployment has gone live yet.
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        kind: string;
        tenantId: string;
        tenantSlug: string;
        setupAgentReady: boolean;
        deployed: string[];
        pending: string[];
        steps: { name: string; status: string }[];
      };
      expect(body).toEqual({
        kind: "provisioning",
        tenantId: TENANT_ID,
        tenantSlug: TENANT_SLUG,
        setupAgentReady: false,
        deployed: [],
        pending: [liveWorkflow.assetName],
        steps: expect.any(Array),
      });

      // Not finished yet — the waiting surface keeps polling this
      // status while the client's needs-list convergence finishes it.
    } finally {
      server.stop(true);
    }
  });
});
