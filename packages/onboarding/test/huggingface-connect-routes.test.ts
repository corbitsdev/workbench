// The Hugging Face connect routes' contract with the browser: /start
// parks a single-use state in an HttpOnly cookie and sends the user to
// HF's consent page with a real S256 challenge, a client id, and the
// requested scope; /callback only ever exchanges a code whose state
// round-tripped intact (both in the cookie and echoed back in the
// query string — HF, unlike OpenRouter, supports `state`), and every
// ending lands back in the wizard as query parameters with no token
// material in any URL. Cross-user/replay/single-use guarantees mirror
// `openrouter-connect-routes.test.ts`'s coverage for the same shape.
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createOnboardingRoutes } from "../src/routes";
import type { CreateOnboardingRoutesDeps } from "../src/routes";
import { s256Challenge } from "../src/pkce";

// Stands in for a stable `CREDENTIAL_ENCRYPTION_KEY`: a fresh cipher
// built from these same bytes is indistinguishable, to the state store,
// from the cipher a still-running process already had — which is
// exactly what a restart needs to be true.
const RESTART_STABLE_KEY = Buffer.alloc(32, 5);

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
  overrides: Partial<CreateOnboardingRoutesDeps> & {
    readonly omitClientId?: boolean;
  } = {},
  session: { userId: string } = { userId: "user_1" },
): Hono<AppEnv> {
  const deps: CreateOnboardingRoutesDeps = {
    hubUrl: overrides.hubUrl ?? "https://bench.example.com",
    pushWorkflow: overrides.pushWorkflow ?? (async () => "pushed"),
    log: overrides.log ?? (() => undefined),
  };
  if (overrides.omitClientId !== true) {
    deps.huggingfaceClientId = overrides.huggingfaceClientId ?? "hf_client_1";
  }
  if (overrides.huggingfaceConnect !== undefined)
    deps.huggingfaceConnect = overrides.huggingfaceConnect;
  if (overrides.credentialCipher !== undefined)
    deps.credentialCipher = overrides.credentialCipher;
  return mountAuthenticated(createOnboardingRoutes(deps), session);
}

function stateCookie(startResponse: Response): string {
  const setCookie = startResponse.headers.get("set-cookie") ?? "";
  const match = /workbench_huggingface_connect=([^;]+)/.exec(setCookie);
  if (!match?.[1]) throw new Error(`no state cookie in: ${setCookie}`);
  return `workbench_huggingface_connect=${match[1]}`;
}

async function startConnect(app: Hono<AppEnv>) {
  const response = await app.request("/api/onboarding/oauth/huggingface/start");
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  return { response, location };
}

describe("GET /oauth/huggingface/start", () => {
  test("redirects to Hugging Face with an S256 challenge, client id, scope, and echoed state", async () => {
    const app = connectRoutes({ hubUrl: "https://bench.example.com" });

    const { response, location } = await startConnect(app);

    expect(location.origin).toBe("https://huggingface.co");
    expect(location.pathname).toBe("/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("hf_client_1");
    expect(location.searchParams.get("scope")).toBe("openid inference-api");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://bench.example.com/api/onboarding/oauth/huggingface/callback",
    );
    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();
    const setCookie = response.headers.get("set-cookie") ?? "";
    // The state cookie carries the sealed state as its value; Hono
    // percent-encodes it in `Set-Cookie`, so compare decoded rather than
    // as a raw substring.
    const cookieMatch = /workbench_huggingface_connect=([^;]+)/.exec(setCookie);
    expect(
      cookieMatch?.[1] !== undefined
        ? decodeURIComponent(cookieMatch[1])
        : undefined,
    ).toBe(state ?? undefined);
    expect(setCookie).toContain("HttpOnly");
  });

  test("without a configured client id, the flow reports not_configured and parks nothing", async () => {
    const app = connectRoutes({ omitClientId: true });

    const response = await app.request(
      "/api/onboarding/oauth/huggingface/start",
    );

    expect(response.status).toBe(302);
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("connect")).toBe("huggingface");
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("not_configured");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("rapid connect starts from the same user are rate-limited", async () => {
    const app = connectRoutes();

    await startConnect(app);
    const second = await app.request("/api/onboarding/oauth/huggingface/start");

    expect(second.status).toBe(302);
    const redirect = new URL(
      second.headers.get("location") ?? "",
      "https://bench.example.com",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("rate_limited");
  });
});

describe("GET /oauth/huggingface/callback", () => {
  test("happy path: exchanges the code with the verifier behind the challenge, seeds with expiry metadata, and reports success", async () => {
    const exchanges: {
      code: string;
      codeVerifier: string;
      redirectUri: string;
      clientId: string;
    }[] = [];
    const completions: {
      provider: string;
      apiKey: string;
      userId: string;
      credentialMetadata?: Record<string, unknown>;
    }[] = [];
    const app = connectRoutes({
      huggingfaceConnect: {
        exchange: async ({ code, codeVerifier, redirectUri, clientId }) => {
          exchanges.push({ code, codeVerifier, redirectUri, clientId });
          return {
            ok: true,
            accessToken: "hf_oauth_minted",
            expiresAt: "2026-08-13T20:00:00.000Z",
          };
        },
        completeSetup: async (args) => {
          completions.push({
            provider: args.provider,
            apiKey: args.apiKey,
            userId: args.userId,
            ...(args.credentialMetadata !== undefined
              ? { credentialMetadata: args.credentialMetadata }
              : {}),
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
    const state = location.searchParams.get("state") ?? "";

    const response = await app.request(
      `/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    );

    expect(response.status).toBe(302);
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://bench.example.com",
    );
    expect(redirect.pathname).toBe("/onboarding");
    expect(redirect.searchParams.get("connect")).toBe("huggingface");
    expect(redirect.searchParams.get("outcome")).toBe("seeded");
    expect(redirect.searchParams.get("tenantSlug")).toBe("alice-user1");
    expect(redirect.searchParams.get("workflows")).toBe("echo,assistant");
    // The minted token reaches the completion path but never a URL.
    expect(redirect.toString()).not.toContain("hf_oauth_minted");

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.code).toBe("auth_code_1");
    expect(exchanges[0]?.clientId).toBe("hf_client_1");
    expect(exchanges[0]?.redirectUri).toBe(
      "https://bench.example.com/api/onboarding/oauth/huggingface/callback",
    );
    expect(
      exchanges[0] && (await s256Challenge(exchanges[0].codeVerifier)),
    ).toBe(location.searchParams.get("code_challenge") ?? "");

    expect(completions).toEqual([
      {
        provider: "huggingface",
        apiKey: "hf_oauth_minted",
        userId: "user_1",
        credentialMetadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
      },
    ]);
  });

  test("a callback whose query state disagrees with the cookie never exchanges", async () => {
    let exchanged = 0;
    const app = connectRoutes({
      huggingfaceConnect: {
        exchange: async () => {
          exchanged += 1;
          return { ok: true, accessToken: "hf_oauth_minted" };
        },
      },
    });
    const { response: started } = await startConnect(app);
    const cookie = stateCookie(started);

    const response = await app.request(
      "/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=not-the-real-state",
      { headers: { cookie } },
    );

    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("state_expired");
    expect(exchanged).toBe(0);
  });

  test("another user's session cannot redeem a stolen state cookie", async () => {
    let exchanged = 0;
    let completed = 0;
    const session = { userId: "user_1" };
    const app = connectRoutes(
      {
        huggingfaceConnect: {
          exchange: async () => {
            exchanged += 1;
            return { ok: true, accessToken: "hf_oauth_minted" };
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
    const { response: started, location } = await startConnect(app);
    const cookie = stateCookie(started);
    const state = location.searchParams.get("state") ?? "";

    session.userId = "user_2";
    const response = await app.request(
      `/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    );

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
      huggingfaceConnect: {
        exchange: async () => ({ ok: true, accessToken: "hf_oauth_minted" }),
        completeSetup: async () => ({
          kind: "seeded",
          tenantId: "ten_1",
          tenantSlug: "alice-user1",
          workflows: ["echo"],
        }),
      },
    });
    const { response: started, location } = await startConnect(app);
    const cookie = stateCookie(started);
    const state = location.searchParams.get("state") ?? "";
    const path = `/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=${encodeURIComponent(state)}`;

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

  test("survives a hub restart between /start and /callback, and still enforces single-use after it", async () => {
    // /start runs against the pre-restart app; a fresh app (a new
    // `createOnboardingRoutes` call, a fresh in-memory state store, the
    // works) stands in for the process that comes back up after a
    // restart. The only thing they share is the cipher key — exactly
    // what a stable `CREDENTIAL_ENCRYPTION_KEY` gives a real restart.
    const beforeRestart = connectRoutes({
      credentialCipher: createEnvKeyCredentialCipher(RESTART_STABLE_KEY),
    });
    const { response: started, location } = await startConnect(beforeRestart);
    const cookie = stateCookie(started);
    const state = location.searchParams.get("state") ?? "";

    const afterRestart = connectRoutes({
      credentialCipher: createEnvKeyCredentialCipher(RESTART_STABLE_KEY),
      huggingfaceConnect: {
        exchange: async () => ({ ok: true, accessToken: "hf_oauth_minted" }),
        completeSetup: async () => ({
          kind: "seeded",
          tenantId: "ten_1",
          tenantSlug: "alice-user1",
          workflows: ["echo"],
        }),
      },
    });
    const path = `/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=${encodeURIComponent(state)}`;

    const first = await afterRestart.request(path, { headers: { cookie } });
    expect(
      new URL(
        first.headers.get("location") ?? "",
        "https://x",
      ).searchParams.get("outcome"),
    ).toBe("seeded");

    // Replaying the same cookie and query state against the
    // post-restart app — no new /start — must fail even though nothing
    // here remembers the pre-restart process at all.
    const replay = await afterRestart.request(path, { headers: { cookie } });
    expect(
      new URL(
        replay.headers.get("location") ?? "",
        "https://x",
      ).searchParams.get("code"),
    ).toBe("state_expired");
  });

  test("an exchange failure is reported as such and never reaches setup", async () => {
    let completed = 0;
    const lines: string[] = [];
    const app = connectRoutes({
      log: (line) => lines.push(line),
      huggingfaceConnect: {
        exchange: async () => ({
          ok: false,
          message: "Hugging Face rejected the code exchange with status 400",
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
    const { response: started, location } = await startConnect(app);
    const state = location.searchParams.get("state") ?? "";

    const response = await app.request(
      `/api/onboarding/oauth/huggingface/callback?code=expired_code&state=${encodeURIComponent(state)}`,
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

  test("a minted token that fails its probe is a key_rejected ending, not a success", async () => {
    const app = connectRoutes({
      huggingfaceConnect: {
        exchange: async () => ({ ok: true, accessToken: "hf_oauth_minted" }),
        completeSetup: async () => ({
          kind: "invalid-credential",
          message: "invalid token",
        }),
      },
    });
    const { response: started, location } = await startConnect(app);
    const state = location.searchParams.get("state") ?? "";

    const response = await app.request(
      `/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=${encodeURIComponent(state)}`,
      { headers: { cookie: stateCookie(started) } },
    );

    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("key_rejected");
  });

  test("a thrown setup failure surfaces honestly without leaking the token", async () => {
    const lines: string[] = [];
    const app = connectRoutes({
      log: (line) => lines.push(line),
      huggingfaceConnect: {
        exchange: async () => ({ ok: true, accessToken: "hf_oauth_minted" }),
        completeSetup: async () => {
          throw new Error("the hub rejected the deployment");
        },
      },
    });
    const { response: started, location } = await startConnect(app);
    const state = location.searchParams.get("state") ?? "";

    const response = await app.request(
      `/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=${encodeURIComponent(state)}`,
      { headers: { cookie: stateCookie(started) } },
    );

    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("code")).toBe("setup_failed");
    expect(lines.join("\n")).not.toContain("hf_oauth_minted");
  });
});
