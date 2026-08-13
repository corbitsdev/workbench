// The connect routes' contract with the browser: /start parks a
// single-use state in an HttpOnly cookie and sends the user to
// OpenRouter's consent page with a real S256 challenge over a
// hub-origin callback URL; /callback only ever exchanges a code whose
// state round-tripped intact, and every ending — minted key seeded,
// state gone stale, exchange refused — lands back in the wizard as
// query parameters with no key material in any URL.
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createOnboardingRoutes } from "../src/routes";
import type { CreateOnboardingRoutesDeps } from "../src/routes";
import { s256Challenge } from "../src/openrouter-connect";

// The signed-in user is read per request from a mutable session, so a
// test can swap identities mid-flow — the cross-user callback guarantee
// has to be pinned at the HTTP layer, not only in the state store.
function asUser(session: { userId: string }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("user", {
      id: session.userId,
      email: `${session.userId}@example.com`,
    } as never);
    await next();
  };
}

function mountAuthenticated(
  routes: Hono<AppEnv>,
  session: { userId: string },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", asUser(session));
  app.route("/api/onboarding", routes);
  return app;
}

function connectRoutes(
  overrides: Partial<CreateOnboardingRoutesDeps> = {},
  session: { userId: string } = { userId: "user_1" },
): Hono<AppEnv> {
  const deps: CreateOnboardingRoutesDeps = {
    hubUrl: overrides.hubUrl ?? "https://bench.example.com",
    pushWorkflow: overrides.pushWorkflow ?? (async () => "pushed"),
    log: overrides.log ?? (() => undefined),
  };
  if (overrides.openrouterConnect !== undefined)
    deps.openrouterConnect = overrides.openrouterConnect;
  return mountAuthenticated(createOnboardingRoutes(deps), session);
}

function stateCookie(startResponse: Response): string {
  const setCookie = startResponse.headers.get("set-cookie") ?? "";
  const match = /workbench_openrouter_connect=([^;]+)/.exec(setCookie);
  if (!match?.[1]) throw new Error(`no state cookie in: ${setCookie}`);
  return `workbench_openrouter_connect=${match[1]}`;
}

async function startConnect(app: Hono<AppEnv>) {
  const response = await app.request("/api/onboarding/oauth/openrouter/start");
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  return { response, location };
}

describe("GET /oauth/openrouter/start", () => {
  test("redirects to OpenRouter with an S256 challenge and the hub-origin callback", async () => {
    const app = connectRoutes({ hubUrl: "https://bench.example.com" });

    const { response, location } = await startConnect(app);

    expect(location.origin).toBe("https://openrouter.ai");
    expect(location.pathname).toBe("/auth");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(location.searchParams.get("callback_url")).toBe(
      "https://bench.example.com/api/onboarding/oauth/openrouter/callback",
    );
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("workbench_openrouter_connect=");
    expect(setCookie).toContain("HttpOnly");
  });

  test("derives the callback origin from configuration, not the request host", async () => {
    const app = connectRoutes({ hubUrl: "http://localhost:3000" });

    const { location } = await startConnect(app);

    expect(location.searchParams.get("callback_url")).toBe(
      "http://localhost:3000/api/onboarding/oauth/openrouter/callback",
    );
  });

  test("rapid connect starts from the same user are rate-limited", async () => {
    const app = connectRoutes();

    await startConnect(app);
    const second = await app.request("/api/onboarding/oauth/openrouter/start");

    expect(second.status).toBe(302);
    const redirect = new URL(
      second.headers.get("location") ?? "",
      "https://bench.example.com",
    );
    expect(redirect.pathname).toBe("/onboarding");
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("rate_limited");
    // A rate-limited start parks nothing: no state cookie is set.
    expect(second.headers.get("set-cookie")).toBeNull();
  });
});

describe("GET /oauth/openrouter/callback", () => {
  test("happy path: exchanges the code with the verifier behind the challenge, seeds, and reports success", async () => {
    const exchanges: { code: string; codeVerifier: string }[] = [];
    const completions: {
      provider: string;
      apiKey: string;
      userId: string;
    }[] = [];
    const app = connectRoutes({
      openrouterConnect: {
        exchange: async ({ code, codeVerifier }) => {
          exchanges.push({ code, codeVerifier });
          return { ok: true, key: "sk-or-v1-minted" };
        },
        completeSetup: async (args) => {
          completions.push({
            provider: args.provider,
            apiKey: args.apiKey,
            userId: args.userId,
          });
          return {
            kind: "seeded",
            tenantId: "ten_1",
            tenantSlug: "alice-user1",
            workflows: ["echo", "assistant"],
          };
        },
      },
    });

    const { response: started, location } = await startConnect(app);
    const cookie = stateCookie(started);

    const response = await app.request(
      "/api/onboarding/oauth/openrouter/callback?code=auth_code_1",
      { headers: { cookie } },
    );

    expect(response.status).toBe(302);
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://bench.example.com",
    );
    expect(redirect.pathname).toBe("/onboarding");
    expect(redirect.searchParams.get("connect")).toBe("openrouter");
    expect(redirect.searchParams.get("outcome")).toBe("seeded");
    expect(redirect.searchParams.get("tenantSlug")).toBe("alice-user1");
    expect(redirect.searchParams.get("workflows")).toBe("echo,assistant");
    // The minted key reaches the completion path but never a URL.
    expect(redirect.toString()).not.toContain("sk-or-v1-minted");

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.code).toBe("auth_code_1");
    // The verifier handed to the exchange is the one whose S256 was
    // sent to OpenRouter at /start — the round trip is real PKCE.
    expect(
      exchanges[0] && (await s256Challenge(exchanges[0].codeVerifier)),
    ).toBe(location.searchParams.get("code_challenge") ?? "");

    // The minted key completes as an ordinary openrouter credential —
    // the same generalized path a pasted key takes.
    expect(completions).toEqual([
      { provider: "openrouter", apiKey: "sk-or-v1-minted", userId: "user_1" },
    ]);
  });

  test("a callback without the state cookie never exchanges", async () => {
    let exchanged = 0;
    const app = connectRoutes({
      openrouterConnect: {
        exchange: async () => {
          exchanged += 1;
          return { ok: true, key: "sk-or-v1-minted" };
        },
      },
    });
    await startConnect(app);

    const response = await app.request(
      "/api/onboarding/oauth/openrouter/callback?code=auth_code_1",
    );

    expect(response.status).toBe(302);
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://bench.example.com",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("state_expired");
    expect(exchanged).toBe(0);
  });

  test("another user's session cannot redeem a stolen state cookie", async () => {
    // Login-CSRF guard: an attacker who lures a victim into finishing
    // the attacker's own flow (or replays a leaked cookie) must never
    // get a key exchanged or a bench seeded under the wrong session.
    let exchanged = 0;
    let completed = 0;
    const session = { userId: "user_1" };
    const app = connectRoutes(
      {
        openrouterConnect: {
          exchange: async () => {
            exchanged += 1;
            return { ok: true, key: "sk-or-v1-minted" };
          },
          completeSetup: async () => {
            completed += 1;
            return {
              kind: "seeded",
              tenantId: "ten_1",
              tenantSlug: "alice-user1",
              workflows: ["echo"],
            };
          },
        },
      },
      session,
    );
    const { response: started } = await startConnect(app);
    const cookie = stateCookie(started);

    session.userId = "user_2";
    const response = await app.request(
      "/api/onboarding/oauth/openrouter/callback?code=auth_code_1",
      { headers: { cookie } },
    );

    expect(response.status).toBe(302);
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("state_expired");
    expect(exchanged).toBe(0);
    expect(completed).toBe(0);
  });

  test("a state is single-use: replaying the callback fails", async () => {
    const app = connectRoutes({
      openrouterConnect: {
        exchange: async () => ({ ok: true, key: "sk-or-v1-minted" }),
        completeSetup: async () => ({
          kind: "seeded",
          tenantId: "ten_1",
          tenantSlug: "alice-user1",
          workflows: ["echo"],
        }),
      },
    });
    const { response: started } = await startConnect(app);
    const cookie = stateCookie(started);
    const path = "/api/onboarding/oauth/openrouter/callback?code=auth_code_1";

    const first = await app.request(path, { headers: { cookie } });
    const second = await app.request(path, { headers: { cookie } });

    expect(
      new URL(
        first.headers.get("location") ?? "",
        "https://x",
      ).searchParams.get("outcome"),
    ).toBe("seeded");
    expect(
      new URL(
        second.headers.get("location") ?? "",
        "https://x",
      ).searchParams.get("code"),
    ).toBe("state_expired");
  });

  test("an exchange failure is reported as such and never reaches setup", async () => {
    let completed = 0;
    const lines: string[] = [];
    const app = connectRoutes({
      log: (line) => lines.push(line),
      openrouterConnect: {
        exchange: async () => ({
          ok: false,
          message: "OpenRouter rejected the code exchange with status 403",
        }),
        completeSetup: async () => {
          completed += 1;
          return {
            kind: "seeded",
            tenantId: "ten_1",
            tenantSlug: "alice-user1",
            workflows: ["echo"],
          };
        },
      },
    });
    const { response: started } = await startConnect(app);

    const response = await app.request(
      "/api/onboarding/oauth/openrouter/callback?code=expired_code",
      { headers: { cookie: stateCookie(started) } },
    );

    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("exchange_failed");
    expect(completed).toBe(0);
    expect(lines.some((line) => line.includes("code exchange failed"))).toBe(
      true,
    );
  });

  test("a minted key that fails its probe is a key_rejected ending, not a success", async () => {
    const app = connectRoutes({
      openrouterConnect: {
        exchange: async () => ({ ok: true, key: "sk-or-v1-minted" }),
        completeSetup: async () => ({
          kind: "invalid-credential",
          message: "invalid api key",
        }),
      },
    });
    const { response: started } = await startConnect(app);

    const response = await app.request(
      "/api/onboarding/oauth/openrouter/callback?code=auth_code_1",
      { headers: { cookie: stateCookie(started) } },
    );

    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("key_rejected");
  });

  test("a thrown setup failure surfaces honestly without leaking the key", async () => {
    const lines: string[] = [];
    const app = connectRoutes({
      log: (line) => lines.push(line),
      openrouterConnect: {
        exchange: async () => ({ ok: true, key: "sk-or-v1-minted" }),
        completeSetup: async () => {
          throw new Error("the hub rejected the deployment");
        },
      },
    });
    const { response: started } = await startConnect(app);

    const response = await app.request(
      "/api/onboarding/oauth/openrouter/callback?code=auth_code_1",
      { headers: { cookie: stateCookie(started) } },
    );

    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("code")).toBe("setup_failed");
    expect(lines.join("\n")).not.toContain("sk-or-v1-minted");
  });
});
