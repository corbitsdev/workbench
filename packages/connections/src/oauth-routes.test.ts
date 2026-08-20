// Route-level tests for the generic oauth-pkce mechanics, exercised
// against a fake connector descriptor rather than the real OpenRouter/
// Hugging Face entries — those two are proven end to end by
// `packages/onboarding`'s own route tests, which mount this factory
// through `createOnboardingRoutes`. This suite proves the mechanics
// themselves: state sealing/consuming, PKCE round-tripping, the
// returnPath cookie, not_configured, rate limiting, and duplicate-
// callback recovery — all driven purely off `ConnectorDescriptor.oauth`.
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createNoopCredentialCipher } from "@intx/crypto";
import {
  createOAuthConnectRoutes,
  DEFAULT_RETURN_PATH_ALLOWLIST,
  sanitizeReturnPath,
} from "./oauth-routes";
import type { CreateOAuthConnectRoutesDeps } from "./oauth-routes";
import type { ConnectorDescriptor } from "./descriptor";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The exact payloads a live reviewer reproduced an open redirect with,
 * plus one that should keep working. Shared between the unit tests
 * below and the route-level regression tests, so the two never drift
 * out of sync with each other. */
const MALICIOUS_RETURN_PATHS: readonly { name: string; value: string }[] = [
  { name: "absolute off-origin URL", value: "https://evil.com" },
  { name: "protocol-relative", value: "//evil.com" },
  {
    name: "backslash smuggling a protocol-relative target",
    value: "/\\evil.com",
  },
  { name: "double-encoded protocol-relative", value: "%2F%2Fevil.com" },
  { name: "CR/LF injection", value: "/onboarding\r\nSet-Cookie: pwned=1" },
  { name: "off-allowlist same-origin path", value: "/admin" },
];

function fakeDescriptor(
  overrides: Partial<ConnectorDescriptor["oauth"]> = {},
): ConnectorDescriptor {
  return {
    id: "widget",
    displayName: "Widget",
    authKind: "oauth-pkce",
    docsUrl: "https://widget.example.com",
    credentialPlugin: "http",
    feedsTools: [],
    oauth: {
      authorizeUrl: "https://widget.example.com/authorize",
      usesPKCE: true,
      echoesState: false,
      deploysDefaultWorkflows: false,
      buildAuthorizeUrl: ({ callbackUrl, codeChallenge }) => {
        const url = new URL("https://widget.example.com/authorize");
        url.searchParams.set("redirect_uri", callbackUrl);
        if (codeChallenge !== undefined) {
          url.searchParams.set("code_challenge", codeChallenge);
        }
        return url;
      },
      exchange: async ({ code }) => ({ ok: true, apiKey: `key-for-${code}` }),
      ...overrides,
    },
  };
}

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
  session: { userId: string } = { userId: "user_1" },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", asUser(session));
  app.route("/api/connections/oauth", routes);
  return app;
}

function connectRoutes(
  overrides: Partial<CreateOAuthConnectRoutesDeps> = {},
  registry: Readonly<Record<string, ConnectorDescriptor>> = {
    widget: fakeDescriptor(),
  },
): Hono<AppEnv> {
  const deps: Mutable<CreateOAuthConnectRoutesDeps> = {
    hubUrl: overrides.hubUrl ?? "https://bench.example.com",
    log: overrides.log ?? (() => undefined),
    credentialCipher:
      overrides.credentialCipher ?? createNoopCredentialCipher(),
    registry: overrides.registry ?? registry,
    connectCredential:
      overrides.connectCredential ??
      (async () => ({
        kind: "connected",
        tenantId: "ten_1",
        tenantSlug: "widget-tenant",
        principalId: "prn_1",
        tenantDomain: "widget-tenant.bench.local",
      })),
  };
  if (overrides.oauthEnv !== undefined) deps.oauthEnv = overrides.oauthEnv;
  if (overrides.recentlyConnected !== undefined)
    deps.recentlyConnected = overrides.recentlyConnected;
  if (overrides.afterConnected !== undefined)
    deps.afterConnected = overrides.afterConnected;
  if (overrides.defaultReturnPath !== undefined)
    deps.defaultReturnPath = overrides.defaultReturnPath;
  return mountAuthenticated(createOAuthConnectRoutes(deps));
}

function allCookies(startResponse: Response): string {
  // Multiple `set-cookie` headers collapse to one string when read via
  // `.get`; tests that need both the state and return cookie build the
  // combined `cookie` header from `getSetCookie` instead.
  return startResponse.headers
    .getSetCookie()
    .map((sc) => sc.split(";")[0])
    .join("; ");
}

async function startConnect(app: Hono<AppEnv>, query = "") {
  const response = await app.request(
    `/api/connections/oauth/widget/start${query}`,
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  return { response, location };
}

describe("sanitizeReturnPath", () => {
  const defaultReturnPath = "/onboarding";
  const allowlist = DEFAULT_RETURN_PATH_ALLOWLIST;

  test("falls back to the default when no value was given", () => {
    expect(sanitizeReturnPath(undefined, defaultReturnPath, allowlist)).toBe(
      defaultReturnPath,
    );
    expect(sanitizeReturnPath("", defaultReturnPath, allowlist)).toBe(
      defaultReturnPath,
    );
  });

  test("passes through a legitimate, allowlisted path", () => {
    expect(
      sanitizeReturnPath("/settings/connections", defaultReturnPath, allowlist),
    ).toBe("/settings/connections");
    expect(
      sanitizeReturnPath("/onboarding", defaultReturnPath, allowlist),
    ).toBe("/onboarding");
  });

  for (const { name, value } of MALICIOUS_RETURN_PATHS) {
    test(`falls back to the default on ${name} (${JSON.stringify(value)})`, () => {
      expect(sanitizeReturnPath(value, defaultReturnPath, allowlist)).toBe(
        defaultReturnPath,
      );
    });
  }

  test("a value that only matches the allowlist after decoding is still honored", () => {
    expect(
      sanitizeReturnPath(
        "%2Fsettings%2Fconnections",
        defaultReturnPath,
        allowlist,
      ),
    ).toBe("/settings/connections");
  });
});

describe("GET /:connectorId/start", () => {
  test("404s an unknown connector", async () => {
    const app = connectRoutes();
    const response = await app.request("/api/connections/oauth/nope/start");
    expect(response.status).toBe(404);
  });

  test("redirects to the connector's authorize URL with a PKCE challenge", async () => {
    const app = connectRoutes();
    const { location, response } = await startConnect(app);

    expect(location.origin).toBe("https://widget.example.com");
    expect(location.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://bench.example.com/api/connections/oauth/widget/callback",
    );
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("workbench_widget_connect=");
  });

  test("carries the ?return= path across to the callback redirect via a second cookie", async () => {
    const app = connectRoutes();
    const { response } = await startConnect(
      app,
      "?return=%2Fsettings%2Fconnections",
    );

    const setCookie = response.headers.getSetCookie().join("; ");
    expect(setCookie).toContain("workbench_widget_connect_return=");
  });

  test("an unsigned-in caller is redirected with signed_out, no cookie set", async () => {
    const app = new Hono<AppEnv>();
    app.route(
      "/api/connections/oauth",
      createOAuthConnectRoutes({
        hubUrl: "https://bench.example.com",
        log: () => undefined,
        credentialCipher: createNoopCredentialCipher(),
        registry: { widget: fakeDescriptor() },
        connectCredential: async () => ({
          kind: "connected",
          tenantId: "t",
          tenantSlug: "t",
          principalId: "p",
          tenantDomain: "t.local",
        }),
      }),
    );

    const response = await app.request("/api/connections/oauth/widget/start");
    expect(response.status).toBe(302);
    const location = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(location.searchParams.get("code")).toBe("signed_out");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("a connector requiring an unset client id reports not_configured and parks nothing", async () => {
    const app = connectRoutes(
      {},
      {
        widget: fakeDescriptor({ clientId: (env) => env["widgetClientId"] }),
      },
    );

    const response = await app.request("/api/connections/oauth/widget/start");
    const location = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(location.searchParams.get("code")).toBe("not_configured");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("rapid starts from the same user are rate-limited", async () => {
    const app = connectRoutes();
    await startConnect(app);
    const second = await app.request("/api/connections/oauth/widget/start");
    const location = new URL(second.headers.get("location") ?? "", "https://x");
    expect(location.searchParams.get("code")).toBe("rate_limited");
  });

  describe("open-redirect regression: every early exit sanitizes ?return= before building a Location", () => {
    function maliciousQuery(value: string): string {
      return `?${new URLSearchParams({ return: value }).toString()}`;
    }

    for (const { name, value } of MALICIOUS_RETURN_PATHS) {
      test(`signed_out never redirects off-origin (${name})`, async () => {
        const app = new Hono<AppEnv>();
        app.route(
          "/api/connections/oauth",
          createOAuthConnectRoutes({
            hubUrl: "https://bench.example.com",
            log: () => undefined,
            credentialCipher: createNoopCredentialCipher(),
            registry: { widget: fakeDescriptor() },
            connectCredential: async () => ({
              kind: "connected",
              tenantId: "t",
              tenantSlug: "t",
              principalId: "p",
              tenantDomain: "t.local",
            }),
          }),
        );

        const response = await app.request(
          `/api/connections/oauth/widget/start${maliciousQuery(value)}`,
        );
        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(location.startsWith("/onboarding?")).toBe(true);
        const parsed = new URL(location, "https://bench.example.com");
        expect(parsed.origin).toBe("https://bench.example.com");
        expect(parsed.searchParams.get("code")).toBe("signed_out");
      });

      test(`not_configured never redirects off-origin (${name})`, async () => {
        const app = connectRoutes(
          {},
          {
            widget: fakeDescriptor({
              clientId: (env) => env["widgetClientId"],
            }),
          },
        );

        const response = await app.request(
          `/api/connections/oauth/widget/start${maliciousQuery(value)}`,
        );
        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(location.startsWith("/onboarding?")).toBe(true);
        const parsed = new URL(location, "https://bench.example.com");
        expect(parsed.origin).toBe("https://bench.example.com");
        expect(parsed.searchParams.get("code")).toBe("not_configured");
      });

      test(`rate_limited never redirects off-origin (${name})`, async () => {
        const app = connectRoutes();
        await startConnect(app);
        const response = await app.request(
          `/api/connections/oauth/widget/start${maliciousQuery(value)}`,
        );
        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(location.startsWith("/onboarding?")).toBe(true);
        const parsed = new URL(location, "https://bench.example.com");
        expect(parsed.origin).toBe("https://bench.example.com");
        expect(parsed.searchParams.get("code")).toBe("rate_limited");
      });
    }

    test("a legitimate, allowlisted ?return= still round-trips through the same early-exit path", async () => {
      const app = new Hono<AppEnv>();
      app.route(
        "/api/connections/oauth",
        createOAuthConnectRoutes({
          hubUrl: "https://bench.example.com",
          log: () => undefined,
          credentialCipher: createNoopCredentialCipher(),
          registry: { widget: fakeDescriptor() },
          connectCredential: async () => ({
            kind: "connected",
            tenantId: "t",
            tenantSlug: "t",
            principalId: "p",
            tenantDomain: "t.local",
          }),
        }),
      );

      const response = await app.request(
        `/api/connections/oauth/widget/start${maliciousQuery("/settings/connections")}`,
      );
      const location = response.headers.get("location") ?? "";
      expect(location.startsWith("/settings/connections?")).toBe(true);
    });
  });
});

describe("GET /:connectorId/callback", () => {
  test("happy path: exchanges the code, stores the credential, and honors the returnPath", async () => {
    const stored: { apiKey: string; connectorId: string }[] = [];
    const app = connectRoutes({
      connectCredential: async (args) => {
        stored.push({ apiKey: args.apiKey, connectorId: args.connectorId });
        return {
          kind: "connected",
          tenantId: "ten_1",
          tenantSlug: "widget-tenant",
          principalId: "prn_1",
          tenantDomain: "widget-tenant.bench.local",
        };
      },
    });
    const { response: started } = await startConnect(
      app,
      "?return=%2Fsettings%2Fconnections",
    );
    const cookie = allCookies(started);

    const response = await app.request(
      "/api/connections/oauth/widget/callback?code=abc123",
      { headers: { cookie } },
    );

    expect(response.status).toBe(302);
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.pathname).toBe("/settings/connections");
    expect(redirect.searchParams.get("connect")).toBe("widget");
    expect(redirect.searchParams.get("outcome")).toBe("connected");
    expect(stored).toEqual([
      { apiKey: "key-for-abc123", connectorId: "widget" },
    ]);
  });

  test("falls back to the default return path when none was requested", async () => {
    const app = connectRoutes();
    const { response: started } = await startConnect(app);
    const cookie = allCookies(started);

    const response = await app.request(
      "/api/connections/oauth/widget/callback?code=abc123",
      { headers: { cookie } },
    );

    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.pathname).toBe("/onboarding");
  });

  test("missing the state cookie never exchanges", async () => {
    let exchanged = 0;
    const app = connectRoutes(
      {},
      {
        widget: fakeDescriptor({
          exchange: async ({ code }) => {
            exchanged += 1;
            return { ok: true, apiKey: `key-for-${code}` };
          },
        }),
      },
    );

    const response = await app.request(
      "/api/connections/oauth/widget/callback?code=abc123",
    );
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("code")).toBe("state_expired");
    expect(exchanged).toBe(0);
  });

  test("a callback whose echoed state disagrees with the cookie never exchanges, for an echoesState connector", async () => {
    let exchanged = 0;
    const app = connectRoutes(
      {},
      {
        widget: fakeDescriptor({
          echoesState: true,
          exchange: async ({ code }) => {
            exchanged += 1;
            return { ok: true, apiKey: `key-for-${code}` };
          },
        }),
      },
    );
    const { response: started } = await startConnect(app);
    const cookie = allCookies(started);

    const response = await app.request(
      "/api/connections/oauth/widget/callback?code=abc123&state=not-the-real-state",
      { headers: { cookie } },
    );
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("code")).toBe("state_expired");
    expect(exchanged).toBe(0);
  });

  test("another user's session cannot redeem a stolen state cookie", async () => {
    let exchanged = 0;
    const session = { userId: "user_1" };
    const app = mountAuthenticated(
      createOAuthConnectRoutes({
        hubUrl: "https://bench.example.com",
        log: () => undefined,
        credentialCipher: createNoopCredentialCipher(),
        registry: {
          widget: fakeDescriptor({
            exchange: async ({ code }) => {
              exchanged += 1;
              return { ok: true, apiKey: `key-for-${code}` };
            },
          }),
        },
        connectCredential: async () => ({
          kind: "connected",
          tenantId: "t",
          tenantSlug: "t",
          principalId: "p",
          tenantDomain: "t.local",
        }),
      }),
      session,
    );
    const { response: started } = await startConnect(app);
    const cookie = allCookies(started);

    session.userId = "user_2";
    const response = await app.request(
      "/api/connections/oauth/widget/callback?code=abc123",
      { headers: { cookie } },
    );
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("code")).toBe("state_expired");
    expect(exchanged).toBe(0);
  });

  test("a duplicate callback recovers as connected via the injected recovery hook", async () => {
    let recoveryCalls = 0;
    const app = connectRoutes({
      recentlyConnected: async () => {
        recoveryCalls += 1;
        return { tenantSlug: "widget-tenant" };
      },
    });
    const { response: started } = await startConnect(app);
    const cookie = allCookies(started);
    const path = "/api/connections/oauth/widget/callback?code=abc123";

    const first = await app.request(path, { headers: { cookie } });
    const second = await app.request(path, { headers: { cookie } });

    expect(
      new URL(
        first.headers.get("location") ?? "",
        "https://x",
      ).searchParams.get("outcome"),
    ).toBe("connected");
    expect(
      new URL(
        second.headers.get("location") ?? "",
        "https://x",
      ).searchParams.get("outcome"),
    ).toBe("connected");
    expect(recoveryCalls).toBe(1);
  });

  test("without a recovery hook, a duplicate callback reports state_expired", async () => {
    const app = connectRoutes();
    const { response: started } = await startConnect(app);
    const cookie = allCookies(started);
    const path = "/api/connections/oauth/widget/callback?code=abc123";

    await app.request(path, { headers: { cookie } });
    const second = await app.request(path, { headers: { cookie } });

    expect(
      new URL(
        second.headers.get("location") ?? "",
        "https://x",
      ).searchParams.get("code"),
    ).toBe("state_expired");
  });

  test("an exchange failure never reaches connectCredential", async () => {
    let connected = 0;
    const app = connectRoutes(
      {
        connectCredential: async () => {
          connected += 1;
          return {
            kind: "connected",
            tenantId: "t",
            tenantSlug: "t",
            principalId: "p",
            tenantDomain: "t.local",
          };
        },
      },
      {
        widget: fakeDescriptor({
          exchange: async () => ({ ok: false, message: "denied" }),
        }),
      },
    );
    const { response: started } = await startConnect(app);
    const cookie = allCookies(started);

    const response = await app.request(
      "/api/connections/oauth/widget/callback?code=abc123",
      { headers: { cookie } },
    );
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("code")).toBe("exchange_failed");
    expect(connected).toBe(0);
  });

  test("an invalid-credential store result is a key_rejected ending", async () => {
    const app = connectRoutes({
      connectCredential: async () => ({
        kind: "invalid-credential",
        message: "bad key",
      }),
    });
    const { response: started } = await startConnect(app);
    const cookie = allCookies(started);

    const response = await app.request(
      "/api/connections/oauth/widget/callback?code=abc123",
      { headers: { cookie } },
    );
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("code")).toBe("key_rejected");
  });

  test("a no-personal-bench store result is a no_bench ending", async () => {
    const app = connectRoutes({
      connectCredential: async () => ({ kind: "no-personal-bench" }),
    });
    const { response: started } = await startConnect(app);
    const cookie = allCookies(started);

    const response = await app.request(
      "/api/connections/oauth/widget/callback?code=abc123",
      { headers: { cookie } },
    );
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("code")).toBe("no_bench");
  });

  test("afterConnected runs only for a connector that deploys default workflows", async () => {
    let calls = 0;
    const app = connectRoutes(
      {
        afterConnected: async () => {
          calls += 1;
        },
      },
      { widget: fakeDescriptor({ deploysDefaultWorkflows: false }) },
    );
    const { response: started } = await startConnect(app);
    const cookie = allCookies(started);

    await app.request("/api/connections/oauth/widget/callback?code=abc123", {
      headers: { cookie },
    });
    expect(calls).toBe(0);

    const deployApp = connectRoutes(
      {
        afterConnected: async () => {
          calls += 1;
        },
      },
      { widget: fakeDescriptor({ deploysDefaultWorkflows: true }) },
    );
    const { response: deployStarted } = await startConnect(deployApp);
    const deployCookie = allCookies(deployStarted);
    await deployApp.request(
      "/api/connections/oauth/widget/callback?code=abc123",
      { headers: { cookie: deployCookie } },
    );
    expect(calls).toBe(1);
  });

  test("a thrown store failure surfaces as setup_failed without leaking the key", async () => {
    const lines: string[] = [];
    const app = connectRoutes({
      log: (line) => lines.push(line),
      connectCredential: async () => {
        throw new Error("boom");
      },
    });
    const { response: started } = await startConnect(app);
    const cookie = allCookies(started);

    const response = await app.request(
      "/api/connections/oauth/widget/callback?code=abc123",
      { headers: { cookie } },
    );
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("code")).toBe("setup_failed");
    expect(lines.join("\n")).not.toContain("key-for-abc123");
  });

  describe("open-redirect regression: the return cookie is never trusted either", () => {
    function stateCookieOnly(startResponse: Response): string {
      const match = /workbench_widget_connect=([^;]+)/.exec(
        startResponse.headers.getSetCookie().join("; "),
      );
      if (!match?.[1]) throw new Error("no state cookie in start response");
      return `workbench_widget_connect=${match[1]}`;
    }

    for (const { name, value } of MALICIOUS_RETURN_PATHS) {
      test(`a forged return cookie with no state cookie falls back to the default (${name})`, async () => {
        const app = connectRoutes();
        const forgedCookie = `workbench_widget_connect_return=${encodeURIComponent(value)}`;

        const response = await app.request(
          "/api/connections/oauth/widget/callback?code=abc123",
          { headers: { cookie: forgedCookie } },
        );

        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(location.startsWith("/onboarding?")).toBe(true);
        const parsed = new URL(location, "https://bench.example.com");
        expect(parsed.origin).toBe("https://bench.example.com");
        expect(parsed.searchParams.get("code")).toBe("state_expired");
      });

      test(`a tampered return cookie on an otherwise-successful connect still lands on the default, not the forged target (${name})`, async () => {
        const app = connectRoutes({
          connectCredential: async () => ({
            kind: "connected",
            tenantId: "ten_1",
            tenantSlug: "widget-tenant",
            principalId: "prn_1",
            tenantDomain: "widget-tenant.bench.local",
          }),
        });
        const { response: started } = await startConnect(
          app,
          "?return=%2Fsettings%2Fconnections",
        );
        // The state cookie is untouched (a real, valid connect in
        // progress); only the return cookie is swapped for the forged
        // value, simulating an attacker who can write cookies on this
        // origin (e.g. a related subdomain) but doesn't otherwise
        // control the OAuth round trip.
        const forgedCookie = `${stateCookieOnly(started)}; workbench_widget_connect_return=${encodeURIComponent(value)}`;

        const response = await app.request(
          "/api/connections/oauth/widget/callback?code=abc123",
          { headers: { cookie: forgedCookie } },
        );

        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(location.startsWith("/onboarding?")).toBe(true);
        const parsed = new URL(location, "https://bench.example.com");
        expect(parsed.origin).toBe("https://bench.example.com");
        expect(parsed.searchParams.get("outcome")).toBe("connected");
      });
    }
  });
});

describe("onConnected hook", () => {
  test("callback fires onConnected once the credential is durably stored", async () => {
    const events: unknown[] = [];
    const app = connectRoutes({
      onConnected: async (info) => {
        events.push(info);
      },
    });
    const { response: started } = await startConnect(app);
    const cookie = allCookies(started);
    const response = await app.request(
      "/api/connections/oauth/widget/callback?code=abc123",
      { headers: { cookie } },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location") ?? "").toContain(
      "outcome=connected",
    );
    expect(events).toEqual([
      {
        tenantId: "ten_1",
        principalId: "prn_1",
        connectorId: "widget",
        displayName: "Widget",
      },
    ]);
  });

  test("a throwing onConnected never breaks the connected redirect", async () => {
    const app = connectRoutes({
      onConnected: async () => {
        throw new Error("settle failed");
      },
    });
    const { response: started } = await startConnect(app);
    const cookie = allCookies(started);
    const response = await app.request(
      "/api/connections/oauth/widget/callback?code=abc123",
      { headers: { cookie } },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location") ?? "").toContain(
      "outcome=connected",
    );
  });
});
