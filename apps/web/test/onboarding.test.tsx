// The setup gate (CL-8112): the first-login hook is a read-only status
// read now — `triggerFirstLoginProvisioning` GETs the hub's native
// `/api/setup/status` and reports only a routing verdict
// (`existing-member` / `needs-onboarding` / `error`), never minting
// anything. The screen at the onboarding path is a thin gate over that
// verdict: an empty hub renders a static pending panel, a set-up hub
// bounces into the shell, and a broken status read blocks with retry.
// Nothing here may touch `/api/onboarding/*` — those routes went with
// the hub mount, and the setup flow itself (T6/T7) has yet to be built.

import { ThemeProvider } from "@corbits/react-ui";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../src/app";
import {
  fetchAgentReadiness,
  hasActiveCredential,
  triggerFirstLoginProvisioning,
} from "../src/onboarding";
import { ONBOARDING_PATH } from "../src/routes";
import type { SessionState } from "../src/session";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const noop = () => undefined;

/** A `navigate` that records every call — the gate hands off to `/`
 * with a navigate call, so proving the hand-off means proving the
 * call, not scraping ending copy. */
function trackedNavigate() {
  const calls: string[] = [];
  return { navigate: (to: string) => calls.push(to), calls };
}

const signedIn: SessionState = {
  kind: "signed-in",
  user: { id: "user_1", name: "Ada", email: "ada@example.com" },
};

describe("triggerFirstLoginProvisioning", () => {
  test("a structured error envelope becomes an error outcome, not null", async () => {
    globalThis.fetch = (async () =>
      json(
        {
          error: {
            code: "setup_status_failed",
            userMessage:
              "Checking your workbench hit a snag. Try again in a moment.",
            refId: "abc123",
          },
        },
        500,
      )) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning();
    expect(result).toEqual({
      kind: "error",
      message: "Checking your workbench hit a snag. Try again in a moment.",
      refId: "abc123",
    });
  });

  // CL-6360: a raw network failure (or any body that doesn't match the
  // hub's error envelope) must never surface its own text to the user —
  // only the fixed consumer sentence.
  test("a network failure becomes a consumer-language error outcome, never the raw cause", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning();
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.message).not.toContain("connection refused");
    expect(result.message).toBe(
      "Setting up your workbench hit a snag — we're on it. Try again in a moment.",
    );
  });

  test("an empty hub reports needs-onboarding, never a silent pass-through", async () => {
    globalThis.fetch = (async () =>
      json({
        setupRequired: true,
        userCount: 1,
        tenantCount: 0,
      })) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning();
    expect(result).toEqual({ kind: "needs-onboarding" });
  });

  test("a hub with tenants reports existing-member", async () => {
    globalThis.fetch = (async () =>
      json({
        setupRequired: false,
        userCount: 1,
        tenantCount: 1,
      })) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning();
    expect(result).toEqual({ kind: "existing-member" });
  });

  test("an unparseable status body is an error, never a fabricated verdict", async () => {
    globalThis.fetch = (async () =>
      json({ not: "a status" })) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning();
    expect(result.kind).toBe("error");
  });

  test("reads the native status route with a bare GET — no body, no minting", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return json({ setupRequired: false, userCount: 1, tenantCount: 1 });
    }) as unknown as typeof fetch;

    await triggerFirstLoginProvisioning();
    expect(seen.map((s) => s.url)).toEqual(["/api/setup/status"]);
    expect(seen[0]?.init?.method ?? "GET").toBe("GET");
    expect(seen[0]?.init?.body).toBeUndefined();
  });
});

describe("fetchAgentReadiness", () => {
  // CL-8112 T1: the legacy `/api/onboarding/provisioning-status` route is
  // gone with the hub mount — a 404/410 must answer `route-gone`, never
  // the generic agent error, so no caller can read a deleted route as
  // "your agent is broken".
  test("a 404 is route-gone, not a generic agent error", async () => {
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;

    expect(await fetchAgentReadiness("tnt_1")).toEqual({
      kind: "route-gone",
    });
  });

  test("a 410 is route-gone, not a generic agent error", async () => {
    globalThis.fetch = (async () =>
      new Response("gone", { status: 410 })) as unknown as typeof fetch;

    expect(await fetchAgentReadiness("tnt_1")).toEqual({
      kind: "route-gone",
    });
  });
});

describe("hasActiveCredential", () => {
  // CL-6868: a transient credentials read must never coerce to "no key" —
  // that path opens paste-a-key as if none exists when one may already be
  // connected. Probe failures are a distinct outcome from a confirmed miss.
  test("an active credential is reported as active", async () => {
    globalThis.fetch = (async () =>
      json({
        data: [{ id: "cred_1", status: "active" }],
        nextCursor: null,
      })) as unknown as typeof fetch;

    expect(await hasActiveCredential("ten_1")).toEqual({ kind: "active" });
  });

  test("an empty credentials page is a confirmed none, not a probe failure", async () => {
    globalThis.fetch = (async () =>
      json({ data: [], nextCursor: null })) as unknown as typeof fetch;

    expect(await hasActiveCredential("ten_1")).toEqual({ kind: "none" });
  });

  test("a network failure is a probe error, never coerced to none", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    expect(await hasActiveCredential("ten_1")).toEqual({ kind: "error" });
  });

  test("a non-OK credentials response is a probe error, never coerced to none", async () => {
    globalThis.fetch = (async () =>
      json({ error: "boom" }, 500)) as unknown as typeof fetch;

    expect(await hasActiveCredential("ten_1")).toEqual({ kind: "error" });
  });

  test("an unparseable credentials body is a probe error, never coerced to none", async () => {
    globalThis.fetch = (async () =>
      json({ not: "credentials" })) as unknown as typeof fetch;

    expect(await hasActiveCredential("ten_1")).toEqual({ kind: "error" });
  });
});

describe("App with a provisioning error", () => {
  test("blocks the shell with a retry action instead of rendering it", () => {
    const markup = renderToStaticMarkup(
      <App
        path="/"
        navigate={noop}
        session={signedIn}
        onSignedIn={noop}
        onSignOut={noop}
        onRetry={noop}
        provisioningError="Could not provision a workbench for this account."
        onRetryProvisioning={noop}
      />,
    );

    expect(markup).toContain("set up your workbench");
    expect(markup).toContain(
      "Could not provision a workbench for this account.",
    );
    expect(markup).not.toContain("shell-frame");
  });
});

describe("App at the onboarding path", () => {
  const renderOnboarding = () =>
    renderToStaticMarkup(
      <App
        path={ONBOARDING_PATH}
        navigate={noop}
        session={signedIn}
        onSignedIn={noop}
        onSignOut={noop}
        onRetry={noop}
      />,
    );

  test("never renders the shell — no rail, no bench dock, nothing", () => {
    const markup = renderOnboarding();
    expect(markup).not.toContain("shell-frame");
    expect(markup).not.toContain("shell-bench-dock");
  });

  test("lands on the checking phase first — the verdict arrives after the status read", () => {
    const markup = renderOnboarding();
    expect(markup).toContain("Checking your workbench");
  });
});

describe("App once onboarding is behind you", () => {
  test("mounts the shell for an ordinary route", () => {
    globalThis.fetch = (async () =>
      json({ data: [] })) as unknown as typeof fetch;

    const markup = renderToStaticMarkup(
      <ThemeProvider>
        <App
          path="/"
          navigate={noop}
          session={signedIn}
          onSignedIn={noop}
          onSignOut={noop}
          onRetry={noop}
        />
      </ThemeProvider>,
    );

    expect(markup).toContain("shell-frame");
  });
});

describe("the setup gate", () => {
  function renderGateAtOnboarding(statusBody: unknown, status = 200) {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(url);
      // Anything outside the native status read is a failure: the gate
      // must never touch the deleted `/api/onboarding/*` routes.
      if (url !== "/api/setup/status") {
        throw new Error(`unexpected fetch: ${url}`);
      }
      return json(statusBody, status);
    }) as unknown as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const { navigate, calls } = trackedNavigate();
    return { container, root, navigate, calls, seen };
  }

  async function settle(root: Root, element: ReactElement) {
    act(() => {
      root.render(element);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  function gateElement(navigate: (to: string) => void) {
    return (
      <ThemeProvider>
        <App
          path={ONBOARDING_PATH}
          navigate={navigate}
          session={signedIn}
          onSignedIn={noop}
          onSignOut={noop}
          onRetry={noop}
        />
      </ThemeProvider>
    );
  }

  test("an empty hub drives the installer, which mints the primary tenant then asks the operator to connect a provider (CL-8154)", async () => {
    // The installer's own flow (CL-8131, extended by CL-8154): the first
    // pass finds no owned primary tenant, mints one over stock
    // `POST /api/tenants`, then checks whether it already resolves a
    // catalog offering. A fresh tenant has none, so the gate renders the
    // credential-connect step rather than the old "no myraDeploy
    // configured" gap — the whole point of CL-8154 is that this page
    // supplies `myraDeploy` itself instead of stopping there.
    let ownsPrimary = false;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const { navigate, calls } = trackedNavigate();
    const seen: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push(url);
      const path = url.split("?")[0] ?? url;
      if (path === "/api/setup/status") {
        return json({ setupRequired: true, userCount: 1, tenantCount: 0 });
      }
      if (path === "/api/me/principals") {
        return json({
          data: ownsPrimary
            ? [
                {
                  principalId: "prn_user",
                  tenantId: "tnt_primary",
                  tenantName: "Ada's Workbench",
                  tenantSlug: "ada",
                  kind: "user",
                  status: "active",
                  roles: [{ id: "role_owner", name: "owner" }],
                },
              ]
            : [],
          nextCursor: null,
        });
      }
      if (path === "/api/tenants" && init?.method === "POST") {
        ownsPrimary = true;
        return json(
          {
            id: "tnt_primary",
            name: "Ada's Workbench",
            slug: "ada",
            domain: "ada.workbench.localhost",
            parentId: null,
          },
          201,
        );
      }
      if (path === "/api/tenants/tnt_primary") {
        return json({
          id: "tnt_primary",
          name: "Ada's Workbench",
          slug: "ada",
          domain: "ada.workbench.localhost",
          parentId: null,
        });
      }
      if (path === "/api/tenants/tnt_primary/principals") {
        return json({ data: [], nextCursor: null });
      }
      if (path === "/api/tenants/tnt_primary/models") {
        return json([]);
      }
      // Anything outside the mocked stock routes is a failure: the gate
      // must never touch the deleted `/api/onboarding/*` routes.
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    try {
      await settle(root, gateElement(navigate));

      expect(container.textContent).toContain("Connect a model provider");
      expect(calls).toEqual([]);
      expect(seen).toContain("/api/setup/status");
      expect(seen).toContain("/api/tenants/tnt_primary/models");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a hub with tenants bounces straight into the shell", async () => {
    const { container, root, navigate, calls, seen } = renderGateAtOnboarding({
      setupRequired: false,
      userCount: 1,
      tenantCount: 1,
    });
    try {
      await settle(root, gateElement(navigate));

      expect(calls).toEqual(["/"]);
      expect(seen).toEqual(["/api/setup/status"]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a broken status read blocks with retry instead of the shell", async () => {
    const { container, root, navigate, calls } = renderGateAtOnboarding(
      {
        error: {
          code: "setup_status_failed",
          userMessage:
            "Checking your workbench hit a snag. Try again in a moment.",
          refId: "r1",
        },
      },
      500,
    );
    try {
      await settle(root, gateElement(navigate));

      expect(container.textContent).toContain("Couldn't check your workbench");
      expect(container.textContent).toContain("Try again");
      expect(container.textContent).toContain("r1");
      expect(calls).toEqual([]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
