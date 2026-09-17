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
              "Checking whether this hub is set up hit a snag. Try again in a moment.",
            refId: "abc123",
          },
        },
        500,
      )) as unknown as typeof fetch;

    const result = await triggerFirstLoginProvisioning();
    expect(result).toEqual({
      kind: "error",
      message:
        "Checking whether this hub is set up hit a snag. Try again in a moment.",
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
    expect(markup).toContain("Checking your hub");
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

  test("an empty hub renders the setup-pending panel with a recheck, and never navigates", async () => {
    const { container, root, navigate, calls, seen } = renderGateAtOnboarding({
      setupRequired: true,
      userCount: 1,
      tenantCount: 0,
    });
    try {
      await settle(root, gateElement(navigate));

      expect(container.textContent).toContain("Set up your hub");
      expect(container.textContent).toContain("Check again");
      expect(calls).toEqual([]);
      expect(seen).toEqual(["/api/setup/status"]);
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
            "Checking whether this hub is set up hit a snag. Try again in a moment.",
          refId: "r1",
        },
      },
      500,
    );
    try {
      await settle(root, gateElement(navigate));

      expect(container.textContent).toContain("Couldn't check your hub");
      expect(container.textContent).toContain("Try again");
      expect(container.textContent).toContain("r1");
      expect(calls).toEqual([]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
